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
ALTER TABLE inpatient_payment_preview ADD COLUMN adjustment_id TEXT;
ALTER TABLE inpatient_payment_attempt ADD COLUMN adjustment_id TEXT;

CREATE TABLE inpatient_refund_preview (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('inpatient-deposit','inpatient-supplement')), source_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen>0), simulator_rule TEXT NOT NULL, fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL, actor_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
-- A supplemental payment can itself need a refund after a pre-settlement charge reversal.
-- The original settlement table retains its deposit-only foreign key and all historical rows.
CREATE TABLE inpatient_settlement_supplement_refund (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, refund_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL, source_payment_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen<0), virtual_time TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,refund_id),
  FOREIGN KEY(workspace_id,epoch,settlement_id) REFERENCES inpatient_settlement(workspace_id,epoch,settlement_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,source_payment_id) REFERENCES inpatient_payment_attempt(workspace_id,epoch,payment_id) ON DELETE RESTRICT
) STRICT;
-- Adopt historical refunds without dispatching a channel or changing the original frozen ledger.
INSERT INTO refund_transaction(workspace_id,epoch,refund_id,source_kind,source_id,basis_id,owner_kind,owner_id,amount_fen,outcome,recovery_outcome,correlation_id,created_at)
SELECT workspace_id,epoch,transaction_id,'inpatient-deposit',source_deposit_id,'first-settlement:'||admission_id,'inpatient',admission_id,-amount_fen,'success','success','legacy-inpatient-'||transaction_id,virtual_time
FROM inpatient_settlement_transaction WHERE kind='refund';
