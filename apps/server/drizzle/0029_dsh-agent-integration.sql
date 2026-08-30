ALTER TABLE command_receipt ADD COLUMN request_id TEXT;
ALTER TABLE command_receipt ADD COLUMN audit_id TEXT;
ALTER TABLE command_receipt ADD COLUMN trace_id TEXT;

CREATE UNIQUE INDEX command_receipt_request_idx
  ON command_receipt (workspace_id, epoch, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX command_receipt_audit_idx
  ON command_receipt (workspace_id, epoch, audit_id)
  WHERE audit_id IS NOT NULL;

CREATE UNIQUE INDEX command_receipt_trace_idx
  ON command_receipt (workspace_id, epoch, trace_id)
  WHERE trace_id IS NOT NULL;

ALTER TABLE action_trace ADD COLUMN request_id TEXT;

CREATE UNIQUE INDEX action_trace_request_idx
  ON action_trace (workspace_id, epoch, request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE agent_page_context (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  context_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  user_account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  role_code TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL CHECK (client_revision > 0),
  view_id TEXT NOT NULL,
  view_revision TEXT NOT NULL,
  claim_json TEXT NOT NULL CHECK (json_valid(claim_json)),
  allowed_operation_ids_json TEXT NOT NULL CHECK (json_valid(allowed_operation_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, context_id),
  UNIQUE (
    workspace_id, epoch, user_account_id, practitioner_role_id,
    client_id, client_revision
  ),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_page_context_actor_idx
  ON agent_page_context (
    workspace_id, epoch, actor_id, practitioner_role_id, status, expires_at
  );

CREATE INDEX agent_page_context_scope_idx
  ON agent_page_context (workspace_id, epoch, scope_key, status, expires_at);

CREATE TABLE agent_tool_call (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_id TEXT,
  audit_id TEXT,
  trace_id TEXT,
  proposal_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  input_hash TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, dsh_session_id, call_id),
  UNIQUE (workspace_id, epoch, dsh_session_id, call_id, context_id),
  FOREIGN KEY (workspace_id, epoch, context_id)
    REFERENCES agent_page_context (workspace_id, epoch, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, audit_id)
    REFERENCES audit_log (workspace_id, epoch, audit_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, scenario_run_id, trace_id)
    REFERENCES action_trace (
      workspace_id, epoch, scenario_run_id, trace_id
    ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_proposal (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, proposal_id),
  UNIQUE (workspace_id, epoch, dsh_session_id, call_id),
  FOREIGN KEY (workspace_id, epoch, context_id)
    REFERENCES agent_page_context (workspace_id, epoch, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, dsh_session_id, call_id, context_id)
    REFERENCES agent_tool_call (
      workspace_id, epoch, dsh_session_id, call_id, context_id
    ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_review_decision (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  human_actor_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  command_request_id TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, decision_id),
  UNIQUE (workspace_id, epoch, proposal_id),
  FOREIGN KEY (workspace_id, epoch, proposal_id)
    REFERENCES agent_proposal (workspace_id, epoch, proposal_id) ON DELETE RESTRICT
) STRICT;
