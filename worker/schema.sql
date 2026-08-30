PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  display_code TEXT NOT NULL UNIQUE,
  display_name TEXT,
  name_updated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  device_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('endless', 'dual')),
  best_score INTEGER NOT NULL CHECK (best_score >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, mode),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scores_mode_rank
  ON scores(mode, best_score DESC, updated_at ASC);
