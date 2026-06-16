import type { Config, FeedItem } from './types';
import {
  USER_AGENT,
  absoluteUrl,
  allBlocks,
  cleanText,
  decodeEntities,
  firstTag,
  logErr,
} from './util';

/**
 * Fetch every configured feed (in parallel, failure-isolated), parse RSS/Atom,
 * filter by age, and de-duplicate by link within the batch.
 */
export async function fetchAllFeeds(cfg: Config): Promise<FeedItem[]> {
  const cutoff = Date.now() - cfg.maxAgeHours * 3600_000;

  const settled = await Promise.allSettled(cfg.feeds.map((url) => fetchOneFeed(url)));

  const all: FeedItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      all.push(...r.value);
    } else {
      logErr('feed failed:', cfg.feeds[i], String(r.reason));
    }
  });

  // Keep items newer than the cutoff. Items with an unknown date are kept
  // (dedup in D1 prevents reposting them on later runs).
  const fresh = all.filter((it) => (it.pubMs ?? Date.now()) >= cutoff);

  // De-dup by link inside this batch.
  const seen = new Set<string>();
  const unique = fresh.filter((it) => {
    if (seen.has(it.link)) return false;
    seen.add(it.link);
    return true;
  });

  // Newest first so downstream "take top N" prefers recent news on ties.
  unique.sort((a, b) => (b.pubMs ?? 0) - (a.pubMs ?? 0));
  return unique;
}

async function fetchOneFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const xml = await res.text();
  return parseFeed(xml, url);
}

/** Parse an RSS 2.0 or Atom document into feed items. Tolerant of malformed XML. */
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = isAtom ? allBlocks(xml, 'entry') : allBlocks(xml, 'item');

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = cleanText(firstTag(block, 'title'));

    let link = cleanText(firstTag(block, 'link'));
    if (!link || /^https?:\/\//i.test(link) === false) {
      const atom = atomLink(block);
      if (atom) link = atom;
    }
    if (link) link = absoluteUrl(feedUrl, decodeEntities(link));

    const guid =
      cleanText(firstTag(block, 'guid')) || cleanText(firstTag(block, 'id')) || '';

    const dateStr =
      firstTag(block, 'pubDate') ||
      firstTag(block, 'published') ||
      firstTag(block, 'updated') ||
      firstTag(block, 'dc:date') ||
      firstTag(block, 'date');
    const parsed = dateStr ? Date.parse(decodeEntities(dateStr).trim()) : NaN;

    const description = cleanText(
      firstTag(block, 'description') ||
        firstTag(block, 'summary') ||
        firstTag(block, 'content') ||
        '',
    );

    if (!title || !link || !/^https?:\/\//i.test(link)) continue;

    items.push({
      title,
      link,
      guid: guid || undefined,
      description: description || undefined,
      pubMs: Number.isNaN(parsed) ? undefined : parsed,
    });
  }
  return items;
}

/** Pick the best href from Atom <link .../> elements (prefer rel="alternate"). */
function atomLink(block: string): string | null {
  const links = block.match(/<link\b[^>]*>/gi) ?? [];
  let alternate: string | null = null;
  let first: string | null = null;
  for (const l of links) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(l)?.[1];
    if (!href) continue;
    const rel = (/rel\s*=\s*["']([^"']+)["']/i.exec(l)?.[1] ?? 'alternate').toLowerCase();
    if (rel === 'self') continue;
    if (!first) first = href;
    if (rel === 'alternate' && !alternate) alternate = href;
  }
  return alternate ?? first;
}
