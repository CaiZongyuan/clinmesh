-- 同台冠脉造影转 PCI（Ad-hoc PCI）：
-- 1. 手术申请新增 standby_ad_hoc_pci、ad_hoc_pci_json、standby_finalization_json 与 standby-pci 状态；
-- 2. 手术执行新增 execution_stage（primary / ad-hoc-pci），同一申请下按阶段唯一；
-- 3. 耗材预计、术前确认清单与耗材预留新增 surgery_stage，隔离同台造影与 PCI 阶段事实。

CREATE TABLE inpatient_surgery_request_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('requested', 'ready', 'standby-pci', 'completed', 'cancelled')),
  planned_procedure_json TEXT NOT NULL CHECK(json_valid(planned_procedure_json)),
  planned_for TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  preop_check_json TEXT CHECK(preop_check_json IS NULL OR json_valid(preop_check_json)),
  consent_confirmation_json TEXT CHECK(consent_confirmation_json IS NULL OR json_valid(consent_confirmation_json)),
  cancellation_json TEXT CHECK(cancellation_json IS NULL OR json_valid(cancellation_json)),
  surgery_type TEXT CHECK(surgery_type IS NULL OR surgery_type IN ('elective', 'semi-elective', 'emergency', 'day-surgery')),
  location_json TEXT CHECK(location_json IS NULL OR json_valid(location_json)),
  surgeon_json TEXT CHECK(surgeon_json IS NULL OR json_valid(surgeon_json)),
  assistant_json TEXT CHECK(assistant_json IS NULL OR json_valid(assistant_json)),
  anesthesia_method TEXT CHECK(anesthesia_method IS NULL OR anesthesia_method IN ('local-infiltration', 'local-sedation', 'general', 'neuraxial', 'nerve-block')),
  standby_ad_hoc_pci INTEGER NOT NULL DEFAULT 0 CHECK(standby_ad_hoc_pci IN (0, 1)),
  ad_hoc_pci_json TEXT CHECK(ad_hoc_pci_json IS NULL OR json_valid(ad_hoc_pci_json)),
  standby_finalization_json TEXT CHECK(standby_finalization_json IS NULL OR json_valid(standby_finalization_json)),
  PRIMARY KEY(workspace_id, epoch, request_id),
  UNIQUE(workspace_id, epoch, admission_id, request_id),
  FOREIGN KEY(workspace_id, epoch, admission_id)
    REFERENCES inpatient_admission(workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO inpatient_surgery_request_next (
  workspace_id, epoch, request_id, admission_id, version, status,
  planned_procedure_json, planned_for, reason, requested_at, requested_by, organization_id,
  preop_check_json, consent_confirmation_json, cancellation_json,
  surgery_type, location_json, surgeon_json, assistant_json, anesthesia_method,
  standby_ad_hoc_pci, ad_hoc_pci_json, standby_finalization_json
)
SELECT
  workspace_id, epoch, request_id, admission_id, version, status,
  planned_procedure_json, planned_for, reason, requested_at, requested_by, organization_id,
  preop_check_json, consent_confirmation_json, cancellation_json,
  surgery_type, location_json, surgeon_json, assistant_json, anesthesia_method,
  0, NULL, NULL
FROM inpatient_surgery_request;

DROP TABLE inpatient_surgery_request;
ALTER TABLE inpatient_surgery_request_next RENAME TO inpatient_surgery_request;

CREATE INDEX inpatient_surgery_pending
  ON inpatient_surgery_request(workspace_id, epoch, admission_id, status);

CREATE TABLE inpatient_surgery_execution_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  execution_stage TEXT NOT NULL DEFAULT 'primary' CHECK(execution_stage IN ('primary', 'ad-hoc-pci')),
  actual_procedure_json TEXT NOT NULL CHECK(json_valid(actual_procedure_json)),
  performed_at TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('in-progress', 'completed')),
  completed_at TEXT,
  linked_nursing_json TEXT CHECK(linked_nursing_json IS NULL OR json_valid(linked_nursing_json)),
  same_session_nursing_included INTEGER NOT NULL DEFAULT 0 CHECK(same_session_nursing_included IN (0, 1)),
  PRIMARY KEY(workspace_id, epoch, execution_id),
  UNIQUE(workspace_id, epoch, request_id, execution_stage),
  UNIQUE(workspace_id, epoch, admission_id, execution_id),
  FOREIGN KEY(workspace_id, epoch, admission_id, request_id)
    REFERENCES inpatient_surgery_request(workspace_id, epoch, admission_id, request_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO inpatient_surgery_execution_next (
  workspace_id, epoch, execution_id, request_id, admission_id, execution_stage,
  actual_procedure_json, performed_at, performed_by, practitioner_role_id, organization_id,
  note, status, completed_at, linked_nursing_json, same_session_nursing_included
)
SELECT
  workspace_id, epoch, execution_id, request_id, admission_id, 'primary',
  actual_procedure_json, performed_at, performed_by, practitioner_role_id, organization_id,
  note, status, completed_at, linked_nursing_json, 0
FROM inpatient_surgery_execution;

DROP TABLE inpatient_surgery_execution;
ALTER TABLE inpatient_surgery_execution_next RENAME TO inpatient_surgery_execution;

CREATE TABLE inpatient_material_estimate_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  surgery_stage TEXT NOT NULL DEFAULT 'primary' CHECK(surgery_stage IN ('primary', 'ad-hoc-pci')),
  version INTEGER NOT NULL CHECK(version > 0),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  authorization_operation TEXT NOT NULL CHECK(authorization_operation IN (
    'inpatient.surgery.request',
    'inpatient.surgery.convert-to-pci',
    'inpatient.material-estimate.request'
  )),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'cancelled')),
  automatic_pending INTEGER NOT NULL DEFAULT 1 CHECK(automatic_pending IN (0, 1)),
  draft_json TEXT CHECK(draft_json IS NULL OR json_valid(draft_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, epoch, task_id),
  UNIQUE(workspace_id, epoch, request_id, surgery_stage),
  FOREIGN KEY(workspace_id, epoch, admission_id)
    REFERENCES inpatient_admission(workspace_id, epoch, admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, epoch, request_id)
    REFERENCES inpatient_surgery_request(workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO inpatient_material_estimate_next (
  workspace_id, epoch, task_id, admission_id, request_id, surgery_stage, version,
  context_json, authorization_operation, basis_json, basis_fingerprint,
  status, automatic_pending, draft_json, created_at
)
SELECT
  workspace_id, epoch, task_id, admission_id, request_id, 'primary', version,
  context_json, authorization_operation, basis_json, basis_fingerprint,
  status, automatic_pending, draft_json, created_at
FROM inpatient_material_estimate;

DROP TABLE inpatient_material_estimate;
ALTER TABLE inpatient_material_estimate_next RENAME TO inpatient_material_estimate;

ALTER TABLE inpatient_material_plan_confirmation
  ADD COLUMN surgery_stage TEXT NOT NULL DEFAULT 'primary' CHECK(surgery_stage IN ('primary', 'ad-hoc-pci'));

ALTER TABLE inpatient_material_reservation
  ADD COLUMN surgery_stage TEXT NOT NULL DEFAULT 'primary' CHECK(surgery_stage IN ('primary', 'ad-hoc-pci'));
