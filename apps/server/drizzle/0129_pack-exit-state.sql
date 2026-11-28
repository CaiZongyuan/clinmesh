CREATE TABLE disease_pack_exit_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  pack_id TEXT NOT NULL CHECK(length(trim(pack_id)) > 0),
  status TEXT NOT NULL CHECK(status IN ('exited', 're-enabled')),
  exit_criterion_id TEXT NOT NULL CHECK(length(trim(exit_criterion_id)) > 0),
  exit_reason_zh TEXT NOT NULL,
  matched_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  audit_id TEXT NOT NULL CHECK(length(trim(audit_id)) > 0),
  exit_summary_delivered INTEGER NOT NULL DEFAULT 0 CHECK(exit_summary_delivered IN (0, 1)),
  exited_at TEXT NOT NULL,
  re_enabled_at TEXT,
  re_enabled_by_actor_id TEXT,
  PRIMARY KEY(workspace_id, epoch, subject_kind, subject_id, pack_id)
) STRICT;

CREATE INDEX disease_pack_exit_state_lookup
  ON disease_pack_exit_state(workspace_id, epoch, subject_kind, subject_id, status);
