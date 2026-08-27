CREATE TABLE synthetic_patient_profile (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('builtin', 'synthea')),
  source_patient_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  display_name TEXT NOT NULL,
  mrn TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  mappings_json TEXT NOT NULL CHECK (json_valid(mappings_json)),
  patient_json TEXT NOT NULL CHECK (json_valid(patient_json)),
  source_format TEXT NOT NULL CHECK (source_format IN (
    'clinmesh-template', 'fhir-r4-bundle', 'legacy-compiled-profile'
  )),
  source_hash TEXT NOT NULL,
  raw_source_json TEXT CHECK (raw_source_json IS NULL OR json_valid(raw_source_json)),
  compilation_json TEXT CHECK (compilation_json IS NULL OR json_valid(compilation_json)),
  mapping_version TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id),
  UNIQUE (workspace_id, batch_id, source_patient_id),
  UNIQUE (workspace_id, mrn),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX synthetic_patient_profile_list_idx
  ON synthetic_patient_profile (workspace_id, updated_at DESC, profile_id);

CREATE TABLE synthetic_patient_profile_batch (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('builtin', 'synthea')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, batch_id),
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES synthetic_patient_profile (workspace_id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX synthetic_patient_profile_batch_idx
  ON synthetic_patient_profile_batch (workspace_id, batch_id, profile_id);

CREATE TABLE synthetic_patient_profile_revision (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  mappings_json TEXT NOT NULL CHECK (json_valid(mappings_json)),
  patient_json TEXT NOT NULL CHECK (json_valid(patient_json)),
  mapping_version TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, revision),
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES synthetic_patient_profile (workspace_id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE synthetic_patient_materialization (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, profile_id, profile_revision),
  UNIQUE (workspace_id, epoch, patient_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, profile_id)
    REFERENCES synthetic_patient_profile (workspace_id, profile_id) ON DELETE RESTRICT
) STRICT;

INSERT OR IGNORE INTO synthetic_patient_profile (
  workspace_id, profile_id, batch_id, batch_name, provider_id,
  source_patient_id, revision, display_name, mrn, identity_json, mappings_json,
  patient_json, source_format, source_hash, raw_source_json,
  compilation_json, mapping_version, created_by_actor_id, created_at, updated_at
)
SELECT
  dataset.workspace_id,
  'synthetic-patient-profile-legacy-' || dataset.content_hash || '-' || json_extract(patient.value, '$.id'),
  dataset.dataset_id,
  dataset.name,
  dataset.provider_id,
  json_extract(patient.value, '$.id'),
  1,
  json_extract(patient.value, '$.name'),
  'CMSYNLEGACY-' || substr(dataset.content_hash, 1, 20) || '-' || printf('%08d', patient.key),
  json_object(
    'address', '合成地址（旧数据回填）',
    'displayName', json_extract(patient.value, '$.name'),
    'email', 'legacy-' || substr(dataset.content_hash, 1, 20) || '-' || printf('%08d', patient.key) || '@example.test',
    'insuranceDisplay', '模拟保险（旧数据回填）',
    'mrn', 'CMSYNLEGACY-' || substr(dataset.content_hash, 1, 20) || '-' || printf('%08d', patient.key),
    'nationalId', '000000' || replace(json_extract(patient.value, '$.birthDate'), '-', '') || '0000',
    'phone', '13000000000'
  ),
  '[]',
  patient.value,
  'legacy-compiled-profile',
  dataset.content_hash,
  NULL,
  NULL,
  'legacy-case-truth-v1',
  dataset.created_by_actor_id,
  dataset.created_at,
  dataset.updated_at
FROM scenario_dataset AS dataset, json_each(dataset.content_json, '$.patients') AS patient
WHERE NOT EXISTS (
  SELECT 1
  FROM json_each(dataset.content_json, '$.patients') AS prior_patient
  WHERE json_extract(prior_patient.value, '$.id') = json_extract(patient.value, '$.id')
    AND CAST(prior_patient.key AS INTEGER) < CAST(patient.key AS INTEGER)
);

INSERT INTO synthetic_patient_profile_revision (
  workspace_id, profile_id, revision, identity_json, mappings_json, patient_json, mapping_version,
  created_by_actor_id, created_at
)
SELECT workspace_id, profile_id, revision, identity_json, mappings_json, patient_json, mapping_version,
  created_by_actor_id, updated_at
FROM synthetic_patient_profile;

INSERT OR IGNORE INTO synthetic_patient_profile_batch (
  workspace_id, profile_id, batch_id, batch_name, provider_id, created_at
)
SELECT
  dataset.workspace_id,
  profile.profile_id,
  dataset.dataset_id,
  dataset.name,
  dataset.provider_id,
  dataset.created_at
FROM scenario_dataset AS dataset, json_each(dataset.content_json, '$.patients') AS patient
JOIN synthetic_patient_profile AS profile
  ON profile.workspace_id = dataset.workspace_id
 AND profile.profile_id = 'synthetic-patient-profile-legacy-' || dataset.content_hash || '-' || json_extract(patient.value, '$.id')
WHERE NOT EXISTS (
  SELECT 1
  FROM json_each(dataset.content_json, '$.patients') AS prior_patient
  WHERE json_extract(prior_patient.value, '$.id') = json_extract(patient.value, '$.id')
    AND CAST(prior_patient.key AS INTEGER) < CAST(patient.key AS INTEGER)
);
