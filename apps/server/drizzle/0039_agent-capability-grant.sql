CREATE TABLE agent_client (
  workspace_id TEXT NOT NULL,
  agent_client_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_client_id),
  UNIQUE (agent_client_id),
  UNIQUE (workspace_id, actor_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_capability_grant (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  agent_client_id TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  catalog_hash TEXT NOT NULL CHECK (length(catalog_hash) = 64),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, grant_id),
  FOREIGN KEY (workspace_id, agent_client_id)
    REFERENCES agent_client (workspace_id, agent_client_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, practitioner_role_id)
    REFERENCES practitioner_role_binding (workspace_id, practitioner_role_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, scenario_run_id)
    REFERENCES scenario_run (workspace_id, epoch, scenario_run_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_grant_operation (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, grant_id, operation_id),
  FOREIGN KEY (workspace_id, epoch, grant_id)
    REFERENCES agent_capability_grant (workspace_id, epoch, grant_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_capability_grant_client_idx
  ON agent_capability_grant (workspace_id, agent_client_id, revoked_at, expires_at);
