CREATE TABLE reference_source_manifest_v6 (
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
      'cn-health-candidate', 'clinmesh-reference-v1', 'loinc-csv',
      'nhc-medical-service-csv', 'nhsa-diagnosis-csv',
      'nhsa-medication-product-csv', 'ucum-xml', 'wst-value-set-csv'
    )
  ),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  import_diagnostics_json TEXT NOT NULL CHECK (json_valid(import_diagnostics_json)),
  candidate_provenance_json TEXT
    CHECK (candidate_provenance_json IS NULL OR json_valid(candidate_provenance_json)),
  PRIMARY KEY (release_id, source_id),
  FOREIGN KEY (release_id) REFERENCES reference_release (release_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_source_manifest_v6 (
  release_id, source_id, upstream_version, published_at, retrieved_at,
  source_url, checksum, license_id, acquisition_method, artifact_format,
  record_count, import_diagnostics_json, candidate_provenance_json
)
SELECT
  release_id, source_id, upstream_version, published_at, retrieved_at,
  source_url, checksum, license_id, acquisition_method, artifact_format,
  record_count, import_diagnostics_json, NULL
FROM reference_source_manifest;

CREATE TABLE reference_concept_v6 (
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
    REFERENCES reference_source_manifest_v6 (release_id, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_concept_v6 (
  release_id, concept_id, domain, system, system_version, code, display,
  status, source_id, source_locator
)
SELECT
  release_id, concept_id, domain, system, system_version, code, display,
  status, source_id, source_locator
FROM reference_concept;

CREATE TABLE reference_medication_product_v6 (
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
    REFERENCES reference_source_manifest_v6 (release_id, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_medication_product_v6 (
  release_id, product_id, system, system_version, code, generic_name,
  brand_name, dosage_form, strength, package_description, manufacturer,
  approval_number, status, source_id, source_locator
)
SELECT
  release_id, product_id, system, system_version, code, generic_name,
  brand_name, dosage_form, strength, package_description, manufacturer,
  approval_number, status, source_id, source_locator
FROM reference_medication_product;

CREATE TABLE reference_medical_service_v6 (
  release_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  system TEXT NOT NULL,
  system_version TEXT NOT NULL,
  code TEXT NOT NULL,
  display TEXT NOT NULL,
  category_code TEXT NOT NULL,
  billing_unit_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, service_id),
  UNIQUE (release_id, system, system_version, code),
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest_v6 (release_id, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_medical_service_v6 (
  release_id, service_id, system, system_version, code, display,
  category_code, billing_unit_code, status, source_id, source_locator
)
SELECT
  release_id, service_id, system, system_version, code, display,
  category_code, billing_unit_code, status, source_id, source_locator
FROM reference_medical_service;

CREATE TABLE reference_value_set_entry_v6 (
  release_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  value_set TEXT NOT NULL,
  system TEXT NOT NULL,
  system_version TEXT NOT NULL,
  code TEXT NOT NULL,
  display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, entry_id),
  UNIQUE (release_id, value_set, system, system_version, code),
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest_v6 (release_id, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_value_set_entry_v6 (
  release_id, entry_id, value_set, system, system_version, code, display,
  status, source_id, source_locator
)
SELECT
  release_id, entry_id, value_set, system, system_version, code, display,
  status, source_id, source_locator
FROM reference_value_set_entry;

DROP TABLE reference_value_set_entry;
DROP TABLE reference_medical_service;
DROP TABLE reference_medication_product;
DROP TABLE reference_concept;
DROP TABLE reference_source_manifest;
ALTER TABLE reference_source_manifest_v6 RENAME TO reference_source_manifest;
ALTER TABLE reference_concept_v6 RENAME TO reference_concept;
ALTER TABLE reference_medication_product_v6 RENAME TO reference_medication_product;
ALTER TABLE reference_medical_service_v6 RENAME TO reference_medical_service;
ALTER TABLE reference_value_set_entry_v6 RENAME TO reference_value_set_entry;

CREATE INDEX reference_concept_search_idx
  ON reference_concept (release_id, domain, status, display, code);

CREATE INDEX reference_medication_product_search_idx
  ON reference_medication_product (
    release_id, status, generic_name, brand_name, code
  );

CREATE INDEX reference_medical_service_search_idx
  ON reference_medical_service (release_id, status, display, code);

CREATE INDEX reference_value_set_entry_search_idx
  ON reference_value_set_entry (
    release_id, value_set, status, display, code
  );
