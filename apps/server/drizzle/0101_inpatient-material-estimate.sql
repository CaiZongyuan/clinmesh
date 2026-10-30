CREATE TABLE inpatient_material_estimate (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  authorization_operation TEXT NOT NULL CHECK(authorization_operation IN ('inpatient.surgery.request','inpatient.material-estimate.request')),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','cancelled')),
  automatic_pending INTEGER NOT NULL DEFAULT 1 CHECK(automatic_pending IN (0,1)),
  draft_json TEXT CHECK(draft_json IS NULL OR json_valid(draft_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,task_id), UNIQUE(workspace_id,epoch,request_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES inpatient_surgery_request(workspace_id,epoch,request_id) ON DELETE RESTRICT
) STRICT;

-- 长期跟进和单次预计复用同一持久分析；授权分别由各自意图拥有。
CREATE TABLE inpatient_drg_agent_analysis_next (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, analysis_id TEXT NOT NULL,
  task_id TEXT NOT NULL, admission_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  task_version INTEGER NOT NULL CHECK(task_version>0), basis_fingerprint TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('preoperative','intraoperative','postoperative')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','stale','blocked','unknown','failed')),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,analysis_id),
  UNIQUE(workspace_id,epoch,task_id,basis_fingerprint,task_version),
  UNIQUE(workspace_id,epoch,task_id,revision),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO inpatient_drg_agent_analysis_next SELECT * FROM inpatient_drg_agent_analysis;
DROP TABLE inpatient_drg_agent_analysis;
ALTER TABLE inpatient_drg_agent_analysis_next RENAME TO inpatient_drg_agent_analysis;

ALTER TABLE inpatient_material_reservation ADD COLUMN material_snapshot_json TEXT
  CHECK(material_snapshot_json IS NULL OR json_valid(material_snapshot_json));
