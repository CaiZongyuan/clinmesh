CREATE TABLE prepared_reference_release (
  release_id TEXT PRIMARY KEY,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE prepared_reference_record (
  release_id TEXT NOT NULL REFERENCES prepared_reference_release(release_id),
  dataset TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  source_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (release_id, dataset, table_name, record_id)
);
CREATE INDEX prepared_reference_code ON prepared_reference_record (release_id, dataset, table_name, code);
CREATE TRIGGER prepared_release_immutable_update BEFORE UPDATE ON prepared_reference_release BEGIN SELECT RAISE(ABORT, 'Prepared release is immutable'); END;
CREATE TRIGGER prepared_release_immutable_delete BEFORE DELETE ON prepared_reference_release BEGIN SELECT RAISE(ABORT, 'Prepared release is immutable'); END;
CREATE TRIGGER prepared_record_immutable_update BEFORE UPDATE ON prepared_reference_record BEGIN SELECT RAISE(ABORT, 'Prepared record is immutable'); END;
CREATE TRIGGER prepared_record_immutable_delete BEFORE DELETE ON prepared_reference_record BEGIN SELECT RAISE(ABORT, 'Prepared record is immutable'); END;
