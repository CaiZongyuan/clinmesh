ALTER TABLE reference_concept
  ADD COLUMN laboratory_metadata_json TEXT
  CHECK (laboratory_metadata_json IS NULL OR json_valid(laboratory_metadata_json));
