-- Legacy synthetic payment facts must be cleared by the explicit development
-- cutover before this migration. New collection facts and business allocations
-- remain authoritative and are preserved when upgrading an existing new-model DB.
DROP TABLE refund_preview;
DROP TABLE payment_resolution;
DROP TABLE payment_tender;
DROP TABLE payment_allocation;
DROP TABLE payment_transaction;
DROP TABLE inpatient_settlement_supplement_refund;
DROP TABLE inpatient_payment_resolution;
DROP TABLE inpatient_payment_attempt;
