CREATE TABLE scenario_generation_job (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  result_dataset_id TEXT,
  dataset_workspace_id TEXT,
  dataset_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_by_actor_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (dataset_workspace_id, dataset_id)
    REFERENCES scenario_dataset (workspace_id, dataset_id) ON DELETE SET NULL,
  CHECK (
    (dataset_workspace_id IS NULL AND dataset_id IS NULL)
    OR (dataset_workspace_id = workspace_id AND dataset_id IS NOT NULL)
  ),
  CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL
      AND result_dataset_id IS NULL AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL
      AND result_dataset_id IS NULL AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND result_dataset_id IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND result_dataset_id IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)
  )
) STRICT;

CREATE INDEX scenario_generation_job_dispatch_idx
  ON scenario_generation_job (status, created_at, job_id);
