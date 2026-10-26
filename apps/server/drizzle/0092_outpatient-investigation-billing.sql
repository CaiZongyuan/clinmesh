-- Applied with foreign_keys disabled outside the migration transaction. Existing
-- references retain their final table names; foreign_key_check runs before commit.
CREATE TABLE outpatient_investigation_preview_target (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  charge_item_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, preview_id)
) STRICT;

-- A recorded allocation is authoritative for a consumed preview. An unused
-- legacy preview is recoverable only when its case/category identifies one fee.
-- NOT NULL rejects missing or ambiguous original targets before any rebuild.
INSERT INTO outpatient_investigation_preview_target
SELECT preview.workspace_id, preview.epoch, preview.preview_id, (
  SELECT CASE WHEN COUNT(*) = 1 THEN MIN(charge.charge_item_id) END
  FROM charge_record AS charge
  WHERE charge.workspace_id = preview.workspace_id AND charge.epoch = preview.epoch
    AND charge.case_id = preview.case_id AND charge.category = preview.category
    AND (
      NOT EXISTS (
        SELECT 1 FROM payment_transaction AS payment
        WHERE payment.workspace_id = preview.workspace_id AND payment.epoch = preview.epoch
          AND payment.preview_id = preview.preview_id
      ) OR EXISTS (
        SELECT 1 FROM payment_transaction AS payment
        JOIN payment_allocation AS allocation USING (workspace_id, epoch, payment_id)
        WHERE payment.workspace_id = preview.workspace_id AND payment.epoch = preview.epoch
          AND payment.preview_id = preview.preview_id
          AND allocation.charge_item_id = charge.charge_item_id
      )
    )
)
FROM payment_preview AS preview;

CREATE TABLE charge_record_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  charge_item_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('registration', 'laboratory', 'medication', 'imaging', 'pathology')),
  source_reference TEXT NOT NULL,
  description_zh TEXT NOT NULL,
  description_en TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_fen INTEGER NOT NULL CHECK (unit_price_fen >= 0),
  total_fen INTEGER NOT NULL CHECK (total_fen >= 0),
  status TEXT NOT NULL CHECK (status IN ('billable', 'payment-pending', 'paid', 'declined', 'ambiguous')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, charge_id),
  UNIQUE (workspace_id, epoch, charge_item_id),
  UNIQUE (workspace_id, epoch, category, source_reference),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO charge_record_next SELECT * FROM charge_record;

CREATE TABLE payment_preview_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('laboratory', 'medication', 'imaging', 'pathology')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  expected_charge_version INTEGER NOT NULL CHECK (expected_charge_version > 0),
  simulator_rule TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  tenders_json TEXT,
  actor_context_hash TEXT,
  charge_item_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, charge_item_id)
    REFERENCES charge_record (workspace_id, epoch, charge_item_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO payment_preview_next
SELECT preview.*, target.charge_item_id
FROM payment_preview AS preview
JOIN outpatient_investigation_preview_target AS target USING (workspace_id, epoch, preview_id);

CREATE TABLE payment_transaction_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('laboratory', 'medication', 'imaging', 'pathology')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'declined', 'ambiguous')),
  correlation_id TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recovery_outcome TEXT NOT NULL DEFAULT 'ambiguous' CHECK (recovery_outcome IN ('success', 'declined', 'ambiguous')),
  PRIMARY KEY (workspace_id, epoch, payment_id),
  UNIQUE (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, preview_id)
    REFERENCES payment_preview (workspace_id, epoch, preview_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO payment_transaction_next SELECT * FROM payment_transaction;

DROP TABLE payment_transaction;
DROP TABLE payment_preview;
DROP TABLE charge_record;
ALTER TABLE charge_record_next RENAME TO charge_record;
ALTER TABLE payment_preview_next RENAME TO payment_preview;
ALTER TABLE payment_transaction_next RENAME TO payment_transaction;
DROP TABLE outpatient_investigation_preview_target;

CREATE INDEX charge_record_queue_idx
  ON charge_record (workspace_id, epoch, category, status, created_at, charge_id);
CREATE INDEX payment_transaction_case_history_idx
  ON payment_transaction (workspace_id, epoch, case_id, created_at DESC, payment_id DESC);

CREATE TABLE outpatient_investigation_billing (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  payment_policy TEXT NOT NULL CHECK (payment_policy IN ('legacy-unbilled', 'prepaid-v1')),
  charge_item_id TEXT,
  price_json TEXT CHECK (price_json IS NULL OR json_valid(price_json)),
  released_at TEXT,
  release_json TEXT CHECK (release_json IS NULL OR json_valid(release_json)),
  PRIMARY KEY (workspace_id, epoch, request_id),
  UNIQUE (workspace_id, epoch, charge_item_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, charge_item_id)
    REFERENCES charge_record (workspace_id, epoch, charge_item_id) ON DELETE RESTRICT,
  CHECK (
    (payment_policy = 'legacy-unbilled' AND charge_item_id IS NULL AND price_json IS NULL
      AND released_at IS NULL AND release_json IS NULL)
    OR (payment_policy = 'prepaid-v1' AND charge_item_id IS NOT NULL AND price_json IS NOT NULL)
  ),
  CHECK ((released_at IS NULL AND release_json IS NULL) OR (released_at IS NOT NULL AND release_json IS NOT NULL))
) STRICT;

INSERT INTO outpatient_investigation_billing (workspace_id, epoch, request_id, case_id, payment_policy)
SELECT request.workspace_id, request.epoch, request.request_id, request.case_id, 'legacy-unbilled'
FROM laboratory_request AS request
JOIN outpatient_case AS outpatient
  ON outpatient.workspace_id = request.workspace_id AND outpatient.epoch = request.epoch
    AND outpatient.case_id = request.case_id;
