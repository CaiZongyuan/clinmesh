ALTER TABLE laboratory_report_acknowledgement
  RENAME TO laboratory_report_acknowledgement_legacy_v4;
ALTER TABLE laboratory_report_revision
  RENAME TO laboratory_report_revision_legacy_v4;
ALTER TABLE laboratory_request RENAME TO laboratory_request_legacy_v4;

CREATE TABLE laboratory_request (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  -- 申请类型由各适配器校验；表上不枚举取值，追加新的申请类型无需重建本表及引用它的各类型明细表。
  request_kind TEXT NOT NULL CHECK (length(request_kind) BETWEEN 1 AND 32),
  catalog_item_id TEXT NOT NULL,
  reference_json TEXT CHECK (reference_json IS NULL OR json_valid(reference_json)),
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
  CHECK (request_kind <> 'laboratory' OR reference_json IS NOT NULL),
  CHECK (
    (generation_error_code IS NULL AND generation_error_message IS NULL)
    OR (generation_error_code IS NOT NULL AND generation_error_message IS NOT NULL)
  )
) STRICT;

INSERT INTO laboratory_request (
  workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id, reference_json,
  result_snapshot_id, indication_code, service_request_id, execution_task_id,
  diagnostic_report_id, generation_error_code, generation_error_message,
  status, version, authored_by, authored_at, accepted_at, started_at,
  reported_at, acknowledged_at, cancelled_at, service_snapshot_json
)
SELECT
  workspace_id, epoch, request_id, case_id, 'laboratory', catalog_item_id, reference_json,
  result_snapshot_id, indication_code, service_request_id, execution_task_id,
  diagnostic_report_id, generation_error_code, generation_error_message,
  status, version, authored_by, authored_at, accepted_at, started_at,
  reported_at, acknowledged_at, cancelled_at, service_snapshot_json
FROM laboratory_request_legacy_v4;

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
SELECT * FROM laboratory_report_acknowledgement_legacy_v4;

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
SELECT * FROM laboratory_report_revision_legacy_v4;

DROP TABLE laboratory_report_acknowledgement_legacy_v4;
DROP TABLE laboratory_report_revision_legacy_v4;
DROP TABLE laboratory_request_legacy_v4;

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
