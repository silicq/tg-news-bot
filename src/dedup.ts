import type { Config, FeedItem } from './types';
import { sha256Hex } from './util';

/** Stable dedup key: sha-256 of the guid, or the link when there is no guid. */
export async function itemId(item: FeedItem): Promise<string> {
  return sha256Hex(item.guid && item.guid.length ? item.guid : item.link);
}

/**
 * Return only the items that have not been posted before. Each surviving item
 * gets its `id` populated so the caller can record it later.
 */
export async function filterUnposted(
  db: D1Database,
  items: FeedItem[],
): Promise<FeedItem[]> {
  if (items.length === 0) return [];

  // Compute ids and drop in-batch duplicates by id.
  const withIds: FeedItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = await itemId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    withIds.push({ ...item, id });
  }

  // Query existing ids in chunks (keeps bound-parameter count small for D1).
  const existing = new Set<string>();
  const ids = withIds.map((i) => i.id!);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT id FROM posted WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of rows.results ?? []) existing.add(r.id);
  }

  return withIds.filter((i) => !existing.has(i.id!));
}

/** Record an item as posted (idempotent). */
export async function recordPosted(db: D1Database, item: FeedItem): Promise<void> {
  const id = item.id ?? (await itemId(item));
  await db
    .prepare(
      'INSERT OR IGNORE INTO posted (id, link, title, posted_at) VALUES (?, ?, ?, ?)',
    )
    .bind(id, item.link, item.title, Date.now())
    .run();
}

/** Delete history rows older than the retention window to keep D1 small. */
export async function cleanupHistory(db: D1Database, cfg: Config): Promise<void> {
  if (cfg.historyRetentionDays <= 0) return;
  const cutoff = Date.now() - cfg.historyRetentionDays * 86_400_000;
  await db.prepare('DELETE FROM posted WHERE posted_at < ?').bind(cutoff).run();
}
