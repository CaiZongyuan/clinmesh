-- Preserve every existing collection and refund preview while allowing a
-- collection to allocate its reviewed total to several original charges.
CREATE TABLE outpatient_payment_allocation_next (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  case_id TEXT NOT NULL, charge_item_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen>=0),
  position INTEGER NOT NULL CHECK(position>=0),
  PRIMARY KEY(workspace_id,epoch,payment_id,charge_item_id),
  UNIQUE(workspace_id,epoch,payment_id,position),
  FOREIGN KEY(workspace_id,epoch,payment_id,case_id)
    REFERENCES collection_transaction(workspace_id,epoch,payment_id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,case_id,charge_item_id)
    REFERENCES charge_record(workspace_id,epoch,case_id,charge_item_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO outpatient_payment_allocation_next
  (workspace_id,epoch,payment_id,case_id,charge_item_id,amount_fen,position)
  SELECT workspace_id,epoch,payment_id,case_id,charge_item_id,amount_fen,0 FROM outpatient_payment_allocation;

CREATE TABLE outpatient_refund_preview_next (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL,
  payment_id TEXT NOT NULL, charge_item_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen>0),
  source_version INTEGER NOT NULL CHECK(source_version>0), charge_version INTEGER NOT NULL,
  simulator_rule TEXT NOT NULL, actor_context_hash TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,payment_id,charge_item_id)
    REFERENCES outpatient_payment_allocation_next(workspace_id,epoch,payment_id,charge_item_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO outpatient_refund_preview_next
  (workspace_id,epoch,preview_id,payment_id,charge_item_id,amount_fen,source_version,charge_version,
   simulator_rule,actor_context_hash,token_hash,expires_at,consumed_at)
  SELECT preview.workspace_id,preview.epoch,preview.preview_id,preview.payment_id,allocation.charge_item_id,
    preview.amount_fen,preview.source_version,preview.charge_version,preview.simulator_rule,
    preview.actor_context_hash,preview.token_hash,preview.expires_at,preview.consumed_at
  FROM outpatient_refund_preview preview
  JOIN outpatient_payment_allocation allocation USING(workspace_id,epoch,payment_id);
DROP TABLE outpatient_refund_preview;
DROP TABLE outpatient_payment_allocation;
ALTER TABLE outpatient_payment_allocation_next RENAME TO outpatient_payment_allocation;
ALTER TABLE outpatient_refund_preview_next RENAME TO outpatient_refund_preview;
CREATE INDEX outpatient_collection_charge ON outpatient_payment_allocation(workspace_id,epoch,charge_item_id);
