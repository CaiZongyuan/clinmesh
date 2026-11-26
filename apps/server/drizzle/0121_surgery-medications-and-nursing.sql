ALTER TABLE inpatient_surgery_execution
  ADD COLUMN linked_nursing_json TEXT CHECK (linked_nursing_json IS NULL OR json_valid(linked_nursing_json));

CREATE TABLE inpatient_surgery_medication (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  medication_use_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  administration_id TEXT NOT NULL,
  medication_id TEXT NOT NULL,
  catalog_version INTEGER NOT NULL CHECK (catalog_version > 0),
  display TEXT NOT NULL,
  dose_text TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit TEXT NOT NULL,
  route_code TEXT NOT NULL,
  price_fen INTEGER NOT NULL CHECK (price_fen >= 0 AND price_fen <= 9007199254740991),
  amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0 AND amount_fen <= 9007199254740991),
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, medication_use_id),
  UNIQUE (workspace_id, epoch, administration_id),
  FOREIGN KEY (workspace_id, epoch, execution_id)
    REFERENCES inpatient_surgery_execution (workspace_id, epoch, execution_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX inpatient_surgery_medication_execution
  ON inpatient_surgery_medication (workspace_id, epoch, execution_id, medication_use_id);
