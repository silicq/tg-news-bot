// Telegram admin panel: view and edit config from an inline-keyboard menu
// (backed by the `settings` table). No code or Cloudflare dashboard needed.

import {
  CATEGORIES,
  SETTINGS,
  getOverrides,
  normalizeValue,
  resetSettings,
  setSetting,
  settingByKey,
  type SettingDef,
} from './settings';
import { getState, setState } from './state';
import { answerCallback, editMessageText, sendMessage } from './telegram';
import type { Env, TelegramCallbackQuery } from './types';

const AWAIT_KEY = 'awaiting_setting';

type Button = { text: string; callback_data: string };
type Keyboard = { inline_keyboard: Button[][] };

function isTrue(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|on|yes)$/i.test(v.trim());
}

function merged(env: Env, overrides: Record<string, string>): Record<string, string | undefined> {
  return { ...(env as unknown as Record<string, string | undefined>), ...overrides };
}

function displayValue(def: SettingDef, src: Record<string, string | undefined>): string {
  const raw = src[def.key];
  if (def.type === 'bool') return isTrue(raw) ? '✅' : '❌';
  if (raw === undefined || raw === '') return '(по умолч.)';
  return raw.length > 22 ? raw.slice(0, 22) + '…' : raw;
}

function mainMenu(): { text: string; markup: Keyboard } {
  const rows: Button[][] = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    rows.push(
      CATEGORIES.slice(i, i + 2).map((c) => ({ text: c.title, callback_data: `cat:${c.id}` })),
    );
  }
  rows.push([
    { text: '🔄 Сброс', callback_data: 'reset' },
    { text: '✖️ Закрыть', callback_data: 'close' },
  ]);
  return { text: '⚙️ <b>Настройки бота</b>\nВыбери раздел:', markup: { inline_keyboard: rows } };
}

function categoryMenu(catId: string, src: Record<string, string | undefined>): { text: string; markup: Keyboard } {
  const cat = CATEGORIES.find((c) => c.id === catId);
  const rows: Button[][] = SETTINGS.filter((s) => s.category === catId).map((s) => [
    {
      text: `${s.label}: ${displayValue(s, src)}`,
      callback_data: `${s.type === 'bool' ? 'tgl' : 'edit'}:${s.key}`,
    },
  ]);
  rows.push([{ text: '⬅️ Назад', callback_data: 'menu' }]);
  return { text: `${cat?.title ?? 'Раздел'}\nТапни настройку, чтобы изменить:`, markup: { inline_keyboard: rows } };
}

/** /settings — open the panel. */
export async function openPanel(env: Env): Promise<void> {
  const m = mainMenu();
  await sendMessage(env, env.ADMIN_ID!, m.text, m.markup);
}

/** Handle a button tap from the panel. */
export async function handleCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
  if (String(cb.from?.id) !== String(env.ADMIN_ID) || !cb.message) {
    await answerCallback(env, cb.id);
    return;
  }
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const data = cb.data ?? '';
  const overrides = await getOverrides(env.DB);
  const src = merged(env, overrides);

  if (data === 'menu') {
    const m = mainMenu();
    await editMessageText(env, chatId, msgId, m.text, m.markup);
  } else if (data.startsWith('cat:')) {
    const m = categoryMenu(data.slice(4), src);
    await editMessageText(env, chatId, msgId, m.text, m.markup);
  } else if (data.startsWith('tgl:')) {
    const key = data.slice(4);
    const def = settingByKey(key);
    if (def) {
      const next = isTrue(src[key]) ? 'false' : 'true';
      await setSetting(env.DB, key, next);
      src[key] = next;
      const m = categoryMenu(def.category, src);
      await editMessageText(env, chatId, msgId, m.text, m.markup);
    }
    await answerCallback(env, cb.id, 'Сохранено');
    return;
  } else if (data.startsWith('edit:')) {
    const key = data.slice(5);
    const def = settingByKey(key);
    if (def) {
      await setState(env.DB, AWAIT_KEY, key);
      const cur = src[key] ?? '(по умолчанию)';
      await sendMessage(
        env,
        env.ADMIN_ID!,
        `✏️ Отправь новое значение для <b>${def.label}</b> (тип: ${def.type}).\n` +
          `Текущее: <code>${escape(cur)}</code>\n/cancel — отмена.`,
      );
    }
    await answerCallback(env, cb.id);
    return;
  } else if (data === 'reset') {
    await resetSettings(env.DB);
    const m = mainMenu();
    await editMessageText(env, chatId, msgId, '♻️ Все настройки сброшены к значениям из кода/wrangler.\n\n' + m.text, m.markup);
    await answerCallback(env, cb.id, 'Сброшено');
    return;
  } else if (data === 'close') {
    await editMessageText(env, chatId, msgId, '⚙️ Настройки закрыты. /settings — открыть снова.');
  }
  await answerCallback(env, cb.id);
}

/**
 * If the admin is mid-edit (tapped a value setting), treat their next message as
 * the new value. Returns true if the message was consumed as settings input.
 */
export async function handleSettingInput(env: Env, text: string): Promise<boolean> {
  const key = await getState(env.DB, AWAIT_KEY);
  if (!key) return false;

  if (/^\/cancel\b/i.test(text.trim())) {
    await setState(env.DB, AWAIT_KEY, '');
    await sendMessage(env, env.ADMIN_ID!, 'Отменено.');
    return true;
  }

  const def = settingByKey(key);
  if (!def) {
    await setState(env.DB, AWAIT_KEY, '');
    return false;
  }
  const value = normalizeValue(def, text);
  if (value === null) {
    await sendMessage(env, env.ADMIN_ID!, `⚠️ Неверное значение для типа "${def.type}". Попробуй ещё раз или /cancel.`);
    return true;
  }
  await setSetting(env.DB, key, value);
  await setState(env.DB, AWAIT_KEY, '');
  await sendMessage(env, env.ADMIN_ID!, `✅ <b>${def.label}</b> = <code>${escape(value)}</code>`);
  return true;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
