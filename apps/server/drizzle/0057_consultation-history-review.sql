ALTER TABLE consultation_history_addition ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK (review_status IN ('unreviewed', 'confirmed', 'undo-pending'));
ALTER TABLE consultation_history_addition ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1));
ALTER TABLE consultation_history_addition ADD COLUMN undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1));
ALTER TABLE consultation_history_addition ADD COLUMN inverse_text TEXT;

-- Explicitly accepted replacements were already reviewed. Preserve their manual ownership.
UPDATE consultation_history_addition SET review_status = 'confirmed'
  WHERE status = 'applied' AND ownership = 'manual' AND target_addition_id IS NOT NULL;
UPDATE consultation_history_addition SET rejected = 1 WHERE review_state = 'ignored';

-- Old corrections retain the exact predecessor text; an unavailable inverse requires manual review.
UPDATE consultation_history_addition AS addition SET inverse_text = (
  SELECT target.current_text FROM consultation_history_addition AS target
  WHERE target.workspace_id = addition.workspace_id AND target.epoch = addition.epoch
    AND target.case_id = addition.case_id AND target.addition_id = addition.target_addition_id
) WHERE status = 'applied' AND target_addition_id IS NOT NULL;
