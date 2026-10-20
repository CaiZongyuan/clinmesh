CREATE TABLE inpatient_diagnosis_confirmation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,admission_id,revision),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_diagnosis_entry (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, revision INTEGER NOT NULL,
  condition_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','secondary')),
  coding_json TEXT NOT NULL CHECK(json_valid(coding_json)), note TEXT,
  admission_condition TEXT NOT NULL CHECK(admission_condition IN ('1','2','3','4')), ordinal INTEGER NOT NULL CHECK(ordinal>0),
  PRIMARY KEY(workspace_id,epoch,admission_id,revision,condition_id), UNIQUE(workspace_id,epoch,admission_id,revision,ordinal),
  FOREIGN KEY(workspace_id,epoch,admission_id,revision) REFERENCES inpatient_diagnosis_confirmation(workspace_id,epoch,admission_id,revision) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX inpatient_diagnosis_primary ON inpatient_diagnosis_entry(workspace_id,epoch,admission_id,revision) WHERE role='primary';
CREATE TABLE inpatient_order (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, order_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('medication','service')), duration TEXT NOT NULL CHECK(duration IN ('long','temporary')),
  catalog_item_id TEXT NOT NULL, catalog_version INTEGER NOT NULL CHECK(catalog_version>0), display TEXT NOT NULL,
  dose_text TEXT NOT NULL, dose_quantity INTEGER NOT NULL CHECK(dose_quantity>0), unit TEXT NOT NULL,
  frequency_code TEXT NOT NULL CHECK(frequency_code IN ('QD','BID','PRN')), price_fen INTEGER NOT NULL CHECK(price_fen>=0),
  state TEXT NOT NULL CHECK(state IN ('signed','verified','stop-requested','stopped','completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), organization_id TEXT NOT NULL,
  signed_at TEXT NOT NULL, signed_by TEXT NOT NULL, verified_at TEXT, stopped_at TEXT,
  PRIMARY KEY(workspace_id,epoch,order_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_order_admission ON inpatient_order(workspace_id,epoch,admission_id,state);
CREATE TABLE inpatient_order_verification (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('verify','verify-stop')), order_version INTEGER NOT NULL CHECK(order_version>0),
  actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, virtual_time TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,order_id,kind),
  FOREIGN KEY(workspace_id,epoch,order_id) REFERENCES inpatient_order(workspace_id,epoch,order_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_execution (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, execution_id TEXT NOT NULL, order_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','dispensed','completed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), administration_id TEXT, reason TEXT,
  PRIMARY KEY(workspace_id,epoch,execution_id), UNIQUE(workspace_id,epoch,order_id,scheduled_for),
  FOREIGN KEY(workspace_id,epoch,order_id) REFERENCES inpatient_order(workspace_id,epoch,order_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_dispense (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, dispense_id TEXT NOT NULL, execution_id TEXT NOT NULL, lot_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity>0), dispensed_at TEXT NOT NULL, dispensed_by TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,dispense_id),
  FOREIGN KEY(workspace_id,epoch,execution_id) REFERENCES inpatient_execution(workspace_id,epoch,execution_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,lot_id) REFERENCES inventory_lot(workspace_id,epoch,lot_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inventory_movement_next (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, movement_id TEXT NOT NULL,
  prescription_id TEXT, inpatient_dispense_id TEXT, lot_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), occurred_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,movement_id), CHECK((prescription_id IS NOT NULL) != (inpatient_dispense_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,epoch,prescription_id) REFERENCES prescription(workspace_id,epoch,prescription_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,inpatient_dispense_id) REFERENCES inpatient_dispense(workspace_id,epoch,dispense_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,lot_id) REFERENCES inventory_lot(workspace_id,epoch,lot_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO inventory_movement_next(workspace_id,epoch,movement_id,prescription_id,lot_id,quantity,occurred_at)
 SELECT workspace_id,epoch,movement_id,prescription_id,lot_id,quantity,occurred_at FROM inventory_movement;
DROP TABLE inventory_movement;
ALTER TABLE inventory_movement_next RENAME TO inventory_movement;
CREATE INDEX inventory_movement_prescription_idx ON inventory_movement(workspace_id,epoch,prescription_id,occurred_at,movement_id);
CREATE INDEX inventory_movement_inpatient_idx ON inventory_movement(workspace_id,epoch,inpatient_dispense_id,occurred_at,movement_id);
CREATE TABLE inpatient_charge_next (
 workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, charge_id TEXT NOT NULL, admission_id TEXT NOT NULL,
 organization_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, service_date TEXT NOT NULL,
 amount_fen INTEGER NOT NULL, virtual_time TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), reversal_of TEXT, reason TEXT,
 PRIMARY KEY(workspace_id,epoch,charge_id), UNIQUE(workspace_id,epoch,admission_id,kind,source_id,service_date),
 UNIQUE(workspace_id,epoch,reversal_of), CHECK((reversal_of IS NULL AND amount_fen>=0) OR (reversal_of IS NOT NULL AND amount_fen<=0 AND reason IS NOT NULL)),
 FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,epoch,reversal_of) REFERENCES inpatient_charge_next(workspace_id,epoch,charge_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO inpatient_charge_next(workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time)
 SELECT workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time FROM inpatient_charge;
DROP TABLE inpatient_charge;
ALTER TABLE inpatient_charge_next RENAME TO inpatient_charge;
