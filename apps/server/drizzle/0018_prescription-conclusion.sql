ALTER TABLE prescription_item
ADD COLUMN course_days INTEGER NOT NULL DEFAULT 1
CHECK (course_days > 0 AND course_days <= 30);

UPDATE prescription_item
SET course_days = CASE medication_id
  WHEN 'medication-oseltamivir' THEN 5
  WHEN 'medication-acetaminophen' THEN 3
  ELSE course_days
END;

CREATE TABLE prescription_authorship (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  authored_by_actor_id TEXT NOT NULL,
  authored_by_practitioner_role_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, prescription_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authored_by_actor_id)
    REFERENCES workspace_membership (workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authored_by_practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE prescription_draft_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, updated_by)
    REFERENCES workspace_membership (workspace_id, actor_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE no_medication_conclusion (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  conclusion_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  authored_by_actor_id TEXT NOT NULL,
  authored_by_practitioner_role_id TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, conclusion_id),
  UNIQUE (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authored_by_actor_id)
    REFERENCES workspace_membership (workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authored_by_practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE prescription_withdrawal (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  withdrawal_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  withdrawn_by_actor_id TEXT NOT NULL,
  withdrawn_by_practitioner_role_id TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, withdrawal_id),
  UNIQUE (workspace_id, epoch, prescription_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, withdrawn_by_actor_id)
    REFERENCES workspace_membership (workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, withdrawn_by_practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;
