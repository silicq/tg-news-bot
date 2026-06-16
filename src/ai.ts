import type { Env } from './types';

/**
 * The Workers AI binding's `run` overloads are keyed by model id and change
 * between `@cloudflare/workers-types` versions. We call models dynamically by
 * string, so we treat the binding as a loose callable here. This is the single
 * place where that cast lives.
 */
type AiRun = (model: string, inputs: unknown, options?: unknown) => Promise<unknown>;

export function aiRun(env: Env): AiRun {
  return (env.AI as unknown as { run: AiRun }).run.bind(env.AI);
}

interface TextOpts {
  maxTokens?: number;
  temperature?: number;
}

/**
 * Run a Workers AI text model with a system + user message and return the
 * plain text response. Throws on failure so callers can decide how to degrade.
 */
export async function runText(
  env: Env,
  model: string,
  system: string,
  user: string,
  opts: TextOpts = {},
): Promise<string> {
  const res = await aiRun(env)(model, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.7,
  });

  const text =
    typeof res === 'string'
      ? res
      : ((res as { response?: unknown } | null)?.response ?? '');
  return String(text).trim();
}

/**
 * Best-effort extraction of a JSON array from a model response.
 * Strips ```json fences and grabs the outermost [ ... ] span.
 */
export function extractJsonArray(text: string): unknown[] | null {
  let t = text.trim();
  t = t
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;

  const slice = t.slice(start, end + 1);
  try {
    const v = JSON.parse(slice);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
