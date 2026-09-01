CREATE TABLE patient_brief_job (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  model_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  created_by_actor_id TEXT NOT NULL,
  result_revision INTEGER CHECK (result_revision IS NULL OR result_revision > 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT,
  CHECK (
    (error_code IS NULL AND error_message IS NULL)
    OR (error_code IS NOT NULL AND error_message IS NOT NULL)
  )
) STRICT;

CREATE INDEX patient_brief_job_queue_idx
  ON patient_brief_job (status, created_at, job_id);

CREATE INDEX patient_brief_job_case_idx
  ON patient_brief_job (workspace_id, case_id, created_at DESC, job_id);

CREATE TABLE patient_brief_revision (
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  output_hash TEXT NOT NULL CHECK (length(output_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, case_id, revision),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT
) STRICT;
