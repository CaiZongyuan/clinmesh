CREATE TABLE inpatient_discharge_event (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, event_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issue','depart','recall','clear')), reason TEXT NOT NULL, bed_id TEXT NOT NULL, departure_method TEXT,
  reverses_event_id TEXT, actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, virtual_time TEXT NOT NULL,
  CHECK((kind='depart') = (departure_method IS NOT NULL)),
  CHECK((kind='recall') = (reverses_event_id IS NOT NULL)),
  CHECK(departure_method IS NULL OR departure_method IN ('home','transfer','against-advice','death','other')),
  PRIMARY KEY(workspace_id,epoch,event_id),
  FOREIGN KEY(workspace_id,epoch,bed_id) REFERENCES inpatient_bed(workspace_id,epoch,bed_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,reverses_event_id) REFERENCES inpatient_discharge_event(workspace_id,epoch,event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE inpatient_settlement (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, settlement_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)), settled_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,settlement_id), UNIQUE(workspace_id,epoch,admission_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_settlement_transaction (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, transaction_id TEXT NOT NULL, admission_id TEXT NOT NULL, settlement_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('supplement','refund')), amount_fen INTEGER NOT NULL, source_deposit_id TEXT, virtual_time TEXT NOT NULL,
  CHECK((kind='supplement' AND amount_fen>0 AND source_deposit_id IS NULL) OR (kind='refund' AND amount_fen<0 AND source_deposit_id IS NOT NULL)),
  PRIMARY KEY(workspace_id,epoch,transaction_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,settlement_id) REFERENCES inpatient_settlement(workspace_id,epoch,settlement_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,source_deposit_id) REFERENCES inpatient_deposit(workspace_id,epoch,transaction_id) ON DELETE RESTRICT
) STRICT;
