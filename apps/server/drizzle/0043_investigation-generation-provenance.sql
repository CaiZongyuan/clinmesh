ALTER TABLE investigation_result_snapshot
  ADD COLUMN source_detail TEXT
  CHECK (source_detail IS NULL OR source_detail IN ('adult-reference-baseline', 'mixed'));

ALTER TABLE investigation_result_snapshot
  ADD COLUMN provenance_json TEXT
  CHECK (provenance_json IS NULL OR json_valid(provenance_json));
