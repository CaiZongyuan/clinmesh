CREATE TABLE virtual_patient (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  virtual_patient_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  patient_id TEXT NOT NULL,
  clinical_summary_json TEXT NOT NULL CHECK (json_valid(clinical_summary_json)),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  PRIMARY KEY (workspace_id, epoch, virtual_patient_id),
  UNIQUE (workspace_id, epoch, patient_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES scenario_epoch_state (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX virtual_patient_available_idx
  ON virtual_patient (workspace_id, epoch, available, virtual_patient_id);

ALTER TABLE outpatient_case RENAME COLUMN triage_task_id TO initial_task_id;

CREATE TABLE virtual_patient_case (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  virtual_patient_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, virtual_patient_id),
  UNIQUE (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, virtual_patient_id)
    REFERENCES virtual_patient (workspace_id, epoch, virtual_patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
