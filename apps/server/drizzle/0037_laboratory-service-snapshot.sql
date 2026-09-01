ALTER TABLE laboratory_request_state
  ADD COLUMN draft_service_snapshot_json TEXT
  CHECK (
    draft_service_snapshot_json IS NULL
    OR json_valid(draft_service_snapshot_json)
  );

ALTER TABLE laboratory_request
  ADD COLUMN service_snapshot_json TEXT
  CHECK (service_snapshot_json IS NULL OR json_valid(service_snapshot_json));
