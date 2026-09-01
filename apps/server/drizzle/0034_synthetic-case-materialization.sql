CREATE TABLE synthetic_case_materialization (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  brief_revision INTEGER NOT NULL CHECK (brief_revision > 0),
  patient_id TEXT NOT NULL,
  outpatient_case_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  queue_task_id TEXT NOT NULL,
  started_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
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
    REFERENCES patient_brief_revision (workspace_id, case_id, revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, outpatient_case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, profile_id, profile_revision)
    REFERENCES synthetic_patient_materialization (
      workspace_id, epoch, profile_id, profile_revision
    ) ON DELETE RESTRICT
) STRICT;
