CREATE TABLE inpatient_vital_signs (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  vital_json TEXT NOT NULL CHECK (json_valid(vital_json)),
  observation_id TEXT NOT NULL,
  observation_version TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, admission_id, revision),
  FOREIGN KEY (workspace_id, epoch, admission_id)
    REFERENCES inpatient_admission (workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE clinical_risk_assessment (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  assessment_json TEXT NOT NULL CHECK (json_valid(assessment_json)),
  observation_id TEXT NOT NULL,
  observation_version TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id, revision),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES clinical_request_context (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

ALTER TABLE triage_record ADD COLUMN observation_id TEXT;
ALTER TABLE triage_record ADD COLUMN observation_version TEXT;
