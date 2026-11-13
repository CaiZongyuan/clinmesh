CREATE TABLE outpatient_case_source (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  outpatient_case_id TEXT NOT NULL,
  source_case_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, outpatient_case_id),
  FOREIGN KEY (workspace_id, epoch, outpatient_case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, source_case_id)
    REFERENCES synthetic_case_materialization (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

DROP VIEW clinical_request_source;
CREATE VIEW clinical_request_source AS
SELECT c.*, m.case_id AS synthetic_case_id, m.case_revision AS synthetic_case_revision,
  m.profile_id, m.profile_revision
FROM clinical_request_context c
LEFT JOIN outpatient_case_source s ON s.workspace_id=c.workspace_id AND s.epoch=c.epoch AND s.outpatient_case_id=c.outpatient_case_id
LEFT JOIN inpatient_admission a ON a.workspace_id=c.workspace_id AND a.epoch=c.epoch AND a.admission_id=c.admission_id
LEFT JOIN synthetic_case_materialization m ON m.workspace_id=c.workspace_id AND m.epoch=c.epoch AND m.patient_id=c.patient_id
  AND ((c.outpatient_case_id IS NOT NULL AND ((s.source_case_id IS NULL AND m.outpatient_case_id=c.outpatient_case_id) OR m.case_id=s.source_case_id))
    OR (c.admission_id IS NOT NULL AND m.case_id=a.source_case_id));
