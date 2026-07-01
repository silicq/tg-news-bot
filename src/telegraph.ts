import type { BudgetTracker } from './budget';
import { getState, setState } from './state';
import { translateTexts } from './translate';
import type { Config, Env, FeedItem } from './types';
import { USER_AGENT, absoluteUrl, cleanText, decodeEntities, log } from './util';

const API = 'https://api.telegra.ph';
const STATE_TOKEN_KEY = 'telegraph_token';

// Telegra.ph content node (subset we emit).
type Node = string | { tag: string; attrs?: Record<string, string>; children?: Node[] };

interface Block {
  type: 'p' | 'h' | 'img';
  text?: string;
  src?: string;
  caption?: string;
}

// End-of-article boundaries: once one of these is hit, stop collecting — the
// rest is author bio, "you may also like", comment forms, newsletter and
// footer boilerplate (anchored at the start to avoid matching mid-paragraph).
const START_BOUNDARY =
  /^\s*(you (may|might) also|related\b|more (from|stories)|explore (more|topics)|discover more|browse\b|recommended|most popular|trending|leave a (reply|comment)|post a comment|comments?\b|choose your news|about the author|read more\b|get the latest|sign up for|subscribe|follow us|share (this|on)|tags?:|filed under|continue reading|advertisement|newsletter|join our)/i;
const STRONG_FOOTER =
  /(powered by salesforce|terms (&|and) conditions|privacy (notice|policy)|all rights reserved|©\s*\d{4})/i;
// "X is a/an [adjectives] writer/journalist/..." — the author bio at the end.
const AUTHOR_BIO =
  /\bis an?\b[a-z\s,'’-]{0,40}\b(writer|journalist|reporter|freelance|photographer|editor|contributor|correspondent|author|columnist|blogger)\b/i;

function isArticleEnd(text: string): boolean {
  return STRONG_FOOTER.test(text) || START_BOUNDARY.test(text) || AUTHOR_BIO.test(text);
}

/**
 * Build a telegra.ph article with an AI translation of the original story and
 * return its URL, or null on any failure (the post still goes out without it).
 * Spends cfg.est.translate neurons on success.
 */
export interface ArticleResult {
  url: string;
  images: string[]; // original article image URLs (for albums)
}

export async function publishTranslatedArticle(
  env: Env,
  cfg: Config,
  item: FeedItem,
  budget: BudgetTracker,
): Promise<ArticleResult | null> {
  try {
    const token = await getToken(env, cfg);
    if (!token) return null;

    const html = await fetchHtml(item.link);
    if (!html) return null;

    const { title, blocks } = extractArticle(html, item.link, cfg.articleMaxBlocks);
    const textBlocks = blocks.filter((b) => b.type !== 'img');
    if (textBlocks.length < 4) {
      // Too thin to be a worthwhile article (e.g. a stub/announcement page).
      log('telegraph: not enough article text extracted, skipping article');
      return null;
    }

    // Build the ordered list of strings to translate: title, then each block's
    // text (paragraphs/headings) or image caption — in document order.
    const toTranslate: string[] = [title || item.title];
    for (const b of blocks) {
      if (b.type === 'img') {
        if (b.caption) toTranslate.push(b.caption);
      } else {
        toTranslate.push(b.text ?? '');
      }
    }

    const translated = await translateTexts(env, cfg, toTranslate);
    budget.spend(cfg.est.translate);

    const translatedTitle = (translated[0] || item.title).slice(0, 256);
    const nodes = buildNodes(blocks, translated, item, cfg);

    const url = await createPage(token, translatedTitle, cfg, nodes);
    if (!url) return null;
    const images = blocks.filter((b) => b.type === 'img' && b.src).map((b) => b.src!);
    return { url, images };
  } catch (e) {
    log('telegraph article failed:', String(e));
    return null;
  }
}

// --- Token (created once, stored in D1 `state`) ---

async function getToken(env: Env, cfg: Config): Promise<string | null> {
  const existing = await getState(env.DB, STATE_TOKEN_KEY);
  if (existing) return existing;
  try {
    const res = await fetch(
      `${API}/createAccount?short_name=${encodeURIComponent('monkeydiary')}` +
        `&author_name=${encodeURIComponent(cfg.telegraphAuthorName)}` +
        `&author_url=${encodeURIComponent(cfg.telegraphAuthorUrl)}`,
    );
    const data = (await res.json()) as { ok?: boolean; result?: { access_token?: string } };
    const token = data.result?.access_token;
    if (data.ok && token) {
      await setState(env.DB, STATE_TOKEN_KEY, token);
      return token;
    }
  } catch (e) {
    log('telegraph createAccount failed:', String(e));
  }
  return null;
}

// --- Article extraction (heuristic, bounded for the 10ms CPU budget) ---

function fetchArticleRegion(html: string): string {
  // Prefer the <article> region; otherwise use a bounded slice of the body.
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article && article[1].length > 400) return article[1].slice(0, 200_000);
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (body ? body[1] : html).slice(0, 200_000);
}

