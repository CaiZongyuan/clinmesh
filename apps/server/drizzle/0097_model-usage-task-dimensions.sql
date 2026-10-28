ALTER TABLE model_usage_daily RENAME TO model_usage_daily_legacy;

CREATE TABLE model_usage_daily (
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  epoch TEXT NOT NULL,
  date TEXT NOT NULL,
  case_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  feature TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  status TEXT NOT NULL,
  requests INTEGER NOT NULL,
  unknown_requests INTEGER NOT NULL,
  known_tokens INTEGER NOT NULL,
  unknown_token_requests INTEGER NOT NULL,
  cny_micro INTEGER,
  unpriced_requests INTEGER NOT NULL,
  known_input_tokens INTEGER NOT NULL,
  known_output_tokens INTEGER NOT NULL,
  unknown_input_token_requests INTEGER NOT NULL,
  unknown_output_token_requests INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, epoch, date, case_id, task_id, stage, feature, provider, requested_model, actual_model, status)
);

-- Expired details cannot be used to infer a legacy aggregate's task or stage.
INSERT INTO model_usage_daily
  (workspace_id, epoch, date, case_id, task_id, stage, feature, provider, requested_model, actual_model, status,
    requests, unknown_requests, known_tokens, unknown_token_requests, cny_micro, unpriced_requests,
    known_input_tokens, known_output_tokens, unknown_input_token_requests, unknown_output_token_requests)
SELECT workspace_id, epoch, date, case_id, '', '', feature, provider, requested_model, actual_model, status,
  requests, unknown_requests, known_tokens, unknown_token_requests, cny_micro, unpriced_requests,
  known_input_tokens, known_output_tokens, unknown_input_token_requests, unknown_output_token_requests
FROM model_usage_daily_legacy;

DROP TABLE model_usage_daily_legacy;
CREATE INDEX model_usage_daily_workspace_date ON model_usage_daily(workspace_id, date);
