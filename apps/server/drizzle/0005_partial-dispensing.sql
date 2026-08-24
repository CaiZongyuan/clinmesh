ALTER TABLE prescription_item
ADD COLUMN dispensed_quantity INTEGER NOT NULL DEFAULT 0
CHECK (dispensed_quantity >= 0 AND dispensed_quantity <= quantity);

CREATE TABLE inventory_movement_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, movement_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, lot_id)
    REFERENCES inventory_lot (workspace_id, epoch, lot_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO inventory_movement_next (
  workspace_id, epoch, movement_id, prescription_id, lot_id, quantity, occurred_at
)
SELECT workspace_id, epoch, movement_id, prescription_id, lot_id, quantity, occurred_at
FROM inventory_movement;

DROP TABLE inventory_movement;
ALTER TABLE inventory_movement_next RENAME TO inventory_movement;

CREATE INDEX inventory_movement_prescription_idx
  ON inventory_movement (workspace_id, epoch, prescription_id, occurred_at, movement_id);

CREATE TABLE dispense_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  dispense_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  medication_dispense_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed')),
  dispensed_by TEXT NOT NULL,
  dispensed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, dispense_id),
  UNIQUE (workspace_id, epoch, medication_dispense_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO dispense_next (
  workspace_id, epoch, dispense_id, prescription_id,
  medication_dispense_id, status, dispensed_by, dispensed_at
)
SELECT workspace_id, epoch, dispense_id, prescription_id,
  medication_dispense_id, status, dispensed_by, dispensed_at
FROM dispense;

DROP TABLE dispense;
ALTER TABLE dispense_next RENAME TO dispense;

CREATE INDEX dispense_prescription_idx
  ON dispense (workspace_id, epoch, prescription_id, dispensed_at, dispense_id);
