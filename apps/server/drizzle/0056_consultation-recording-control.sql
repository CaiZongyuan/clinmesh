ALTER TABLE consultation_recording ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE consultation_recording ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));
-- 自动资格不补录开场白；旧病例显式补录从首轮开始。
ALTER TABLE consultation_recording ADD COLUMN start_sequence INTEGER NOT NULL DEFAULT 2 CHECK (start_sequence > 0);
ALTER TABLE consultation_recording_job ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
ALTER TABLE consultation_recording_job ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 1 CHECK (scheduled IN (0, 1));
