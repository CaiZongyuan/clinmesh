CREATE TABLE doctor_consideration_disposition (
  actor_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('laboratory', 'imaging', 'pathology', 'diagnosis')),
  label_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'dismissed')),
  label TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, case_id, kind, label_key)
) STRICT;
