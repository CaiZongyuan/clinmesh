CREATE TABLE development_reset_required_for_synthea_case_v2 (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
) STRICT;

INSERT INTO development_reset_required_for_synthea_case_v2 (row_count)
SELECT
  (SELECT COUNT(*) FROM synthetic_patient_profile)
  + (SELECT COUNT(*) FROM synthetic_case_instance)
  + (SELECT COUNT(*) FROM scenario_generation_job)
  + (SELECT COUNT(*) FROM scenario_dataset)
  + (SELECT COUNT(*) FROM scenario_package);

DROP TABLE development_reset_required_for_synthea_case_v2;

DROP TABLE scenario_generation_job;
DROP TABLE scenario_package;
DROP TABLE scenario_dataset;

DROP TABLE synthetic_patient_materialization;
DROP TABLE synthetic_patient_profile_batch;
DROP TABLE synthetic_patient_profile_revision;
DROP TABLE synthetic_patient_profile;

CREATE TABLE synthetic_patient_profile (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  source_patient_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  display_name TEXT NOT NULL,
  mrn TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  demographics_json TEXT NOT NULL CHECK (json_valid(demographics_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  raw_source_json TEXT NOT NULL CHECK (json_valid(raw_source_json)),
  generation_json TEXT NOT NULL CHECK (json_valid(generation_json)),
  localization_provenance_json TEXT
    CHECK (localization_provenance_json IS NULL OR json_valid(localization_provenance_json)),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id),
  UNIQUE (workspace_id, batch_id, source_patient_id),
  UNIQUE (workspace_id, mrn),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX synthetic_patient_profile_list_idx
  ON synthetic_patient_profile (workspace_id, updated_at DESC, profile_id);

CREATE TABLE synthetic_patient_profile_batch (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT 'synthea' CHECK (provider_id = 'synthea'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, batch_id),
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES synthetic_patient_profile (workspace_id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX synthetic_patient_profile_batch_idx
  ON synthetic_patient_profile_batch (workspace_id, batch_id, profile_id);

CREATE TABLE synthetic_patient_profile_revision (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  demographics_json TEXT NOT NULL CHECK (json_valid(demographics_json)),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, revision),
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES synthetic_patient_profile (workspace_id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE synthetic_patient_materialization (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, profile_id, profile_revision),
  UNIQUE (workspace_id, epoch, patient_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, profile_id, profile_revision)
    REFERENCES synthetic_patient_profile_revision (workspace_id, profile_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE scenario_generation_job (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  result_profile_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(result_profile_ids_json)),
  result_case_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(result_case_ids_json)),
  error_code TEXT,
  error_message TEXT,
  created_by_actor_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL
      AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL
      AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_code IS NOT NULL AND error_message IS NOT NULL)
  )
) STRICT;

CREATE INDEX scenario_generation_job_dispatch_idx
  ON scenario_generation_job (status, created_at, job_id);

ALTER TABLE prescription_item
ADD COLUMN dispensed_quantity INTEGER NOT NULL DEFAULT 0
CHECK (dispensed_quantity >= 0 AND dispensed_quantity <= quantity);
