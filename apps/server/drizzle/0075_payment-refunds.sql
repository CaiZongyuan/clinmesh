CREATE TABLE refund_transaction (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, refund_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('outpatient-payment','inpatient-deposit','inpatient-supplement')),
  source_id TEXT NOT NULL, basis_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('outpatient','inpatient')), owner_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','declined','ambiguous')),
  recovery_outcome TEXT NOT NULL CHECK(recovery_outcome IN ('success','declined','ambiguous')),
  correlation_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,refund_id),
  FOREIGN KEY(workspace_id,epoch) REFERENCES workspace_epoch(workspace_id,epoch) ON DELETE RESTRICT
) STRICT;
CREATE INDEX refund_source_idx ON refund_transaction(workspace_id,epoch,source_kind,source_id);
CREATE INDEX refund_basis_idx ON refund_transaction(workspace_id,epoch,basis_id);
CREATE INDEX refund_owner_idx ON refund_transaction(workspace_id,epoch,owner_kind,owner_id,created_at,refund_id);
CREATE TABLE refund_resolution (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, refund_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','declined')), resolved_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,refund_id),
  FOREIGN KEY(workspace_id,epoch,refund_id) REFERENCES refund_transaction(workspace_id,epoch,refund_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE financial_charge_adjustment (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, adjustment_id TEXT NOT NULL,
  charge_item_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  reason TEXT NOT NULL, execution_state TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,adjustment_id),
  FOREIGN KEY(workspace_id,epoch,charge_item_id) REFERENCES charge_record(workspace_id,epoch,charge_item_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX financial_adjustment_charge_idx ON financial_charge_adjustment(workspace_id,epoch,charge_item_id);
CREATE TABLE refund_preview (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL,
  payment_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  source_version INTEGER NOT NULL CHECK(source_version > 0), charge_version INTEGER NOT NULL,
  simulator_rule TEXT NOT NULL, actor_context_hash TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,payment_id) REFERENCES payment_transaction(workspace_id,epoch,payment_id) ON DELETE RESTRICT
) STRICT;
