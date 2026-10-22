-- A live Host lease describes undispatched work, never a model attempt or credential.
CREATE TABLE model_host_wait (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_json TEXT NOT NULL CHECK (json_valid(task_json)),
  deadline_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, task_id),
  FOREIGN KEY (workspace_id, epoch) REFERENCES workspace_epoch(workspace_id, epoch) ON DELETE RESTRICT
) STRICT;
