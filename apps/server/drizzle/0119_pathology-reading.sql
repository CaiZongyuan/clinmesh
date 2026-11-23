CREATE TABLE pathology_reading_config (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(workspace_id),
  version INTEGER NOT NULL CHECK (version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
);

CREATE TABLE pathology_reading_binding (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  binding_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  remote_json TEXT CHECK (remote_json IS NULL OR json_valid(remote_json)),
  remote_revision INTEGER CHECK (remote_revision IS NULL OR remote_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'ready', 'unknown', 'repair-required')),
  PRIMARY KEY (workspace_id, epoch, request_id)
);

CREATE TABLE pathology_reading_checkpoint_intent (
  binding_id TEXT NOT NULL REFERENCES pathology_reading_binding(binding_id),
  intent_id TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  confirmed_revision INTEGER,
  PRIMARY KEY (binding_id, intent_id)
);

CREATE TABLE pathology_reading_session (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  auth_session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  head_report_id TEXT NOT NULL,
  head_report_version TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  generation TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  callback_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  displayed INTEGER NOT NULL DEFAULT 0 CHECK (displayed IN (0, 1)),
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  remote_json TEXT CHECK (remote_json IS NULL OR json_valid(remote_json)),
  UNIQUE (workspace_id, epoch, actor_id, idempotency_key)
);
