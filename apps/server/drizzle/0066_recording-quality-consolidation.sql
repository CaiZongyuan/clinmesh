-- Keep the immutable recording input linked to its saved facts independently of
-- the retired verifier. Historical verdicts and their original states remain readable.
ALTER TABLE consultation_history_addition ADD COLUMN batch_id TEXT;
UPDATE consultation_history_addition AS a SET batch_id = (
  SELECT v.batch_id FROM consultation_recording_verification v
  WHERE v.workspace_id = a.workspace_id AND v.epoch = a.epoch
    AND v.case_id = a.case_id AND v.addition_id = a.addition_id
);

ALTER TABLE consultation_recording_verification ADD COLUMN retired_status TEXT
  CHECK (retired_status IN ('pending', 'verified', 'flagged', 'failed', 'stale'));
UPDATE consultation_recording_verification SET retired_status = status,
  status = CASE WHEN status = 'pending' THEN 'stale' ELSE status END;
