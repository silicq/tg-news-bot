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
}

/**
 * Build a telegra.ph article with an AI translation of the original story and
 * return its URL, or null on any failure (the post still goes out without it).
 * Spends cfg.est.translate neurons on success.
 */
export async function publishTranslatedArticle(
  env: Env,
  cfg: Config,
  item: FeedItem,
  budget: BudgetTracker,
): Promise<string | null> {
  try {
    const token = await getToken(env, cfg);
    if (!token) return null;

    const html = await fetchHtml(item.link);
    if (!html) return null;

    const { title, blocks } = extractArticle(html, item.link, cfg.articleMaxBlocks);
    const textBlocks = blocks.filter((b) => b.type !== 'img');
    if (textBlocks.length < 2) {
      log('telegraph: not enough article text extracted, skipping article');
      return null;
    }

    // Translate the title + every text block in one ordered pass.
    const source = [title || item.title, ...textBlocks.map((b) => b.text ?? '')];
    const translated = await translateTexts(env, cfg, source);
    budget.spend(cfg.est.translate);

    const translatedTitle = (translated[0] || item.title).slice(0, 256);
    const nodes = buildNodes(blocks, translated.slice(1), item, cfg);

    return await createPage(token, translatedTitle, cfg, nodes);
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

  // Match headings, paragraphs and images in document order.
  const re = /<(h[1-4]|p)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null && blocks.length < maxBlocks) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const text = cleanText(m[2]);
      if (tag === 'p') {
        if (text.length >= 60) blocks.push({ type: 'p', text });
      } else if (text.length >= 3 && text.length <= 140) {
        blocks.push({ type: 'h', text });
      }
    } else {
      const src = imageSrc(m[0]);
      if (src) {
        const abs = absoluteUrl(baseUrl, decodeEntities(src));
        if (isUsableImage(abs) && !seenImages.has(abs)) {
          seenImages.add(abs);
          blocks.push({ type: 'img', src: abs });
        }
      }
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

function buildNodes(blocks: Block[], translations: string[], item: FeedItem, cfg: Config): Node[] {
  const nodes: Node[] = [];
  let t = 0; // index into translations (text blocks only)

  for (const block of blocks) {
    if (block.type === 'img') {
      nodes.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: block.src! } }] });
    } else {
      const text = translations[t++] || block.text || '';
      if (!text) continue;
      nodes.push({ tag: block.type === 'h' ? 'h3' : 'p', children: [text] });
    }
  }

  // Footer: source + how the translation was made + AI-error disclaimer.
  nodes.push({ tag: 'hr' });
  nodes.push({
    tag: 'p',
    children: ['Источник: ', { tag: 'a', attrs: { href: item.link }, children: [hostname(item.link)] }],
  });
  nodes.push({
    tag: 'p',
    children: [
      { tag: 'em', children: [`Перевод выполнен автоматически (нейросеть ${cfg.translateModel}). Возможны неточности и ошибки перевода — сверяйтесь с оригиналом.`] },
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
