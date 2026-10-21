-- Private execution checkpoints belong to business tasks, never to the usage ledger.
ALTER TABLE doctor_recommendation_execution_unit ADD COLUMN blocked_kind TEXT
  CHECK (blocked_kind IN ('initial', 'format-repair', 'rate-limit-retry'));
CREATE TABLE model_task_step (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  task_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'blocked', 'succeeded', 'unknown')),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  repair_count INTEGER NOT NULL DEFAULT 0 CHECK (repair_count >= 0),
  rate_limit_count INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_count >= 0),
  blocked_kind TEXT CHECK (blocked_kind IN ('initial', 'format-repair', 'rate-limit-retry')),
  blocked_code TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  PRIMARY KEY (workspace_id, epoch, task_id, step_key),
  FOREIGN KEY (workspace_id, epoch) REFERENCES workspace_epoch(workspace_id, epoch) ON DELETE RESTRICT
) STRICT;
CREATE TABLE model_task_wait (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, event_id),
  FOREIGN KEY (workspace_id, epoch, event_id) REFERENCES outbox_event(workspace_id, epoch, event_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE model_reply_wait (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  PRIMARY KEY(workspace_id, epoch, attempt_id),
  FOREIGN KEY(workspace_id, epoch, attempt_id) REFERENCES consultation_reply_attempt(workspace_id, epoch, attempt_id) ON DELETE RESTRICT
) STRICT;
