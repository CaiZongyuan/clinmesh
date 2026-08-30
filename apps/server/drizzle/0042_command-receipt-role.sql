ALTER TABLE command_receipt ADD COLUMN practitioner_role_id TEXT;

UPDATE command_receipt
SET practitioner_role_id = (
  SELECT audit.practitioner_role_id
  FROM audit_log AS audit
  WHERE audit.workspace_id = command_receipt.workspace_id
    AND audit.epoch = command_receipt.epoch
    AND audit.audit_id = json_extract(command_receipt.response_json, '$.auditId')
)
WHERE response_json IS NOT NULL;
