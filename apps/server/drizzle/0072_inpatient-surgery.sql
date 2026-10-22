CREATE TABLE inpatient_surgery_catalog (
 workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, item_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('procedure','material')), version INTEGER NOT NULL CHECK(version>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(workspace_id,epoch,item_id),
 FOREIGN KEY(workspace_id,epoch) REFERENCES scenario_epoch_state(workspace_id,epoch) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_surgery_request (
 workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, request_id TEXT NOT NULL, admission_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), status TEXT NOT NULL CHECK(status IN ('requested','ready','completed','cancelled')),
 planned_procedure_json TEXT NOT NULL CHECK(json_valid(planned_procedure_json)), planned_for TEXT NOT NULL, reason TEXT NOT NULL,
 requested_at TEXT NOT NULL, requested_by TEXT NOT NULL, organization_id TEXT NOT NULL,
 preop_check_json TEXT CHECK(preop_check_json IS NULL OR json_valid(preop_check_json)),
 consent_confirmation_json TEXT CHECK(consent_confirmation_json IS NULL OR json_valid(consent_confirmation_json)),
 cancellation_json TEXT CHECK(cancellation_json IS NULL OR json_valid(cancellation_json)),
 PRIMARY KEY(workspace_id,epoch,request_id), UNIQUE(workspace_id,epoch,admission_id,request_id),
 FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_surgery_pending ON inpatient_surgery_request(workspace_id,epoch,admission_id,status);
CREATE TABLE inpatient_surgery_execution (
 workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, execution_id TEXT NOT NULL, request_id TEXT NOT NULL, admission_id TEXT NOT NULL,
 actual_procedure_json TEXT NOT NULL CHECK(json_valid(actual_procedure_json)), performed_at TEXT NOT NULL,
 performed_by TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, organization_id TEXT NOT NULL, note TEXT NOT NULL,
 PRIMARY KEY(workspace_id,epoch,execution_id), UNIQUE(workspace_id,epoch,request_id), UNIQUE(workspace_id,epoch,admission_id,execution_id),
 FOREIGN KEY(workspace_id,epoch,admission_id,request_id) REFERENCES inpatient_surgery_request(workspace_id,epoch,admission_id,request_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_surgery_material (
 workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, material_use_id TEXT NOT NULL, execution_id TEXT NOT NULL,
 item_json TEXT NOT NULL CHECK(json_valid(item_json)), quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
 amount_fen INTEGER NOT NULL CHECK(amount_fen>=0 AND amount_fen<=9007199254740991),
 PRIMARY KEY(workspace_id,epoch,material_use_id),
 FOREIGN KEY(workspace_id,epoch,execution_id) REFERENCES inpatient_surgery_execution(workspace_id,epoch,execution_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX inpatient_order_admission_identity ON inpatient_order(workspace_id,epoch,admission_id,order_id);
CREATE TABLE inpatient_postoperative_order (
 workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, order_id TEXT NOT NULL, surgery_execution_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,epoch,order_id),
 FOREIGN KEY(workspace_id,epoch,admission_id,order_id) REFERENCES inpatient_order(workspace_id,epoch,admission_id,order_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,epoch,admission_id,surgery_execution_id) REFERENCES inpatient_surgery_execution(workspace_id,epoch,admission_id,execution_id) ON DELETE RESTRICT
) STRICT;
