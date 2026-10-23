-- 医保办 DRG 模拟核定复核：追加记录保留每次复核的输入身份、参数身份与差异依据。
CREATE TABLE inpatient_drg_payer_review (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  review_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  archive_sources_hash TEXT NOT NULL,
  record_revision INTEGER NOT NULL,
  frozen_rules_id TEXT NOT NULL,
  frozen_rules_version TEXT NOT NULL,
  frozen_result_hash TEXT NOT NULL,
  drg_code TEXT NOT NULL,
  parameter_set_id TEXT NOT NULL,
  parameter_version TEXT NOT NULL,
  simulated_payment_fen INTEGER NOT NULL,
  hospital_charges_fen INTEGER NOT NULL,
  difference_fen INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, review_id),
  FOREIGN KEY (workspace_id, epoch, admission_id) REFERENCES inpatient_admission(workspace_id, epoch, admission_id)
) STRICT;
CREATE INDEX idx_drg_payer_review_admission ON inpatient_drg_payer_review(workspace_id, epoch, admission_id, created_at, review_id);
