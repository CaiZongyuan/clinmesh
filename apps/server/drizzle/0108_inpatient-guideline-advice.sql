CREATE TABLE inpatient_guideline_advice (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)), basis_fingerprint TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('automatic','manual')),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','no-evidence','blocked','unknown','rejected','failed','stale')),
  error_code TEXT, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,task_id,version), UNIQUE(workspace_id,epoch,request_id,version),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES inpatient_surgery_request(workspace_id,epoch,request_id) ON DELETE RESTRICT
) STRICT;
