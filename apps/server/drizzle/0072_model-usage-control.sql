CREATE TABLE model_usage_control (
  scope_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  request_limit INTEGER CHECK (request_limit >= 0),
  automatic_retries INTEGER NOT NULL DEFAULT 1 CHECK (automatic_retries IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  requests_started_at TEXT,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);
INSERT INTO model_usage_control(scope_id) VALUES ('deployment');
CREATE TABLE model_usage_request_reservation (
  attempt_id TEXT NOT NULL REFERENCES model_usage_attempt(attempt_id),
  scope_id TEXT NOT NULL REFERENCES model_usage_control(scope_id),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'released')),
  PRIMARY KEY(attempt_id, scope_id)
);
CREATE TABLE model_usage_control_rejection (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(workspace_id),
  code TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'deployment')),
  rejected_at TEXT NOT NULL
);
