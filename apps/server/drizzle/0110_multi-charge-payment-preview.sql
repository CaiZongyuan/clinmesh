CREATE TABLE multi_charge_payment_preview (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  expected_versions_json TEXT NOT NULL CHECK (json_valid(expected_versions_json)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  simulator_rule TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, case_id) REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
