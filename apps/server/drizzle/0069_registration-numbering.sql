CREATE TABLE registration_number_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  counters_hash TEXT NOT NULL CHECK (length(counters_hash) = 64)
) STRICT;

CREATE TABLE registration_number_counter (
  visit_date TEXT PRIMARY KEY,
  high_water INTEGER NOT NULL CHECK (high_water >= 0 AND high_water <= 9007199254740991)
) STRICT;
