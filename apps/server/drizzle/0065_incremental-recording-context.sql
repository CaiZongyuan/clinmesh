-- The migration runner stages actor_context_json only when the early 0064 schema lacks it.
-- Recover the exact job selected by the original verification event, never a current case actor.
UPDATE consultation_recording_verification AS v SET actor_context_json = (
  SELECT j.actor_context_json FROM outbox_event e
  JOIN consultation_recording_job j
    ON j.workspace_id = e.workspace_id AND j.epoch = e.epoch
    AND j.turn_id = json_extract(e.payload_json, '$.turnId')
    AND j.case_id = v.case_id
  WHERE e.workspace_id = v.workspace_id AND e.epoch = v.epoch
    AND e.kind = 'consultation.verify-history'
    AND json_extract(e.payload_json, '$.batchId') = v.batch_id
    AND json_extract(e.payload_json, '$.additionId') = v.addition_id
) WHERE actor_context_json IS NULL;

CREATE TABLE consultation_recording_verification_upgrade (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  addition_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'flagged', 'failed', 'stale')),
  reason TEXT CHECK (reason IN ('verification-rejected', 'verification-unavailable')),
  elapsed_ms INTEGER CHECK (elapsed_ms >= 0),
  PRIMARY KEY (workspace_id, epoch, case_id, addition_id),
  FOREIGN KEY (workspace_id, epoch, case_id, addition_id)
    REFERENCES consultation_history_addition (workspace_id, epoch, case_id, addition_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, batch_id)
    REFERENCES consultation_recording_batch (workspace_id, epoch, batch_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO consultation_recording_verification_upgrade
  (workspace_id, epoch, case_id, addition_id, batch_id, content_hash, actor_context_json, status, reason, elapsed_ms)
SELECT workspace_id, epoch, case_id, addition_id, batch_id, content_hash, actor_context_json, status, reason, elapsed_ms
FROM consultation_recording_verification;
DROP TABLE consultation_recording_verification;
ALTER TABLE consultation_recording_verification_upgrade RENAME TO consultation_recording_verification;
CREATE INDEX consultation_recording_verification_pending
  ON consultation_recording_verification (workspace_id, epoch, batch_id, status);

UPDATE consultation_recording_job AS j SET result = CASE WHEN EXISTS (
  SELECT 1 FROM consultation_history_addition a
  WHERE a.workspace_id = j.workspace_id AND a.epoch = j.epoch AND a.case_id = j.case_id
    AND (a.source_turn_id = j.turn_id OR EXISTS (
      SELECT 1 FROM json_each(a.facts_json) fact, json_each(fact.value, '$.sources') source
      WHERE json_extract(source.value, '$.sourceTurnId') = j.turn_id
    ))
) THEN 'recorded' ELSE 'no-new-facts' END WHERE status = 'completed' AND result IS NULL;
