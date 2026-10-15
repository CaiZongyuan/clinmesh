CREATE TABLE clinical_document_quality (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY (workspace_id, epoch, case_id, scope_key),
  FOREIGN KEY (workspace_id, epoch, case_id) REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE clinical_document_quality_review (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  related_fingerprint TEXT NOT NULL,
  review_json TEXT NOT NULL CHECK (json_valid(review_json)),
  PRIMARY KEY (workspace_id, epoch, case_id, related_fingerprint),
  FOREIGN KEY (workspace_id, epoch, case_id) REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE clinical_document_agent_content (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  fragments_json TEXT NOT NULL CHECK (json_valid(fragments_json)),
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id) REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
