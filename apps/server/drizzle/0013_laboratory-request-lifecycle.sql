INSERT OR IGNORE INTO outpatient_catalog (
  workspace_id, epoch, item_id, kind, code, name_zh, name_en,
  price_fen, version, active, config_json
)
SELECT workspace_id, epoch, 'lab-cbc', 'laboratory', 'CBC',
  '血常规', 'Complete blood count', 2500, 1, 1,
  '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'
FROM scenario_epoch_state;

INSERT OR IGNORE INTO outpatient_catalog (
  workspace_id, epoch, item_id, kind, code, name_zh, name_en,
  price_fen, version, active, config_json
)
SELECT workspace_id, epoch, 'lab-crp', 'laboratory', 'CRP',
  'C 反应蛋白', 'C-reactive protein', 4300, 1, 1,
  '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'
FROM scenario_epoch_state;

CREATE TABLE laboratory_request_state (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  draft_catalog_item_id TEXT,
  draft_indication_code TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  CHECK (
    (draft_catalog_item_id IS NULL AND draft_indication_code IS NULL)
    OR (draft_catalog_item_id IS NOT NULL AND draft_indication_code IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, draft_catalog_item_id)
    REFERENCES outpatient_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE laboratory_request (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  request_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  indication_code TEXT NOT NULL,
  service_request_id TEXT NOT NULL,
  execution_task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'issued', 'accepted', 'in-progress', 'reported', 'acknowledged', 'cancelled'
  )),
  version INTEGER NOT NULL CHECK (version > 0),
  authored_by TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  accepted_at TEXT,
  started_at TEXT,
  reported_at TEXT,
  acknowledged_at TEXT,
  cancelled_at TEXT,
  PRIMARY KEY (workspace_id, epoch, request_id),
  UNIQUE (workspace_id, epoch, service_request_id),
  UNIQUE (workspace_id, epoch, execution_task_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES outpatient_case (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, catalog_item_id)
    REFERENCES outpatient_catalog (workspace_id, epoch, item_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX laboratory_request_active_item_unique
  ON laboratory_request (workspace_id, epoch, case_id, catalog_item_id)
  WHERE status <> 'cancelled';

CREATE INDEX laboratory_request_case_status_idx
  ON laboratory_request (workspace_id, epoch, case_id, status, authored_at, request_id);
