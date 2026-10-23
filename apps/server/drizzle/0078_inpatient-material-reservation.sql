CREATE TABLE inpatient_material_reservation (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, reservation_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  request_id TEXT, material_id TEXT NOT NULL, catalog_version INTEGER NOT NULL CHECK(catalog_version>0),
  material_display TEXT NOT NULL, price_fen INTEGER NOT NULL CHECK(price_fen>=0), quantity INTEGER NOT NULL CHECK(quantity>0),
  status TEXT NOT NULL CHECK(status IN ('reserved','replaced','released')), material_use_id TEXT, reason TEXT NOT NULL,
  actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,reservation_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX inpatient_material_reservation_admission ON inpatient_material_reservation(workspace_id,epoch,admission_id);
