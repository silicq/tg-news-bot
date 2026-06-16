import { aiRun, runText } from './ai';
import type { BudgetTracker } from './budget';
import type { Config, Env, FeedItem, ImageOutcome } from './types';
import { USER_AGENT, absoluteUrl, base64ToUint8Array, decodeEntities, log, stripTags } from './util';

/**
 * Decide on and obtain an image for a post, honouring IMAGE_MODE and the
 * neuron budget. Spends neurons on the tracker only for AI generation.
 *
 * Strategy:
 *   og_first  -> try og:image (free), else generate (if budget allows).
 *   generate  -> generate (if budget healthy), else fall back to og:image.
 * Returns {kind:'none'} when nothing could be obtained; the caller then
 * applies NO_IMAGE_BEHAVIOR.
 */
export async function acquireImage(
  env: Env,
  cfg: Config,
  item: FeedItem,
  budget: BudgetTracker,
): Promise<ImageOutcome> {
  const canGenerate = () =>
    !budget.isLow() && budget.canAfford(cfg.est.imagePrompt + cfg.est.image);

  const tryGenerate = async (): Promise<Uint8Array | null> => {
    try {
      const prompt = await makeImagePrompt(env, cfg, item);
      budget.spend(cfg.est.imagePrompt); // estimated cost of the prompt call
      const bytes = await generateImage(env, cfg, prompt);
      budget.spend(cfg.est.image); // estimated cost of the image generation
      return bytes;
    } catch (e) {
      log('image generation failed:', String(e));
      return null;
    }
  };

  if (cfg.imageMode === 'og_first') {
    const og = await fetchOgImage(item.link);
    if (og) return { kind: 'url', url: og };
    if (canGenerate()) {
      const bytes = await tryGenerate();
      if (bytes) return { kind: 'bytes', bytes };
    }
    return { kind: 'none' };
  }

  // mode === 'generate'
  if (canGenerate()) {
    const bytes = await tryGenerate();
    if (bytes) return { kind: 'bytes', bytes };
  } else {
    log(`budget low (remaining ${budget.remaining()}), skipping generation`);
  }
  // Fallback: free og:image (works whether budget ran out or generation failed).
  const og = await fetchOgImage(item.link);
  if (og) return { kind: 'url', url: og };

  return { kind: 'none' };
}

/** Turn a headline into a short, concrete English image prompt (no text in image). */
export async function makeImagePrompt(env: Env, cfg: Config, item: FeedItem): Promise<string> {
  const system =
    `You convert a news headline into a short visual prompt for an ` +
    `image-generation model. Describe one concrete photographic or illustrative ` +
    `scene: subject, setting, lighting, style. No text, words, letters, logos or ` +
    `watermarks in the image. One sentence, under 60 words. Output ONLY the prompt.`;
  const user = `Headline: ${item.title}\n\nWrite the image prompt.`;

  const out = await runText(env, cfg.textModel, system, user, {
    maxTokens: 128,
    temperature: 0.6,
  });
  const prompt = stripTags(out).replace(/^["']+|["']+$/g, '').trim() || item.title;
  // Reinforce the no-text constraint regardless of what the model returned.
  return `${prompt}. High quality, detailed, no text, no watermark.`;
}

/**
 * Call the image model and return raw image bytes. Handles both response
 * shapes Workers AI uses:
 *   - flux-1-schnell        -> { image: "<base64>" }
 *   - sdxl-lightning etc.   -> a binary ReadableStream / ArrayBuffer
 */
export async function generateImage(env: Env, cfg: Config, prompt: string): Promise<Uint8Array> {
  const out = await aiRun(env)(cfg.imageModel, { prompt, steps: cfg.imageSteps });

  if (out instanceof ReadableStream) {
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  if (out instanceof ArrayBuffer) {
    return new Uint8Array(out);
  }
  if (out instanceof Uint8Array) {
    return out;
  }
  const image = (out as { image?: unknown } | null)?.image;
  if (typeof image === 'string') {
    return base64ToUint8Array(image);
  }
  throw new Error('Unexpected image model output shape');
}

/**
 * Extract an og:image (or twitter:image) URL from the article page.
 * Free in neurons — used as the budget-friendly fallback.
 */
export async function fetchOgImage(link: string): Promise<string | null> {
  try {
    const res = await fetch(link, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(10_000),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) return null;

    // Only scan the head region — og tags live there and this bounds work.
    const html = (await res.text()).slice(0, 250_000);

    const props = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'];
    for (const prop of props) {
      const tag = findMetaTag(html, prop);
      if (!tag) continue;
      const content = metaContent(tag);
      if (content) {
        const url = absoluteUrl(link, decodeEntities(content));
        if (/^https?:\/\//i.test(url)) return url;
      }
    }
    return null;
  } catch (e) {
    log('og:image fetch failed:', String(e));
    return null;
  }
}

function findMetaTag(html: string, prop: string): string | null {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // property/name can appear before OR after the content attribute.
  const re = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']${esc}["'][^>]*>`, 'i');
  return html.match(re)?.[0] ?? null;
}

function metaContent(tag: string): string | null {
  return /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null;
}
