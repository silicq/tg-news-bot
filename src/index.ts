import { handleStats, handleTest, helpText } from './admin';
import { BudgetTracker, createTracker } from './budget';
import { buildBody, buildButtons, buildCaption, buildMessage, makeCaption } from './caption';
import { assertConfig, loadConfig } from './config';
import { cleanupHistory, filterUnposted, recordPosted, recentPostedTitles } from './dedup';
import { fetchAllFeeds } from './feeds';
import { runHealthCheck, type RunOutcome } from './health';
import { acquireImage, applyWatermark } from './image';
import { handleCallback, handleSettingInput, openPanel } from './panel';
import { rankItems } from './ranking';
import { applyReactionCount, recordPost, reviewReactions } from './reactions';
import { rubricFor } from './rubric';
import { isQuietHours } from './schedule';
import { ensureSchema } from './schema';
import { getOverrides } from './settings';
import { dedupeByTopic, dropSimilarToRecent } from './similarity';
import { publishTranslatedArticle } from './telegraph';
import { type AlbumPhoto, sendMediaGroup, sendMessage, sendPhoto, setWebhook } from './telegram';
import type { Config, Env, FeedItem, RankedItem, TelegramUpdate } from './types';
import { escapeHtml, log, logErr } from './util';

// Second cron (see wrangler.toml) reviews reactions before the daily reset.
const REVIEW_CRON = '50 23 * * *';

interface RunOptions {
  respectQuietHours?: boolean;
  healthAlerts?: boolean;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      if (controller.cron === REVIEW_CRON) {
        const cfg = await resolveConfig(env);
        await reviewReactions(env, cfg);
      } else {
        await runOnce(env, { respectQuietHours: true, healthAlerts: true });
      }
    } catch (e) {
      logErr('scheduled run failed:', String(e));
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json({ ok: true, service: 'tg-news-bot' });
    }

    if (url.pathname === '/run') {
      if (!authorized(env, url)) return forbidden(env);
      ctx.waitUntil(runOnce(env).catch((e) => logErr('manual run failed:', String(e))));
      return Response.json({ ok: true, triggered: true });
    }

    if (url.pathname === '/setup') {
      if (!authorized(env, url)) return forbidden(env);
      const webhookUrl = `${url.origin}/telegram`;
      try {
        const result = await setWebhook(env, webhookUrl, env.MANUAL_TRIGGER_TOKEN);
        return Response.json({ ok: true, webhook: webhookUrl, result });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }

    if (req.method === 'POST' && url.pathname === '/telegram') {
      if (
        env.MANUAL_TRIGGER_TOKEN &&
        req.headers.get('x-telegram-bot-api-secret-token') !== env.MANUAL_TRIGGER_TOKEN
      ) {
        return new Response('forbidden', { status: 403 });
      }
      let update: TelegramUpdate;
      try {
        update = (await req.json()) as TelegramUpdate;
      } catch {
        return new Response('bad request', { status: 400 });
      }
      ctx.waitUntil(dispatchUpdate(env, update).catch((e) => logErr('update handler failed:', String(e))));
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },
};

function authorized(env: Env, url: URL): boolean {
  return Boolean(env.MANUAL_TRIGGER_TOKEN) && url.searchParams.get('token') === env.MANUAL_TRIGGER_TOKEN;
}

function forbidden(env: Env): Response {
  const msg = env.MANUAL_TRIGGER_TOKEN ? 'Forbidden' : 'Disabled (set MANUAL_TRIGGER_TOKEN).';
  return new Response(msg, { status: 403 });
}

/** Ensure schema + load config with admin overrides applied. */
async function resolveConfig(env: Env): Promise<Config> {
  await ensureSchema(env.DB);
  return loadConfig(env, await getOverrides(env.DB));
}

/** Route an incoming webhook update to the right handler. */
async function dispatchUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  await ensureSchema(env.DB);
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }
  if (update.message_reaction_count) {
    await applyReactionCount(env, update.message_reaction_count);
    return;
  }
  await handleUpdate(env, update);
}

