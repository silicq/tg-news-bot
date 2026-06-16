import type { Config, Env } from './types';

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Publish a photo with an HTML caption via sendPhoto (multipart/form-data).
 * `photo` is either raw bytes (uploaded as a file) or a URL string that
 * Telegram fetches itself (used for the og:image fallback).
 */
export async function sendPhoto(
  env: Env,
  cfg: Config,
  photo: Uint8Array | string,
  caption: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', cfg.channelId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');

  if (typeof photo === 'string') {
    form.append('photo', photo);
  } else {
    // flux returns JPEG bytes; Telegram sniffs the actual type regardless.
    const blob = new Blob([asArrayBuffer(photo)], { type: 'image/jpeg' });
    form.append('photo', blob, 'image.jpg');
  }

  const res = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'sendPhoto'), {
    method: 'POST',
    body: form,
  });
  await assertOk(res, 'sendPhoto');
}

/** Publish a text-only message (no-image fallback). Link preview left enabled. */
export async function sendMessage(env: Env, cfg: Config, text: string): Promise<void> {
  const res = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.channelId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  await assertOk(res, 'sendMessage');
}

async function assertOk(res: Response, method: string): Promise<void> {
  let data: { ok?: boolean; description?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // ignore parse errors; status check below still applies
  }
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${data.description ?? 'unknown error'}`);
  }
}

// Copy into a fresh ArrayBuffer so Blob gets a plain ArrayBuffer (not a view
// over a possibly-shared buffer), keeping TS/runtime types happy.
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
