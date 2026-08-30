ALTER TABLE synthetic_patient_profile
  ADD COLUMN reference_data_json TEXT
  CHECK (reference_data_json IS NULL OR json_valid(reference_data_json));

ALTER TABLE synthetic_patient_profile_revision
  ADD COLUMN reference_data_json TEXT
  CHECK (reference_data_json IS NULL OR json_valid(reference_data_json));
