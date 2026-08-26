CREATE TABLE clinical_document_draft (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE clinical_document_sign_preview (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX signed_clinical_document_root_case_unique
ON signed_clinical_document (workspace_id, epoch, case_id)
WHERE revision_of_document_id IS NULL;
