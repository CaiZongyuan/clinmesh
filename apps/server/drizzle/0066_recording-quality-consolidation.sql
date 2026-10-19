-- Keep the immutable recording input linked to its saved facts independently of
-- the retired verifier. Historical verdicts and their original states remain readable.
CREATE UNIQUE INDEX consultation_recording_batch_case
  ON consultation_recording_batch (workspace_id, epoch, case_id, batch_id);

CREATE TABLE consultation_history_addition_batch (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  addition_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id, addition_id),
  FOREIGN KEY (workspace_id, epoch, case_id, addition_id)
    REFERENCES consultation_history_addition (workspace_id, epoch, case_id, addition_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, case_id, batch_id)
    REFERENCES consultation_recording_batch (workspace_id, epoch, case_id, batch_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO consultation_history_addition_batch (workspace_id, epoch, case_id, addition_id, batch_id)
  SELECT v.workspace_id, v.epoch, v.case_id, v.addition_id, v.batch_id
  FROM consultation_recording_verification v JOIN consultation_recording_batch b
    ON b.workspace_id = v.workspace_id AND b.epoch = v.epoch
      AND b.case_id = v.case_id AND b.batch_id = v.batch_id;

ALTER TABLE consultation_recording_verification ADD COLUMN retired_status TEXT
  CHECK (retired_status IN ('pending', 'verified', 'flagged', 'failed', 'stale'));
UPDATE consultation_recording_verification SET retired_status = status,
  status = CASE WHEN status = 'pending' THEN 'stale' ELSE status END;
