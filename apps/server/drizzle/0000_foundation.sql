CREATE TABLE runtime_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO runtime_metadata (key, value)
VALUES ('schema_family', 'clinmesh-r5-sqlite');

CREATE TABLE workspace (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_epoch TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_epoch (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'active', 'closing', 'closed')),
  scenario_id TEXT NOT NULL,
  canonical_state_hash TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  closed_at TEXT,
  PRIMARY KEY (workspace_id, epoch),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE scenario_run (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'closed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, scenario_run_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE fhir_resource (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version_id INTEGER NOT NULL CHECK (version_id > 0),
  last_updated TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, resource_type, resource_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE fhir_history (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version_id INTEGER NOT NULL CHECK (version_id > 0),
  last_updated TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, resource_type, resource_id, version_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX fhir_history_resource_idx
  ON fhir_history (workspace_id, epoch, resource_type, resource_id, version_id DESC);

CREATE TABLE fhir_sp_string (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  param TEXT NOT NULL,
  normalized TEXT NOT NULL,
  exact_value TEXT NOT NULL,
  PRIMARY KEY (
    workspace_id, epoch, resource_type, resource_id,
    param, normalized, exact_value
  ),
  FOREIGN KEY (workspace_id, epoch, resource_type, resource_id)
    REFERENCES fhir_resource (workspace_id, epoch, resource_type, resource_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX fhir_sp_string_search_idx
  ON fhir_sp_string (workspace_id, epoch, resource_type, param, normalized, resource_id);

CREATE TABLE command_receipt (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('executing', 'completed', 'ambiguous', 'failed')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, actor_id, operation, idempotency_key),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE command_effect (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  effect_index INTEGER NOT NULL CHECK (effect_index >= 0),
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  version_id TEXT NOT NULL,
  PRIMARY KEY (
    workspace_id, epoch, actor_id, operation,
    idempotency_key, effect_index
  ),
  FOREIGN KEY (
    workspace_id, epoch, actor_id, operation, idempotency_key
  ) REFERENCES command_receipt (
    workspace_id, epoch, actor_id, operation, idempotency_key
  ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE audit_head (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE audit_log (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  real_timestamp TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  practitioner_id TEXT,
  practitioner_role_id TEXT,
  role_code TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, audit_id),
  UNIQUE (workspace_id, epoch, sequence),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE action_trace (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  virtual_timestamp TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, scenario_run_id, trace_id),
  UNIQUE (workspace_id, epoch, scenario_run_id, sequence),
  FOREIGN KEY (workspace_id, epoch, scenario_run_id)
    REFERENCES scenario_run (workspace_id, epoch, scenario_run_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE outbox_event (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'claimed', 'completed', 'failed', 'ambiguous', 'abandoned')
  ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  correlation_id TEXT,
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  leased_until TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, event_id),
  UNIQUE (workspace_id, epoch, kind, dedup_key),
  FOREIGN KEY (workspace_id, epoch, scenario_run_id)
    REFERENCES scenario_run (workspace_id, epoch, scenario_run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX outbox_claim_idx
  ON outbox_event (status, next_attempt_at, leased_until, workspace_id, epoch);
