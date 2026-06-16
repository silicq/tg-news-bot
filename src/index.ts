import { handleStats, handleTest, helpText } from './admin';
import { BudgetTracker, createTracker } from './budget';
import { buildCaption, buildMessage, makeCaption } from './caption';
import { assertConfig, loadConfig } from './config';
import { cleanupHistory, filterUnposted, recordPosted } from './dedup';
import { fetchAllFeeds } from './feeds';
import { acquireImage } from './image';
import { rankItems } from './ranking';
import { ensureSchema } from './schema';
import { sendMessage, sendPhoto, setWebhook } from './telegram';
import type { Config, Env, FeedItem, RankedItem, TelegramUpdate } from './types';
import { log, logErr } from './util';

export default {
  // Cron entry point.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runOnce(env);
    } catch (e) {
      logErr('run failed:', String(e));
    }
  },

  // HTTP entry point: health check, manual trigger, Telegram webhook, webhook setup.
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json({ ok: true, service: 'tg-news-bot' });
    }

    // Manual full-pipeline trigger for testing: GET /run?token=...
    if (url.pathname === '/run') {
      if (!authorized(env, url)) return forbidden(env);
      ctx.waitUntil(runOnce(env).catch((e) => logErr('manual run failed:', String(e))));
      return Response.json({ ok: true, triggered: true });
    }

    // One-time webhook registration: GET /setup?token=...
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

    // Telegram webhook: POST /telegram
    if (req.method === 'POST' && url.pathname === '/telegram') {
      // Verify the secret token Telegram echoes back (set during /setup).
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
      // Ack immediately, do the (possibly slow) work in the background so
      // Telegram doesn't time out and re-deliver the update.
      ctx.waitUntil(handleUpdate(env, update).catch((e) => logErr('update handler failed:', String(e))));
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

/** Route an admin Telegram command. Non-admins are ignored silently. */
async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  const text = msg?.text;
  if (!msg || typeof text !== 'string') return;

  // Only the configured admin may run commands.
  if (!env.ADMIN_ID || String(msg.from?.id) !== String(env.ADMIN_ID)) return;

  const cfg = loadConfig(env);
  await ensureSchema(env.DB);

  // "/stats@my_bot foo" -> "/stats"
  const cmd = text.trim().split(/\s+/)[0].replace(/@.*/, '').toLowerCase();

  try {
    switch (cmd) {
      case '/test':
        await handleTest(env, cfg);
        break;
      case '/stats':
        await handleStats(env, cfg);
        break;
      case '/run':
        await sendMessage(env, env.ADMIN_ID, '▶️ Запускаю цикл публикации…');
        await runOnce(env);
        await sendMessage(env, env.ADMIN_ID, '✅ Готово. Загляни в /stats.');
        break;
      case '/start':
      case '/help':
        await sendMessage(env, env.ADMIN_ID, helpText());
        break;
      default:
        await sendMessage(env, env.ADMIN_ID, 'Неизвестная команда. Доступно: /test, /stats, /run, /help');
    }
  } catch (e) {
    await sendMessage(env, env.ADMIN_ID, '❌ Ошибка команды ' + cmd + ':\n' + String(e)).catch(() => {});
  }
}

/** One full pipeline pass. Safe to call repeatedly (idempotent via dedup). */
export async function runOnce(env: Env): Promise<void> {
  const cfg = loadConfig(env);
  assertConfig(cfg, env);
  await ensureSchema(env.DB);

  const tracker = await createTracker(env.DB, cfg);
  log(
    `run start — neurons used today: ${cfg.dailyNeuronBudget - tracker.remaining()}/${cfg.dailyNeuronBudget}, ` +
      `posts today: ${tracker.totalPosts()}/${cfg.maxPostsPerDay}`,
  );

  if (tracker.totalPosts() >= cfg.maxPostsPerDay) {
    log('daily post cap reached, nothing to do');
    return;
  }

  // 1. Fetch + 2. parse.
  const items = await fetchAllFeeds(cfg);
  log(`fetched ${items.length} fresh items from ${cfg.feeds.length} feeds`);
  if (items.length === 0) return;

  // 3. Dedup against history.
  const unposted = await filterUnposted(env.DB, items);
  log(`${unposted.length} items remain after dedup`);
  if (unposted.length === 0) return;

  // 4. Rank (single batched AI call) — only if we can afford it.
  let passing: RankedItem[];
  if (tracker.canAfford(cfg.est.rank)) {
    const { ranked, fallback } = await rankItems(env, cfg, unposted);
    tracker.spend(cfg.est.rank);
    if (fallback) {
      passing = ranked;
    } else {
      passing = ranked.filter((r) => r.score >= cfg.minScore);
      // Items the editor explicitly rejected as off-theme count as "skipped".
      tracker.countSkipped(ranked.length - passing.length);
    }
  } else {
    log('not enough budget to rank; using recency order');
    passing = unposted.map((item) => ({ item, score: 50, reason: 'no budget for ranking' }));
  }
  await tracker.flush();
  log(`${passing.length} items passed the score threshold (>= ${cfg.minScore})`);

  // 5. How many can we post this run?
  const slots = Math.min(cfg.maxPostsPerRun, cfg.maxPostsPerDay - tracker.totalPosts());
  if (slots <= 0) {
    log('no posting slots left for this run');
    return;
  }

  // 6. Publish top items.
  let published = 0;
  for (const { item, score, reason } of passing) {
    if (published >= slots) break;
    if (tracker.totalPosts() >= cfg.maxPostsPerDay) break;

    try {
      const posted = await publishItem(env, cfg, tracker, item);
      if (posted) {
        await recordPosted(env.DB, item);
        tracker.countPost();
        published += 1;
        log(`posted (score ${score}): ${item.title} — ${reason}`);
      } else {
        // Skipped on purpose (NO_IMAGE_BEHAVIOR=skip).
        tracker.countSkipped(1);
      }
    } catch (e) {
      logErr('failed to publish item:', item.link, String(e));
    } finally {
      await tracker.flush();
    }
  }

  // 7. Housekeeping.
  await tracker.flush();
  try {
    await cleanupHistory(env.DB, cfg);
  } catch (e) {
    logErr('history cleanup failed:', String(e));
  }
  log(`run done — published ${published}, neurons used today: ${cfg.dailyNeuronBudget - tracker.remaining()}`);
}

/**
 * Build caption + image and send to the channel. Returns true if a post was
 * sent, false if it was intentionally skipped (NO_IMAGE_BEHAVIOR = skip).
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
    captionBody = item.title;
  }

  const image = await acquireImage(env, cfg, item, tracker);

  if (image.kind === 'none') {
    if (cfg.noImageBehavior === 'skip') {
      log('no image available and NO_IMAGE_BEHAVIOR=skip; skipping:', item.link);
      return false;
    }
    await sendMessage(env, cfg.channelId, buildMessage(captionBody, item.link, cfg));
    return true;
  }

  const caption = buildCaption(captionBody, item.link, cfg);
  if (image.kind === 'url') {
    await sendPhoto(env, cfg.channelId, image.url, caption);
  } else {
    await sendPhoto(env, cfg.channelId, image.bytes, caption);
  }
  return true;
}
