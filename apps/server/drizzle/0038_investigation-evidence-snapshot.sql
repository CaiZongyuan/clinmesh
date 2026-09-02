ALTER TABLE laboratory_report_acknowledgement
  RENAME TO laboratory_report_acknowledgement_legacy_v3;
ALTER TABLE laboratory_report_revision
  RENAME TO laboratory_report_revision_legacy_v3;
ALTER TABLE laboratory_request RENAME TO laboratory_request_legacy_v3;
ALTER TABLE investigation_result_snapshot
  RENAME TO investigation_result_snapshot_legacy_v3;

CREATE TABLE investigation_result_snapshot (
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  requested_concept_json TEXT NOT NULL CHECK (json_valid(requested_concept_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  source TEXT NOT NULL CHECK (source IN ('synthea-exact', 'investigation-agent')),
  model_id TEXT,
  prompt_version TEXT,
  prompt_hash TEXT CHECK (prompt_hash IS NULL OR length(prompt_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  output_hash TEXT NOT NULL CHECK (length(output_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, snapshot_id),
  UNIQUE (workspace_id, case_id, catalog_item_id, input_hash),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT,
  CHECK (
    (source = 'synthea-exact' AND model_id IS NULL
      AND prompt_version IS NULL AND prompt_hash IS NULL)
    OR (source = 'investigation-agent' AND model_id IS NOT NULL
      AND prompt_version IS NOT NULL AND prompt_hash IS NOT NULL)
  )
) STRICT;

INSERT INTO investigation_result_snapshot
SELECT * FROM investigation_result_snapshot_legacy_v3;

CREATE TABLE laboratory_request (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  reference_json TEXT NOT NULL CHECK (json_valid(reference_json)),
  result_snapshot_id TEXT,
  indication_code TEXT NOT NULL,
  service_request_id TEXT NOT NULL,
  execution_task_id TEXT NOT NULL,
  diagnostic_report_id TEXT,
  generation_error_code TEXT,
  generation_error_message TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'issued', 'accepted', 'in-progress', 'generation-failed',
    'reported', 'acknowledged', 'cancelled'
  )),
  version INTEGER NOT NULL CHECK (version > 0),
  authored_by TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  accepted_at TEXT,
  started_at TEXT,
  reported_at TEXT,
  acknowledged_at TEXT,
  cancelled_at TEXT,
  service_snapshot_json TEXT
    CHECK (service_snapshot_json IS NULL OR json_valid(service_snapshot_json)),
  PRIMARY KEY (workspace_id, epoch, request_id),
  UNIQUE (workspace_id, epoch, service_request_id),
  UNIQUE (workspace_id, epoch, execution_task_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, result_snapshot_id)
    REFERENCES investigation_result_snapshot (workspace_id, snapshot_id) ON DELETE RESTRICT,
  CHECK (
    (generation_error_code IS NULL AND generation_error_message IS NULL)
    OR (generation_error_code IS NOT NULL AND generation_error_message IS NOT NULL)
  )
) STRICT;

INSERT INTO laboratory_request (
  workspace_id, epoch, request_id, case_id, catalog_item_id, reference_json,
  result_snapshot_id, indication_code, service_request_id, execution_task_id,
  diagnostic_report_id, generation_error_code, generation_error_message,
  status, version, authored_by, authored_at, accepted_at, started_at,
  reported_at, acknowledged_at, cancelled_at, service_snapshot_json
)
SELECT
  workspace_id, epoch, request_id, case_id, catalog_item_id, reference_json,
  result_snapshot_id, indication_code, service_request_id, execution_task_id,
  diagnostic_report_id, generation_error_code, generation_error_message,
  status, version, authored_by, authored_at, accepted_at, started_at,
  reported_at, acknowledged_at, cancelled_at, service_snapshot_json
FROM laboratory_request_legacy_v3;

CREATE TABLE laboratory_report_acknowledgement (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  acknowledgement_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  diagnostic_report_id TEXT NOT NULL,
  acknowledged_by TEXT NOT NULL,
  acknowledged_by_practitioner_role_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  request_version INTEGER NOT NULL CHECK (request_version > 0),
  PRIMARY KEY (workspace_id, epoch, acknowledgement_id),
  UNIQUE (workspace_id, epoch, diagnostic_report_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO laboratory_report_acknowledgement
SELECT * FROM laboratory_report_acknowledgement_legacy_v3;

CREATE TABLE laboratory_report_revision (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  diagnostic_report_id TEXT NOT NULL,
  revision_of_diagnostic_report_id TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  corrected_by TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, revision_id),
  UNIQUE (workspace_id, epoch, diagnostic_report_id),
  UNIQUE (workspace_id, epoch, revision_of_diagnostic_report_id),
  UNIQUE (workspace_id, epoch, provenance_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO laboratory_report_revision
SELECT * FROM laboratory_report_revision_legacy_v3;

DROP TABLE laboratory_report_acknowledgement_legacy_v3;
DROP TABLE laboratory_report_revision_legacy_v3;
DROP TABLE laboratory_request_legacy_v3;
DROP TABLE investigation_result_snapshot_legacy_v3;

CREATE UNIQUE INDEX laboratory_request_diagnostic_report_unique
  ON laboratory_request (workspace_id, epoch, diagnostic_report_id)
  WHERE diagnostic_report_id IS NOT NULL;

CREATE UNIQUE INDEX laboratory_request_active_item_unique
  ON laboratory_request (workspace_id, epoch, case_id, catalog_item_id)
  WHERE status IN ('issued', 'accepted', 'in-progress', 'generation-failed');

CREATE INDEX laboratory_request_case_status_idx
  ON laboratory_request (workspace_id, epoch, case_id, status, authored_at, request_id);

CREATE INDEX laboratory_report_acknowledgement_request_idx
  ON laboratory_report_acknowledgement (
    workspace_id, epoch, request_id, acknowledged_at
  );

CREATE INDEX laboratory_report_revision_request_idx
  ON laboratory_report_revision (workspace_id, epoch, request_id, corrected_at);

CREATE INDEX investigation_result_snapshot_evidence_idx
  ON investigation_result_snapshot (
    workspace_id, case_id, catalog_item_id, input_hash, created_at
  );
