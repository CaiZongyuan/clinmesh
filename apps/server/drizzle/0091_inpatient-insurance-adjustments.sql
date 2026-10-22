CREATE TABLE inpatient_insurance_adjustment (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, adjustment_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  original_settlement_id TEXT NOT NULL, compensation_id TEXT NOT NULL, replacement_id TEXT,
  PRIMARY KEY(workspace_id,epoch,adjustment_id),
  UNIQUE(workspace_id,epoch,original_settlement_id),
  UNIQUE(workspace_id,epoch,replacement_id),
  FOREIGN KEY(workspace_id,epoch,adjustment_id) REFERENCES inpatient_financial_adjustment(workspace_id,epoch,adjustment_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,original_settlement_id) REFERENCES insurance_event(workspace_id,epoch,event_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,compensation_id) REFERENCES insurance_event(workspace_id,epoch,event_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,replacement_id) REFERENCES insurance_event(workspace_id,epoch,event_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_insurance_adjustment_admission ON inpatient_insurance_adjustment(workspace_id,epoch,admission_id);
CREATE TABLE inpatient_insurance_adjustment_preview (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, preview_id TEXT NOT NULL, adjustment_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,preview_id),
  FOREIGN KEY(workspace_id,epoch,preview_id) REFERENCES insurance_preview(workspace_id,epoch,preview_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,adjustment_id) REFERENCES inpatient_insurance_adjustment(workspace_id,epoch,adjustment_id) ON DELETE RESTRICT
) STRICT;
