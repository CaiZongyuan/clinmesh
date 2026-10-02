-- 成功的生成任务可以附带警告：患者已保存，但后续步骤（例如定向生成后的影像准备）未完成。
ALTER TABLE scenario_generation_job ADD COLUMN warning_code TEXT;
ALTER TABLE scenario_generation_job ADD COLUMN warning_message TEXT;
