CREATE TABLE scenario_dataset (
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('builtin', 'synthea')),
  version INTEGER NOT NULL CHECK (version > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX scenario_dataset_list_idx
  ON scenario_dataset (workspace_id, updated_at DESC, dataset_id);

CREATE TABLE scenario_package (
  workspace_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  source_dataset_id TEXT NOT NULL,
  source_dataset_version INTEGER NOT NULL CHECK (source_dataset_version > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, package_id),
  UNIQUE (workspace_id, source_dataset_id, source_dataset_version),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;
