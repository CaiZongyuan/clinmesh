CREATE TABLE prescription_item_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  medication_request_id TEXT NOT NULL,
  medication_id TEXT NOT NULL,
  medication_snapshot_json TEXT NOT NULL CHECK (json_valid(medication_snapshot_json)),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  dose_text TEXT NOT NULL,
  frequency_code TEXT NOT NULL,
  route_code TEXT NOT NULL CHECK (route_code IN ('PO', 'IVGTT', 'IV', 'IM', 'IH', 'SL', 'TOP', 'INH')),
  course_days INTEGER NOT NULL CHECK (course_days > 0 AND course_days <= 30),
  dispensed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (dispensed_quantity >= 0 AND dispensed_quantity <= quantity),
  unit_price_fen INTEGER CHECK (unit_price_fen IS NULL OR unit_price_fen >= 0),
  coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json)),
  PRIMARY KEY (workspace_id, epoch, prescription_id, medication_request_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO prescription_item_next (
  workspace_id, epoch, prescription_id, medication_request_id,
  medication_id, medication_snapshot_json, quantity, dose_text,
  frequency_code, route_code, course_days, dispensed_quantity,
  unit_price_fen, coverage_json
)
SELECT
  workspace_id, epoch, prescription_id, medication_request_id,
  medication_id, medication_snapshot_json, quantity, dose_text,
  frequency_code,
  CASE medication_id
    WHEN 'medication-nitroglycerin' THEN 'SL'
    WHEN 'medication-enoxaparin' THEN 'IH'
    WHEN 'medication-heparin' THEN 'IV'
    WHEN 'medication-pci-heparin' THEN 'IV'
    WHEN 'medication-pci-iohexol' THEN 'IV'
    WHEN 'medication-sodium-chloride' THEN 'IVGTT'
    ELSE 'PO'
  END,
  course_days, dispensed_quantity,
  unit_price_fen, coverage_json
FROM prescription_item;

DROP TABLE prescription_item;
ALTER TABLE prescription_item_next RENAME TO prescription_item;

CREATE TABLE inpatient_order_next (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  order_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('medication', 'service')),
  duration TEXT NOT NULL CHECK (duration IN ('long', 'temporary')),
  catalog_item_id TEXT NOT NULL,
  catalog_version INTEGER NOT NULL CHECK (catalog_version > 0),
  display TEXT NOT NULL,
  dose_text TEXT NOT NULL,
  dose_quantity INTEGER NOT NULL CHECK (dose_quantity > 0),
  unit TEXT NOT NULL,
  frequency_code TEXT NOT NULL CHECK (frequency_code IN ('QD', 'BID', 'TID', 'QN', 'PRN', 'ONCE')),
  route_code TEXT CHECK (route_code IN ('PO', 'IVGTT', 'IV', 'IM', 'IH', 'SL', 'TOP', 'INH')),
  price_fen INTEGER NOT NULL CHECK (price_fen >= 0),
  state TEXT NOT NULL CHECK (state IN ('signed', 'verified', 'stop-requested', 'stopped', 'completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  organization_id TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  verified_at TEXT,
  stopped_at TEXT,
  coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json)),
  CHECK ((kind = 'medication' AND route_code IS NOT NULL) OR (kind = 'service' AND route_code IS NULL)),
  PRIMARY KEY (workspace_id, epoch, order_id),
  FOREIGN KEY (workspace_id, epoch, admission_id)
    REFERENCES inpatient_admission (workspace_id, epoch, admission_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO inpatient_order_next (
  workspace_id, epoch, order_id, admission_id, kind, duration,
  catalog_item_id, catalog_version, display, dose_text, dose_quantity,
  unit, frequency_code, route_code, price_fen, state, version,
  organization_id, signed_at, signed_by, verified_at, stopped_at, coverage_json
)
SELECT
  workspace_id, epoch, order_id, admission_id, kind, duration,
  catalog_item_id, catalog_version, display, dose_text, dose_quantity,
  unit, frequency_code,
  CASE
    WHEN kind = 'service' THEN NULL
    WHEN catalog_item_id = 'medication-nitroglycerin' THEN 'SL'
    WHEN catalog_item_id = 'medication-enoxaparin' THEN 'IH'
    WHEN catalog_item_id IN ('medication-heparin', 'medication-pci-heparin', 'medication-pci-iohexol') THEN 'IV'
    WHEN catalog_item_id = 'medication-sodium-chloride' THEN 'IVGTT'
    ELSE 'PO'
  END,
  price_fen, state, version, organization_id, signed_at, signed_by,
  verified_at, stopped_at, coverage_json
FROM inpatient_order;

DROP TABLE inpatient_order;
ALTER TABLE inpatient_order_next RENAME TO inpatient_order;
CREATE INDEX inpatient_order_admission ON inpatient_order (workspace_id, epoch, admission_id, state);
CREATE UNIQUE INDEX inpatient_order_admission_identity ON inpatient_order (workspace_id, epoch, admission_id, order_id);

UPDATE prescription_draft_state
SET draft_json = json_set(
  draft_json,
  '$.items',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(item.value, '$.referenceProduct') = 'object'
            AND json_type(item.value, '$.referenceProduct.defaultRouteCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode', COALESCE(
              json_extract(item.value, '$.routeCode'),
              CASE json_extract(item.value, '$.catalogItemId')
                WHEN 'medication-nitroglycerin' THEN 'SL'
                WHEN 'medication-enoxaparin' THEN 'IH'
                WHEN 'medication-heparin' THEN 'IV'
                WHEN 'medication-pci-heparin' THEN 'IV'
                WHEN 'medication-pci-iohexol' THEN 'IV'
                WHEN 'medication-sodium-chloride' THEN 'IVGTT'
                ELSE 'PO'
              END
            ),
            '$.referenceProduct.defaultRouteCode', 'PO',
            '$.referenceProduct.allowedRouteCodes', json('["PO"]')
          )
          WHEN json_type(item.value, '$.routeCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode',
            CASE json_extract(item.value, '$.catalogItemId')
              WHEN 'medication-nitroglycerin' THEN 'SL'
              WHEN 'medication-enoxaparin' THEN 'IH'
              WHEN 'medication-heparin' THEN 'IV'
              WHEN 'medication-pci-heparin' THEN 'IV'
              WHEN 'medication-pci-iohexol' THEN 'IV'
              WHEN 'medication-sodium-chloride' THEN 'IVGTT'
              ELSE 'PO'
            END
          )
          ELSE item.value
        END
      )
    )
    FROM json_each(prescription_draft_state.draft_json, '$.items') AS item
  )
)
WHERE draft_json IS NOT NULL AND json_type(draft_json, '$.items') = 'array';

