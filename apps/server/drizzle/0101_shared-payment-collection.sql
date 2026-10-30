-- New transactions use one collection model. Historical payment tables are not
-- converted or read by the new owner; the explicit development cutover owns them.
CREATE UNIQUE INDEX clinical_request_collection_identity
  ON clinical_request_context(workspace_id,epoch,case_id,patient_id,encounter_id);

CREATE TABLE collection_transaction (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('outpatient','inpatient')), owner_id TEXT NOT NULL,
  patient_id TEXT NOT NULL, encounter_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('outpatient-charge','inpatient-deposit','inpatient-supplement')),
  preview_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen>=0),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','declined','ambiguous')),
  recovery_outcome TEXT NOT NULL CHECK(recovery_outcome IN ('success','declined','ambiguous')),
  correlation_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,payment_id), UNIQUE(workspace_id,epoch,preview_id),
  UNIQUE(workspace_id,epoch,payment_id,owner_id,amount_fen),
  CHECK((owner_kind='outpatient' AND purpose='outpatient-charge') OR
    (owner_kind='inpatient' AND purpose IN ('inpatient-deposit','inpatient-supplement'))),
  FOREIGN KEY(workspace_id,epoch,owner_id,patient_id,encounter_id)
    REFERENCES clinical_request_context(workspace_id,epoch,case_id,patient_id,encounter_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX collection_owner_history ON collection_transaction(workspace_id,epoch,owner_kind,owner_id,created_at DESC,payment_id DESC);

CREATE TABLE collection_tender (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','bank-card','mobile')),
  amount_fen INTEGER NOT NULL CHECK(amount_fen>=0), position INTEGER NOT NULL CHECK(position>=0),
  PRIMARY KEY(workspace_id,epoch,payment_id,method), UNIQUE(workspace_id,epoch,payment_id,position),
  FOREIGN KEY(workspace_id,epoch,payment_id) REFERENCES collection_transaction(workspace_id,epoch,payment_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE collection_resolution (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','declined')), resolved_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,payment_id),
  FOREIGN KEY(workspace_id,epoch,payment_id) REFERENCES collection_transaction(workspace_id,epoch,payment_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX charge_collection_owner ON charge_record(workspace_id,epoch,case_id,charge_item_id);
CREATE TABLE outpatient_payment_allocation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, payment_id TEXT NOT NULL,
  case_id TEXT NOT NULL, charge_item_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen>=0),
  PRIMARY KEY(workspace_id,epoch,payment_id),
  FOREIGN KEY(workspace_id,epoch,payment_id,case_id,amount_fen)
    REFERENCES collection_transaction(workspace_id,epoch,payment_id,owner_id,amount_fen) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,case_id,charge_item_id)
    REFERENCES charge_record(workspace_id,epoch,case_id,charge_item_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX outpatient_collection_charge ON outpatient_payment_allocation(workspace_id,epoch,charge_item_id);

CREATE TABLE outpatient_refund_preview (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL,
  payment_id TEXT NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen>0),
  source_version INTEGER NOT NULL CHECK(source_version>0), charge_version INTEGER NOT NULL,
  simulator_rule TEXT NOT NULL, actor_context_hash TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,payment_id) REFERENCES collection_transaction(workspace_id,epoch,payment_id) ON DELETE RESTRICT
) STRICT;
