ALTER TABLE inpatient_surgery_material_record ADD COLUMN recording_kind TEXT NOT NULL DEFAULT 'initial'
  CHECK(recording_kind IN ('initial','postoperative-addendum'));
