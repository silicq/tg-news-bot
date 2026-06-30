// Shared types for the worker.

/** Runtime bindings + configuration variables (raw strings from wrangler). */
export interface Env {
  // Bindings
  DB: D1Database;
  AI: Ai;
  // Cloudflare Images binding (optional). Used to overlay the watermark
  // off-Worker (the Free plan's 10ms CPU budget can't do pixel compositing).
  IMAGES?: unknown;

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
  CREDIT_TEXT?: string;
  CREDIT_URL?: string;
  MAX_AGE_HOURS?: string;
  MAX_POSTS_PER_RUN?: string;
  MAX_POSTS_PER_DAY?: string;
  MIN_SCORE?: string;
  TOPIC_DEDUP?: string;
  SIMILARITY_THRESHOLD?: string;
  QUIET_START_HOUR?: string;
  QUIET_END_HOUR?: string;
  TZ_OFFSET_HOURS?: string;
  HEALTH_ALERTS?: string;
  HEALTH_EMPTY_STREAK?: string;
  HEALTH_COOLDOWN_HOURS?: string;
  IMAGE_MODE?: string;
  OG_FALLBACK_NEURON_THRESHOLD?: string;
  NO_IMAGE_BEHAVIOR?: string;
  DAILY_NEURON_BUDGET?: string;
  TEXT_MODEL?: string;
  TRANSLATE_MODEL?: string;
  IMAGE_MODEL?: string;
  IMAGE_MODEL_FALLBACK?: string;
  IMAGE_STEPS?: string;
  IMAGE_STEPS_FALLBACK?: string;
  IMAGE_WIDTH?: string;
  IMAGE_HEIGHT?: string;
  WATERMARK_ENABLED?: string;
  WATERMARK_OPACITY?: string;
  WATERMARK_PADDING?: string;
  TELEGRAPH_ENABLED?: string;
  TELEGRAPH_AUTHOR_NAME?: string;
  TELEGRAPH_AUTHOR_URL?: string;
  ARTICLE_MAX_BLOCKS?: string;
  ARTICLE_READ_LABEL?: string;
  BUTTONS_ENABLED?: string;
  EST_NEURONS_RANK?: string;
  EST_NEURONS_CAPTION?: string;
  EST_NEURONS_IMAGE_PROMPT?: string;
  EST_NEURONS_IMAGE?: string;
  EST_NEURONS_IMAGE_FALLBACK?: string;
  EST_NEURONS_TRANSLATE?: string;
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
  creditText: string;
  creditUrl: string;
  maxAgeHours: number;
  maxPostsPerRun: number;
  maxPostsPerDay: number;
  minScore: number;
  topicDedup: boolean;
  similarityThreshold: number;
  quietStartHour: number;
  quietEndHour: number;
  tzOffsetHours: number;
  healthAlerts: boolean;
  healthEmptyStreak: number;
  healthCooldownHours: number;
  imageMode: ImageMode;
  ogFallbackThreshold: number;
  noImageBehavior: NoImageBehavior;
  dailyNeuronBudget: number;
  textModel: string;
  translateModel: string;
  imageModel: string;
  imageModelFallback: string;
  imageSteps: number;
  imageStepsFallback: number;
  imageWidth: number;
  imageHeight: number;
  watermarkEnabled: boolean;
  watermarkOpacity: number;
  watermarkPadding: number;
  telegraphEnabled: boolean;
  telegraphAuthorName: string;
  telegraphAuthorUrl: string;
  articleMaxBlocks: number;
  articleReadLabel: string;
  buttonsEnabled: boolean;
  historyRetentionDays: number;
  est: {
    rank: number;
    caption: number;
    imagePrompt: number;
    image: number;
    imageFallback: number;
    translate: number;
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
