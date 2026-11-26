CREATE TABLE clinical_prompt_card_snapshot (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  card_id TEXT NOT NULL CHECK(length(trim(card_id)) > 0),
  timing TEXT NOT NULL CHECK(timing IN ('encounter-open', 'order-draft-select', 'order-sign', 'encounter-complete', 'pci-plan', 'discharge', 'report-arrived')),
  pack_id TEXT,
  pack_version TEXT,
  knowledge_snapshot_version TEXT,
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('display', 'silent')),
  based_on_fact_versions_json TEXT NOT NULL CHECK(json_valid(based_on_fact_versions_json)),
  card_json TEXT NOT NULL CHECK(json_valid(card_json)),
  created_at TEXT NOT NULL,
  created_as_of TEXT NOT NULL,
  PRIMARY KEY(workspace_id, epoch, subject_kind, subject_id, encounter_id, card_id)
) STRICT;

CREATE INDEX clinical_prompt_card_snapshot_lookup
  ON clinical_prompt_card_snapshot(workspace_id, epoch, subject_kind, subject_id, timing, created_at DESC);

CREATE TABLE clinical_prompt_card_dismissal (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  card_id TEXT NOT NULL CHECK(length(trim(card_id)) > 0),
  pack_id TEXT,
  reason_code TEXT NOT NULL CHECK(reason_code IN ('documented-contraindication', 'external-result-verified', 'result-pending-follow-up', 'patient-informed-refusal', 'clinical-judgement', 'emergency-care')),
  note TEXT NOT NULL CHECK(length(trim(note)) > 0),
  actor_id TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id, epoch, subject_kind, subject_id, card_id)
) STRICT;

CREATE TABLE clinical_prompt_safety_block_audit (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('outpatient', 'inpatient')),
  subject_id TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  timing TEXT NOT NULL CHECK(timing IN ('encounter-open', 'order-draft-select', 'order-sign', 'encounter-complete', 'pci-plan', 'discharge', 'report-arrived')),
  pack_id TEXT,
  block_reason TEXT NOT NULL CHECK(block_reason IN ('allergy-conflict', 'red-line-violation', 'forbidden-action', 'inapplicable-population', 'invalid-citation')),
  card_summary TEXT NOT NULL CHECK(length(trim(card_summary)) > 0),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  actor_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id, epoch, audit_id)
) STRICT;

CREATE INDEX clinical_prompt_safety_block_lookup
  ON clinical_prompt_safety_block_audit(workspace_id, epoch, subject_kind, subject_id, blocked_at DESC);
