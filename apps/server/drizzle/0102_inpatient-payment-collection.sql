-- Only business-purpose links remain inpatient-owned. Old synthetic attempts
-- are discarded by the explicit development cutover, never read as new money.
CREATE UNIQUE INDEX collection_inpatient_owner
  ON collection_transaction(workspace_id,epoch,payment_id,owner_id);
CREATE UNIQUE INDEX inpatient_collection_preview_owner
  ON inpatient_payment_preview(workspace_id,epoch,preview_id,admission_id);
CREATE UNIQUE INDEX inpatient_collection_adjustment_owner
  ON inpatient_financial_adjustment(workspace_id,epoch,adjustment_id,admission_id);

CREATE TABLE inpatient_payment_allocation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  admission_id TEXT NOT NULL, preview_id TEXT, adjustment_id TEXT,
  PRIMARY KEY(workspace_id,epoch,payment_id), UNIQUE(workspace_id,epoch,preview_id),
  CHECK(adjustment_id IS NULL OR preview_id IS NOT NULL),
  FOREIGN KEY(workspace_id,epoch,payment_id,admission_id)
    REFERENCES collection_transaction(workspace_id,epoch,payment_id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id)
    REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,preview_id,admission_id)
    REFERENCES inpatient_payment_preview(workspace_id,epoch,preview_id,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,adjustment_id,admission_id)
    REFERENCES inpatient_financial_adjustment(workspace_id,epoch,adjustment_id,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_collection_admission ON inpatient_payment_allocation(workspace_id,epoch,admission_id);
CREATE UNIQUE INDEX inpatient_collection_payment_owner
  ON inpatient_payment_allocation(workspace_id,epoch,payment_id,admission_id);

CREATE TABLE inpatient_collection_supplement_refund (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, refund_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL, source_payment_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen<0), virtual_time TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,refund_id),
  FOREIGN KEY(workspace_id,epoch,settlement_id)
    REFERENCES inpatient_settlement(workspace_id,epoch,settlement_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,source_payment_id,admission_id)
    REFERENCES inpatient_payment_allocation(workspace_id,epoch,payment_id,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,refund_id)
    REFERENCES refund_transaction(workspace_id,epoch,refund_id) ON DELETE RESTRICT
) STRICT;
