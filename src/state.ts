// Tiny key-value store in D1 for cross-run bot state (health counters, etc.).
// The `state` table is created by ensureSchema(), so no manual migration is
// needed. All helpers swallow DB errors so health alerting still works even if
// D1 is the thing that's failing.

import { logErr } from './util';

export async function getState(db: D1Database, key: string): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT value FROM state WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  } catch (e) {
    logErr('getState failed:', key, String(e));
    return null;
  }
}

export async function getStateNum(db: D1Database, key: string, fallback = 0): Promise<number> {
  const v = await getState(db, key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function setState(db: D1Database, key: string, value: string | number): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .bind(key, String(value))
      .run();
  } catch (e) {
    logErr('setState failed:', key, String(e));
  }
}
