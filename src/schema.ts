// Self-applied schema. Lets the worker run without anyone executing a D1
// migration: tables are created if missing and new columns are added
// idempotently. Runs at most once per isolate.

let ensured = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (ensured) return;

  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS posted (
         id        TEXT PRIMARY KEY,
         link      TEXT,
         title     TEXT,
         posted_at INTEGER NOT NULL
       )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS budget (
         day          TEXT PRIMARY KEY,
         neurons_used INTEGER NOT NULL DEFAULT 0,
         posts_count  INTEGER NOT NULL DEFAULT 0
       )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_posted_at ON posted (posted_at)`),
  ]);

  // Add skipped_count to existing budget tables. Throws "duplicate column"
  // when it already exists — which is exactly the no-op we want.
  try {
    await db
      .prepare(`ALTER TABLE budget ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0`)
      .run();
  } catch {
    /* column already present */
  }

  ensured = true;
}
