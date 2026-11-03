CREATE TABLE inpatient_angiography_report (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL,
  procedure_id TEXT NOT NULL, report_id TEXT NOT NULL, report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  PRIMARY KEY(workspace_id,epoch,procedure_id), UNIQUE(workspace_id,epoch,report_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,procedure_id) REFERENCES inpatient_surgery_execution(workspace_id,epoch,execution_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE inpatient_pci_selection_draft (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, request_id TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
  PRIMARY KEY(workspace_id,epoch,request_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES inpatient_surgery_request(workspace_id,epoch,request_id) ON DELETE RESTRICT
) STRICT;
