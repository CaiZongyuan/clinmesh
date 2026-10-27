CREATE TABLE inpatient_drg_agent_analysis (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, analysis_id TEXT NOT NULL,
  task_id TEXT NOT NULL, admission_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  task_version INTEGER NOT NULL CHECK(task_version>0), basis_fingerprint TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('preoperative','intraoperative','postoperative')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','stale','blocked','unknown','failed')),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,analysis_id),
  UNIQUE(workspace_id,epoch,task_id,basis_fingerprint),
  UNIQUE(workspace_id,epoch,task_id,revision),
  FOREIGN KEY(workspace_id,epoch,task_id) REFERENCES inpatient_drg_followup(workspace_id,epoch,task_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
