CREATE TABLE reference_offline_inventory (
  inventory_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  inventory_json TEXT NOT NULL
) STRICT;

CREATE TABLE reference_offline_inventory_audit (
  sequence INTEGER PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  inventory_id TEXT,
  content_hash TEXT
) STRICT;
