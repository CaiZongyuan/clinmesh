CREATE TABLE virtual_patient_question_rule (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  virtual_patient_id TEXT NOT NULL,
  question_code TEXT NOT NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  question_text TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  fact_code TEXT,
  revealed_answer_text TEXT,
  CHECK (
    (fact_code IS NULL AND revealed_answer_text IS NULL)
    OR (fact_code IS NOT NULL AND revealed_answer_text IS NOT NULL)
  ),
  PRIMARY KEY (workspace_id, epoch, virtual_patient_id, question_code),
  UNIQUE (workspace_id, epoch, virtual_patient_id, ordinal),
  FOREIGN KEY (workspace_id, epoch, virtual_patient_id)
    REFERENCES virtual_patient (workspace_id, epoch, virtual_patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, fact_code)
    REFERENCES scenario_hidden_fact (workspace_id, epoch, fact_code) ON DELETE RESTRICT
) STRICT;

CREATE TABLE consultation (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE consultation_record (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  record_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  question_code TEXT NOT NULL,
  question_text TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  asked_by_actor_id TEXT NOT NULL,
  asked_by_practitioner_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, record_id),
  UNIQUE (workspace_id, epoch, case_id, sequence),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX consultation_record_case_sequence_idx
  ON consultation_record (workspace_id, epoch, case_id, sequence);

INSERT INTO consultation (workspace_id, epoch, case_id, version)
SELECT workspace_id, epoch, case_id, 1
FROM virtual_patient_case;
