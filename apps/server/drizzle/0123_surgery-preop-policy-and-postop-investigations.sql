ALTER TABLE inpatient_surgery_request
  ADD COLUMN preop_order_policy TEXT NOT NULL DEFAULT 'continue-active'
  CHECK (preop_order_policy IN ('continue-active', 'stop-on-completion'));

CREATE UNIQUE INDEX inpatient_investigation_admission_request_uq
  ON inpatient_investigation(workspace_id, epoch, admission_id, request_id);

CREATE TABLE inpatient_postoperative_investigation (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  surgery_execution_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, request_id),
  FOREIGN KEY (workspace_id, epoch, admission_id, request_id)
    REFERENCES inpatient_investigation(workspace_id, epoch, admission_id, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, admission_id, surgery_execution_id)
    REFERENCES inpatient_surgery_execution(workspace_id, epoch, admission_id, execution_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX inpatient_postoperative_investigation_execution_idx
  ON inpatient_postoperative_investigation(workspace_id, epoch, admission_id, surgery_execution_id);
