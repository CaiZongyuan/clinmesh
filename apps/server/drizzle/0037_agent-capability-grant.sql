CREATE TABLE agent_client (
  agent_client_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, actor_id),
  UNIQUE (agent_client_id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_capability_grant (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  agent_client_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  operation_ids_json TEXT NOT NULL CHECK (
    json_valid(operation_ids_json) AND json_type(operation_ids_json) = 'array'
  ),
  catalog_hash TEXT NOT NULL CHECK (length(catalog_hash) = 64),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_client_id, workspace_id)
    REFERENCES agent_client (agent_client_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, practitioner_role_id)
    REFERENCES practitioner_role_binding (workspace_id, practitioner_role_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, scenario_run_id)
    REFERENCES scenario_run (workspace_id, epoch, scenario_run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_capability_grant_client_idx
  ON agent_capability_grant (agent_client_id, workspace_id, revoked_at, expires_at);
