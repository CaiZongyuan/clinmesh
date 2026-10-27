ALTER TABLE inpatient_surgery_execution ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('in-progress','completed'));
ALTER TABLE inpatient_surgery_execution ADD COLUMN completed_at TEXT;
UPDATE inpatient_surgery_execution SET completed_at=performed_at WHERE status='completed';
ALTER TABLE inpatient_material_reservation ADD COLUMN consumed_quantity INTEGER NOT NULL DEFAULT 0 CHECK(consumed_quantity>=0 AND consumed_quantity<=quantity);
ALTER TABLE inpatient_material_reservation ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE inpatient_material_reservation ADD COLUMN release_reason TEXT;
UPDATE inpatient_material_reservation SET consumed_quantity=quantity WHERE status='replaced';
CREATE TABLE inpatient_surgery_material_record (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, material_use_id TEXT NOT NULL, reservation_id TEXT,
  recorded_at TEXT NOT NULL, recorded_by TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, note TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,material_use_id),
  FOREIGN KEY(workspace_id,epoch,material_use_id) REFERENCES inpatient_surgery_material(workspace_id,epoch,material_use_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,reservation_id) REFERENCES inpatient_material_reservation(workspace_id,epoch,reservation_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO inpatient_surgery_material_record
SELECT m.workspace_id,m.epoch,m.material_use_id,r.reservation_id,e.performed_at,e.performed_by,e.practitioner_role_id,e.note
FROM inpatient_surgery_material m JOIN inpatient_surgery_execution e
ON e.workspace_id=m.workspace_id AND e.epoch=m.epoch AND e.execution_id=m.execution_id
LEFT JOIN inpatient_material_reservation r ON r.workspace_id=m.workspace_id AND r.epoch=m.epoch AND r.material_use_id=m.material_use_id;
CREATE TABLE inpatient_surgery_material_correction (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, correction_id TEXT NOT NULL, material_use_id TEXT NOT NULL,
  replacement_use_id TEXT, original_charge_id TEXT NOT NULL, reversal_charge_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL, recorded_by TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, note TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,correction_id), UNIQUE(workspace_id,epoch,material_use_id),
  FOREIGN KEY(workspace_id,epoch,material_use_id) REFERENCES inpatient_surgery_material(workspace_id,epoch,material_use_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,replacement_use_id) REFERENCES inpatient_surgery_material(workspace_id,epoch,material_use_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,original_charge_id) REFERENCES inpatient_charge(workspace_id,epoch,charge_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,reversal_charge_id) REFERENCES inpatient_charge(workspace_id,epoch,charge_id) ON DELETE RESTRICT
) STRICT;
