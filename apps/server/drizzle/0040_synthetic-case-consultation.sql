CREATE TABLE consultation_question_rule (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  question_code TEXT NOT NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  question_text TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id, question_code),
  UNIQUE (workspace_id, epoch, case_id, ordinal),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
