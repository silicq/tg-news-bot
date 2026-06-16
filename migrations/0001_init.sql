-- D1 schema for the Telegram news bot.
-- Apply with:
--   wrangler d1 migrations apply news_bot --local    (for `wrangler dev`)
--   wrangler d1 migrations apply news_bot --remote    (for production)

-- Published items, used for deduplication / idempotency.
-- `id` is sha-256(guid || link).
CREATE TABLE IF NOT EXISTS posted (
  id        TEXT PRIMARY KEY,
  link      TEXT,
  title     TEXT,
  posted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posted_at ON posted (posted_at);

-- Daily neuron spend + post counter. One row per UTC day ('YYYY-MM-DD').
-- Resets implicitly at 00:00 UTC because a new day = a new row.
CREATE TABLE IF NOT EXISTS budget (
  day          TEXT PRIMARY KEY,
  neurons_used INTEGER NOT NULL DEFAULT 0,
  posts_count  INTEGER NOT NULL DEFAULT 0
);