export function extractArticle(
  html: string,
  baseUrl: string,
  maxBlocks: number,
): { title: string; blocks: Block[] } {
  const title =
    cleanText(/<meta[^>]+property=["']og:title["'][^>]*>/i.exec(html)?.[0]?.match(/content=["']([^"']*)["']/i)?.[1]) ||
    cleanText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]) ||
    cleanText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);

  const region = fetchArticleRegion(html);
  const blocks: Block[] = [];
  const seenImages = new Set<string>();
  let paragraphs = 0;

  const pushImage = (rawSrc: string | null, caption?: string): void => {
    if (!rawSrc) return;
    const abs = absoluteUrl(baseUrl, decodeEntities(rawSrc));
    if (isUsableImage(abs) && !seenImages.has(abs)) {
      seenImages.add(abs);
      blocks.push({ type: 'img', src: abs, caption: caption || undefined });
    }
  };

  // Match <figure> (image + caption), headings, paragraphs and bare images,
  // all in document order.
  const re = /<figure\b[^>]*>([\s\S]*?)<\/figure>|<(h[1-4]|p)\b[^>]*>([\s\S]*?)<\/\2>|<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null && blocks.length < maxBlocks) {
    if (m[1] !== undefined) {
      // <figure>: pull the image and its caption.
      const caption = cleanText(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(m[1])?.[1]);
      pushImage(imageSrc(m[1]), caption.length <= 300 ? caption : '');
    } else if (m[2] !== undefined) {
      const tag = m[2].toLowerCase();
      const text = cleanText(m[3]);
      // Stop at end-of-article boilerplate (only once we're past the intro).
      if (paragraphs >= 2 && isArticleEnd(text)) {
        // Drop trailing junk images (author headshot, related thumbnails) that
        // were collected just before the boundary — they have no caption.
        while (blocks.length && blocks[blocks.length - 1].type === 'img' && !blocks[blocks.length - 1].caption) {
          blocks.pop();
        }
        break;
      }
      if (tag === 'p') {
        if (text.length >= 60) {
          blocks.push({ type: 'p', text });
          paragraphs++;
        }
      } else if (text.length >= 3 && text.length <= 140) {
        blocks.push({ type: 'h', text });
      }
    } else {
      pushImage(imageSrc(m[0]));
    }
  }
  return { title, blocks };
}

function imageSrc(tag: string): string | null {
  return (
    /\b(?:data-src|data-original|src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? null
  );
}

function isUsableImage(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return !/(\.svg|data:|sprite|logo|icon|avatar|pixel|spacer|1x1|tracking|blank|newsletter|signup|sign-up|leaderboard|banner|advert|promo|subscribe|donate|footer|header|widget|placeholder|gravatar|emoji)/i.test(url);
}

// --- Telegraph node tree ---

function buildNodes(blocks: Block[], translated: string[], item: FeedItem, cfg: Config): Node[] {
  const nodes: Node[] = [];
  let t = 1; // translated[0] is the title; block strings follow in order

  for (const block of blocks) {
    if (block.type === 'img') {
      const children: Node[] = [{ tag: 'img', attrs: { src: block.src! } }];
      if (block.caption) {
        const cap = translated[t++] || block.caption;
        children.push({ tag: 'figcaption', children: [cap] });
      }
      nodes.push({ tag: 'figure', children });
    } else {
      const text = translated[t++] || block.text || '';
      if (!text) continue;
      nodes.push({ tag: block.type === 'h' ? 'h3' : 'p', children: [text] });
    }
  }

  // Footer: source + how it was translated (no model name) + AI-error disclaimer.
  nodes.push({ tag: 'hr' });
  nodes.push({
    tag: 'p',
    children: ['Источник: ', { tag: 'a', attrs: { href: item.link }, children: [hostname(item.link)] }],
  });
  nodes.push({
    tag: 'p',
    children: [
      { tag: 'em', children: ['Перевод выполнен автоматически нейросетью — возможны неточности и ошибки, сверяйтесь с оригиналом.'] },
    ],
  });
  nodes.push({
    tag: 'p',
    children: ['Канал: ', { tag: 'a', attrs: { href: cfg.telegraphAuthorUrl }, children: [cfg.telegraphAuthorName] }],
  });
  return nodes;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'оригинал';
  }
}

// --- Telegraph API ---

async function createPage(token: string, title: string, cfg: Config, content: Node[]): Promise<string | null> {
  const body = new URLSearchParams({
    access_token: token,
    title: title.slice(0, 256) || 'Новость',
    author_name: cfg.telegraphAuthorName.slice(0, 128),
    author_url: cfg.telegraphAuthorUrl.slice(0, 512),
    content: JSON.stringify(content),
    return_content: 'false',
  });
  const res = await fetch(`${API}/createPage`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as { ok?: boolean; result?: { url?: string }; error?: string };
  if (!data.ok || !data.result?.url) {
    throw new Error(`createPage: ${data.error ?? 'unknown error'}`);
  }
  return data.result.url;
}

async function fetchHtml(link: string): Promise<string | null> {
  try {
    const res = await fetch(link, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(10_000),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) return null;
    return await res.text();
  } catch (e) {
    log('telegraph: failed to fetch article html:', String(e));
    return null;
  }
}
