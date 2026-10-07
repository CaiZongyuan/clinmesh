CREATE TABLE ai_model_binding (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;
