CREATE TABLE model_usage_dimension (
  scope_id TEXT NOT NULL REFERENCES model_usage_control(scope_id),
  dimension TEXT NOT NULL CHECK (dimension IN ('tokens', 'cny')),
  limit_value INTEGER CHECK (limit_value BETWEEN 0 AND 9007199254740991),
  started_at TEXT,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (scope_id, dimension)
);
INSERT INTO model_usage_dimension(scope_id, dimension)
SELECT scope_id, 'tokens' FROM model_usage_control
UNION ALL SELECT scope_id, 'cny' FROM model_usage_control;

CREATE TABLE model_usage_dimension_reservation (
  attempt_id TEXT NOT NULL REFERENCES model_usage_attempt(attempt_id),
  scope_id TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('tokens', 'cny')),
  amount INTEGER CHECK (amount BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'released')),
  PRIMARY KEY (attempt_id, scope_id, dimension),
  FOREIGN KEY (scope_id, dimension) REFERENCES model_usage_dimension(scope_id, dimension),
  CHECK (state <> 'used' OR amount IS NOT NULL)
);
CREATE INDEX model_usage_dimension_reservation_scope ON model_usage_dimension_reservation(scope_id, dimension, state);

ALTER TABLE model_usage_control_rejection ADD COLUMN dimension TEXT CHECK (dimension IN ('requests', 'tokens', 'cny'));
ALTER TABLE model_usage_control_rejection ADD COLUMN remaining REAL CHECK (remaining >= 0);
ALTER TABLE model_usage_control_rejection ADD COLUMN required REAL CHECK (required >= 0);
