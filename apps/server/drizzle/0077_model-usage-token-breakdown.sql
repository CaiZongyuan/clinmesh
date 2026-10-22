ALTER TABLE model_usage_daily ADD COLUMN known_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_usage_daily ADD COLUMN known_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_usage_daily ADD COLUMN unknown_input_token_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_usage_daily ADD COLUMN unknown_output_token_requests INTEGER NOT NULL DEFAULT 0;

-- Old daily totals cannot recover the split after their request details were deleted.
UPDATE model_usage_daily SET unknown_input_token_requests = requests, unknown_output_token_requests = requests;
