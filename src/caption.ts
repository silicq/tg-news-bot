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
    `You write short, catchy captions for a Telegram channel in ${lang} ` +
    `(language code "${cfg.captionLang}").\n` +
    `Tone: ${cfg.captionTone}.\n` +
    `Rules:\n` +
    `- 2 to 4 sentences maximum.\n` +
    `- Use your OWN words. Do NOT copy or closely paraphrase sentences from the source.\n` +
    `- No clickbait lies, no ALL CAPS.\n` +
    `- At most 1-2 relevant emoji.\n` +
    `- Do NOT include any links, URLs or "read more".\n` +
    `- Output ONLY the caption text, nothing else.`;

  const summary = item.description
    ? `\nContext (do not copy): ${truncate(stripTags(item.description), 600)}`
    : '';
  const user = `Headline: ${item.title}${summary}\n\nWrite the caption now.`;

  const out = await runText(env, cfg.textModel, system, user, {
    maxTokens: 256,
    temperature: 0.75,
  });

  const body = stripTags(out).replace(/^["'<>]+|["'<>]+$/g, '').trim();
  return body || item.title;
}

/**
 * Assemble the final HTML caption: escaped body + a clickable source link,
 * trimmed to Telegram's 1024-char limit. We measure the raw string (tags
 * included), which is stricter than Telegram's count — safe on the short side.
 */
export function buildCaption(body: string, link: string, cfg: Config): string {
  const footer = buildFooter(link, cfg);
  const room = TELEGRAM_CAPTION_LIMIT - footer.length;
  const safeBody = truncate(escapeHtml(body), Math.max(0, room));
  return safeBody + footer;
}

/** Footer: clickable source link + the channel credit (@monkeydiary). */
function buildFooter(link: string, cfg: Config): string {
  const source = `🔗 <a href="${escapeHtml(link)}">${escapeHtml(cfg.sourceLabel)}</a>`;
  const credit = cfg.creditText
    ? ` · <a href="${escapeHtml(cfg.creditUrl)}">${escapeHtml(cfg.creditText)}</a>`
    : '';
  return `\n\n${source}${credit}`;
}

/** Plain-text-with-link message body for the no-photo fallback (sendMessage). */
export function buildMessage(body: string, link: string, cfg: Config): string {
  // sendMessage allows 4096 chars, so the same builder fits comfortably.
  return buildCaption(body, link, cfg);
}
