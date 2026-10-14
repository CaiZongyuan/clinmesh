CREATE TABLE doctor_recommendation_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  context_key TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('laboratory', 'imaging', 'pathology', 'diagnosis', 'prescription')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  input_fingerprint TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'missing-evidence')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, actor_id, context_key, case_id, kind),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
