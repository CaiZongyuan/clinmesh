-- Preserve all source, anchor, review and inverse data while extending history fields.
CREATE TABLE consultation_history_addition_integrated (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  addition_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('chiefComplaint', 'historyOfPresentIllness', 'priorMedicalHistory', 'familyHistory', 'allergyHistory', 'physicalExamination', 'auxiliaryExamination', 'assessment', 'disposition', 'followUp')),
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

INSERT INTO consultation_history_addition_integrated
  (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
    target_addition_id, ownership, start_offset, end_offset, current_text, review_state,
    review_status, rejected, undone, inverse_text, facts_json)
SELECT workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
  target_addition_id, ownership, start_offset, end_offset, current_text, review_state,
  review_status, rejected, undone, inverse_text, facts_json FROM consultation_history_integration_staging ORDER BY original_rowid;

DROP TABLE consultation_history_addition;
ALTER TABLE consultation_history_addition_integrated RENAME TO consultation_history_addition;

DROP TABLE consultation_history_integration_staging;

-- Reprocess pending suggestions through the current Command and source verifier.
-- The migration changes job state only; it never writes document text.
UPDATE consultation_recording_job AS j
SET status = 'queued', generation = generation + 1, scheduled = 0, error_code = NULL
WHERE EXISTS (
  SELECT 1 FROM consultation_history_addition a
  JOIN consultation_recording_source t ON t.workspace_id = a.workspace_id AND t.epoch = a.epoch AND t.source_id = a.source_turn_id
  JOIN consultation_recording_source current ON current.workspace_id = j.workspace_id AND current.epoch = j.epoch AND current.source_id = j.turn_id
  WHERE a.workspace_id = j.workspace_id AND a.epoch = j.epoch AND a.case_id = j.case_id
    AND a.status = 'pending' AND a.review_state IS NULL AND a.undone = 0 AND a.rejected = 0
    AND current.sequence >= t.sequence
);

UPDATE consultation_history_addition SET review_state = 'superseded'
WHERE status = 'pending' AND review_state IS NULL AND undone = 0 AND rejected = 0;
