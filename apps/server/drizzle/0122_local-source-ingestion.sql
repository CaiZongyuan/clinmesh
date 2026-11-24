CREATE TABLE local_ingestion_batch (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_system_id TEXT NOT NULL,
  hospital_id TEXT NOT NULL,
  expected_count INTEGER NOT NULL CHECK (expected_count > 0),
  received_count INTEGER NOT NULL CHECK (received_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'complete')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, batch_id)
) STRICT;

CREATE TABLE local_ingestion_quarantine (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_system_id TEXT NOT NULL,
  external_patient_id TEXT NOT NULL,
  target_patient_id TEXT,
  confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  threshold REAL NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  decision TEXT NOT NULL CHECK (decision IN ('matched', 'distinct-patient', 'quarantined')),
  resolution_status TEXT NOT NULL CHECK (
    resolution_status IN ('auto-matched', 'pending-review', 'confirmed-merged', 'rejected-distinct')
  ),
  mismatch_reasons_json TEXT NOT NULL,
  patient_payload_json TEXT NOT NULL,
  resolved_by_actor_id TEXT,
  resolved_by_practitioner_id TEXT,
  resolved_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, candidate_id),
  UNIQUE (workspace_id, epoch, batch_id, source_system_id, external_patient_id),
  FOREIGN KEY (workspace_id, epoch, batch_id)
    REFERENCES local_ingestion_batch (workspace_id, epoch, batch_id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE local_ingestion_record (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  ingestion_record_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_system_id TEXT NOT NULL,
  patient_id TEXT,
  fhir_observation_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, ingestion_record_id),
  FOREIGN KEY (workspace_id, epoch, batch_id)
    REFERENCES local_ingestion_batch (workspace_id, epoch, batch_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, epoch, candidate_id)
    REFERENCES local_ingestion_quarantine (workspace_id, epoch, candidate_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX local_ingestion_batch_status_idx
  ON local_ingestion_batch (workspace_id, epoch, source_system_id, status, created_at);

CREATE INDEX local_ingestion_quarantine_status_idx
  ON local_ingestion_quarantine (workspace_id, epoch, resolution_status, source_system_id, created_at);

CREATE INDEX local_ingestion_quarantine_ext_idx
  ON local_ingestion_quarantine (workspace_id, epoch, source_system_id, external_patient_id, resolution_status);

CREATE INDEX local_ingestion_record_patient_idx
  ON local_ingestion_record (workspace_id, epoch, patient_id, batch_id, candidate_id);

CREATE INDEX local_ingestion_record_candidate_idx
  ON local_ingestion_record (workspace_id, epoch, candidate_id);
