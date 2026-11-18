CREATE TABLE clinical_quality_override (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  override_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate IN ('outpatient-prescription', 'outpatient-completion', 'inpatient-order', 'inpatient-pci-plan', 'inpatient-discharge')),
  operation TEXT NOT NULL,
  subject_reference TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  alerts_json TEXT NOT NULL CHECK (json_valid(alerts_json) AND json_array_length(alerts_json) > 0),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('documented-contraindication', 'external-result-verified', 'result-pending-follow-up', 'patient-informed-refusal', 'clinical-judgement', 'emergency-care')),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  actor_id TEXT NOT NULL,
  practitioner_role_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, override_id)
) STRICT;

CREATE INDEX clinical_quality_override_subject_idx
  ON clinical_quality_override (workspace_id, epoch, subject_reference, gate);
