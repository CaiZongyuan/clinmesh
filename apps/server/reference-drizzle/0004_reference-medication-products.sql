ALTER TABLE reference_release
  ADD COLUMN medication_product_count INTEGER NOT NULL DEFAULT 0
  CHECK (medication_product_count >= 0);

CREATE TABLE reference_source_manifest_v4 (
  release_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  upstream_version TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  license_id TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('bundled-fixture', 'documented-api', 'generated', 'manual-download')
  ),
  artifact_format TEXT NOT NULL CHECK (
    artifact_format IN (
      'clinmesh-reference-v1', 'loinc-csv', 'nhsa-diagnosis-csv',
      'nhsa-medication-product-csv', 'ucum-xml'
    )
  ),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  import_diagnostics_json TEXT NOT NULL CHECK (json_valid(import_diagnostics_json)),
  PRIMARY KEY (release_id, source_id),
  FOREIGN KEY (release_id) REFERENCES reference_release (release_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_source_manifest_v4 (
  release_id, source_id, upstream_version, published_at, retrieved_at,
  source_url, checksum, license_id, acquisition_method, artifact_format,
  record_count, import_diagnostics_json
)
SELECT
  release_id, source_id, upstream_version, published_at, retrieved_at,
  source_url, checksum, license_id, acquisition_method, artifact_format,
  record_count, import_diagnostics_json
FROM reference_source_manifest;

CREATE TABLE reference_concept_v4 (
  release_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (
    domain IN ('diagnosis', 'laboratory', 'medication', 'service', 'unit', 'other')
  ),
  system TEXT NOT NULL,
  system_version TEXT NOT NULL,
  code TEXT NOT NULL,
  display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, concept_id),
  UNIQUE (release_id, system, system_version, code),
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest_v4 (release_id, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_concept_v4 (
  release_id, concept_id, domain, system, system_version, code, display,
  status, source_id, source_locator
)
SELECT
  release_id, concept_id, domain, system, system_version, code, display,
  status, source_id, source_locator
FROM reference_concept;

DROP TABLE reference_concept;
DROP TABLE reference_source_manifest;
ALTER TABLE reference_source_manifest_v4 RENAME TO reference_source_manifest;
ALTER TABLE reference_concept_v4 RENAME TO reference_concept;

CREATE INDEX reference_concept_search_idx
  ON reference_concept (release_id, domain, status, display, code);

CREATE TABLE reference_medication_product (
  release_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  system TEXT NOT NULL,
  system_version TEXT NOT NULL,
  code TEXT NOT NULL,
  generic_name TEXT NOT NULL,
  brand_name TEXT,
  dosage_form TEXT NOT NULL,
  strength TEXT NOT NULL,
  package_description TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  approval_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, product_id),
  UNIQUE (release_id, system, system_version, code),
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX reference_medication_product_search_idx
  ON reference_medication_product (
    release_id, status, generic_name, brand_name, code
  );
