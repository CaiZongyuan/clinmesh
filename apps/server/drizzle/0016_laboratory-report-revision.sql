CREATE TABLE laboratory_report_revision (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  diagnostic_report_id TEXT NOT NULL,
  revision_of_diagnostic_report_id TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  corrected_by TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, revision_id),
  UNIQUE (workspace_id, epoch, diagnostic_report_id),
  UNIQUE (workspace_id, epoch, revision_of_diagnostic_report_id),
  UNIQUE (workspace_id, epoch, provenance_id),
  FOREIGN KEY (workspace_id, epoch, request_id)
    REFERENCES laboratory_request (workspace_id, epoch, request_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX laboratory_report_revision_request_idx
  ON laboratory_report_revision (workspace_id, epoch, request_id, corrected_at);
