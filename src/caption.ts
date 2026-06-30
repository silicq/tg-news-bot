import { runText } from './ai';
import type { Config, Env, FeedItem } from './types';
import { escapeHtml, stripTags, truncate } from './util';

// Telegram hard limit for a photo caption.
const TELEGRAM_CAPTION_LIMIT = 1024;

const LANG_NAMES: Record<string, string> = {
  ru: 'Russian',
  en: 'English',
  uk: 'Ukrainian',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
};

function languageName(code: string): string {
  return LANG_NAMES[code.toLowerCase()] ?? code;
}

/**
 * Write a short, original caption in the configured language and tone.
 * Importantly, it must NOT copy sentences from the source (copyright).
 * Returns the caption BODY only (no link) — the link is appended by buildCaption.
 */
export async function makeCaption(env: Env, cfg: Config, item: FeedItem): Promise<string> {
  const lang = languageName(cfg.captionLang);
  const system =
    `You write punchy captions for a Telegram news channel in ${lang} ` +
    `(language code "${cfg.captionLang}"). Tone: ${cfg.captionTone}.\n\n` +
    `Write ONE caption of 2-3 sentences that makes the reader want to know more ` +
    `AND already gives them something concrete.\n` +
    `Rules:\n` +
    `- Lead with the single most surprising or specific fact: a number, a name, ` +
    `a place, an unexpected detail. Concreteness over vague praise.\n` +
    `- Deliver the gist so it's interesting even without opening the link, but ` +
    `leave a little intrigue (hint at the "how/why", don't retell everything).\n` +
    `- NEVER write empty filler like "amazing discovery", "stunning artwork", ` +
    `"scientists found something" without saying WHAT exactly and WHY it matters.\n` +
    `- Your OWN words; do not copy sentences from the source. No clickbait lies, no ALL CAPS.\n` +
    `- Exactly one fitting emoji at the end. No hashtags, no links, no "read more".\n` +
    `- Output ONLY the caption text.\n\n` +
    `BAD (vague, no specifics): "В Риме открыли потрясающие фрески этрусков. ` +
    `Они рассказывают об эпических битвах. 🏯"\n` +
    `GOOD (concrete + hook): "Италия выкупила за миллионы и впервые показала ` +
    `публике этрусские фрески возрастом ~2500 лет — на них сцены поединков, ` +
    `почти не сохранившиеся в античном искусстве. Откуда они взялись — отдельная ` +
    `детективная история. 🏛️"`;

  const summary = item.description
    ? `\nDetails to mine for specifics (do not copy wording): ${truncate(stripTags(item.description), 900)}`
    : '';
  const user = `Headline: ${item.title}${summary}\n\nWrite the caption now.`;

  const out = await runText(env, cfg.textModel, system, user, {
    maxTokens: 256,
    temperature: 0.7,
  });

  const body = stripTags(out).replace(/^["'<>]+|["'<>]+$/g, '').trim();
  return body || item.title;
}

/**
 * Assemble the final HTML caption: escaped body + a clickable source link,
 * trimmed to Telegram's 1024-char limit. We measure the raw string (tags
 * included), which is stricter than Telegram's count — safe on the short side.
 */
export function buildCaption(body: string, link: string, cfg: Config, articleUrl?: string | null): string {
  const footer = buildFooter(link, cfg, articleUrl);
  const room = TELEGRAM_CAPTION_LIMIT - footer.length;
  const safeBody = truncate(escapeHtml(body), Math.max(0, room));
  return safeBody + footer;
}

/** Footer: source link + optional "read translation" link + channel credit. */
function buildFooter(link: string, cfg: Config, articleUrl?: string | null): string {
  const parts = [`🔗 <a href="${escapeHtml(link)}">${escapeHtml(cfg.sourceLabel)}</a>`];
  if (articleUrl) {
    parts.push(`<a href="${escapeHtml(articleUrl)}">${escapeHtml(cfg.articleReadLabel)}</a>`);
  }
  if (cfg.creditText) {
    parts.push(`<a href="${escapeHtml(cfg.creditUrl)}">${escapeHtml(cfg.creditText)}</a>`);
  }
  return `\n\n${parts.join(' · ')}`;
}

/** Plain-text-with-link message body for the no-photo fallback (sendMessage). */
export function buildMessage(body: string, link: string, cfg: Config, articleUrl?: string | null): string {
  // sendMessage allows 4096 chars, so the same builder fits comfortably.
  return buildCaption(body, link, cfg, articleUrl);
}

/** Caption with NO footer links — used when links live in inline buttons instead. */
export function buildBody(body: string): string {
  return truncate(escapeHtml(body), TELEGRAM_CAPTION_LIMIT);
}

export interface InlineButton {
  text: string;
  url: string;
}

/** Inline keyboard: [📖 Перевод] [🔗 Источник] (translation button only if present). */
export function buildButtons(link: string, cfg: Config, articleUrl?: string | null): InlineButton[][] {
  const row: InlineButton[] = [];
  if (articleUrl) row.push({ text: cfg.articleReadLabel, url: articleUrl });
  row.push({ text: `🔗 ${cfg.sourceLabel}`, url: link });
  return [row];
}
