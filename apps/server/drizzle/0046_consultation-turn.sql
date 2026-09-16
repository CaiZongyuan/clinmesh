CREATE TABLE consultation_turn (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  speaker TEXT NOT NULL CHECK (speaker IN ('doctor', 'patient')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'report-card')),
  source TEXT NOT NULL CHECK (source IN (
    'doctor-typed', 'patient-agent', 'persona-opening', 'report-card', 'legacy-question-answer',
    'asr-import', 'external-sync'
  )),
  message_text TEXT NOT NULL,
  persona_revision INTEGER CHECK (persona_revision IS NULL OR persona_revision > 0),
  report_reference TEXT,
  actor_id TEXT,
  practitioner_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, turn_id),
  UNIQUE (workspace_id, epoch, case_id, sequence),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX consultation_turn_case_sequence_idx
  ON consultation_turn (workspace_id, epoch, case_id, sequence);

INSERT INTO consultation_turn (
  workspace_id, epoch, turn_id, case_id, sequence, speaker, kind, source,
  message_text, persona_revision, report_reference, actor_id, practitioner_id, recorded_at
)
SELECT
  workspace_id, epoch, record_id || ':question', case_id, sequence * 2 - 1,
  'doctor', 'text', 'legacy-question-answer', question_text,
  NULL, NULL, asked_by_actor_id, asked_by_practitioner_id, recorded_at
FROM consultation_record;

INSERT INTO consultation_turn (
  workspace_id, epoch, turn_id, case_id, sequence, speaker, kind, source,
  message_text, persona_revision, report_reference, actor_id, practitioner_id, recorded_at
)
SELECT
  workspace_id, epoch, record_id || ':answer', case_id, sequence * 2,
  'patient', 'text', 'legacy-question-answer', answer_text,
  NULL, NULL, NULL, NULL, recorded_at
FROM consultation_record;

UPDATE consultation
SET version = (
  SELECT coalesce(MAX(turn.sequence), 0) + 1
  FROM consultation_turn AS turn
  WHERE turn.workspace_id = consultation.workspace_id
    AND turn.epoch = consultation.epoch
    AND turn.case_id = consultation.case_id
);

DROP TABLE consultation_record;
DROP TABLE consultation_question_rule;
DROP TABLE virtual_patient_question_rule;
DROP TABLE virtual_patient_case;
DROP TABLE virtual_patient;
