CREATE TABLE inpatient_payment_preview (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('deposit','supplement')), amount_fen INTEGER NOT NULL CHECK(amount_fen>0),
  tenders_json TEXT NOT NULL, simulator_rule TEXT NOT NULL, fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL, actor_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_payment_attempt (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  preview_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('deposit','supplement')),
  amount_fen INTEGER NOT NULL CHECK(amount_fen>0), tenders_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','declined','ambiguous')),
  recovery_outcome TEXT NOT NULL CHECK(recovery_outcome IN ('success','declined','ambiguous')),
  correlation_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,payment_id), UNIQUE(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,preview_id) REFERENCES inpatient_payment_preview(workspace_id,epoch,preview_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_payment_admission ON inpatient_payment_attempt(workspace_id,epoch,admission_id);
CREATE TABLE inpatient_payment_resolution (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','declined')), resolved_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,payment_id),
  FOREIGN KEY(workspace_id,epoch,payment_id) REFERENCES inpatient_payment_attempt(workspace_id,epoch,payment_id) ON DELETE RESTRICT
) STRICT;
