ALTER TABLE reference_release
  ADD COLUMN laboratory_definition_count INTEGER NOT NULL DEFAULT 0
  CHECK (laboratory_definition_count >= 0);

ALTER TABLE reference_release
  ADD COLUMN laboratory_unit_count INTEGER NOT NULL DEFAULT 0
  CHECK (laboratory_unit_count >= 0);

ALTER TABLE reference_release
  ADD COLUMN laboratory_specimen_count INTEGER NOT NULL DEFAULT 0
  CHECK (laboratory_specimen_count >= 0);

ALTER TABLE reference_release
  ADD COLUMN laboratory_panel_member_count INTEGER NOT NULL DEFAULT 0
  CHECK (laboratory_panel_member_count >= 0);

CREATE TABLE reference_laboratory_definition (
  release_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  component TEXT,
  property TEXT,
  time_aspect TEXT,
  system_part TEXT,
  scale_type TEXT,
  method_type TEXT,
  class_code TEXT,
  class_type INTEGER CHECK (class_type IS NULL OR class_type BETWEEN 1 AND 4),
  order_observation TEXT CHECK (
    order_observation IS NULL
    OR order_observation IN ('Order', 'Observation', 'Both', 'Subset')
  ),
  panel_type TEXT,
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, concept_id),
  FOREIGN KEY (release_id, concept_id)
    REFERENCES reference_concept (release_id, concept_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX reference_laboratory_definition_candidate_idx
  ON reference_laboratory_definition (
    release_id, class_type, order_observation, concept_id
  );

CREATE TABLE reference_laboratory_unit (
  release_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'example'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, concept_id, source_locator),
  FOREIGN KEY (release_id, concept_id)
    REFERENCES reference_concept (release_id, concept_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX reference_laboratory_unit_concept_idx
  ON reference_laboratory_unit (release_id, concept_id, ordinal, code);

CREATE TABLE reference_laboratory_specimen (
  release_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  part_number TEXT NOT NULL,
  part_name TEXT NOT NULL,
  display TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type = 'Primary'),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, concept_id, part_number, link_type),
  FOREIGN KEY (release_id, concept_id)
    REFERENCES reference_concept (release_id, concept_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX reference_laboratory_specimen_concept_idx
  ON reference_laboratory_specimen (release_id, concept_id, part_number);

CREATE TABLE reference_laboratory_panel_member (
  release_id TEXT NOT NULL,
  panel_concept_id TEXT NOT NULL,
  member_concept_id TEXT NOT NULL,
  member_order INTEGER NOT NULL CHECK (member_order >= 0),
  relationship TEXT NOT NULL CHECK (relationship = 'contains'),
  source_id TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (release_id, panel_concept_id, member_concept_id, source_locator),
  CHECK (panel_concept_id <> member_concept_id),
  FOREIGN KEY (release_id, panel_concept_id)
    REFERENCES reference_concept (release_id, concept_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, member_concept_id)
    REFERENCES reference_concept (release_id, concept_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, source_id)
    REFERENCES reference_source_manifest (release_id, source_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX reference_laboratory_panel_member_panel_idx
  ON reference_laboratory_panel_member (
    release_id, panel_concept_id, member_order, member_concept_id
  );
