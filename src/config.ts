import type { Config, Env, ImageMode, NoImageBehavior } from './types';
import { logErr } from './util';

function num(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function str(v: unknown, fallback: string): string {
  // TOML vars can arrive as numbers/booleans (e.g. an unquoted channel id),
  // so coerce defensively instead of assuming a string.
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s.length ? s : fallback;
}

function parseFeeds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      return v.map((x) => String(x).trim()).filter((x) => /^https?:\/\//i.test(x));
    }
  } catch (e) {
    logErr('RSS_FEEDS is not valid JSON:', e);
  }
  return [];
}

/** Parse the raw env strings into a typed, validated config object. */
export function loadConfig(env: Env): Config {
  const imageMode = (str(env.IMAGE_MODE, 'generate') as ImageMode) || 'generate';
  const noImageBehavior = (str(env.NO_IMAGE_BEHAVIOR, 'og') as NoImageBehavior) || 'og';

  return {
    channelId: str(env.TELEGRAM_CHANNEL_ID, ''),
    feeds: parseFeeds(env.RSS_FEEDS),
    channelTheme: str(env.CHANNEL_THEME, 'Interesting, positive, curious news.'),
    captionLang: str(env.CAPTION_LANG, 'ru'),
    captionTone: str(env.CAPTION_TONE, 'живой, тёплый, без кликбейта'),
    sourceLabel: str(env.SOURCE_LABEL, 'Источник'),
    creditText: str(env.CREDIT_TEXT, '@monkeydiary'),
    creditUrl: str(env.CREDIT_URL, 'https://t.me/monkeydiary'),
    maxAgeHours: num(env.MAX_AGE_HOURS, 24),
    maxPostsPerRun: Math.max(0, num(env.MAX_POSTS_PER_RUN, 2)),
    maxPostsPerDay: Math.max(0, num(env.MAX_POSTS_PER_DAY, 16)),
    minScore: num(env.MIN_SCORE, 55),
    topicDedup: bool(env.TOPIC_DEDUP, true),
    similarityThreshold: Math.min(1, Math.max(0, num(env.SIMILARITY_THRESHOLD, 0.5))),
    // Posting window in the audience timezone (no posts when start <= hour < end).
    // Set start === end to disable quiet hours.
    quietStartHour: Math.min(23, Math.max(0, num(env.QUIET_START_HOUR, 0))),
    quietEndHour: Math.min(24, Math.max(0, num(env.QUIET_END_HOUR, 8))),
    tzOffsetHours: num(env.TZ_OFFSET_HOURS, 3),
    healthAlerts: bool(env.HEALTH_ALERTS, true),
    healthEmptyStreak: Math.max(1, num(env.HEALTH_EMPTY_STREAK, 3)),
    healthCooldownHours: Math.max(0, num(env.HEALTH_COOLDOWN_HOURS, 6)),
    imageMode: imageMode === 'og_first' ? 'og_first' : 'generate',
    ogFallbackThreshold: num(env.OG_FALLBACK_NEURON_THRESHOLD, 2000),
    noImageBehavior: ['og', 'text', 'skip'].includes(noImageBehavior) ? noImageBehavior : 'og',
    dailyNeuronBudget: num(env.DAILY_NEURON_BUDGET, 9000),
    textModel: str(env.TEXT_MODEL, '@cf/meta/llama-3.1-8b-instruct-fast'),
    translateModel: str(env.TRANSLATE_MODEL, str(env.TEXT_MODEL, '@cf/meta/llama-3.1-8b-instruct-fast')),
    imageModel: str(env.IMAGE_MODEL, '@cf/black-forest-labs/flux-1-schnell'),
    // Free diffusion model used when the neuron budget is low or the primary
    // model fails. Keeps the AI-generated look (unlike og:image).
    imageModelFallback: str(env.IMAGE_MODEL_FALLBACK, '@cf/bytedance/stable-diffusion-xl-lightning'),
    imageSteps: Math.min(8, Math.max(1, num(env.IMAGE_STEPS, 4))),
    imageStepsFallback: Math.max(1, num(env.IMAGE_STEPS_FALLBACK, 8)),
    // Target dimensions for models that accept width/height (SDXL family).
    // NOTE: flux-1-schnell ignores these and always returns a square image.
    imageWidth: num(env.IMAGE_WIDTH, 1280),
    imageHeight: num(env.IMAGE_HEIGHT, 720),
    watermarkEnabled: bool(env.WATERMARK_ENABLED, true),
    watermarkOpacity: Math.min(1, Math.max(0, num(env.WATERMARK_OPACITY, 0.55))),
    watermarkPadding: Math.max(0, num(env.WATERMARK_PADDING, 28)),
    // Telegra.ph article with an AI translation of the original.
    telegraphEnabled: bool(env.TELEGRAPH_ENABLED, true),
    telegraphAuthorName: str(env.TELEGRAPH_AUTHOR_NAME, str(env.CREDIT_TEXT, '@monkeydiary')),
    telegraphAuthorUrl: str(env.TELEGRAPH_AUTHOR_URL, str(env.CREDIT_URL, 'https://t.me/monkeydiary')),
    articleMaxBlocks: Math.max(3, num(env.ARTICLE_MAX_BLOCKS, 25)),
    articleReadLabel: str(env.ARTICLE_READ_LABEL, '📖 Перевод'),
    // Put the source/translation links as tappable inline buttons instead of
    // links inside the caption text (cleaner look).
    buttonsEnabled: bool(env.BUTTONS_ENABLED, true),
    historyRetentionDays: num(env.HISTORY_RETENTION_DAYS, 30),
    est: {
      rank: num(env.EST_NEURONS_RANK, 60),
      caption: num(env.EST_NEURONS_CAPTION, 30),
      imagePrompt: num(env.EST_NEURONS_IMAGE_PROMPT, 15),
      image: num(env.EST_NEURONS_IMAGE, 150),
      imageFallback: num(env.EST_NEURONS_IMAGE_FALLBACK, 0),
      translate: num(env.EST_NEURONS_TRANSLATE, 250),
    },
  };
}

/** Throw if a required config value is missing. Called at the start of a run. */
export function assertConfig(cfg: Config, env: Env): void {
  const problems: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) problems.push('TELEGRAM_BOT_TOKEN secret is not set');
  if (!cfg.channelId) problems.push('TELEGRAM_CHANNEL_ID is not set');
  if (cfg.feeds.length === 0) problems.push('RSS_FEEDS is empty or invalid');
  if (problems.length) {
    throw new Error('Invalid configuration: ' + problems.join('; '));
  }
}
