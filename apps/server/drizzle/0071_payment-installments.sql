ALTER TABLE payment_preview ADD COLUMN tenders_json TEXT;
ALTER TABLE payment_preview ADD COLUMN actor_context_hash TEXT;
ALTER TABLE payment_transaction ADD COLUMN recovery_outcome TEXT NOT NULL DEFAULT 'ambiguous'
  CHECK (recovery_outcome IN ('success', 'declined', 'ambiguous'));

CREATE TABLE payment_allocation (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  charge_item_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  PRIMARY KEY (workspace_id, epoch, payment_id, charge_item_id),
  FOREIGN KEY (workspace_id, epoch, payment_id)
    REFERENCES payment_transaction (workspace_id, epoch, payment_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, charge_item_id)
    REFERENCES charge_record (workspace_id, epoch, charge_item_id) ON DELETE RESTRICT
) STRICT;

-- A legacy attempt can only be assigned when its original receivable is unambiguous.
CREATE TABLE payment_migration_guard (unmapped INTEGER NOT NULL CHECK (unmapped = 0)) STRICT;
INSERT INTO payment_migration_guard
SELECT COUNT(*) FROM payment_transaction AS payment
WHERE (SELECT COUNT(*) FROM charge_record AS charge
  WHERE charge.workspace_id = payment.workspace_id AND charge.epoch = payment.epoch
    AND charge.case_id = payment.case_id AND charge.category = payment.category) <> 1;
DROP TABLE payment_migration_guard;

INSERT INTO payment_allocation
SELECT payment.workspace_id, payment.epoch, payment.payment_id, charge.charge_item_id, payment.amount_fen
FROM payment_transaction AS payment JOIN charge_record AS charge
  ON charge.workspace_id = payment.workspace_id AND charge.epoch = payment.epoch
    AND charge.case_id = payment.case_id AND charge.category = payment.category;

CREATE INDEX payment_allocation_charge_idx
  ON payment_allocation (workspace_id, epoch, charge_item_id);

CREATE TABLE payment_tender (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank-card', 'mobile')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (workspace_id, epoch, payment_id, method),
  FOREIGN KEY (workspace_id, epoch, payment_id)
    REFERENCES payment_transaction (workspace_id, epoch, payment_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO payment_tender
SELECT workspace_id, epoch, payment_id, 'cash', amount_fen, 0 FROM payment_transaction;

CREATE TABLE payment_resolution (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'declined')),
  resolved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, payment_id),
  FOREIGN KEY (workspace_id, epoch, payment_id)
    REFERENCES payment_transaction (workspace_id, epoch, payment_id) ON DELETE RESTRICT
) STRICT;
