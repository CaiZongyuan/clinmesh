CREATE TABLE practitioner_role_binding_new (
  workspace_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  practitioner_id TEXT NOT NULL,
  role_code TEXT NOT NULL CHECK (role_code IN ('registrar', 'triage-nurse', 'outpatient-doctor', 'cashier', 'pharmacist', 'administrator', 'inpatient-doctor', 'ward-nurse', 'medical-records')),
  organization_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (workspace_id, practitioner_role_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO practitioner_role_binding_new SELECT * FROM practitioner_role_binding;
DROP TABLE practitioner_role_binding;
ALTER TABLE practitioner_role_binding_new RENAME TO practitioner_role_binding;

CREATE TABLE inpatient_ward (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, ward_id TEXT NOT NULL,
  organization_id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, ward_id),
  FOREIGN KEY (workspace_id, epoch) REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_bed (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, bed_id TEXT NOT NULL,
  ward_id TEXT NOT NULL, room_id TEXT NOT NULL, name TEXT NOT NULL,
  daily_price_fen INTEGER NOT NULL CHECK (daily_price_fen >= 0),
  PRIMARY KEY (workspace_id, epoch, bed_id),
  FOREIGN KEY (workspace_id, epoch, ward_id) REFERENCES inpatient_ward (workspace_id, epoch, ward_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_referral (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, referral_id TEXT NOT NULL,
  patient_id TEXT NOT NULL, encounter_id TEXT NOT NULL, ward_id TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('issued', 'received')),
  issued_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, referral_id),
  FOREIGN KEY (workspace_id, epoch, ward_id) REFERENCES inpatient_ward (workspace_id, epoch, ward_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_admission (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL,
  patient_id TEXT NOT NULL, inpatient_number TEXT NOT NULL,
  admission_route TEXT NOT NULL CHECK(admission_route IN ('direct', 'outpatient', 'transfer')),
  referral_id TEXT, source_case_id TEXT, ward_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('registered', 'admitted', 'discharge-pending', 'departed', 'cleared')),
  financial_status TEXT NOT NULL DEFAULT 'open' CHECK(financial_status IN ('open', 'settled')),
  record_status TEXT NOT NULL DEFAULT 'open' CHECK(record_status IN ('open', 'reviewed', 'archived')),
  registered_at TEXT NOT NULL, admitted_at TEXT,
  PRIMARY KEY (workspace_id, epoch, admission_id),
  UNIQUE (workspace_id, epoch, inpatient_number),
  UNIQUE (workspace_id, epoch, referral_id),
  FOREIGN KEY (workspace_id, epoch, ward_id) REFERENCES inpatient_ward (workspace_id, epoch, ward_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, source_case_id) REFERENCES synthetic_case_materialization (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, referral_id) REFERENCES inpatient_referral (workspace_id, epoch, referral_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_bed_occupancy (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, occupancy_id TEXT NOT NULL,
  bed_id TEXT NOT NULL, admission_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  PRIMARY KEY (workspace_id, epoch, occupancy_id),
  FOREIGN KEY (workspace_id, epoch, bed_id) REFERENCES inpatient_bed (workspace_id, epoch, bed_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, admission_id) REFERENCES inpatient_admission (workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX inpatient_active_bed ON inpatient_bed_occupancy (workspace_id, epoch, bed_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX inpatient_active_admission_bed ON inpatient_bed_occupancy (workspace_id, epoch, admission_id) WHERE ended_at IS NULL;
CREATE TABLE inpatient_deposit (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, transaction_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0), virtual_time TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, transaction_id),
  FOREIGN KEY (workspace_id, epoch, admission_id) REFERENCES inpatient_admission (workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_charge (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, charge_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  organization_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, service_date TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen >= 0), virtual_time TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, charge_id),
  UNIQUE (workspace_id, epoch, admission_id, kind, source_id, service_date),
  FOREIGN KEY (workspace_id, epoch, admission_id) REFERENCES inpatient_admission (workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;
