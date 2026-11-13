-- Rebuild referenced billing tables without altering existing clinical or financial facts.
CREATE TABLE charge_record_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  charge_item_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('registration', 'laboratory', 'medication', 'imaging', 'pathology', 'examination')),
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
  category TEXT NOT NULL CHECK (category IN ('laboratory', 'medication', 'imaging', 'pathology', 'examination')),
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
INSERT INTO payment_preview_next SELECT * FROM payment_preview;
DROP TABLE payment_preview;
DROP TABLE charge_record;
ALTER TABLE charge_record_next RENAME TO charge_record;
ALTER TABLE payment_preview_next RENAME TO payment_preview;
CREATE INDEX charge_record_queue_idx ON charge_record(workspace_id,epoch,category,status,created_at,charge_id);
CREATE UNIQUE INDEX charge_collection_owner ON charge_record(workspace_id,epoch,case_id,charge_item_id);
CREATE TABLE examination_request_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_service_id TEXT,
  draft_indication TEXT,
  draft_service_snapshot_json TEXT
    CHECK (draft_service_snapshot_json IS NULL OR json_valid(draft_service_snapshot_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES clinical_request_context (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  CHECK (
    (draft_service_id IS NULL AND draft_indication IS NULL AND draft_service_snapshot_json IS NULL)
    OR (draft_service_id IS NOT NULL AND draft_indication IS NOT NULL
      AND draft_service_snapshot_json IS NOT NULL)
  )
) STRICT;

CREATE TABLE examination_request_detail (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  exam_code TEXT NOT NULL CHECK (exam_code IN ('ecg-12-lead', 'tte')),
  indication TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, request_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE examination_report_content (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, diagnostic_report_id TEXT NOT NULL,
  request_id TEXT NOT NULL, case_id TEXT NOT NULL, content_json TEXT NOT NULL CHECK(json_valid(content_json)), issued_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,diagnostic_report_id),
  FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES laboratory_request(workspace_id,epoch,request_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,case_id) REFERENCES clinical_request_context(workspace_id,epoch,case_id) ON DELETE RESTRICT
) STRICT;
