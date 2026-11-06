CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  phone_tail TEXT NOT NULL,
  score      INTEGER NOT NULL,
  caught     INTEGER NOT NULL DEFAULT 0,
  combo      INTEGER NOT NULL DEFAULT 0,
  week       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_week ON scores (week, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_phone ON scores (phone, week);
CREATE INDEX IF NOT EXISTS idx_scores_all ON scores (score DESC);
