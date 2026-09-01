ALTER TABLE laboratory_report_acknowledgement
  RENAME TO laboratory_report_acknowledgement_legacy;
ALTER TABLE laboratory_report_revision
  RENAME TO laboratory_report_revision_legacy;
ALTER TABLE laboratory_request RENAME TO laboratory_request_legacy;
ALTER TABLE laboratory_request_state RENAME TO laboratory_request_state_legacy;

CREATE TABLE laboratory_request_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_catalog_item_id TEXT,
  draft_indication_code TEXT,
  draft_reference_json TEXT CHECK (
    draft_reference_json IS NULL OR json_valid(draft_reference_json)
  ),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  CHECK (
    (draft_catalog_item_id IS NULL AND draft_indication_code IS NULL AND draft_reference_json IS NULL)
    OR (draft_catalog_item_id IS NOT NULL AND draft_indication_code IS NOT NULL AND draft_reference_json IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO laboratory_request_state (
  workspace_id, epoch, case_id, version, draft_catalog_item_id,
  draft_indication_code, draft_reference_json, updated_by, updated_at
)
SELECT
  state.workspace_id,
  state.epoch,
  state.case_id,
  state.version,
  state.draft_catalog_item_id,
  state.draft_indication_code,
  CASE WHEN state.draft_catalog_item_id IS NULL THEN NULL ELSE
    CASE WHEN json_type(catalog.config_json, '$.referenceConcept') = 'object'
      THEN json_extract(catalog.config_json, '$.referenceConcept')
      ELSE json_object(
        'code', catalog.code,
        'display', catalog.name_zh,
        'id', catalog.item_id,
        'sourceLocator', 'operational:outpatient_catalog',
        'system', 'urn:clinmesh:operational:laboratory',
        'version', CAST(catalog.version AS TEXT)
      )
    END
  END,
  state.updated_by,
  state.updated_at
FROM laboratory_request_state_legacy AS state
LEFT JOIN outpatient_catalog AS catalog
  ON catalog.workspace_id = state.workspace_id
 AND catalog.epoch = state.epoch
 AND catalog.item_id = state.draft_catalog_item_id;

CREATE TABLE laboratory_request (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  reference_json TEXT NOT NULL CHECK (json_valid(reference_json)),
  indication_code TEXT NOT NULL,
  service_request_id TEXT NOT NULL,
  execution_task_id TEXT NOT NULL,
  diagnostic_report_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'issued', 'accepted', 'in-progress', 'reported', 'acknowledged', 'cancelled'
  )),
  version INTEGER NOT NULL CHECK (version > 0),
  authored_by TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  accepted_at TEXT,
  started_at TEXT,
  reported_at TEXT,
  acknowledged_at TEXT,
  cancelled_at TEXT,
  PRIMARY KEY (workspace_id, epoch, request_id),
  UNIQUE (workspace_id, epoch, service_request_id),
  UNIQUE (workspace_id, epoch, execution_task_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO laboratory_request (
  workspace_id, epoch, request_id, case_id, catalog_item_id, reference_json,
  indication_code, service_request_id, execution_task_id, diagnostic_report_id,
  status, version, authored_by, authored_at, accepted_at, started_at,
  reported_at, acknowledged_at, cancelled_at
)
SELECT
  request.workspace_id,
  request.epoch,
  request.request_id,
  request.case_id,
  request.catalog_item_id,
  CASE WHEN json_type(catalog.config_json, '$.referenceConcept') = 'object'
    THEN json_extract(catalog.config_json, '$.referenceConcept')
    ELSE json_object(
      'code', catalog.code,
      'display', catalog.name_zh,
      'id', catalog.item_id,
      'sourceLocator', 'operational:outpatient_catalog',
      'system', 'urn:clinmesh:operational:laboratory',
      'version', CAST(catalog.version AS TEXT)
    )
  END,
  request.indication_code,
  request.service_request_id,
  request.execution_task_id,
  request.diagnostic_report_id,
  request.status,
  request.version,
  request.authored_by,
  request.authored_at,
  request.accepted_at,
  request.started_at,
  request.reported_at,
  request.acknowledged_at,
  request.cancelled_at
FROM laboratory_request_legacy AS request
JOIN outpatient_catalog AS catalog
  ON catalog.workspace_id = request.workspace_id
 AND catalog.epoch = request.epoch
 AND catalog.item_id = request.catalog_item_id;

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
SELECT * FROM laboratory_report_acknowledgement_legacy;

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
SELECT * FROM laboratory_report_revision_legacy;

DROP TABLE laboratory_report_acknowledgement_legacy;
DROP TABLE laboratory_report_revision_legacy;
DROP TABLE laboratory_request_legacy;
DROP TABLE laboratory_request_state_legacy;

CREATE UNIQUE INDEX laboratory_request_diagnostic_report_unique
  ON laboratory_request (workspace_id, epoch, diagnostic_report_id)
  WHERE diagnostic_report_id IS NOT NULL;

CREATE UNIQUE INDEX laboratory_request_active_item_unique
  ON laboratory_request (workspace_id, epoch, case_id, catalog_item_id)
  WHERE status IN ('issued', 'accepted', 'in-progress');

CREATE INDEX laboratory_request_case_status_idx
  ON laboratory_request (workspace_id, epoch, case_id, status, authored_at, request_id);

CREATE INDEX laboratory_report_acknowledgement_request_idx
  ON laboratory_report_acknowledgement (
    workspace_id, epoch, request_id, acknowledged_at
  );

CREATE INDEX laboratory_report_revision_request_idx
  ON laboratory_report_revision (workspace_id, epoch, request_id, corrected_at);
