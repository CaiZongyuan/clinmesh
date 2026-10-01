CREATE TABLE imaging_case_preparation (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  catalog_pack_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  catalog_hash TEXT NOT NULL CHECK (length(catalog_hash) = 64),
  exams_json TEXT NOT NULL CHECK (json_valid(exams_json)),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, case_id, revision),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, profile_id, profile_revision)
    REFERENCES synthetic_patient_profile_revision (workspace_id, profile_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE imaging_case_binding (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  exam_code TEXT NOT NULL CHECK (exam_code IN ('chest-ct-plain', 'chest-radiograph')),
  preparation_revision INTEGER NOT NULL CHECK (preparation_revision > 0),
  matching_profile_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_output_json TEXT NOT NULL CHECK (json_valid(asset_output_json)),
  report_revision INTEGER NOT NULL CHECK (report_revision > 0),
  report_content_sha256 TEXT NOT NULL CHECK (length(report_content_sha256) = 64),
  bound_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, case_id, source_hash, exam_code),
  FOREIGN KEY (workspace_id, case_id, preparation_revision)
    REFERENCES imaging_case_preparation (workspace_id, case_id, revision) ON DELETE RESTRICT
) STRICT;
