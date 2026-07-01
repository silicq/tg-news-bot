// Admin-editable config overrides stored in D1. loadConfig() merges these over
// the wrangler vars, so everything is tunable from the Telegram panel without a
// redeploy. Keys are env-var names; values are strings.

import { logErr } from './util';

export type SettingType = 'bool' | 'int' | 'float' | 'text';

export interface SettingDef {
  key: string; // env var name
  label: string; // shown in the menu
  type: SettingType;
  category: string;
}

export const CATEGORIES: Array<{ id: string; title: string }> = [
  { id: 'posting', title: '📤 Постинг' },
  { id: 'images', title: '🖼 Картинки' },
  { id: 'article', title: '📖 Статьи/перевод' },
  { id: 'quiet', title: '🕐 Тихие часы' },
  { id: 'features', title: '⚙️ Функции' },
  { id: 'theme', title: '🎯 Тема/тон' },
];

export const SETTINGS: SettingDef[] = [
  { key: 'MAX_POSTS_PER_DAY', label: 'Постов в сутки', type: 'int', category: 'posting' },
  { key: 'MAX_POSTS_PER_RUN', label: 'Постов за запуск', type: 'int', category: 'posting' },
  { key: 'MIN_SCORE', label: 'Мин. оценка (0-100)', type: 'int', category: 'posting' },

  { key: 'IMAGE_MODEL', label: 'Модель картинки', type: 'text', category: 'images' },
  { key: 'IMAGE_STEPS', label: 'Шагов генерации', type: 'int', category: 'images' },
  { key: 'WATERMARK_ENABLED', label: 'Вотермарка', type: 'bool', category: 'images' },
  { key: 'WATERMARK_OPACITY', label: 'Прозрачность WM', type: 'float', category: 'images' },

  { key: 'TELEGRAPH_ENABLED', label: 'Статья-перевод', type: 'bool', category: 'article' },
  { key: 'ARTICLE_MAX_BLOCKS', label: 'Макс. блоков', type: 'int', category: 'article' },
  { key: 'ARTICLE_MAX_IMAGES', label: 'Фото в альбоме', type: 'int', category: 'article' },

  { key: 'QUIET_START_HOUR', label: 'Тишина с (час)', type: 'int', category: 'quiet' },
  { key: 'QUIET_END_HOUR', label: 'Тишина до (час)', type: 'int', category: 'quiet' },
  { key: 'TZ_OFFSET_HOURS', label: 'Часовой пояс (UTC±)', type: 'int', category: 'quiet' },

  { key: 'TOPIC_DEDUP', label: 'Дедуп тем', type: 'bool', category: 'features' },
  { key: 'BUTTONS_ENABLED', label: 'Кнопки-ссылки', type: 'bool', category: 'features' },
  { key: 'RUBRICS_ENABLED', label: 'Рубрики', type: 'bool', category: 'features' },
  { key: 'ALBUMS_ENABLED', label: 'Альбомы', type: 'bool', category: 'features' },
  { key: 'CAPTION_FORMATTING', label: 'Формат. текста', type: 'bool', category: 'features' },
  { key: 'REACTIONS_ENABLED', label: 'Учёт реакций', type: 'bool', category: 'features' },
  { key: 'HEALTH_ALERTS', label: 'Алерты о сбоях', type: 'bool', category: 'features' },

  { key: 'CHANNEL_THEME', label: 'Тема канала', type: 'text', category: 'theme' },
  { key: 'CAPTION_TONE', label: 'Тон подписи', type: 'text', category: 'theme' },
];

export function settingByKey(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** All overrides as an env-var map (merged over wrangler vars in loadConfig). */
export async function getOverrides(db: D1Database): Promise<Record<string, string>> {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const r of rows.results ?? []) out[r.key] = r.value;
    return out;
  } catch (e) {
    logErr('getOverrides failed:', String(e));
    return {};
  }
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

export async function resetSettings(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM settings').run();
}

/** Validate + normalize a raw admin input for a setting. Returns null if invalid. */
export function normalizeValue(def: SettingDef, raw: string): string | null {
  const v = raw.trim();
  switch (def.type) {
    case 'bool':
      if (/^(1|true|on|yes|да|вкл)$/i.test(v)) return 'true';
      if (/^(0|false|off|no|нет|выкл)$/i.test(v)) return 'false';
      return null;
    case 'int': {
      const n = Number(v);
      return Number.isInteger(n) ? String(n) : null;
    }
    case 'float': {
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'text':
      return v.length ? v : null;
  }
}
