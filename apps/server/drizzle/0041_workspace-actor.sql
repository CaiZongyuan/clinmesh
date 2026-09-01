CREATE TABLE workspace_actor (
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'suspended')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, actor_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO workspace_actor (workspace_id, actor_id, kind, status, created_at)
SELECT workspace_id, actor_id, 'human', status, created_at
FROM workspace_membership;

INSERT INTO workspace_actor (workspace_id, actor_id, kind, status, created_at)
SELECT workspace_id, actor_id, 'agent', status, created_at
FROM agent_client;

CREATE TRIGGER workspace_membership_actor_insert
AFTER INSERT ON workspace_membership
BEGIN
  INSERT INTO workspace_actor (workspace_id, actor_id, kind, status, created_at)
  VALUES (NEW.workspace_id, NEW.actor_id, 'human', NEW.status, NEW.created_at);
END;

CREATE TRIGGER workspace_membership_actor_update
AFTER UPDATE OF status ON workspace_membership
BEGIN
  UPDATE workspace_actor SET status = NEW.status
  WHERE workspace_id = NEW.workspace_id AND actor_id = NEW.actor_id;
END;

CREATE TRIGGER agent_client_actor_insert
AFTER INSERT ON agent_client
BEGIN
  INSERT INTO workspace_actor (workspace_id, actor_id, kind, status, created_at)
  VALUES (NEW.workspace_id, NEW.actor_id, 'agent', NEW.status, NEW.created_at);
END;

CREATE TRIGGER agent_client_actor_update
AFTER UPDATE OF status ON agent_client
BEGIN
  UPDATE workspace_actor SET status = NEW.status
  WHERE workspace_id = NEW.workspace_id AND actor_id = NEW.actor_id;
END;

ALTER TABLE prescription_authorship RENAME TO prescription_authorship_legacy;

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
    REFERENCES workspace_actor (workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authored_by_practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO prescription_authorship
SELECT * FROM prescription_authorship_legacy;

DROP TABLE prescription_authorship_legacy;

ALTER TABLE prescription_draft_state RENAME TO prescription_draft_state_legacy;

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
    REFERENCES workspace_actor (workspace_id, actor_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO prescription_draft_state
SELECT * FROM prescription_draft_state_legacy;

DROP TABLE prescription_draft_state_legacy;

ALTER TABLE no_medication_conclusion RENAME TO no_medication_conclusion_legacy;

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
    REFERENCES workspace_actor (workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authored_by_practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO no_medication_conclusion
SELECT * FROM no_medication_conclusion_legacy;

DROP TABLE no_medication_conclusion_legacy;

ALTER TABLE prescription_withdrawal RENAME TO prescription_withdrawal_legacy;

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
    REFERENCES workspace_actor (workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, withdrawn_by_practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO prescription_withdrawal
SELECT * FROM prescription_withdrawal_legacy;

DROP TABLE prescription_withdrawal_legacy;
