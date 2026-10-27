ALTER TABLE synthetic_patient_profile ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'synthea'
  CHECK (provider_id IN ('synthea', 'clinmesh-authored'));
ALTER TABLE synthetic_patient_profile ADD COLUMN authoring_json TEXT
  CHECK (authoring_json IS NULL OR json_valid(authoring_json));

CREATE TABLE synthetic_patient_profile_batch_v2 (
  workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('synthea', 'clinmesh-authored')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, batch_id),
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES synthetic_patient_profile (workspace_id, profile_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO synthetic_patient_profile_batch_v2 SELECT * FROM synthetic_patient_profile_batch;
DROP TABLE synthetic_patient_profile_batch;
ALTER TABLE synthetic_patient_profile_batch_v2 RENAME TO synthetic_patient_profile_batch;
CREATE INDEX synthetic_patient_profile_batch_idx
  ON synthetic_patient_profile_batch (workspace_id, batch_id, profile_id);
