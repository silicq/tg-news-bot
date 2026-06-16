// Shared types for the worker.

/** Runtime bindings + configuration variables (raw strings from wrangler). */
export interface Env {
  // Bindings
  DB: D1Database;
  AI: Ai;

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  MANUAL_TRIGGER_TOKEN?: string;
  // Telegram user id of the admin. Only this user may run bot commands
  // (/test, /stats, ...). Also the chat the bot replies to.
  ADMIN_ID?: string;

  // Vars (all strings — parsed in config.ts)
  TELEGRAM_CHANNEL_ID: string;
  RSS_FEEDS: string;
  CHANNEL_THEME: string;
  CAPTION_LANG?: string;
  CAPTION_TONE?: string;
  SOURCE_LABEL?: string;
  MAX_AGE_HOURS?: string;
  MAX_POSTS_PER_RUN?: string;
  MAX_POSTS_PER_DAY?: string;
  MIN_SCORE?: string;
  IMAGE_MODE?: string;
  OG_FALLBACK_NEURON_THRESHOLD?: string;
  NO_IMAGE_BEHAVIOR?: string;
  DAILY_NEURON_BUDGET?: string;
  TEXT_MODEL?: string;
  IMAGE_MODEL?: string;
  IMAGE_STEPS?: string;
  EST_NEURONS_RANK?: string;
  EST_NEURONS_CAPTION?: string;
  EST_NEURONS_IMAGE_PROMPT?: string;
  EST_NEURONS_IMAGE?: string;
  HISTORY_RETENTION_DAYS?: string;
}

export type ImageMode = 'generate' | 'og_first';
export type NoImageBehavior = 'og' | 'text' | 'skip';

/** Parsed, typed configuration. */
export interface Config {
  channelId: string;
  feeds: string[];
  channelTheme: string;
  captionLang: string;
  captionTone: string;
  sourceLabel: string;
  maxAgeHours: number;
  maxPostsPerRun: number;
  maxPostsPerDay: number;
  minScore: number;
  imageMode: ImageMode;
  ogFallbackThreshold: number;
  noImageBehavior: NoImageBehavior;
  dailyNeuronBudget: number;
  textModel: string;
  imageModel: string;
  imageSteps: number;
  historyRetentionDays: number;
  est: {
    rank: number;
    caption: number;
    imagePrompt: number;
    image: number;
  };
}

/** A single news item parsed from a feed. `id` is filled in during dedup. */
export interface FeedItem {
  title: string;
  link: string;
  guid?: string;
  description?: string;
  pubMs?: number;
  id?: string;
}

/** A feed item plus its AI relevance score. */
export interface RankedItem {
  item: FeedItem;
  score: number;
  reason: string;
}

/** Result of trying to obtain an image for a post. */
export type ImageOutcome =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'url'; url: string }
  | { kind: 'none' };

// --- Minimal Telegram webhook update shape (only the fields we read). ---
export interface TelegramUpdate {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  text?: string;
  chat?: { id: number; type?: string };
  from?: { id: number; is_bot?: boolean; first_name?: string };
}
