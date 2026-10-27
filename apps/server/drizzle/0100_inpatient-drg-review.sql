CREATE TABLE inpatient_drg_review_revision (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, revision_id TEXT NOT NULL, task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, fingerprint TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,revision_id), UNIQUE(workspace_id,epoch,task_id,fingerprint),
  FOREIGN KEY(workspace_id,epoch,task_id) REFERENCES inpatient_drg_followup(workspace_id,epoch,task_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_drg_review (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, task_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0), revision_id TEXT, handoff_json TEXT CHECK(handoff_json IS NULL OR json_valid(handoff_json)),
  PRIMARY KEY(workspace_id,epoch,admission_id),
  FOREIGN KEY(workspace_id,epoch,task_id) REFERENCES inpatient_drg_followup(workspace_id,epoch,task_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,revision_id) REFERENCES inpatient_drg_review_revision(workspace_id,epoch,revision_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_drg_review_todo (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, todo_id TEXT NOT NULL, task_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  issue_key TEXT NOT NULL, evidence_fingerprint TEXT NOT NULL, issue_json TEXT NOT NULL CHECK(json_valid(issue_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','in-progress','resolved','dismissed')), version INTEGER NOT NULL CHECK(version>0), reason TEXT,
  PRIMARY KEY(workspace_id,epoch,todo_id), UNIQUE(workspace_id,epoch,task_id,issue_key),
  FOREIGN KEY(workspace_id,epoch,task_id) REFERENCES inpatient_drg_followup(workspace_id,epoch,task_id) ON DELETE RESTRICT
) STRICT;
