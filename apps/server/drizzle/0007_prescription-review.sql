CREATE TABLE prescription_review (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  review_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved')),
  note TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, review_id),
  UNIQUE (workspace_id, epoch, prescription_id),
  FOREIGN KEY (workspace_id, epoch, prescription_id)
    REFERENCES prescription (workspace_id, epoch, prescription_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX prescription_review_queue_idx
  ON prescription_review (workspace_id, epoch, reviewed_at, prescription_id);
