CREATE INDEX payment_transaction_case_history_idx
  ON payment_transaction (workspace_id, epoch, case_id, created_at DESC, payment_id DESC);
