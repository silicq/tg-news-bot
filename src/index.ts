import { BudgetTracker, createTracker } from './budget';
import { buildCaption, buildMessage, makeCaption } from './caption';
import { assertConfig, loadConfig } from './config';
import { cleanupHistory, filterUnposted, recordPosted } from './dedup';
import { fetchAllFeeds } from './feeds';
import { acquireImage } from './image';
import { rankItems } from './ranking';
import { sendMessage, sendPhoto } from './telegram';
import type { Config, Env, FeedItem, RankedItem } from './types';
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

  // HTTP entry point: health check + manual trigger for testing.
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json({ ok: true, service: 'tg-news-bot' });
    }

    if (url.pathname === '/run') {
      const token = env.MANUAL_TRIGGER_TOKEN;
      if (!token) {
        return new Response('Manual trigger disabled (set MANUAL_TRIGGER_TOKEN).', {
          status: 403,
        });
      }
      if (url.searchParams.get('token') !== token) {
        return new Response('Forbidden', { status: 403 });
      }
      // Run in the background so the request returns immediately.
      ctx.waitUntil(runOnce(env).catch((e) => logErr('manual run failed:', String(e))));
      return Response.json({ ok: true, triggered: true });
    }

    return new Response('Not found', { status: 404 });
  },
};

/** One full pipeline pass. Safe to call repeatedly (idempotent via dedup). */
export async function runOnce(env: Env): Promise<void> {
  const cfg = loadConfig(env);
  assertConfig(cfg, env);

  const tracker = await createTracker(env.DB, cfg);
  log(
    `run start — neurons used today: ${cfg.dailyNeuronBudget - tracker.remaining()}/${cfg.dailyNeuronBudget}, ` +
      `posts today: ${tracker.totalPosts()}/${cfg.maxPostsPerDay}`,
  );

  // Daily post cap reached?
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
  let ranked: RankedItem[];
  if (tracker.canAfford(cfg.est.rank)) {
    ranked = await rankItems(env, cfg, unposted);
    tracker.spend(cfg.est.rank);
  } else {
    log('not enough budget to rank; using recency order');
    ranked = unposted.map((item) => ({ item, score: 50, reason: 'no budget for ranking' }));
  }
  await tracker.flush();
  log(`${ranked.length} items passed the score threshold (>= ${cfg.minScore})`);

  // 5. How many can we post this run?
  const slots = Math.min(cfg.maxPostsPerRun, cfg.maxPostsPerDay - tracker.totalPosts());
  if (slots <= 0) {
    log('no posting slots left for this run');
    return;
  }

  // 6. Publish top items.
  let published = 0;
  for (const { item, score, reason } of ranked) {
    if (published >= slots) break;
    if (tracker.totalPosts() >= cfg.maxPostsPerDay) break;

    try {
      const posted = await publishItem(env, cfg, tracker, item);
      if (posted) {
        await recordPosted(env.DB, item);
        tracker.countPost();
        published += 1;
        log(`posted (score ${score}): ${item.title} — ${reason}`);
      }
    } catch (e) {
      // One bad item must not kill the run.
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
 * Build caption + image and send to Telegram. Returns true if a post was sent,
 * false if it was intentionally skipped (NO_IMAGE_BEHAVIOR = skip).
 */
async function publishItem(
  env: Env,
  cfg: Config,
  tracker: BudgetTracker,
  item: FeedItem,
): Promise<boolean> {
  // Caption: use AI when affordable, otherwise degrade to the headline.
  let captionBody: string;
  if (tracker.canAfford(cfg.est.caption)) {
    captionBody = await makeCaption(env, cfg, item);
    tracker.spend(cfg.est.caption);
  } else {
    log('budget too low for AI caption; using headline');
    captionBody = item.title;
  }

  // Image (may spend neurons or fall back to og:image / none).
  const image = await acquireImage(env, cfg, item, tracker);

  if (image.kind === 'none') {
    if (cfg.noImageBehavior === 'skip') {
      log('no image available and NO_IMAGE_BEHAVIOR=skip; skipping:', item.link);
      return false;
    }
    await sendMessage(env, cfg, buildMessage(captionBody, item.link, cfg));
    return true;
  }

  const caption = buildCaption(captionBody, item.link, cfg);
  if (image.kind === 'url') {
    await sendPhoto(env, cfg, image.url, caption);
  } else {
    await sendPhoto(env, cfg, image.bytes, caption);
  }
  return true;
}
