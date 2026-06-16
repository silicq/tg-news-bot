import type { Config, Env, ImageMode, NoImageBehavior } from './types';
import { logErr } from './util';

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim();
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
    maxAgeHours: num(env.MAX_AGE_HOURS, 24),
    maxPostsPerRun: Math.max(0, num(env.MAX_POSTS_PER_RUN, 2)),
    maxPostsPerDay: Math.max(0, num(env.MAX_POSTS_PER_DAY, 4)),
    minScore: num(env.MIN_SCORE, 55),
    imageMode: imageMode === 'og_first' ? 'og_first' : 'generate',
    ogFallbackThreshold: num(env.OG_FALLBACK_NEURON_THRESHOLD, 2000),
    noImageBehavior: ['og', 'text', 'skip'].includes(noImageBehavior) ? noImageBehavior : 'og',
    dailyNeuronBudget: num(env.DAILY_NEURON_BUDGET, 9000),
    textModel: str(env.TEXT_MODEL, '@cf/meta/llama-3.1-8b-instruct-fast'),
    imageModel: str(env.IMAGE_MODEL, '@cf/black-forest-labs/flux-1-schnell'),
    imageSteps: Math.min(8, Math.max(1, num(env.IMAGE_STEPS, 4))),
    historyRetentionDays: num(env.HISTORY_RETENTION_DAYS, 30),
    est: {
      rank: num(env.EST_NEURONS_RANK, 60),
      caption: num(env.EST_NEURONS_CAPTION, 30),
      imagePrompt: num(env.EST_NEURONS_IMAGE_PROMPT, 15),
      image: num(env.EST_NEURONS_IMAGE, 150),
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
