ALTER TABLE laboratory_request ADD COLUMN diagnostic_report_id TEXT;

CREATE UNIQUE INDEX laboratory_request_diagnostic_report_unique
  ON laboratory_request (workspace_id, epoch, diagnostic_report_id)
  WHERE diagnostic_report_id IS NOT NULL;

INSERT OR IGNORE INTO scenario_hidden_fact (
  workspace_id, epoch, fact_code, value_json
)
SELECT workspace_id, epoch, 'laboratory-results',
  '{"lab-cbc":{"conclusion":"白细胞计数升高，其余血常规指标在参考范围内。","results":[{"code":"6690-2","display":"白细胞计数","interpretation":"high","referenceRange":{"high":9.5,"low":3.5,"text":"3.5-9.5 x10^9/L"},"unit":{"code":"10*9/L","display":"10^9/L","system":"http://unitsofmeasure.org"},"value":11.2},{"code":"718-7","display":"血红蛋白","interpretation":"normal","referenceRange":{"high":150,"low":115,"text":"115-150 g/L"},"unit":{"code":"g/L","display":"g/L","system":"http://unitsofmeasure.org"},"value":135},{"code":"777-3","display":"血小板计数","interpretation":"normal","referenceRange":{"high":350,"low":125,"text":"125-350 x10^9/L"},"unit":{"code":"10*9/L","display":"10^9/L","system":"http://unitsofmeasure.org"},"value":210}]},"lab-crp":{"conclusion":"C 反应蛋白升高。","results":[{"code":"1988-5","display":"C 反应蛋白","interpretation":"high","referenceRange":{"high":8,"low":0,"text":"0-8 mg/L"},"unit":{"code":"mg/L","display":"mg/L","system":"http://unitsofmeasure.org"},"value":18.6}]}}'
FROM scenario_epoch_state;
