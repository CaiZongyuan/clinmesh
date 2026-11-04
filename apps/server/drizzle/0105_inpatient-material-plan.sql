-- 只保存新确认的原始快照；历史工作稿和预留余额不构成可回填证据。
CREATE TABLE inpatient_material_plan_confirmation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL,
  request_id TEXT NOT NULL, confirmation_id TEXT NOT NULL, estimate_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(workspace_id,epoch,confirmation_id),
  UNIQUE(workspace_id,epoch,estimate_id,draft_revision),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES inpatient_surgery_request(workspace_id,epoch,request_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,estimate_id) REFERENCES inpatient_material_estimate(workspace_id,epoch,task_id) ON DELETE RESTRICT
) STRICT;
