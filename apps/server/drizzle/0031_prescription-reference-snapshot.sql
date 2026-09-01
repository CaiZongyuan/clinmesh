ALTER TABLE prescription_item RENAME TO prescription_item_legacy;

CREATE TABLE prescription_item (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  medication_request_id TEXT NOT NULL,
  medication_id TEXT NOT NULL,
  medication_snapshot_json TEXT NOT NULL CHECK (json_valid(medication_snapshot_json)),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  dose_text TEXT NOT NULL,
  frequency_code TEXT NOT NULL,
  course_days INTEGER NOT NULL CHECK (course_days > 0 AND course_days <= 30),
  PRIMARY KEY (workspace_id, epoch, prescription_id, medication_request_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO prescription_item (
  workspace_id, epoch, prescription_id, medication_request_id,
  medication_id, medication_snapshot_json, quantity, dose_text,
  frequency_code, course_days
)
SELECT
  item.workspace_id,
  item.epoch,
  item.prescription_id,
  item.medication_request_id,
  item.medication_id,
  json_object(
    'code', catalog.code,
    'display', catalog.name_zh,
    'id', catalog.item_id,
    'sourceLocator', 'operational:outpatient_catalog',
    'system', 'urn:clinmesh:operational:medication',
    'version', CAST(catalog.version AS TEXT)
  ),
  item.quantity,
  item.dose_text,
  item.frequency_code,
  item.course_days
FROM prescription_item_legacy AS item
JOIN outpatient_catalog AS catalog
  ON catalog.workspace_id = item.workspace_id
 AND catalog.epoch = item.epoch
 AND catalog.item_id = item.medication_id;

DROP TABLE prescription_item_legacy;
