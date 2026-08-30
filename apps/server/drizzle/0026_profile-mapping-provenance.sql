ALTER TABLE synthetic_patient_profile
  ADD COLUMN mapping_provenance_json TEXT
  CHECK (mapping_provenance_json IS NULL OR json_valid(mapping_provenance_json));

ALTER TABLE synthetic_patient_profile_revision
  ADD COLUMN mapping_provenance_json TEXT
  CHECK (mapping_provenance_json IS NULL OR json_valid(mapping_provenance_json));
