import { runText } from './ai';
import type { Config, Env } from './types';
import { log } from './util';

const LANG_NAMES: Record<string, string> = {
  ru: 'Russian',
  en: 'English',
  uk: 'Ukrainian',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
};

// Translate this many text blocks per model call (bounds tokens per request).
const BATCH = 6;
// Hard cap per block so one giant paragraph can't blow up the token budget.
const MAX_BLOCK_CHARS = 900;

/**
 * Translate an ordered list of text blocks into cfg.captionLang. Returns an
 * array the SAME length as the input; any block that fails to translate falls
 * back to its original text (so the article still renders).
 */
export async function translateTexts(env: Env, cfg: Config, texts: string[]): Promise<string[]> {
  const target = LANG_NAMES[cfg.captionLang.toLowerCase()] ?? cfg.captionLang;
  const out: string[] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_BLOCK_CHARS));
    try {
      const translated = await translateBatch(env, cfg, batch, target);
      out.push(...translated);
    } catch (e) {
      log('translate batch failed, keeping original:', String(e));
      out.push(...batch);
    }
  }
  return out;
}

async function translateBatch(
  env: Env,
  cfg: Config,
  batch: string[],
  target: string,
): Promise<string[]> {
  const system =
    `You are a professional native ${target} translator. Translate each numbered ` +
    `news fragment into fluent, grammatically correct, natural ${target} — the way a ` +
    `native journalist would write it, not a word-for-word calque.\n` +
    `Rules:\n` +
    `- Correct grammar, gender and case agreement; smooth awkward literal phrasings.\n` +
    `- Do NOT transliterate letter-by-letter; keep proper nouns/brands in their usual ` +
    `form (translate or keep Latin as appropriate), never mix scripts inside a word.\n` +
    `- Keep the meaning faithful; do not add or drop information or commentary.\n` +
    `- If a fragment is already in ${target}, return it unchanged.\n` +
    `- Keep the exact same numbering and order. Output ONLY the translated numbered list.`;
  const user = batch.map((t, i) => `${i + 1}. ${t}`).join('\n\n');

  const raw = await runText(env, cfg.translateModel, system, user, {
    maxTokens: 1024,
    temperature: 0.2,
  });

  const parsed = parseNumberedList(raw, batch.length);
  // If parsing didn't recover every line, fall back to originals for missing ones.
  return batch.map((orig, i) => parsed[i] ?? orig);
}

/** Parse "1. ...\n2. ..." into a sparse array indexed by (number-1). */
function parseNumberedList(text: string, expected: number): Array<string | undefined> {
  const result: Array<string | undefined> = new Array(expected).fill(undefined);
  // Split on a line that starts with "<n>." — keep multi-line fragments intact.
  const re = /(?:^|\n)\s*(\d{1,2})[.)]\s*([\s\S]*?)(?=\n\s*\d{1,2}[.)]\s|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]) - 1;
    const value = m[2].trim();
    if (idx >= 0 && idx < expected && value) result[idx] = value;
  }
  return result;
}
