CREATE TABLE laboratory_service_publication_job (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  job_id TEXT NOT NULL,
  reference_release_id TEXT NOT NULL,
  concept_ids_json TEXT NOT NULL CHECK (json_valid(concept_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  model_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  created_by_actor_id TEXT NOT NULL,
  published_service_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(published_service_ids_json)),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, job_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX laboratory_service_publication_job_queue_idx
  ON laboratory_service_publication_job (status, created_at, job_id)
  WHERE status = 'queued';

CREATE TABLE laboratory_service_publication_candidate (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  reference_release_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('publishing', 'published', 'failed')),
  version INTEGER NOT NULL CHECK (version > 0),
  job_id TEXT NOT NULL,
  published_service_id TEXT,
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, reference_release_id, concept_id),
  FOREIGN KEY (workspace_id, epoch, job_id)
    REFERENCES laboratory_service_publication_job (workspace_id, epoch, job_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX laboratory_service_publication_candidate_status_idx
  ON laboratory_service_publication_candidate (
    workspace_id, epoch, reference_release_id, status, concept_id
  );
