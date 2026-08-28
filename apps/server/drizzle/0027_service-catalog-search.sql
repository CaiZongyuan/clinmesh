CREATE TABLE hospital_service_catalog (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  service_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  PRIMARY KEY (workspace_id, epoch, service_id),
  FOREIGN KEY (workspace_id, epoch)
    REFERENCES workspace_epoch (workspace_id, epoch) ON DELETE RESTRICT
) STRICT;

CREATE INDEX hospital_service_catalog_search_idx
  ON hospital_service_catalog (workspace_id, epoch, active, service_id)
  WHERE active = 1;
