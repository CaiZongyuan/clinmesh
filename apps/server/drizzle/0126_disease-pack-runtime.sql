CREATE TABLE disease_pack_activation_override (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  pack_id TEXT NOT NULL CHECK(length(trim(pack_id)) > 0),
  override_mode TEXT NOT NULL CHECK(override_mode IN ('enabled', 'disabled')),
  note TEXT,
  updated_by_actor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(workspace_id, epoch, subject_kind, subject_id, pack_id)
) STRICT;

CREATE TABLE disease_pack_stage_audit (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  pack_id TEXT NOT NULL CHECK(length(trim(pack_id)) > 0),
  from_stage_id TEXT,
  to_stage_id TEXT NOT NULL CHECK(length(trim(to_stage_id)) > 0),
  recorded_by_actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, epoch, audit_id)
) STRICT;

CREATE INDEX disease_pack_stage_audit_lookup
  ON disease_pack_stage_audit(workspace_id, epoch, subject_kind, subject_id, pack_id, recorded_at DESC);
