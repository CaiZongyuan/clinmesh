CREATE TABLE drg_simulation_case (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id)
);
