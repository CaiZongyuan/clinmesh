CREATE TABLE diagnosis_catalog (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  code_system TEXT NOT NULL,
  code TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (workspace_id, epoch, item_id),
  UNIQUE (workspace_id, epoch, code_system, code),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES scenario_epoch_state (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX diagnosis_catalog_lookup_idx
  ON diagnosis_catalog (workspace_id, epoch, active, item_id);

INSERT INTO diagnosis_catalog (
  workspace_id, epoch, item_id, code_system, code, name_zh, name_en
)
SELECT workspace_id, epoch, 'diagnosis-influenza',
  'http://hl7.org/fhir/sid/icd-10', 'J10.1',
  '流感伴其他呼吸道表现，季节性流感病毒已标明',
  'Influenza with other respiratory manifestations, seasonal influenza virus identified'
FROM scenario_epoch_state;

INSERT INTO diagnosis_catalog (
  workspace_id, epoch, item_id, code_system, code, name_zh, name_en
)
SELECT workspace_id, epoch, 'diagnosis-acute-upper-respiratory-infection',
  'http://hl7.org/fhir/sid/icd-10', 'J06.9',
  '急性上呼吸道感染，未特指',
  'Acute upper respiratory infection, unspecified'
FROM scenario_epoch_state;

INSERT INTO diagnosis_catalog (
  workspace_id, epoch, item_id, code_system, code, name_zh, name_en
)
SELECT workspace_id, epoch, 'diagnosis-fever',
  'http://hl7.org/fhir/sid/icd-10', 'R50.9',
  '发热，未特指', 'Fever, unspecified'
FROM scenario_epoch_state;

CREATE TABLE diagnosis_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed')),
  draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  CHECK (
    (status = 'draft' AND draft_json IS NOT NULL)
    OR (status = 'confirmed' AND draft_json IS NULL)
  ),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE diagnosis_confirmation (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  provenance_resource_type TEXT NOT NULL DEFAULT 'Provenance'
    CHECK (provenance_resource_type = 'Provenance'),
  provenance_id TEXT NOT NULL,
  confirmed_by_actor_id TEXT NOT NULL,
  confirmed_by_practitioner_role_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, confirmation_id),
  UNIQUE (workspace_id, epoch, case_id),
  UNIQUE (workspace_id, epoch, provenance_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, epoch, provenance_resource_type, provenance_id
  ) REFERENCES fhir_resource (
    workspace_id, epoch, resource_type, resource_id
  ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE diagnosis_entry (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  condition_resource_type TEXT NOT NULL DEFAULT 'Condition'
    CHECK (condition_resource_type = 'Condition'),
  condition_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  PRIMARY KEY (workspace_id, epoch, confirmation_id, ordinal),
  UNIQUE (workspace_id, epoch, condition_id),
  UNIQUE (workspace_id, epoch, confirmation_id, catalog_item_id),
  FOREIGN KEY (workspace_id, epoch, confirmation_id)
    REFERENCES diagnosis_confirmation (
      workspace_id, epoch, confirmation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, catalog_item_id)
    REFERENCES diagnosis_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, epoch, condition_resource_type, condition_id
  ) REFERENCES fhir_resource (
    workspace_id, epoch, resource_type, resource_id
  ) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX diagnosis_entry_primary_unique
  ON diagnosis_entry (workspace_id, epoch, confirmation_id)
  WHERE role = 'primary';
