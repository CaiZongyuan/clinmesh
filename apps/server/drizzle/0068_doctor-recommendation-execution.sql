CREATE TABLE doctor_recommendation_execution (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  extra_request_count INTEGER NOT NULL DEFAULT 0 CHECK (extra_request_count BETWEEN 0 AND 4),
  PRIMARY KEY (workspace_id, epoch, execution_key),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE doctor_recommendation_execution_plan (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('history-selection', 'catalog-selection', 'generation', 'verification')),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  PRIMARY KEY (workspace_id, epoch, execution_key, stage),
  FOREIGN KEY (workspace_id, epoch, execution_key)
    REFERENCES doctor_recommendation_execution(workspace_id, epoch, execution_key) ON DELETE RESTRICT
) STRICT;

CREATE TABLE doctor_recommendation_execution_unit (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'succeeded', 'failed', 'unknown')),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 3),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  resume_available INTEGER NOT NULL DEFAULT 0 CHECK (resume_available IN (0, 1)),
  PRIMARY KEY (workspace_id, epoch, execution_key, stage, batch_id),
  FOREIGN KEY (workspace_id, epoch, execution_key, stage)
    REFERENCES doctor_recommendation_execution_plan(workspace_id, epoch, execution_key, stage) ON DELETE RESTRICT,
  CHECK ((status = 'succeeded') = (result_json IS NOT NULL))
) STRICT;

CREATE TABLE doctor_recommendation_execution_continue (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, execution_key, intent_key),
  FOREIGN KEY (workspace_id, epoch, execution_key)
    REFERENCES doctor_recommendation_execution(workspace_id, epoch, execution_key) ON DELETE RESTRICT
) STRICT;

CREATE INDEX doctor_recommendation_execution_selection
ON doctor_recommendation_execution_unit (workspace_id, epoch, stage, input_hash) WHERE status = 'succeeded';

-- Old pending tasks cannot prove whether a model request was already dispatched.
UPDATE doctor_recommendation_state
SET status = 'failed', state_json = json_set(state_json, '$.status', 'failed', '$.errorCode', 'MODEL_OUTCOME_UNKNOWN',
  '$.items', json('[]'), '$.considerations', json('[]'), '$.missingInformation',
  json('["升级前任务缺少完整执行记录，结果未知；自动处理已停止，请明确重新生成。"]'))
WHERE status = 'pending';
