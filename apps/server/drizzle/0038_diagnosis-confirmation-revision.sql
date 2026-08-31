ALTER TABLE diagnosis_entry RENAME TO diagnosis_entry_before_revision;
ALTER TABLE diagnosis_confirmation RENAME TO diagnosis_confirmation_before_revision;

CREATE TABLE diagnosis_confirmation (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  supersedes_confirmation_id TEXT,
  provenance_resource_type TEXT NOT NULL DEFAULT 'Provenance'
    CHECK (provenance_resource_type = 'Provenance'),
  provenance_id TEXT NOT NULL,
  confirmed_by_actor_id TEXT NOT NULL,
  confirmed_by_practitioner_role_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, confirmation_id),
  UNIQUE (workspace_id, epoch, case_id, revision_number),
  UNIQUE (workspace_id, epoch, provenance_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, supersedes_confirmation_id)
    REFERENCES diagnosis_confirmation (
      workspace_id, epoch, confirmation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, epoch, provenance_resource_type, provenance_id
  ) REFERENCES fhir_resource (
    workspace_id, epoch, resource_type, resource_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO diagnosis_confirmation (
  workspace_id, epoch, confirmation_id, case_id, revision_number,
  supersedes_confirmation_id, provenance_resource_type, provenance_id,
  confirmed_by_actor_id, confirmed_by_practitioner_role_id, confirmed_at
)
SELECT
  workspace_id, epoch, confirmation_id, case_id, 1, NULL,
  provenance_resource_type, provenance_id, confirmed_by_actor_id,
  confirmed_by_practitioner_role_id, confirmed_at
FROM diagnosis_confirmation_before_revision;

CREATE TABLE diagnosis_entry (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  condition_resource_type TEXT NOT NULL DEFAULT 'Condition'
    CHECK (condition_resource_type = 'Condition'),
  condition_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  coding_snapshot_json TEXT NOT NULL CHECK (json_valid(coding_snapshot_json)),
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  PRIMARY KEY (workspace_id, epoch, confirmation_id, ordinal),
  UNIQUE (workspace_id, epoch, condition_id),
  UNIQUE (workspace_id, epoch, confirmation_id, catalog_item_id),
  FOREIGN KEY (workspace_id, epoch, confirmation_id)
    REFERENCES diagnosis_confirmation (
      workspace_id, epoch, confirmation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, epoch, condition_resource_type, condition_id
  ) REFERENCES fhir_resource (
    workspace_id, epoch, resource_type, resource_id
  ) ON DELETE RESTRICT
) STRICT;

INSERT INTO diagnosis_entry (
  workspace_id, epoch, confirmation_id, ordinal, condition_resource_type,
  condition_id, catalog_item_id, coding_snapshot_json, role
)
SELECT
  workspace_id, epoch, confirmation_id, ordinal, condition_resource_type,
  condition_id, catalog_item_id, coding_snapshot_json, role
FROM diagnosis_entry_before_revision;

DROP TABLE diagnosis_entry_before_revision;
DROP TABLE diagnosis_confirmation_before_revision;

CREATE UNIQUE INDEX diagnosis_entry_primary_unique
  ON diagnosis_entry (workspace_id, epoch, confirmation_id)
  WHERE role = 'primary';

CREATE INDEX diagnosis_confirmation_current_idx
  ON diagnosis_confirmation (workspace_id, epoch, case_id, revision_number DESC);
