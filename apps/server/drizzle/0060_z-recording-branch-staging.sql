-- Preserve both released source-backed rows and pre-merge history-field rows.
-- Runtime startup completes every migration before exposing application services.
CREATE TABLE consultation_history_integration_staging AS
SELECT rowid AS original_rowid, * FROM consultation_history_addition;
DELETE FROM consultation_history_addition;
