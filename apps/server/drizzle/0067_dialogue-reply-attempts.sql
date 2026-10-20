CREATE TABLE consultation_reply_attempt (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  doctor_turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('executing', 'succeeded', 'failed', 'unknown')),
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  error_code TEXT,
  PRIMARY KEY (workspace_id, epoch, attempt_id),
  FOREIGN KEY (workspace_id, epoch, doctor_turn_id)
    REFERENCES consultation_turn (workspace_id, epoch, turn_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX consultation_reply_one_executing
  ON consultation_reply_attempt (workspace_id, epoch, doctor_turn_id) WHERE status = 'executing';
CREATE INDEX consultation_reply_turn
  ON consultation_reply_attempt (workspace_id, epoch, doctor_turn_id, started_at);

CREATE TABLE consultation_reply_intent (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('ask', 'retry')),
  idempotency_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, actor_id, operation, idempotency_key),
  FOREIGN KEY (workspace_id, epoch, attempt_id)
    REFERENCES consultation_reply_attempt (workspace_id, epoch, attempt_id) ON DELETE RESTRICT
) STRICT;

-- An unanswered legacy question has no durable evidence of whether inference was dispatched.
INSERT INTO consultation_reply_attempt
  (workspace_id, epoch, attempt_id, encounter_id, doctor_turn_id, status, started_at, deadline_at, error_code)
SELECT t.workspace_id, t.epoch, 'legacy:' || t.turn_id, c.encounter_id, t.turn_id, 'unknown',
  strftime('%Y-%m-%dT%H:%M:%fZ', t.recorded_at),
  strftime('%Y-%m-%dT%H:%M:%fZ', t.recorded_at, '+30 seconds'), 'CONSULTATION_REPLY_UNKNOWN'
FROM consultation_turn t JOIN outpatient_case c
  ON c.workspace_id = t.workspace_id AND c.epoch = t.epoch AND c.case_id = t.case_id
WHERE t.speaker = 'doctor' AND t.kind = 'text' AND NOT EXISTS (
  SELECT 1 FROM consultation_turn next
  WHERE next.workspace_id = t.workspace_id AND next.epoch = t.epoch AND next.case_id = t.case_id
    AND next.sequence > t.sequence AND next.kind = 'text'
);

INSERT INTO consultation_reply_intent
  (workspace_id, epoch, actor_id, operation, idempotency_key, attempt_id)
SELECT r.workspace_id, r.epoch, r.actor_id,
  CASE r.operation WHEN 'consultation.doctor-turn.append' THEN 'ask' ELSE 'retry' END,
  CASE r.operation WHEN 'consultation.doctor-turn.append'
    THEN substr(r.idempotency_key, 1, length(r.idempotency_key) - length(':doctor-turn'))
    ELSE r.idempotency_key END,
  a.attempt_id
FROM command_receipt r JOIN consultation_reply_attempt a
  ON a.workspace_id = r.workspace_id AND a.epoch = r.epoch
    AND a.doctor_turn_id = json_extract(r.response_json, '$.data.turn.id')
WHERE r.operation IN ('consultation.doctor-turn.append', 'consultation.reply.accept')
  AND r.status = 'completed' AND json_valid(r.response_json)
  AND (r.operation <> 'consultation.doctor-turn.append'
    OR substr(r.idempotency_key, -length(':doctor-turn')) = ':doctor-turn');
