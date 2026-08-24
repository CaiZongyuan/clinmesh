CREATE TABLE scenario_definition (
  scenario_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('candidate', 'density', 'golden')),
  schema_version TEXT NOT NULL,
  clinical_review_json TEXT CHECK (clinical_review_json IS NULL OR json_valid(clinical_review_json)),
  CHECK (kind != 'golden' OR clinical_review_json IS NOT NULL)
) STRICT;

CREATE TABLE scenario_epoch_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  scenario_run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  deterministic_seed INTEGER NOT NULL,
  virtual_time TEXT NOT NULL,
  clock_revision INTEGER NOT NULL DEFAULT 1 CHECK (clock_revision > 0),
  initial_state_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch),
  UNIQUE (workspace_id, epoch, scenario_run_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, scenario_run_id)
    REFERENCES scenario_run (workspace_id, epoch, scenario_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_id) REFERENCES scenario_definition (scenario_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE scenario_hidden_fact (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fact_code TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY (workspace_id, epoch, fact_code),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES scenario_epoch_state (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE scenario_reveal_policy (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  policy_code TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  fact_code TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, policy_code),
  FOREIGN KEY (workspace_id, epoch, fact_code)
    REFERENCES scenario_hidden_fact (workspace_id, epoch, fact_code) ON DELETE RESTRICT
) STRICT;

CREATE TABLE scenario_simulator_rule (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  simulator TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  outcome TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  PRIMARY KEY (workspace_id, epoch, simulator, rule_code),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES scenario_epoch_state (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;
