CREATE TABLE inpatient_drg_explanation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  basis_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,task_id), UNIQUE(workspace_id,epoch,admission_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
