CREATE TABLE refund_tender (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, refund_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','bank-card','mobile')),
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0), position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(workspace_id,epoch,refund_id,method),
  FOREIGN KEY(workspace_id,epoch,refund_id) REFERENCES refund_transaction(workspace_id,epoch,refund_id) ON DELETE RESTRICT
) STRICT;
