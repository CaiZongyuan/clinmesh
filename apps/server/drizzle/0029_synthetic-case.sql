CREATE TABLE synthetic_case_instance (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  case_type TEXT NOT NULL CHECK (case_type IN ('new-problem', 'follow-up', 'preventive')),
  status TEXT NOT NULL CHECK (status IN (
    'brief-pending', 'brief-ready', 'started', 'completed', 'retired'
  )),
  active_brief_revision INTEGER CHECK (active_brief_revision IS NULL OR active_brief_revision > 0),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  visible_history_count INTEGER NOT NULL CHECK (visible_history_count >= 0),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, case_id),
  UNIQUE (workspace_id, profile_id, profile_revision),
  FOREIGN KEY (workspace_id, profile_id, profile_revision)
    REFERENCES synthetic_patient_profile_revision (workspace_id, profile_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX synthetic_case_instance_list_idx
  ON synthetic_case_instance (workspace_id, updated_at DESC, case_id);

CREATE TABLE synthetic_case_visible_resource (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_json TEXT NOT NULL CHECK (json_valid(resource_json)),
  PRIMARY KEY (workspace_id, case_id, source_reference),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE synthetic_case_visible_history (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  source_reference TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  clinical_date TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (workspace_id, case_id, sequence),
  UNIQUE (workspace_id, case_id, source_reference),
  FOREIGN KEY (workspace_id, case_id, source_reference)
    REFERENCES synthetic_case_visible_resource (workspace_id, case_id, source_reference)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX synthetic_case_visible_history_page_idx
  ON synthetic_case_visible_history (workspace_id, case_id, sequence);

CREATE TABLE synthetic_case_truth (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  index_encounter_reference TEXT NOT NULL,
  hidden_resource_references_json TEXT NOT NULL
    CHECK (json_valid(hidden_resource_references_json)),
  hidden_resources_json TEXT NOT NULL CHECK (json_valid(hidden_resources_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, case_id),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT
) STRICT;

ALTER TABLE scenario_generation_job
  ADD COLUMN result_profile_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(result_profile_ids_json));

ALTER TABLE scenario_generation_job
  ADD COLUMN result_case_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(result_case_ids_json));
