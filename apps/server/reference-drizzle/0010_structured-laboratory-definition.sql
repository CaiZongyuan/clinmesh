DROP INDEX reference_laboratory_definition_candidate_idx;

ALTER TABLE reference_source_manifest
  ADD COLUMN materialization_json TEXT
  CHECK (materialization_json IS NULL OR json_valid(materialization_json));

ALTER TABLE reference_laboratory_definition
  RENAME TO reference_laboratory_definition_legacy_v1;

CREATE TABLE reference_laboratory_definition (
  release_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, concept_id),
  FOREIGN KEY (release_id, concept_id)
    REFERENCES reference_concept (release_id, concept_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO reference_laboratory_definition (
  release_id, concept_id, definition_json, source_id, source_locator
)
SELECT
  release_id,
  concept_id,
  json_object(
    'kind', 'loinc',
    'classCode', class_code,
    'classType', class_type,
    'component', component,
    'conceptId', concept_id,
    'methodType', method_type,
    'orderObservation', order_observation,
    'panelType', panel_type,
    'property', property,
    'scaleType', scale_type,
    'sourceLocator', source_locator,
    'system', system_part,
    'timeAspect', time_aspect
  ),
  source_id,
  source_locator
FROM reference_laboratory_definition_legacy_v1;

DROP TABLE reference_laboratory_definition_legacy_v1;

CREATE INDEX reference_laboratory_definition_candidate_idx
  ON reference_laboratory_definition (
    release_id,
    json_extract(definition_json, '$.kind'),
    json_extract(definition_json, '$.classType'),
    json_extract(definition_json, '$.orderObservation'),
    concept_id
  );
