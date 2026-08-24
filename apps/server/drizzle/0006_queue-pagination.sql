CREATE INDEX outpatient_case_arrival_idx
  ON outpatient_case (workspace_id, epoch, arrived_at DESC, case_id);

CREATE INDEX outpatient_case_status_arrival_idx
  ON outpatient_case (workspace_id, epoch, status, arrived_at, case_id);

CREATE INDEX outpatient_case_status_updated_idx
  ON outpatient_case (workspace_id, epoch, status, updated_at, case_id);
