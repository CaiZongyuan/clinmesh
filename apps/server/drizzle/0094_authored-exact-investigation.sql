CREATE TABLE investigation_result_snapshot_v2 (
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  requested_concept_json TEXT NOT NULL CHECK (json_valid(requested_concept_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  source TEXT NOT NULL CHECK (source IN ('synthea-exact', 'case-truth-exact', 'investigation-agent')),
  model_id TEXT,
  prompt_version TEXT,
  prompt_hash TEXT CHECK (prompt_hash IS NULL OR length(prompt_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  output_hash TEXT NOT NULL CHECK (length(output_hash) = 64),
  created_at TEXT NOT NULL,
  source_detail TEXT CHECK (source_detail IS NULL OR source_detail IN ('adult-reference-baseline', 'mixed')),
  provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  PRIMARY KEY (workspace_id, snapshot_id),
  UNIQUE (workspace_id, case_id, catalog_item_id, input_hash),
  FOREIGN KEY (workspace_id, case_id)
    REFERENCES synthetic_case_instance (workspace_id, case_id) ON DELETE RESTRICT,
  CHECK (
    (source IN ('synthea-exact', 'case-truth-exact') AND model_id IS NULL
      AND prompt_version IS NULL AND prompt_hash IS NULL)
    OR (source = 'investigation-agent' AND model_id IS NOT NULL
      AND prompt_version IS NOT NULL AND prompt_hash IS NOT NULL)
  )
) STRICT;

INSERT INTO investigation_result_snapshot_v2
  (workspace_id,snapshot_id,case_id,catalog_item_id,requested_concept_json,result_json,source,model_id,prompt_version,prompt_hash,input_hash,output_hash,created_at,source_detail,provenance_json)
SELECT workspace_id,snapshot_id,case_id,catalog_item_id,requested_concept_json,result_json,source,model_id,prompt_version,prompt_hash,input_hash,output_hash,created_at,source_detail,provenance_json
FROM investigation_result_snapshot;
DROP TABLE investigation_result_snapshot;
ALTER TABLE investigation_result_snapshot_v2 RENAME TO investigation_result_snapshot;
