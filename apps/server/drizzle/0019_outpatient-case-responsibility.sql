CREATE TABLE outpatient_case_responsibility (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, practitioner_role_id)
    REFERENCES practitioner_role_binding (
      workspace_id, practitioner_role_id
    ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX outpatient_case_responsibility_doctor_idx
  ON outpatient_case_responsibility (
    workspace_id, epoch, practitioner_role_id, assigned_at DESC, case_id
  );

INSERT INTO outpatient_case_responsibility (
  workspace_id, epoch, case_id, practitioner_role_id, assigned_at
)
WITH responsibility_source AS (
  SELECT
    outpatient_case.workspace_id,
    outpatient_case.epoch,
    outpatient_case.case_id,
    coalesce(
      (
        SELECT audit.practitioner_role_id
        FROM command_receipt AS receipt
        JOIN audit_log AS audit
          ON audit.workspace_id = receipt.workspace_id
         AND audit.epoch = receipt.epoch
         AND audit.actor_id = receipt.actor_id
         AND audit.operation = receipt.operation
         AND audit.request_hash = receipt.request_hash
         AND audit.outcome = 'success'
        JOIN practitioner_role_binding AS audited_role
          ON audited_role.workspace_id = audit.workspace_id
         AND audited_role.practitioner_role_id = audit.practitioner_role_id
        WHERE receipt.workspace_id = outpatient_case.workspace_id
          AND receipt.epoch = outpatient_case.epoch
          AND receipt.operation = 'virtual-patient.start-consultation'
          AND receipt.status = 'completed'
          AND json_extract(receipt.response_json, '$.data.caseId') = outpatient_case.case_id
        ORDER BY audit.sequence DESC
        LIMIT 1
      ),
      substr(
        json_extract(task.content_json, '$.owner.reference'),
        length('PractitionerRole/') + 1
      )
    ) AS practitioner_role_id,
    coalesce(
      json_extract(task.content_json, '$.executionPeriod.start'),
      json_extract(task.content_json, '$.authoredOn'),
      outpatient_case.updated_at
    ) AS assigned_at
  FROM outpatient_case
  JOIN fhir_resource AS task
    ON task.workspace_id = outpatient_case.workspace_id
   AND task.epoch = outpatient_case.epoch
   AND task.resource_type = 'Task'
   AND task.resource_id = outpatient_case.doctor_task_id
  WHERE json_extract(task.content_json, '$.owner.reference') LIKE 'PractitionerRole/%'
)
SELECT
  responsibility_source.workspace_id,
  responsibility_source.epoch,
  responsibility_source.case_id,
  responsibility_source.practitioner_role_id,
  responsibility_source.assigned_at
FROM responsibility_source
JOIN practitioner_role_binding AS role
  ON role.workspace_id = responsibility_source.workspace_id
 AND role.practitioner_role_id = responsibility_source.practitioner_role_id;
