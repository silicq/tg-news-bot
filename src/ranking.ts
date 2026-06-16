import { extractJsonArray, runText } from './ai';
import type { Config, Env, FeedItem, RankedItem } from './types';
import { log } from './util';

// Cap how many headlines we feed the model in one batch call (bounds tokens).
const MAX_CANDIDATES = 40;

export interface RankResult {
  /** All scored candidates, sorted by score descending (NOT yet filtered). */
  ranked: RankedItem[];
  /** True when AI ranking failed and we fell back to recency order. */
  fallback: boolean;
}

/**
 * Score all candidate headlines in a SINGLE batched AI call (to save neurons),
 * then return them sorted by score. The caller applies cfg.minScore so it can
 * also count how many were rejected.
 *
 * If the model output can't be parsed at all, we degrade gracefully: items are
 * returned in recency order with a neutral score and `fallback: true`.
 */
export async function rankItems(
  env: Env,
  cfg: Config,
  items: FeedItem[],
): Promise<RankResult> {
  const candidates = items.slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return { ranked: [], fallback: false };

  const numbered = candidates.map((it, i) => `${i}. ${it.title}`).join('\n');

  const system =
    `You are the editor of a Telegram channel.\n` +
    `Channel theme and audience: ${cfg.channelTheme}\n\n` +
    `For each numbered headline, rate from 0 to 100 how well it fits this ` +
    `channel and how engaging it is for that audience. Penalize anything the ` +
    `theme says to exclude.\n` +
    `Return ONLY a JSON array, no markdown, no code fences, no commentary:\n` +
    `[{"index": <number>, "score": <0-100>, "reason": "<short>"}]`;

  const user = `Headlines:\n${numbered}\n\nReturn the JSON array now.`;

  let raw = '';
  try {
    raw = await runText(env, cfg.textModel, system, user, {
      maxTokens: Math.min(2048, 256 + candidates.length * 40),
      temperature: 0.2,
    });
  } catch (e) {
    log('ranking AI call failed, using recency fallback:', String(e));
    return { ranked: fallbackRanking(candidates), fallback: true };
  }

  const parsed = extractJsonArray(raw);
  if (!parsed) {
    log('ranking: could not parse JSON, using recency fallback');
    return { ranked: fallbackRanking(candidates), fallback: true };
  }

  const ranked: RankedItem[] = [];
  for (const entry of parsed) {
    const e = entry as { index?: unknown; score?: unknown; reason?: unknown };
    const idx = Number(e.index);
    const score = Number(e.score);
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
    ranked.push({
      item: candidates[idx],
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
      reason: typeof e.reason === 'string' ? e.reason : '',
    });
  }

  if (ranked.length === 0) {
    return { ranked: fallbackRanking(candidates), fallback: true };
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, fallback: false };
}

function fallbackRanking(items: FeedItem[]): RankedItem[] {
  // Items already arrive newest-first; give them a neutral passing score.
  return items.map((item) => ({ item, score: 50, reason: 'fallback (no AI ranking)' }));
}
