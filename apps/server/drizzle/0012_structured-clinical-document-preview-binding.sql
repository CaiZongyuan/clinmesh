ALTER TABLE clinical_document_sign_preview
ADD COLUMN encounter_version TEXT NOT NULL DEFAULT '';

ALTER TABLE clinical_document_sign_preview
ADD COLUMN actor_context_hash TEXT NOT NULL DEFAULT '';
