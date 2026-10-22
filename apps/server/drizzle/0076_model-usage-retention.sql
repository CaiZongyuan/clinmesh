CREATE TABLE model_usage_retention (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(workspace_id),
  days INTEGER DEFAULT 90 CHECK (days > 0 AND days <= 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  compacted_requests INTEGER NOT NULL DEFAULT 0 CHECK (compacted_requests >= 0),
  last_compacted_at TEXT
);

CREATE TABLE model_usage_daily (
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  epoch TEXT NOT NULL,
  date TEXT NOT NULL,
  case_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  status TEXT NOT NULL,
  requests INTEGER NOT NULL,
  unknown_requests INTEGER NOT NULL,
  known_tokens INTEGER NOT NULL,
  unknown_token_requests INTEGER NOT NULL,
  cny_micro INTEGER,
  unpriced_requests INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, epoch, date, case_id, feature, provider, requested_model, actual_model, status)
);
CREATE INDEX model_usage_daily_workspace_date ON model_usage_daily(workspace_id, date);

-- Only necessary reconciliation evidence survives; this is not a detail archive.
CREATE TABLE model_usage_correction_audit (
  attempt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json))
);