/** Route an admin Telegram command / settings input. Non-admins are ignored. */
async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  const text = msg?.text;
  if (!msg || typeof text !== 'string') return;
  if (!env.ADMIN_ID || String(msg.from?.id) !== String(env.ADMIN_ID)) return;

  const trimmed = text.trim();

  // Plain text while editing a setting → treat as the new value.
  if (!trimmed.startsWith('/')) {
    await handleSettingInput(env, trimmed);
    return;
  }

  const cfg = await resolveConfig(env);
  const cmd = trimmed.split(/\s+/)[0].replace(/@.*/, '').toLowerCase();

  try {
    switch (cmd) {
      case '/test':
        await handleTest(env, cfg);
        break;
      case '/stats':
        await handleStats(env, cfg);
        break;
      case '/settings':
        await openPanel(env);
        break;
      case '/run':
        await sendMessage(env, env.ADMIN_ID, '▶️ Запускаю цикл публикации…');
        await runOnce(env);
        await sendMessage(env, env.ADMIN_ID, '✅ Готово. Загляни в /stats.');
        break;
      case '/cancel':
        await handleSettingInput(env, '/cancel');
        break;
      case '/start':
      case '/help':
        await sendMessage(env, env.ADMIN_ID, helpText());
        break;
      default:
        await sendMessage(env, env.ADMIN_ID, 'Неизвестная команда. Доступно: /test, /stats, /settings, /run, /help');
    }
  } catch (e) {
    await sendMessage(env, env.ADMIN_ID, '❌ Ошибка команды ' + cmd + ':\n' + String(e)).catch(() => {});
  }
}

/** One full pipeline pass. Safe to call repeatedly (idempotent via dedup). */
export async function runOnce(env: Env, opts: RunOptions = {}): Promise<void> {
  const cfg = await resolveConfig(env);

  if (opts.respectQuietHours && isQuietHours(cfg)) {
    log('quiet hours for the audience timezone — skipping this run');
    return;
  }

  const outcome: RunOutcome = { fetched: 0, posted: 0, postAttempts: 0, postFailures: 0 };
  let threw: unknown;

  try {
    await runPipeline(env, cfg, outcome);
  } catch (e) {
    outcome.error = String(e);
    logErr('run failed:', String(e));
    threw = e;
  }

  if (opts.healthAlerts) {
    await runHealthCheck(env, cfg, outcome);
  } else if (threw) {
    throw threw;
  }
}

/** The actual pipeline; fills `outcome` for health reporting. */
async function runPipeline(env: Env, cfg: Config, outcome: RunOutcome): Promise<void> {
  assertConfig(cfg, env);

  const tracker = await createTracker(env.DB, cfg);
  log(
    `run start — neurons used today: ${cfg.dailyNeuronBudget - tracker.remaining()}/${cfg.dailyNeuronBudget}, ` +
      `posts today: ${tracker.totalPosts()}/${cfg.maxPostsPerDay}`,
  );

  if (tracker.totalPosts() >= cfg.maxPostsPerDay) {
    log('daily post cap reached, nothing to do');
    return;
  }

  const items = await fetchAllFeeds(cfg);
  outcome.fetched = items.length;
  log(`fetched ${items.length} fresh items from ${cfg.feeds.length} feeds`);
  if (items.length === 0) return;

  let unposted = await filterUnposted(env.DB, items);
  log(`${unposted.length} items remain after hash dedup`);

  if (cfg.topicDedup && unposted.length > 0) {
    const before = unposted.length;
    unposted = dedupeByTopic(unposted, cfg.similarityThreshold);
    const recent = await recentPostedTitles(env.DB);
    unposted = dropSimilarToRecent(unposted, recent, cfg.similarityThreshold);
    if (unposted.length !== before) log(`${before - unposted.length} near-duplicate items dropped`);
  }
  if (unposted.length === 0) return;

  let passing: RankedItem[];
  if (tracker.canAfford(cfg.est.rank)) {
    const { ranked, fallback } = await rankItems(env, cfg, unposted);
    tracker.spend(cfg.est.rank);
    if (fallback) {
      passing = ranked;
    } else {
      passing = ranked.filter((r) => r.score >= cfg.minScore);
      tracker.countSkipped(ranked.length - passing.length);
    }
  } else {
    log('not enough budget to rank; using recency order');
    passing = unposted.map((item) => ({ item, score: 50, reason: 'no budget for ranking' }));
  }
  await tracker.flush();
  log(`${passing.length} items passed the score threshold (>= ${cfg.minScore})`);

  const slots = Math.min(cfg.maxPostsPerRun, cfg.maxPostsPerDay - tracker.totalPosts());
  if (slots <= 0) {
    log('no posting slots left for this run');
    return;
  }

  for (const { item, score, reason } of passing) {
    if (outcome.posted >= slots) break;
    if (tracker.totalPosts() >= cfg.maxPostsPerDay) break;

    try {
      const posted = await publishItem(env, cfg, tracker, item);
      if (posted) {
        await recordPosted(env.DB, item);
        tracker.countPost();
        outcome.posted += 1;
        outcome.postAttempts += 1;
        log(`posted (score ${score}): ${item.title} — ${reason}`);
      } else {
        tracker.countSkipped(1);
      }
    } catch (e) {
      outcome.postAttempts += 1;
      outcome.postFailures += 1;
      logErr('failed to publish item:', item.link, String(e));
    } finally {
      await tracker.flush();
    }
  }

  await tracker.flush();
  try {
    await cleanupHistory(env.DB, cfg);
  } catch (e) {
    logErr('history cleanup failed:', String(e));
  }
  log(`run done — published ${outcome.posted}, neurons used today: ${cfg.dailyNeuronBudget - tracker.remaining()}`);
}

