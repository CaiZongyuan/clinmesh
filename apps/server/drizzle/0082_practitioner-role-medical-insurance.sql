-- 医保办专岗：扩展岗位绑定表的岗位枚举。
CREATE TABLE practitioner_role_binding_new (
  workspace_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  practitioner_id TEXT NOT NULL,
  role_code TEXT NOT NULL CHECK (role_code IN ('registrar', 'triage-nurse', 'outpatient-doctor', 'cashier', 'pharmacist', 'administrator', 'inpatient-doctor', 'ward-nurse', 'medical-records', 'medical-insurance')),
  organization_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (workspace_id, practitioner_role_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO practitioner_role_binding_new SELECT * FROM practitioner_role_binding;
DROP TABLE practitioner_role_binding;
ALTER TABLE practitioner_role_binding_new RENAME TO practitioner_role_binding;
