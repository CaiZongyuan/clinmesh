CREATE TABLE insurance_event (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  year TEXT NOT NULL,
  plan_code TEXT NOT NULL CHECK(plan_code IN ('employee-v1','resident-v1')),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('outpatient','inpatient')),
  target_id TEXT NOT NULL,
  eligible_delta INTEGER NOT NULL,
  fund_delta INTEGER NOT NULL,
  account_delta INTEGER NOT NULL,
  reverses_id TEXT,
  data_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,event_id),
  UNIQUE(workspace_id,epoch,reverses_id),
  FOREIGN KEY(workspace_id,epoch,reverses_id) REFERENCES insurance_event(workspace_id,epoch,event_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX insurance_patient_year ON insurance_event(workspace_id,epoch,patient_id,year);
CREATE INDEX insurance_target ON insurance_event(workspace_id,epoch,target_kind,target_id);
CREATE TABLE insurance_preview (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,preview_id)
) STRICT;
