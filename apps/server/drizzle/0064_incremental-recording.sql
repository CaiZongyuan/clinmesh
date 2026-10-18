ALTER TABLE consultation_recording_job ADD COLUMN result TEXT
  CHECK (result IN ('recorded', 'no-new-facts', 'needs-verification', 'failed'));
ALTER TABLE consultation_recording_job ADD COLUMN lane TEXT NOT NULL DEFAULT 'realtime'
  CHECK (lane IN ('realtime', 'backfill'));
ALTER TABLE consultation_recording_source ADD COLUMN saved_at TEXT;

UPDATE consultation_recording_job AS j SET result = CASE WHEN EXISTS (
  SELECT 1 FROM consultation_history_addition a
  WHERE a.workspace_id = j.workspace_id AND a.epoch = j.epoch AND a.case_id = j.case_id
    AND (a.source_turn_id = j.turn_id OR EXISTS (
      SELECT 1 FROM json_each(a.facts_json) fact, json_each(fact.value, '$.sources') source
      WHERE json_extract(source.value, '$.sourceTurnId') = j.turn_id
    ))
) THEN 'recorded' ELSE 'no-new-facts' END WHERE status = 'completed';

CREATE TABLE consultation_recording_batch (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  timings_json TEXT CHECK (timings_json IS NULL OR json_valid(timings_json)),
  PRIMARY KEY (workspace_id, epoch, batch_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation_recording (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE consultation_recording_verification (
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

CREATE TABLE consultation_recording_candidate_failure (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  reason TEXT NOT NULL CHECK (reason IN ('citation', 'target', 'field-limit')),
  PRIMARY KEY (workspace_id, epoch, batch_id, candidate_id),
  FOREIGN KEY (workspace_id, epoch, batch_id)
    REFERENCES consultation_recording_batch (workspace_id, epoch, batch_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX consultation_recording_verification_pending
  ON consultation_recording_verification (workspace_id, epoch, batch_id, status);
CREATE INDEX outbox_kind_ready ON outbox_event (kind, status, next_attempt_at);
