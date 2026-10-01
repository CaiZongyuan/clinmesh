CREATE TABLE imaging_request_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_service_id TEXT,
  draft_indication TEXT,
  draft_service_snapshot_json TEXT
    CHECK (draft_service_snapshot_json IS NULL OR json_valid(draft_service_snapshot_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  CHECK (
    (draft_service_id IS NULL AND draft_indication IS NULL AND draft_service_snapshot_json IS NULL)
    OR (draft_service_id IS NOT NULL AND draft_indication IS NOT NULL
      AND draft_service_snapshot_json IS NOT NULL)
  )
) STRICT;

CREATE TABLE imaging_request_detail (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  exam_code TEXT NOT NULL CHECK (exam_code IN ('chest-ct-plain', 'chest-radiograph')),
  indication TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, request_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE imaging_study (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  study_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  exam_code TEXT NOT NULL CHECK (exam_code IN ('chest-ct-plain', 'chest-radiograph')),
  study_instance_uid TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_output_json TEXT NOT NULL CHECK (json_valid(asset_output_json)),
  performed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, study_id),
  UNIQUE (workspace_id, epoch, request_id),
  UNIQUE (workspace_id, epoch, study_instance_uid),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE imaging_report_content (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  diagnostic_report_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  report_revision INTEGER NOT NULL CHECK (report_revision > 0),
  report_content_sha256 TEXT NOT NULL CHECK (length(report_content_sha256) = 64),
  technique TEXT NOT NULL,
  findings TEXT NOT NULL,
  impression TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, diagnostic_report_id),
  FOREIGN KEY (workspace_id, epoch, study_id)
    REFERENCES imaging_study (workspace_id, epoch, study_id) ON DELETE RESTRICT
) STRICT;
