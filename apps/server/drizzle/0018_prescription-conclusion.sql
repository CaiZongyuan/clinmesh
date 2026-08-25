UPDATE outpatient_catalog
SET config_json = json_set(
  config_json,
  '$.allowedCourseDays', json('[5]'),
  '$.allowedDiagnosisCatalogItemIds', json('["diagnosis-influenza"]'),
  '$.allowedQuantities', json('[10]'),
  '$.defaultCourseDays', 5,
  '$.defaultQuantity', 10
)
WHERE kind = 'medication' AND item_id = 'medication-oseltamivir';

UPDATE outpatient_catalog
SET config_json = json_set(
  config_json,
  '$.allowedCourseDays', json('[3]'),
  '$.allowedDiagnosisCatalogItemIds', json('["diagnosis-influenza","diagnosis-acute-upper-respiratory-infection","diagnosis-fever"]'),
  '$.allowedQuantities', json('[6]'),
  '$.defaultCourseDays', 3,
  '$.defaultQuantity', 6
)
WHERE kind = 'medication' AND item_id = 'medication-acetaminophen';

ALTER TABLE prescription
ADD COLUMN authored_by_practitioner_role_id TEXT;

ALTER TABLE prescription_item
ADD COLUMN course_days INTEGER NOT NULL DEFAULT 1
CHECK (course_days > 0 AND course_days <= 30);

UPDATE prescription_item
SET course_days = CASE medication_id
  WHEN 'medication-oseltamivir' THEN 5
  WHEN 'medication-acetaminophen' THEN 3
  ELSE course_days
END;

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
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
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
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
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
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT
) STRICT;
