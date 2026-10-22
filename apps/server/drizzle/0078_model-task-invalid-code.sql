-- 结构化输出的固定安全领域分类，与控制拒绝码 blocked_code 独立持久。
ALTER TABLE model_task_step ADD COLUMN invalid_code TEXT;
