ALTER TABLE synthetic_patient_profile
ADD COLUMN localization_warning_json TEXT
  CHECK (localization_warning_json IS NULL OR json_valid(localization_warning_json));
