CREATE TABLE reference_release (
  release_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  status TEXT NOT NULL CHECK (status = 'published'),
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE CHECK (length(content_hash) = 64),
  source_count INTEGER NOT NULL CHECK (source_count > 0),
  concept_count INTEGER NOT NULL CHECK (concept_count >= 0)
) STRICT;

CREATE TABLE reference_source_manifest (
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
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  import_diagnostics_json TEXT NOT NULL CHECK (json_valid(import_diagnostics_json)),
  PRIMARY KEY (release_id, source_id),
  FOREIGN KEY (release_id) REFERENCES reference_release (release_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE reference_concept (
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
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX reference_concept_search_idx
  ON reference_concept (release_id, domain, status, display, code);
