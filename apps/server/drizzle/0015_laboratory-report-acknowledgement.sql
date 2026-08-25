CREATE TABLE laboratory_report_acknowledgement (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  acknowledgement_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  diagnostic_report_id TEXT NOT NULL,
  acknowledged_by TEXT NOT NULL,
  acknowledged_by_practitioner_role_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  request_version INTEGER NOT NULL CHECK (request_version > 0),
  PRIMARY KEY (workspace_id, epoch, acknowledgement_id),
  UNIQUE (workspace_id, epoch, diagnostic_report_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX laboratory_report_acknowledgement_request_idx
  ON laboratory_report_acknowledgement (workspace_id, epoch, request_id, acknowledged_at);
