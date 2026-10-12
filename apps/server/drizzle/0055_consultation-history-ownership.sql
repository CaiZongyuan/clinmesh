ALTER TABLE consultation_history_addition ADD COLUMN target_addition_id TEXT;
ALTER TABLE consultation_history_addition ADD COLUMN ownership TEXT NOT NULL DEFAULT 'automatic' CHECK (ownership IN ('automatic', 'manual'));
ALTER TABLE consultation_history_addition ADD COLUMN start_offset INTEGER;
ALTER TABLE consultation_history_addition ADD COLUMN end_offset INTEGER;
ALTER TABLE consultation_history_addition ADD COLUMN current_text TEXT NOT NULL DEFAULT '';
ALTER TABLE consultation_history_addition ADD COLUMN review_state TEXT CHECK (review_state IN ('superseded', 'ignored'));

-- Legacy anchors are recovered from unique exact fragments by the Command owner using UTF-16 offsets.