/**
 * Build caption + image and publish. Returns true if a post was sent, false if
 * intentionally skipped (NO_IMAGE_BEHAVIOR = skip).
 */
async function publishItem(
  env: Env,
  cfg: Config,
  tracker: BudgetTracker,
  item: FeedItem,
): Promise<boolean> {
  let captionBody: string;
  if (tracker.canAfford(cfg.est.caption)) {
    captionBody = await makeCaption(env, cfg, item);
    tracker.spend(cfg.est.caption);
  } else {
    log('budget too low for AI caption; using headline');
    captionBody = escapeHtml(item.title);
  }
  if (cfg.rubricsEnabled) captionBody = `${rubricFor(item)}\n\n${captionBody}`;

  // Optional telegra.ph page with the full AI translation of the original.
  let articleUrl: string | null = null;
  let articleImages: string[] = [];
  if (cfg.telegraphEnabled && tracker.canAfford(cfg.est.translate)) {
    const article = await publishTranslatedArticle(env, cfg, item, tracker);
    if (article) {
      articleUrl = article.url;
      articleImages = article.images;
      log('telegraph article:', article.url);
    }
  }

  const image = await acquireImage(env, cfg, item, tracker);

  // No image at all → text post (or skip).
  if (image.kind === 'none') {
    if (cfg.noImageBehavior === 'skip') {
      log('no image available and NO_IMAGE_BEHAVIOR=skip; skipping:', item.link);
      return false;
    }
    const markup = cfg.buttonsEnabled ? { inline_keyboard: buildButtons(item.link, cfg, articleUrl) } : undefined;
    const text = cfg.buttonsEnabled ? buildBody(captionBody) : buildMessage(captionBody, item.link, cfg, articleUrl);
    const mid = await sendMessage(env, cfg.channelId, text, markup);
    if (cfg.reactionsEnabled && mid) await recordPost(env, mid, item);
    return true;
  }

  const aiBytes = image.kind === 'bytes' ? await applyWatermark(env, cfg, image.bytes) : null;
  let messageId: number | null = null;

  // Album: generated image + original article photos (no inline buttons on albums,
  // so links go in the caption).
  if (cfg.albumsEnabled && aiBytes && articleImages.length > 0 && cfg.articleMaxImages > 0) {
    const caption = buildCaption(captionBody, item.link, cfg, articleUrl);
    const photos: AlbumPhoto[] = [{ media: aiBytes, caption }];
    for (const src of articleImages.slice(0, cfg.articleMaxImages)) photos.push({ media: src });
    try {
      messageId = await sendMediaGroup(env, cfg.channelId, photos);
    } catch (e) {
      logErr('album failed, falling back to single photo:', String(e));
    }
  }

  // Single photo (with inline buttons when enabled).
  if (messageId === null) {
    const markup = cfg.buttonsEnabled ? { inline_keyboard: buildButtons(item.link, cfg, articleUrl) } : undefined;
    const caption = cfg.buttonsEnabled ? buildBody(captionBody) : buildCaption(captionBody, item.link, cfg, articleUrl);
    const photo = aiBytes ?? (image.kind === 'url' ? image.url : '');
    messageId = await sendPhoto(env, cfg.channelId, photo, caption, markup);
  }

  if (cfg.reactionsEnabled && messageId) await recordPost(env, messageId, item);
  return true;
}
