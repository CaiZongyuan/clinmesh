CREATE TABLE inpatient_drg_followup (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  status TEXT NOT NULL CHECK(status IN ('active','stopped','authorization-lost','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT,
  rule_status TEXT NOT NULL DEFAULT 'pending' CHECK(rule_status IN ('pending','complete','incomplete','stale')),
  target_fingerprint TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  PRIMARY KEY(workspace_id,epoch,task_id),
  UNIQUE(workspace_id,epoch,admission_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id)
) STRICT;
