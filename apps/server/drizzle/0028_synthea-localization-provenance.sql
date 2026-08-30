ALTER TABLE synthetic_patient_profile
  ADD COLUMN localization_provenance_json TEXT
  CHECK (localization_provenance_json IS NULL OR json_valid(localization_provenance_json));

ALTER TABLE synthetic_patient_profile_revision
  ADD COLUMN localization_provenance_json TEXT
  CHECK (localization_provenance_json IS NULL OR json_valid(localization_provenance_json));
