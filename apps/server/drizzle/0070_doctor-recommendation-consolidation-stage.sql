-- 病史整理（history-consolidation）作为独立执行阶段纳入请求账本：扩展执行计划的 stage CHECK。
-- SQLite 无法原地修改 CHECK 约束，按官方表重建流程在事务内完成换表；
-- 迁移期间外键保持开启，先重命名旧表让子表引用跟随改写，再重建并回填，保留全部检查点与审计行。
ALTER TABLE doctor_recommendation_execution_plan RENAME TO doctor_recommendation_execution_plan_deprecated;

CREATE TABLE doctor_recommendation_execution_plan (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('history-selection', 'history-consolidation', 'catalog-selection', 'generation', 'verification')),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  PRIMARY KEY (workspace_id, epoch, execution_key, stage),
  FOREIGN KEY (workspace_id, epoch, execution_key)
    REFERENCES doctor_recommendation_execution(workspace_id, epoch, execution_key) ON DELETE RESTRICT
) STRICT;

INSERT INTO doctor_recommendation_execution_plan SELECT * FROM doctor_recommendation_execution_plan_deprecated;

ALTER TABLE doctor_recommendation_execution_unit RENAME TO doctor_recommendation_execution_unit_deprecated;

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

INSERT INTO doctor_recommendation_execution_unit SELECT * FROM doctor_recommendation_execution_unit_deprecated;

DROP TABLE doctor_recommendation_execution_unit_deprecated;
DROP TABLE doctor_recommendation_execution_plan_deprecated;

CREATE INDEX doctor_recommendation_execution_selection
ON doctor_recommendation_execution_unit (workspace_id, epoch, stage, input_hash) WHERE status = 'succeeded';
