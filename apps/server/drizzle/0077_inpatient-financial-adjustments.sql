CREATE TABLE inpatient_financial_adjustment (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, adjustment_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, charge_id TEXT NOT NULL, settlement_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen>0), reason TEXT NOT NULL,
  actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,adjustment_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,charge_id) REFERENCES inpatient_charge(workspace_id,epoch,charge_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,settlement_id) REFERENCES inpatient_settlement(workspace_id,epoch,settlement_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_financial_adjustment_admission ON inpatient_financial_adjustment(workspace_id,epoch,admission_id);
CREATE TABLE inpatient_financial_refund_preview (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, input_json TEXT NOT NULL, token_hash TEXT NOT NULL,
  actor_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
