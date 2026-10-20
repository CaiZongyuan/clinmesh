CREATE TABLE clinical_request_context (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, case_id TEXT NOT NULL,
  outpatient_case_id TEXT, admission_id TEXT, patient_id TEXT NOT NULL, encounter_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,case_id), UNIQUE(workspace_id,epoch,encounter_id),
  CHECK((outpatient_case_id IS NOT NULL) != (admission_id IS NOT NULL)),
  CHECK(case_id = COALESCE(outpatient_case_id,admission_id)),
  FOREIGN KEY(workspace_id,epoch,outpatient_case_id) REFERENCES outpatient_case(workspace_id,epoch,case_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO clinical_request_context(workspace_id,epoch,case_id,outpatient_case_id,patient_id,encounter_id)
  SELECT workspace_id,epoch,case_id,case_id,patient_id,encounter_id FROM outpatient_case;
INSERT INTO clinical_request_context(workspace_id,epoch,case_id,admission_id,patient_id,encounter_id)
  SELECT workspace_id,epoch,admission_id,admission_id,patient_id,admission_id FROM inpatient_admission;

CREATE TABLE laboratory_request_next (
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
    REFERENCES clinical_request_context (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, result_snapshot_id)
    REFERENCES investigation_result_snapshot (workspace_id, snapshot_id) ON DELETE RESTRICT,
  CHECK (request_kind <> 'laboratory' OR reference_json IS NOT NULL),
  CHECK (
    (generation_error_code IS NULL AND generation_error_message IS NULL)
    OR (generation_error_code IS NOT NULL AND generation_error_message IS NOT NULL)
  )
) STRICT;
INSERT INTO laboratory_request_next SELECT * FROM laboratory_request;
DROP TABLE laboratory_request;
ALTER TABLE laboratory_request_next RENAME TO laboratory_request;
CREATE UNIQUE INDEX laboratory_request_diagnostic_report_unique
  ON laboratory_request (workspace_id, epoch, diagnostic_report_id)
  WHERE diagnostic_report_id IS NOT NULL;
CREATE UNIQUE INDEX laboratory_request_active_item_unique
  ON laboratory_request (workspace_id, epoch, case_id, catalog_item_id)
  WHERE status IN ('issued', 'accepted', 'in-progress', 'generation-failed');
CREATE INDEX laboratory_request_case_status_idx
  ON laboratory_request (workspace_id, epoch, case_id, status, authored_at, request_id);

CREATE TABLE laboratory_request_state_next (
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
  updated_at TEXT NOT NULL, draft_service_snapshot_json TEXT
  CHECK (
    draft_service_snapshot_json IS NULL
    OR json_valid(draft_service_snapshot_json)
  ),
  PRIMARY KEY (workspace_id, epoch, case_id),
  CHECK (
    (draft_catalog_item_id IS NULL AND draft_indication_code IS NULL AND draft_reference_json IS NULL)
    OR (draft_catalog_item_id IS NOT NULL AND draft_indication_code IS NOT NULL AND draft_reference_json IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES clinical_request_context (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO laboratory_request_state_next SELECT * FROM laboratory_request_state;
DROP TABLE laboratory_request_state;
ALTER TABLE laboratory_request_state_next RENAME TO laboratory_request_state;

CREATE TABLE imaging_request_state_next (
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
    REFERENCES clinical_request_context (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  CHECK (
    (draft_service_id IS NULL AND draft_indication IS NULL AND draft_service_snapshot_json IS NULL)
    OR (draft_service_id IS NOT NULL AND draft_indication IS NOT NULL
      AND draft_service_snapshot_json IS NOT NULL)
  )
) STRICT;
INSERT INTO imaging_request_state_next SELECT * FROM imaging_request_state;
DROP TABLE imaging_request_state;
ALTER TABLE imaging_request_state_next RENAME TO imaging_request_state;

CREATE TABLE imaging_study_next (
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
  UNIQUE (workspace_id, epoch, study_id, request_id),
  UNIQUE (workspace_id, epoch, study_instance_uid),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES clinical_request_context (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO imaging_study_next SELECT * FROM imaging_study;
DROP TABLE imaging_study;
ALTER TABLE imaging_study_next RENAME TO imaging_study;

CREATE TABLE inpatient_investigation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, request_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  price_fen INTEGER NOT NULL CHECK(price_fen >= 0), charge_definition_json TEXT NOT NULL CHECK(json_valid(charge_definition_json)),
  sent_at TEXT, sent_by TEXT, sent_by_practitioner_role_id TEXT,
  PRIMARY KEY(workspace_id,epoch,request_id),
  CHECK((sent_at IS NULL AND sent_by IS NULL AND sent_by_practitioner_role_id IS NULL) OR (sent_at IS NOT NULL AND sent_by IS NOT NULL AND sent_by_practitioner_role_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES laboratory_request(workspace_id,epoch,request_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;

CREATE VIEW clinical_request_source AS
SELECT c.*, m.case_id AS synthetic_case_id, m.case_revision AS synthetic_case_revision,
  m.profile_id, m.profile_revision
FROM clinical_request_context c
LEFT JOIN inpatient_admission a ON a.workspace_id=c.workspace_id AND a.epoch=c.epoch AND a.admission_id=c.admission_id
LEFT JOIN synthetic_case_materialization m ON m.workspace_id=c.workspace_id AND m.epoch=c.epoch
  AND ((c.outpatient_case_id IS NOT NULL AND m.outpatient_case_id=c.outpatient_case_id)
    OR (c.admission_id IS NOT NULL AND m.case_id=a.source_case_id));

CREATE TABLE inpatient_transfer (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, transfer_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  source_ward_id TEXT NOT NULL, source_organization_id TEXT NOT NULL, target_ward_id TEXT NOT NULL, target_organization_id TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','handed-over','completed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), requested_at TEXT NOT NULL, requested_by TEXT NOT NULL,
  handed_over_at TEXT, handed_over_by TEXT, received_at TEXT, received_by TEXT, bed_id TEXT,
  PRIMARY KEY(workspace_id,epoch,transfer_id),
  CHECK(source_ward_id <> target_ward_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,source_ward_id) REFERENCES inpatient_ward(workspace_id,epoch,ward_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,target_ward_id) REFERENCES inpatient_ward(workspace_id,epoch,ward_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,bed_id) REFERENCES inpatient_bed(workspace_id,epoch,bed_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX inpatient_active_transfer ON inpatient_transfer(workspace_id,epoch,admission_id) WHERE status IN ('requested','handed-over');
