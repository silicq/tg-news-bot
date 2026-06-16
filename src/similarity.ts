// Lightweight, neuron-free near-duplicate detection for headlines.
// The same story often appears across several feeds with different wording;
// hash dedup (guid/link) can't catch that, so we compare title word-sets.

import type { FeedItem } from './types';

// Small bilingual stop-word list so common words don't inflate similarity.
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
  'was', 'has', 'have', 'how', 'why', 'what', 'who', 'new', 'into', 'out',
  'about', 'over', 'after', 'before', 'their', 'they', 'its', 'can', 'will',
  'more', 'most', 'than', 'then', 'but', 'not', 'all', 'one', 'two',
  // Russian
  'и', 'в', 'во', 'не', 'на', 'что', 'как', 'это', 'для', 'или', 'но', 'из',
  'по', 'за', 'от', 'до', 'со', 'же', 'бы', 'то', 'так', 'уже', 'был', 'была',
  'эти', 'его', 'ее', 'их', 'про', 'при',
]);

/** Normalize a headline into a set of significant lowercase word tokens. */
export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Count tokens of `a` that have a match in `b`. A match is an exact token or a
 * prefix relationship (min length 4) — so "australia"≈"australian" and
 * "coast"≈"coastline". News headlines reword the same story heavily, so this
 * prefix-aware overlap separates "same story" from "different story" far better
 * than plain Jaccard.
 */
function matchCount(a: Set<string>, b: Set<string>): number {
  let matched = 0;
  for (const x of a) {
    for (const y of b) {
      if (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))) {
        matched++;
        break;
      }
    }
  }
  return matched;
}

/** True when two headlines are about the same story (overlap-coefficient based). */
export function isSimilar(a: Set<string>, b: Set<string>, threshold: number): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const minSize = Math.min(a.size, b.size);
  const matched = matchCount(a, b);
  const overlap = matched / minSize;
  // Require a few shared significant words too, so short headlines that share
  // one generic word aren't merged.
  const minMatch = Math.min(3, minSize);
  return matched >= minMatch && overlap >= threshold;
}

/**
 * Drop near-duplicate items within a batch, keeping the first occurrence
 * (callers pass items newest-first, so the freshest copy is kept).
 */
export function dedupeByTopic(items: FeedItem[], threshold: number): FeedItem[] {
  const kept: Array<{ item: FeedItem; tokens: Set<string> }> = [];
  for (const item of items) {
    const tokens = titleTokens(item.title);
    const dup = kept.some((k) => isSimilar(tokens, k.tokens, threshold));
    if (!dup) kept.push({ item, tokens });
  }
  return kept.map((k) => k.item);
}

/** Remove items whose topic matches any recently posted title. */
export function dropSimilarToRecent(
  items: FeedItem[],
  recentTitles: string[],
  threshold: number,
): FeedItem[] {
  const recent = recentTitles.map(titleTokens);
  return items.filter((item) => {
    const tokens = titleTokens(item.title);
    return !recent.some((rt) => isSimilar(tokens, rt, threshold));
  });
}
