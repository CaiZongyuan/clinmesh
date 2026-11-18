CREATE TABLE inpatient_order_next (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, order_id TEXT NOT NULL, admission_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('medication','service')), duration TEXT NOT NULL CHECK(duration IN ('long','temporary')),
  catalog_item_id TEXT NOT NULL, catalog_version INTEGER NOT NULL CHECK(catalog_version>0), display TEXT NOT NULL,
  dose_text TEXT NOT NULL, dose_quantity INTEGER NOT NULL CHECK(dose_quantity>0), unit TEXT NOT NULL,
  frequency_code TEXT NOT NULL CHECK(frequency_code IN ('QD','BID','TID','QN','PRN','ONCE')), price_fen INTEGER NOT NULL CHECK(price_fen>=0),
  state TEXT NOT NULL CHECK(state IN ('signed','verified','stop-requested','stopped','completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), organization_id TEXT NOT NULL,
  signed_at TEXT NOT NULL, signed_by TEXT NOT NULL, verified_at TEXT, stopped_at TEXT,
  PRIMARY KEY(workspace_id,epoch,order_id),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;


INSERT INTO inpatient_order_next SELECT * FROM inpatient_order;
DROP TABLE inpatient_order;
ALTER TABLE inpatient_order_next RENAME TO inpatient_order;
CREATE INDEX inpatient_order_admission ON inpatient_order(workspace_id,epoch,admission_id,state);
CREATE UNIQUE INDEX inpatient_order_admission_identity ON inpatient_order(workspace_id,epoch,admission_id,order_id);
