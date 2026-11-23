ALTER TABLE inpatient_surgery_request
  ADD COLUMN surgery_type TEXT CHECK (surgery_type IS NULL OR surgery_type IN ('elective', 'semi-elective', 'emergency', 'day-surgery'));

ALTER TABLE inpatient_surgery_request
  ADD COLUMN location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json));

ALTER TABLE inpatient_surgery_request
  ADD COLUMN surgeon_json TEXT CHECK (surgeon_json IS NULL OR json_valid(surgeon_json));

ALTER TABLE inpatient_surgery_request
  ADD COLUMN assistant_json TEXT CHECK (assistant_json IS NULL OR json_valid(assistant_json));

ALTER TABLE inpatient_surgery_request
  ADD COLUMN anesthesia_method TEXT CHECK (anesthesia_method IS NULL OR anesthesia_method IN ('local-infiltration', 'local-sedation', 'general', 'neuraxial', 'nerve-block'));
