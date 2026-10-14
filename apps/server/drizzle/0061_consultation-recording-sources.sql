-- All recorder sources share the existing durable job and fragment lifecycle.
ALTER TABLE consultation_recording RENAME TO consultation_recording_legacy;
CREATE TABLE consultation_recording (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  start_sequence INTEGER NOT NULL DEFAULT 2 CHECK (start_sequence > 0),
  actor_context_json TEXT CHECK (actor_context_json IS NULL OR json_valid(actor_context_json)),
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO consultation_recording (workspace_id, epoch, case_id, version, paused, start_sequence)
SELECT workspace_id, epoch, case_id, version, paused, start_sequence FROM consultation_recording_legacy;

CREATE TABLE consultation_recording_source (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('patient', 'doctor', 'report')),
  message_text TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  recorded_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  PRIMARY KEY (workspace_id, epoch, source_id),
  UNIQUE (workspace_id, epoch, case_id, sequence),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO consultation_recording_source
  (workspace_id, epoch, case_id, source_id, source_kind, message_text, sequence, recorded_at, metadata_json)
SELECT workspace_id, epoch, case_id, turn_id, 'patient', message_text, sequence, recorded_at,
  json_object('consultationTurnId', turn_id) FROM consultation_turn WHERE speaker = 'patient' AND kind = 'text';

CREATE TABLE consultation_recording_job_sources (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed', 'failed')),
  error_code TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  scheduled INTEGER NOT NULL DEFAULT 1 CHECK (scheduled IN (0, 1)),
  PRIMARY KEY (workspace_id, epoch, turn_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation_recording (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, turn_id)
    REFERENCES consultation_recording_source (workspace_id, epoch, source_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO consultation_recording_job_sources SELECT * FROM consultation_recording_job;
DROP TABLE consultation_recording_job;
ALTER TABLE consultation_recording_job_sources RENAME TO consultation_recording_job;
CREATE INDEX consultation_recording_job_case_idx ON consultation_recording_job (workspace_id, epoch, case_id);

-- Preserve extracts, ownership, review and inverse history; summaries add a new relation.
CREATE TABLE consultation_history_addition_sources (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  addition_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('chiefComplaint', 'historyOfPresentIllness', 'priorMedicalHistory', 'physicalExamination', 'auxiliaryExamination', 'assessment', 'disposition', 'followUp')),
  quote TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('addition', 'update', 'correction', 'conflict')),
  status TEXT NOT NULL CHECK (status IN ('applied', 'pending')),
  target_addition_id TEXT,
  ownership TEXT NOT NULL DEFAULT 'automatic' CHECK (ownership IN ('automatic', 'manual')),
  start_offset INTEGER,
  end_offset INTEGER,
  current_text TEXT NOT NULL DEFAULT '',
  review_state TEXT CHECK (review_state IN ('superseded', 'ignored')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'confirmed', 'undo-pending')),
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1)),
  undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
  inverse_text TEXT,
  facts_json TEXT CHECK (facts_json IS NULL OR json_valid(facts_json)),
  PRIMARY KEY (workspace_id, epoch, case_id, addition_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation_recording (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, source_turn_id)
    REFERENCES consultation_recording_source (workspace_id, epoch, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO consultation_history_addition_sources SELECT * FROM consultation_history_addition;
DROP TABLE consultation_history_addition;
ALTER TABLE consultation_history_addition_sources RENAME TO consultation_history_addition;
DROP TABLE consultation_recording_legacy;
