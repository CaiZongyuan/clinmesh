ALTER TABLE patient_brief_job RENAME TO patient_persona_job;
ALTER TABLE patient_brief_revision RENAME TO patient_persona_revision;

DROP INDEX patient_brief_job_queue_idx;
DROP INDEX patient_brief_job_case_idx;

CREATE INDEX patient_persona_job_queue_idx
  ON patient_persona_job (status, created_at, job_id);

CREATE INDEX patient_persona_job_case_idx
  ON patient_persona_job (workspace_id, case_id, created_at DESC, job_id);
