CREATE TABLE pathology_request_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_service_id TEXT,
  draft_purpose TEXT,
  draft_service_snapshot_json TEXT
    CHECK (draft_service_snapshot_json IS NULL OR json_valid(draft_service_snapshot_json)),
  draft_source_procedure_json TEXT
    CHECK (draft_source_procedure_json IS NULL OR json_valid(draft_source_procedure_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  CHECK (
    (draft_service_id IS NULL AND draft_purpose IS NULL AND draft_service_snapshot_json IS NULL
      AND draft_source_procedure_json IS NULL)
    OR (draft_service_id IS NOT NULL AND draft_purpose IS NOT NULL
      AND draft_service_snapshot_json IS NOT NULL AND draft_source_procedure_json IS NOT NULL)
  )
) STRICT;

CREATE TABLE pathology_request_detail (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  exam_code TEXT NOT NULL CHECK (length(exam_code) BETWEEN 1 AND 64),
  purpose TEXT NOT NULL,
  source_procedure_reference TEXT NOT NULL CHECK (length(source_procedure_reference) BETWEEN 1 AND 512),
  source_procedure_json TEXT NOT NULL CHECK (json_valid(source_procedure_json)),
  PRIMARY KEY (workspace_id, epoch, request_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE pathology_study (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  study_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  exam_code TEXT NOT NULL CHECK (length(exam_code) BETWEEN 1 AND 64),
  study_instance_uid TEXT NOT NULL,
  specimen_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_output_json TEXT NOT NULL CHECK (json_valid(asset_output_json)),
  received_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, study_id),
  UNIQUE (workspace_id, epoch, request_id),
  UNIQUE (workspace_id, epoch, study_id, request_id),
  UNIQUE (workspace_id, epoch, study_instance_uid),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE pathology_report_content (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  diagnostic_report_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  report_revision INTEGER NOT NULL CHECK (report_revision > 0),
  report_content_sha256 TEXT NOT NULL CHECK (length(report_content_sha256) = 64),
  microscopy TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  immunohistochemistry TEXT NOT NULL,
  note TEXT NOT NULL,
  slide_count INTEGER NOT NULL CHECK (slide_count > 0),
  issued_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, diagnostic_report_id),
  FOREIGN KEY (workspace_id, epoch, study_id, request_id)
    REFERENCES pathology_study (workspace_id, epoch, study_id, request_id) ON DELETE RESTRICT
) STRICT;
