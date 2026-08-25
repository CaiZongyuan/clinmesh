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
SELECT
  outpatient_case.workspace_id,
  outpatient_case.epoch,
  outpatient_case.case_id,
  substr(
    json_extract(task.content_json, '$.owner.reference'),
    length('PractitionerRole/') + 1
  ),
  coalesce(
    json_extract(task.content_json, '$.executionPeriod.start'),
    json_extract(task.content_json, '$.authoredOn'),
    outpatient_case.updated_at
  )
FROM outpatient_case
JOIN fhir_resource AS task
  ON task.workspace_id = outpatient_case.workspace_id
 AND task.epoch = outpatient_case.epoch
 AND task.resource_type = 'Task'
 AND task.resource_id = outpatient_case.doctor_task_id
JOIN practitioner_role_binding AS role
  ON role.workspace_id = outpatient_case.workspace_id
 AND role.practitioner_role_id = substr(
   json_extract(task.content_json, '$.owner.reference'),
   length('PractitionerRole/') + 1
 )
WHERE json_extract(task.content_json, '$.owner.reference') LIKE 'PractitionerRole/%';
