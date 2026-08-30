ALTER TABLE diagnosis_entry RENAME TO diagnosis_entry_legacy;

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
  entry.workspace_id,
  entry.epoch,
  entry.confirmation_id,
  entry.ordinal,
  entry.condition_resource_type,
  entry.condition_id,
  entry.catalog_item_id,
  json_object(
    'code', catalog.code,
    'display', catalog.name_zh,
    'id', catalog.item_id,
    'sourceLocator', 'operational:diagnosis_catalog',
    'system', catalog.code_system,
    'version', CAST(catalog.version AS TEXT)
  ),
  entry.role
FROM diagnosis_entry_legacy AS entry
JOIN diagnosis_catalog AS catalog
  ON catalog.workspace_id = entry.workspace_id
 AND catalog.epoch = entry.epoch
 AND catalog.item_id = entry.catalog_item_id;

DROP TABLE diagnosis_entry_legacy;

CREATE UNIQUE INDEX diagnosis_entry_primary_unique
  ON diagnosis_entry (workspace_id, epoch, confirmation_id)
  WHERE role = 'primary';
