-- Reprocess pending suggestions through the current Command and source verifier.
-- The migration changes job state only; it never writes document text.
UPDATE consultation_recording_job AS j
SET status = 'queued', generation = generation + 1, scheduled = 0, error_code = NULL
WHERE EXISTS (
  SELECT 1 FROM consultation_history_addition a
  JOIN consultation_turn t ON t.workspace_id = a.workspace_id AND t.epoch = a.epoch AND t.turn_id = a.source_turn_id
  JOIN consultation_turn current ON current.workspace_id = j.workspace_id AND current.epoch = j.epoch AND current.turn_id = j.turn_id
  WHERE a.workspace_id = j.workspace_id AND a.epoch = j.epoch AND a.case_id = j.case_id
    AND a.status = 'pending' AND a.review_state IS NULL AND a.undone = 0 AND a.rejected = 0
    AND current.sequence >= t.sequence
);

UPDATE consultation_history_addition SET review_state = 'superseded'
WHERE status = 'pending' AND review_state IS NULL AND undone = 0 AND rejected = 0;