UPDATE command_receipt
SET response_json = json_set(
  response_json,
  '$.data.orders',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(item.value, '$.kind') = 'medication'
            AND json_type(item.value, '$.routeCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode',
            CASE json_extract(item.value, '$.catalogItemId')
              WHEN 'medication-nitroglycerin' THEN 'SL'
              WHEN 'medication-enoxaparin' THEN 'IH'
              WHEN 'medication-heparin' THEN 'IV'
              WHEN 'medication-pci-heparin' THEN 'IV'
              WHEN 'medication-pci-iohexol' THEN 'IV'
              WHEN 'medication-sodium-chloride' THEN 'IVGTT'
              ELSE 'PO'
            END
          )
          ELSE item.value
        END
      )
    )
    FROM json_each(command_receipt.response_json, '$.data.orders') AS item
  )
)
WHERE response_json IS NOT NULL AND json_type(response_json, '$.data.orders') = 'array';

UPDATE command_receipt
SET response_json = json_set(
  response_json,
  '$.data.prescription.items',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(item.value, '$.referenceProduct') = 'object'
            AND json_type(item.value, '$.referenceProduct.defaultRouteCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode', COALESCE(
              json_extract(item.value, '$.routeCode'),
              CASE json_extract(item.value, '$.catalogItemId')
                WHEN 'medication-nitroglycerin' THEN 'SL'
                WHEN 'medication-enoxaparin' THEN 'IH'
                WHEN 'medication-heparin' THEN 'IV'
                WHEN 'medication-pci-heparin' THEN 'IV'
                WHEN 'medication-pci-iohexol' THEN 'IV'
                WHEN 'medication-sodium-chloride' THEN 'IVGTT'
                ELSE 'PO'
              END
            ),
            '$.referenceProduct.defaultRouteCode', 'PO',
            '$.referenceProduct.allowedRouteCodes', json('["PO"]')
          )
          WHEN json_type(item.value, '$.routeCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode',
            CASE json_extract(item.value, '$.catalogItemId')
              WHEN 'medication-nitroglycerin' THEN 'SL'
              WHEN 'medication-enoxaparin' THEN 'IH'
              WHEN 'medication-heparin' THEN 'IV'
              WHEN 'medication-pci-heparin' THEN 'IV'
              WHEN 'medication-pci-iohexol' THEN 'IV'
              WHEN 'medication-sodium-chloride' THEN 'IVGTT'
              ELSE 'PO'
            END
          )
          ELSE item.value
        END
      )
    )
    FROM json_each(command_receipt.response_json, '$.data.prescription.items') AS item
  )
)
WHERE response_json IS NOT NULL AND json_type(response_json, '$.data.prescription.items') = 'array';

UPDATE command_receipt
SET response_json = json_set(
  response_json,
  '$.data.draft.items',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(item.value, '$.referenceProduct') = 'object'
            AND json_type(item.value, '$.referenceProduct.defaultRouteCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode', COALESCE(
              json_extract(item.value, '$.routeCode'),
              CASE json_extract(item.value, '$.catalogItemId')
                WHEN 'medication-nitroglycerin' THEN 'SL'
                WHEN 'medication-enoxaparin' THEN 'IH'
                WHEN 'medication-heparin' THEN 'IV'
                WHEN 'medication-pci-heparin' THEN 'IV'
                WHEN 'medication-pci-iohexol' THEN 'IV'
                WHEN 'medication-sodium-chloride' THEN 'IVGTT'
                ELSE 'PO'
              END
            ),
            '$.referenceProduct.defaultRouteCode', 'PO',
            '$.referenceProduct.allowedRouteCodes', json('["PO"]')
          )
          WHEN json_type(item.value, '$.routeCode') IS NULL
          THEN json_set(
            item.value,
            '$.routeCode',
            CASE json_extract(item.value, '$.catalogItemId')
              WHEN 'medication-nitroglycerin' THEN 'SL'
              WHEN 'medication-enoxaparin' THEN 'IH'
              WHEN 'medication-heparin' THEN 'IV'
              WHEN 'medication-pci-heparin' THEN 'IV'
              WHEN 'medication-pci-iohexol' THEN 'IV'
              WHEN 'medication-sodium-chloride' THEN 'IVGTT'
              ELSE 'PO'
            END
          )
          ELSE item.value
        END
      )
    )
    FROM json_each(command_receipt.response_json, '$.data.draft.items') AS item
  )
)
WHERE response_json IS NOT NULL AND json_type(response_json, '$.data.draft.items') = 'array';
