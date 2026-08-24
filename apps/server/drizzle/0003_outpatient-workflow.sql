CREATE TABLE outpatient_catalog (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('department', 'visit-type', 'laboratory', 'medication')),
  code TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  price_fen INTEGER NOT NULL DEFAULT 0 CHECK (price_fen >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  PRIMARY KEY (workspace_id, epoch, item_id),
  UNIQUE (workspace_id, epoch, kind, code),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES scenario_epoch_state (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX outpatient_catalog_lookup_idx
  ON outpatient_catalog (workspace_id, epoch, kind, active, item_id);

CREATE TABLE outpatient_case (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  triage_task_id TEXT NOT NULL,
  doctor_task_id TEXT,
  laboratory_task_id TEXT,
  pharmacy_task_id TEXT,
  service_request_id TEXT,
  diagnostic_report_id TEXT,
  prescription_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting-triage', 'awaiting-doctor', 'first-visit',
    'awaiting-lab-payment', 'awaiting-lis', 'awaiting-report',
    'awaiting-revisit', 'revisit-draft', 'awaiting-medication-payment',
    'awaiting-dispense', 'completed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  arrived_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  UNIQUE (workspace_id, epoch, registration_id),
  UNIQUE (workspace_id, epoch, encounter_id),
  UNIQUE (workspace_id, epoch, triage_task_id),
  FOREIGN KEY (workspace_id, epoch, scenario_run_id)
    REFERENCES scenario_run (workspace_id, epoch, scenario_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, department_id)
    REFERENCES outpatient_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX outpatient_case_queue_idx
  ON outpatient_case (workspace_id, epoch, status, department_id, arrived_at, case_id);

CREATE INDEX outpatient_case_patient_idx
  ON outpatient_case (workspace_id, epoch, patient_id, arrived_at DESC);

CREATE TABLE registration (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  visit_type_id TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered', 'triaged', 'in-progress', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, registration_id),
  UNIQUE (workspace_id, epoch, registration_number),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, visit_type_id)
    REFERENCES outpatient_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE triage_record (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  triage_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  acuity_code TEXT NOT NULL,
  chief_complaint TEXT NOT NULL,
  vital_json TEXT NOT NULL CHECK (json_valid(vital_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, triage_id),
  UNIQUE (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE clinical_draft (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  draft_kind TEXT NOT NULL CHECK (draft_kind IN ('first-visit', 'revisit', 'document')),
  version INTEGER NOT NULL CHECK (version > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id, draft_kind),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE prescription (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  prescription_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'signed', 'paid', 'dispensed')),
  version INTEGER NOT NULL CHECK (version > 0),
  authored_by TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  signed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, prescription_id),
  UNIQUE (workspace_id, epoch, prescription_number),
  UNIQUE (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE prescription_item (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  medication_request_id TEXT NOT NULL,
  medication_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  dose_text TEXT NOT NULL,
  frequency_code TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, prescription_id, medication_request_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, medication_id)
    REFERENCES outpatient_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE charge_record (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  charge_item_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('registration', 'laboratory', 'medication')),
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

CREATE INDEX charge_record_queue_idx
  ON charge_record (workspace_id, epoch, category, status, created_at, charge_id);

CREATE TABLE payment_preview (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('laboratory', 'medication')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  expected_charge_version INTEGER NOT NULL CHECK (expected_charge_version > 0),
  simulator_rule TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE payment_transaction (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('laboratory', 'medication')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'declined', 'ambiguous')),
  correlation_id TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, payment_id),
  UNIQUE (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, preview_id)
    REFERENCES payment_preview (workspace_id, epoch, preview_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE inventory_lot (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  medication_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  lot_number TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL CHECK (quantity_on_hand >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, epoch, lot_id),
  UNIQUE (workspace_id, epoch, medication_id, location_id, lot_number),
  FOREIGN KEY (workspace_id, epoch, medication_id)
    REFERENCES outpatient_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX inventory_lot_available_idx
  ON inventory_lot (workspace_id, epoch, location_id, medication_id, expires_on, quantity_on_hand);

CREATE TABLE inventory_movement (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, movement_id),
  UNIQUE (workspace_id, epoch, prescription_id, lot_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, lot_id)
    REFERENCES inventory_lot (workspace_id, epoch, lot_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE dispense (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  dispense_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  medication_dispense_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed')),
  dispensed_by TEXT NOT NULL,
  dispensed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, dispense_id),
  UNIQUE (workspace_id, epoch, prescription_id),
  UNIQUE (workspace_id, epoch, medication_dispense_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT
) STRICT;
