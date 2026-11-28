CREATE TABLE disease_pack_registry_activation (
  pack_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(pack_id)) > 0),
  pack_version TEXT NOT NULL CHECK(length(trim(pack_version)) > 0),
  source_fingerprint TEXT NOT NULL CHECK(length(trim(source_fingerprint)) > 0),
  pack_dir TEXT,
  activated_by_actor_id TEXT NOT NULL CHECK(length(trim(activated_by_actor_id)) > 0),
  activated_at TEXT NOT NULL CHECK(length(trim(activated_at)) > 0),
  note TEXT
) STRICT;
