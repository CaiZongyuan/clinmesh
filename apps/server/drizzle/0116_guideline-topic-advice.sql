CREATE TABLE inpatient_guideline_advice_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  task_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  topic_id TEXT NOT NULL CHECK(length(trim(topic_id)) > 0),
  request_id TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_fingerprint TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('automatic', 'manual')),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'no-evidence', 'blocked', 'unknown', 'rejected', 'failed', 'stale')),
  error_code TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, epoch, task_id, version),
  FOREIGN KEY(workspace_id, epoch, admission_id)
    REFERENCES inpatient_admission(workspace_id, epoch, admission_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, epoch, admission_id, request_id)
    REFERENCES inpatient_surgery_request(workspace_id, epoch, admission_id, request_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO inpatient_guideline_advice_next (
  workspace_id, epoch, task_id, admission_id, topic_id, request_id, version,
  context_json, basis_json, basis_fingerprint, trigger, cancelled, status, error_code, result_json, created_at
)
SELECT
  workspace_id, epoch, task_id, admission_id, 'pci-stent', request_id, version,
  context_json, basis_json, basis_fingerprint, trigger, cancelled, status, error_code, result_json, created_at
FROM inpatient_guideline_advice;

DROP TABLE inpatient_guideline_advice;
ALTER TABLE inpatient_guideline_advice_next RENAME TO inpatient_guideline_advice;

CREATE UNIQUE INDEX inpatient_guideline_advice_request_version
  ON inpatient_guideline_advice(workspace_id, epoch, admission_id, topic_id, request_id, version)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX inpatient_guideline_advice_admission_topic_version
  ON inpatient_guideline_advice(workspace_id, epoch, admission_id, topic_id, version)
  WHERE request_id IS NULL;

CREATE INDEX inpatient_guideline_advice_lookup
  ON inpatient_guideline_advice(workspace_id, epoch, admission_id, topic_id, request_id, version DESC);
