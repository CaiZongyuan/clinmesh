ALTER TABLE reference_source_manifest
  ADD COLUMN artifact_format TEXT NOT NULL DEFAULT 'clinmesh-reference-v1'
  CHECK (artifact_format IN ('clinmesh-reference-v1', 'loinc-csv', 'ucum-xml'));
