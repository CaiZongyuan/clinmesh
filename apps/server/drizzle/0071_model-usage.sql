CREATE TABLE model_usage_attempt (
  attempt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  epoch TEXT NOT NULL,
  case_id TEXT,
  feature TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT,
  status TEXT NOT NULL CHECK (status IN ('in-flight', 'succeeded', 'failed', 'cancelled', 'unknown')),
  started_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
CREATE INDEX model_usage_workspace_time ON model_usage_attempt(workspace_id, started_at DESC, attempt_id);
CREATE INDEX model_usage_case ON model_usage_attempt(workspace_id, epoch, case_id);
