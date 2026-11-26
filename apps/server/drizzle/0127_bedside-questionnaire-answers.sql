CREATE TABLE bedside_questionnaire_answers (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  answers_json TEXT NOT NULL CHECK (json_valid(answers_json)),
  recorded_by_actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, subject_kind, subject_id, revision)
) STRICT;

CREATE INDEX bedside_questionnaire_answers_patient_lookup
  ON bedside_questionnaire_answers(workspace_id, epoch, patient_id, revision DESC);
