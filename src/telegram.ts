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

/** Publish/send a text message (HTML). Returns the new message id. */
export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  replyMarkup?: object,
): Promise<number | null> {
  const res = await tgApi<{ message_id?: number }>(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return res?.message_id ?? null;
}

/** Edit an existing message's text + inline keyboard (used by the admin panel). */
export function editMessageText(
  env: Env,
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: object,
): Promise<unknown> {
  return tgApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }).catch(() => undefined); // ignore "message is not modified" etc.
}

/** Acknowledge a callback query (stops the button's loading spinner). */
export function answerCallback(env: Env, callbackId: string, text?: string): Promise<unknown> {
  return tgApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => undefined);
}

export interface AlbumPhoto {
  media: Uint8Array | string; // bytes (uploaded) or a URL
  caption?: string; // only the first item's caption is shown by Telegram
}

/**
 * Send 2-10 photos as a media group (album). No inline keyboard is possible on
 * albums, so links must live in the caption. Returns the first message id.
 */
export async function sendMediaGroup(
  env: Env,
  chatId: string | number,
  photos: AlbumPhoto[],
): Promise<number | null> {
  const form = new FormData();
  form.append('chat_id', String(chatId));

  const media: Array<Record<string, unknown>> = [];
  let fileIndex = 0;
  for (const p of photos) {
    const item: Record<string, unknown> = { type: 'photo' };
    if (typeof p.media === 'string') {
      item.media = p.media;
    } else {
      const name = `file${fileIndex++}`;
      form.append(name, new Blob([asArrayBuffer(p.media)], { type: 'image/jpeg' }), `${name}.jpg`);
      item.media = `attach://${name}`;
    }
    if (p.caption) {
      item.caption = p.caption;
      item.parse_mode = 'HTML';
    }
    media.push(item);
  }
  form.append('media', JSON.stringify(media));

  const res = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'sendMediaGroup'), { method: 'POST', body: form });
  let data: { ok?: boolean; result?: Array<{ message_id?: number }>; description?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* fall through */
  }
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendMediaGroup failed (${res.status}): ${data.description ?? 'unknown error'}`);
  }
  return data.result?.[0]?.message_id ?? null;
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
  replyMarkup?: object,
): Promise<number | null> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

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
  let data: { ok?: boolean; result?: { message_id?: number }; description?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* fall through */
  }
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed (${res.status}): ${data.description ?? 'unknown error'}`);
  }
  return data.result?.message_id ?? null;
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
    allowed_updates: ['message', 'callback_query', 'message_reaction_count'],
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
