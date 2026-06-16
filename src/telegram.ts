import type { Env } from './types';

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Generic Telegram Bot API call (JSON in / JSON result out). Throws on error. */
export async function tgApi<T = unknown>(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  let data: { ok?: boolean; result?: unknown; description?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* fall through to the status check */
  }
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${data.description ?? 'unknown error'}`);
  }
  return data.result as T;
}

/** Publish/send a text message (HTML). Used for posts and admin replies. */
export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
): Promise<void> {
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
}

/**
 * Send a photo with an HTML caption via sendPhoto (multipart/form-data).
 * `photo` is either raw bytes (uploaded as a file) or a URL string that
 * Telegram fetches itself (used for the og:image fallback).
 */
export async function sendPhoto(
  env: Env,
  chatId: string | number,
  photo: Uint8Array | string,
  caption: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
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
  let data: { ok?: boolean; description?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* fall through */
  }
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed (${res.status}): ${data.description ?? 'unknown error'}`);
  }
}

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TgChatMember {
  status: string; // creator | administrator | member | restricted | left | kicked
  can_post_messages?: boolean;
}

export function getMe(env: Env): Promise<TgUser> {
  return tgApi<TgUser>(env, 'getMe', {});
}

export function getChat(env: Env, chatId: string | number): Promise<TgChat> {
  return tgApi<TgChat>(env, 'getChat', { chat_id: chatId });
}

export function getChatMember(
  env: Env,
  chatId: string | number,
  userId: number,
): Promise<TgChatMember> {
  return tgApi<TgChatMember>(env, 'getChatMember', { chat_id: chatId, user_id: userId });
}

/** Register the webhook so Telegram delivers updates to this worker. */
export function setWebhook(env: Env, url: string, secretToken?: string): Promise<unknown> {
  return tgApi(env, 'setWebhook', {
    url,
    allowed_updates: ['message'],
    drop_pending_updates: true,
    ...(secretToken ? { secret_token: secretToken } : {}),
  });
}

// Copy into a fresh ArrayBuffer so Blob gets a plain ArrayBuffer (not a view
// over a possibly-shared buffer), keeping TS/runtime types happy.
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
