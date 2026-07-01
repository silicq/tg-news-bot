// Small dependency-free helpers shared across modules.

export const USER_AGENT =
  'Mozilla/5.0 (compatible; tg-news-bot/1.0; +https://workers.cloudflare.com)';

export function log(...args: unknown[]): void {
  console.log('[bot]', ...args);
}

export function logErr(...args: unknown[]): void {
  console.error('[bot]', ...args);
}

/** Current UTC day as 'YYYY-MM-DD' (used as the budget bucket key). */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Hex sha-256 of a string. Used to build stable dedup keys. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a base64 string (e.g. flux image output) to raw bytes. */
export function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Decode XML/HTML entities and unwrap CDATA. */
export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // must come last
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** Escape text for Telegram HTML parse_mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip HTML/XML tags and collapse whitespace. */
export function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Inline tags Telegram accepts in captions/messages (we normalize synonyms).
const TG_TAGS: Record<string, string> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', del: 's',
  strike: 's', 'tg-spoiler': 'tg-spoiler', code: 'code',
};

/**
 * Sanitize model output into safe Telegram HTML: keep only the allowed inline
 * tags (attributes dropped), escape everything else, and guarantee the result
 * is balanced (stray closers dropped, open tags auto-closed) so Telegram never
 * rejects the message. Also converts **markdown bold** the model may emit.
 */
export function sanitizeTelegramHtml(input: string): string {
  const md = input.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const re = /<(\/?)([a-z0-9-]+)(?:\s[^>]*)?>/gi;
  const stack: string[] = [];
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    out += escapeHtml(md.slice(last, m.index));
    last = re.lastIndex;
    const tag = TG_TAGS[m[2].toLowerCase()];
    if (!tag) continue; // drop disallowed tags entirely
    if (m[1] === '/') {
      if (stack[stack.length - 1] === tag) {
        out += `</${tag}>`;
        stack.pop();
      }
    } else {
      out += `<${tag}>`;
      stack.push(tag);
    }
  }
  out += escapeHtml(md.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out.trim();
}

/** Clean a raw XML field: unwrap CDATA, decode entities, strip tags, trim. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return '';
  return stripTags(decodeEntities(s)).trim();
}

/** Truncate to `max` characters, adding an ellipsis if cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/** Resolve a possibly-relative URL against a base. */
export function absoluteUrl(base: string, url: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

// --- Tolerant XML helpers (regex-based; Workers has no DOM XML parser). ---

/** Inner content of the first <tag>...</tag> in `block`. */
export function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeTag(tag)}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}

/** Inner content of every <tag>...</tag> in `xml`. */
export function allBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeTag(tag)}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
