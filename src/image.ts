import { aiRun, runText } from './ai';
import type { BudgetTracker } from './budget';
import type { Config, Env, FeedItem, ImageOutcome } from './types';
import {
  USER_AGENT,
  absoluteUrl,
  base64ToUint8Array,
  decodeEntities,
  log,
  stripTags,
} from './util';
import { WATERMARK_PNG_BASE64 } from './watermark-asset';

/**
 * Decide on and obtain an image for a post, honouring IMAGE_MODE and the
 * neuron budget. Spends neurons on the tracker only for AI generation.
 *
 * Chain (mode "generate"):
 *   primary model (flux, costs neurons)  →  free fallback model (SDXL, 0 cost)
 *   →  og:image (free)  →  none
 * The free fallback keeps the AI-generated look once the budget runs low, so
 * the channel can keep posting generated art well past the neuron budget.
 */
export async function acquireImage(
  env: Env,
  cfg: Config,
  item: FeedItem,
  budget: BudgetTracker,
): Promise<ImageOutcome> {
  // Build the visual prompt at most once per item (saves a text call).
  let promptCache: string | null = null;
  const getPrompt = async (): Promise<string> => {
    if (promptCache !== null) return promptCache;
    if (budget.canAfford(cfg.est.imagePrompt)) {
      try {
        promptCache = await makeImagePrompt(env, cfg, item);
        budget.spend(cfg.est.imagePrompt);
        return promptCache;
      } catch (e) {
        log('image prompt failed, using headline:', String(e));
      }
    }
    promptCache = fallbackPrompt(item);
    return promptCache;
  };

  const generate = async (model: string, neuronCost: number): Promise<Uint8Array | null> => {
    try {
      const prompt = await getPrompt();
      const bytes = await generateImage(env, cfg, model, prompt);
      budget.spend(neuronCost);
      return bytes;
    } catch (e) {
      log(`generation failed (${model}):`, String(e));
      return null;
    }
  };

  const tryFallbackModel = (): Promise<Uint8Array | null> =>
    cfg.imageModelFallback ? generate(cfg.imageModelFallback, cfg.est.imageFallback) : Promise.resolve(null);

  const canPrimary = (): boolean =>
    !budget.isLow() && budget.canAfford(cfg.est.imagePrompt + cfg.est.image);

  if (cfg.imageMode === 'og_first') {
    const og = await fetchOgImage(item.link);
    if (og) return { kind: 'url', url: og };
    if (canPrimary()) {
      const b = await generate(cfg.imageModel, cfg.est.image);
      if (b) return { kind: 'bytes', bytes: b };
    }
    const fb = await tryFallbackModel();
    if (fb) return { kind: 'bytes', bytes: fb };
    return { kind: 'none' };
  }

  // mode === 'generate'
  if (canPrimary()) {
    const b = await generate(cfg.imageModel, cfg.est.image);
    if (b) return { kind: 'bytes', bytes: b };
  } else {
    log(`budget low (remaining ${budget.remaining()}); switching to free fallback model`);
  }
  const fb = await tryFallbackModel();
  if (fb) return { kind: 'bytes', bytes: fb };

  const og = await fetchOgImage(item.link);
  if (og) return { kind: 'url', url: og };

  return { kind: 'none' };
}

function fallbackPrompt(item: FeedItem): string {
  return `${item.title}. High quality, detailed illustration, no text, no watermark.`;
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
  return `${prompt}. High quality, detailed, no text, no watermark.`;
}

/** Per-model input shape (schemas differ across model families). */
function buildImageInputs(model: string, cfg: Config, prompt: string): Record<string, unknown> {
  if (/flux-1-schnell/i.test(model)) {
    // flux-1-schnell: only prompt + steps, always square output.
    return { prompt, steps: cfg.imageSteps };
  }
  if (/flux/i.test(model)) {
    // flux-2 family (klein/dev): prompt + steps + width/height (16:9 capable).
    return { prompt, steps: cfg.imageSteps, width: cfg.imageWidth, height: cfg.imageHeight };
  }
  // SDXL / SD1.5 / dreamshaper family: num_steps + width/height.
  return {
    prompt,
    num_steps: cfg.imageStepsFallback,
    width: cfg.imageWidth,
    height: cfg.imageHeight,
  };
}

/**
 * Call an image model and return raw image bytes. Handles both response shapes:
 *   - flux-1-schnell        -> { image: "<base64>" }
 *   - sdxl / sd1.5 / etc.   -> a binary ReadableStream / ArrayBuffer
 */
export async function generateImage(
  env: Env,
  cfg: Config,
  model: string,
  prompt: string,
): Promise<Uint8Array> {
  const out = await aiRun(env)(model, buildImageInputs(model, cfg, prompt));

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

// --- Watermark (applied off-Worker via the Cloudflare Images binding) ---

let watermarkCache: Uint8Array | null = null;
function watermarkBytes(): Uint8Array {
  if (!watermarkCache) watermarkCache = base64ToUint8Array(WATERMARK_PNG_BASE64);
  return watermarkCache;
}

interface ImagesBinding {
  input(stream: ReadableStream): ImageTransformer;
}
interface ImageTransformer {
  transform(opts: Record<string, unknown>): ImageTransformer;
  draw(overlay: ReadableStream, opts: Record<string, unknown>): ImageTransformer;
  output(opts: Record<string, unknown>): Promise<{ response(): Response }>;
}

/** Wrap raw bytes as a ReadableStream for the Images binding. */
function toStream(bytes: Uint8Array): ReadableStream {
  return new Response(bytes as unknown as BodyInit).body as ReadableStream;
}

/**
 * Overlay the @monkeydiary watermark at a random corner (with padding).
 * Runs in Cloudflare's Images service — NOT in the Worker — so it costs 0 ms of
 * the 10ms Free-plan CPU budget and ~1 transformation of the 5000/month free
 * Images allowance. Falls back to the original bytes if anything goes wrong.
 */
export async function applyWatermark(env: Env, cfg: Config, bytes: Uint8Array): Promise<Uint8Array> {
  if (!cfg.watermarkEnabled) return bytes;
  const images = env.IMAGES as ImagesBinding | undefined;
  if (!images) {
    log('IMAGES binding not configured; sending image without watermark');
    return bytes;
  }
  try {
    const result = await images
      .input(toStream(bytes))
      .draw(toStream(watermarkBytes()), {
        opacity: cfg.watermarkOpacity,
        ...randomCorner(cfg.watermarkPadding),
      })
      .output({ format: 'image/jpeg', quality: 90 });
    const ab = await result.response().arrayBuffer();
    return new Uint8Array(ab);
  } catch (e) {
    log('watermark failed, sending original image:', String(e));
    return bytes;
  }
}

function randomCorner(pad: number): Record<string, number> {
  const vertical = Math.random() < 0.5 ? 'top' : 'bottom';
  const horizontal = Math.random() < 0.5 ? 'left' : 'right';
  return { [vertical]: pad, [horizontal]: pad };
}

/**
 * Extract an og:image (or twitter:image) URL from the article page.
 * Free in neurons — used as the last-resort fallback.
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
  const re = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']${esc}["'][^>]*>`, 'i');
  return html.match(re)?.[0] ?? null;
}

function metaContent(tag: string): string | null {
  return /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null;
}
