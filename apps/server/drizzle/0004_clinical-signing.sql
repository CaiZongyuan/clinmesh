CREATE TABLE clinical_sign_preview (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  expected_versions_json TEXT NOT NULL CHECK (json_valid(expected_versions_json)),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  medication_total_fen INTEGER NOT NULL CHECK (medication_total_fen >= 0),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (workspace_id, epoch, preview_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE signed_clinical_document (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  document_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  composition_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  revision_of_document_id TEXT,
  signed_by TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, document_id),
  UNIQUE (workspace_id, epoch, composition_id),
  UNIQUE (workspace_id, epoch, bundle_id),
  UNIQUE (workspace_id, epoch, provenance_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, revision_of_document_id)
    REFERENCES signed_clinical_document (workspace_id, epoch, document_id) ON DELETE RESTRICT
) STRICT;
