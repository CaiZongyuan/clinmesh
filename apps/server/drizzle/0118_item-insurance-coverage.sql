ALTER TABLE prescription_item
  ADD COLUMN unit_price_fen INTEGER CHECK (unit_price_fen IS NULL OR unit_price_fen >= 0);

ALTER TABLE prescription_item
  ADD COLUMN coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json));

ALTER TABLE charge_record
  ADD COLUMN coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json));

ALTER TABLE inpatient_order
  ADD COLUMN coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json));

ALTER TABLE inpatient_charge
  ADD COLUMN coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json));

ALTER TABLE laboratory_service_publication_job
  ADD COLUMN coverage_overrides_json TEXT CHECK (coverage_overrides_json IS NULL OR json_valid(coverage_overrides_json));
