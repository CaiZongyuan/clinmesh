DROP VIEW clinical_request_source;

CREATE TABLE synthetic_case_materialization_v2 (
  visit_kind TEXT NOT NULL DEFAULT 'outpatient' CHECK (visit_kind IN ('outpatient', 'inpatient')),
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  brief_revision INTEGER NOT NULL CHECK (brief_revision > 0),
  patient_id TEXT NOT NULL,
  outpatient_case_id TEXT,
  registration_id TEXT,
  encounter_id TEXT NOT NULL,
  queue_task_id TEXT,
  started_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((visit_kind = 'outpatient' AND outpatient_case_id IS NOT NULL AND registration_id IS NOT NULL AND queue_task_id IS NOT NULL)
    OR (visit_kind = 'inpatient' AND outpatient_case_id IS NULL AND registration_id IS NULL AND queue_task_id IS NULL)),
  PRIMARY KEY (workspace_id, epoch, case_id),
  UNIQUE (workspace_id, epoch, outpatient_case_id),
  UNIQUE (workspace_id, epoch, encounter_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, profile_id, profile_revision)
    REFERENCES synthetic_patient_profile_revision (workspace_id, profile_id, revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, case_id, brief_revision)
    REFERENCES patient_persona_revision (workspace_id, case_id, revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, outpatient_case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, profile_id, profile_revision)
    REFERENCES synthetic_patient_materialization (
      workspace_id, epoch, profile_id, profile_revision
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO synthetic_case_materialization_v2
SELECT 'outpatient', * FROM synthetic_case_materialization;
DROP TABLE synthetic_case_materialization;
ALTER TABLE synthetic_case_materialization_v2 RENAME TO synthetic_case_materialization;

CREATE VIEW clinical_request_source AS
SELECT c.*, m.case_id AS synthetic_case_id, m.case_revision AS synthetic_case_revision,
  m.profile_id, m.profile_revision
FROM clinical_request_context c
LEFT JOIN inpatient_admission a ON a.workspace_id=c.workspace_id AND a.epoch=c.epoch AND a.admission_id=c.admission_id
LEFT JOIN synthetic_case_materialization m ON m.workspace_id=c.workspace_id AND m.epoch=c.epoch
  AND ((c.outpatient_case_id IS NOT NULL AND m.outpatient_case_id=c.outpatient_case_id)
    OR (c.admission_id IS NOT NULL AND m.case_id=a.source_case_id));
