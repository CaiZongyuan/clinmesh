CREATE TABLE clinical_fact_verification (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  item_code TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  source_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('verified', 'rejected')),
  note TEXT,
  actor_id TEXT NOT NULL,
  practitioner_id TEXT,
  practitioner_role_id TEXT,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, verification_id),
  UNIQUE (workspace_id, epoch, subject_kind, subject_id, verification_id)
) STRICT;

CREATE INDEX clinical_fact_verification_subject_idx
  ON clinical_fact_verification (workspace_id, epoch, subject_kind, subject_id, fact_id, verified_at);

CREATE INDEX clinical_fact_verification_patient_idx
  ON clinical_fact_verification (workspace_id, epoch, patient_id, fact_id, verified_at);
