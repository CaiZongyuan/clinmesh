ALTER TABLE laboratory_request_state
  ADD COLUMN draft_price_json TEXT
  CHECK (draft_price_json IS NULL OR json_valid(draft_price_json));
