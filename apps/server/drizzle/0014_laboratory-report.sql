ALTER TABLE laboratory_request ADD COLUMN diagnostic_report_id TEXT;

CREATE UNIQUE INDEX laboratory_request_diagnostic_report_unique
  ON laboratory_request (workspace_id, epoch, diagnostic_report_id)
  WHERE diagnostic_report_id IS NOT NULL;
