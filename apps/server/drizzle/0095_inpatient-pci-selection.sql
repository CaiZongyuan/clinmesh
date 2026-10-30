CREATE TABLE inpatient_pci_selection (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  confirmation_json TEXT NOT NULL CHECK (json_valid(confirmation_json)),
  PRIMARY KEY (workspace_id, epoch, admission_id, version),
  UNIQUE (workspace_id, epoch, selection_id, version),
  FOREIGN KEY (workspace_id, epoch, admission_id)
    REFERENCES inpatient_admission (workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;
