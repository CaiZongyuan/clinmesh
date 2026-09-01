CREATE VIRTUAL TABLE reference_concept_fts USING fts5(
  release_id UNINDEXED,
  concept_id UNINDEXED,
  code,
  display,
  content = 'reference_concept',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

INSERT INTO reference_concept_fts (rowid, release_id, concept_id, code, display)
SELECT rowid, release_id, concept_id, code, display FROM reference_concept;

CREATE TRIGGER reference_concept_fts_insert AFTER INSERT ON reference_concept BEGIN
  INSERT INTO reference_concept_fts (rowid, release_id, concept_id, code, display)
  VALUES (new.rowid, new.release_id, new.concept_id, new.code, new.display);
END;

CREATE TRIGGER reference_concept_fts_delete AFTER DELETE ON reference_concept BEGIN
  INSERT INTO reference_concept_fts (
    reference_concept_fts, rowid, release_id, concept_id, code, display
  ) VALUES (
    'delete', old.rowid, old.release_id, old.concept_id, old.code, old.display
  );
END;

CREATE TRIGGER reference_concept_fts_update AFTER UPDATE ON reference_concept BEGIN
  INSERT INTO reference_concept_fts (
    reference_concept_fts, rowid, release_id, concept_id, code, display
  ) VALUES (
    'delete', old.rowid, old.release_id, old.concept_id, old.code, old.display
  );
  INSERT INTO reference_concept_fts (rowid, release_id, concept_id, code, display)
  VALUES (new.rowid, new.release_id, new.concept_id, new.code, new.display);
END;

CREATE VIRTUAL TABLE reference_medication_product_fts USING fts5(
  release_id UNINDEXED,
  product_id UNINDEXED,
  code,
  generic_name,
  brand_name,
  manufacturer,
  content = 'reference_medication_product',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

INSERT INTO reference_medication_product_fts (
  rowid, release_id, product_id, code, generic_name, brand_name, manufacturer
)
SELECT rowid, release_id, product_id, code, generic_name, brand_name, manufacturer
FROM reference_medication_product;

CREATE TRIGGER reference_medication_product_fts_insert
AFTER INSERT ON reference_medication_product BEGIN
  INSERT INTO reference_medication_product_fts (
    rowid, release_id, product_id, code, generic_name, brand_name, manufacturer
  ) VALUES (
    new.rowid, new.release_id, new.product_id, new.code,
    new.generic_name, new.brand_name, new.manufacturer
  );
END;

CREATE TRIGGER reference_medication_product_fts_delete
AFTER DELETE ON reference_medication_product BEGIN
  INSERT INTO reference_medication_product_fts (
    reference_medication_product_fts, rowid, release_id, product_id,
    code, generic_name, brand_name, manufacturer
  ) VALUES (
    'delete', old.rowid, old.release_id, old.product_id,
    old.code, old.generic_name, old.brand_name, old.manufacturer
  );
END;

CREATE TRIGGER reference_medication_product_fts_update
AFTER UPDATE ON reference_medication_product BEGIN
  INSERT INTO reference_medication_product_fts (
    reference_medication_product_fts, rowid, release_id, product_id,
    code, generic_name, brand_name, manufacturer
  ) VALUES (
    'delete', old.rowid, old.release_id, old.product_id,
    old.code, old.generic_name, old.brand_name, old.manufacturer
  );
  INSERT INTO reference_medication_product_fts (
    rowid, release_id, product_id, code, generic_name, brand_name, manufacturer
  ) VALUES (
    new.rowid, new.release_id, new.product_id, new.code,
    new.generic_name, new.brand_name, new.manufacturer
  );
END;
