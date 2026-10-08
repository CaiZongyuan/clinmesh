-- 仅新建 Consultation 登记资格，不为已有对话隐式补录。
CREATE TABLE consultation_recording (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, epoch, case_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation (workspace_id, epoch, case_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE consultation_recording_job (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed', 'failed')),
  error_code TEXT,
  PRIMARY KEY (workspace_id, epoch, turn_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation_recording (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, turn_id)
    REFERENCES consultation_turn (workspace_id, epoch, turn_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX consultation_recording_job_case_idx
  ON consultation_recording_job (workspace_id, epoch, case_id);

CREATE TABLE consultation_history_addition (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  case_id TEXT NOT NULL,
  addition_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('chiefComplaint', 'historyOfPresentIllness', 'priorMedicalHistory')),
  quote TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('addition', 'correction', 'conflict')),
  status TEXT NOT NULL CHECK (status IN ('applied', 'pending')),
  PRIMARY KEY (workspace_id, epoch, case_id, addition_id),
  FOREIGN KEY (workspace_id, epoch, case_id)
    REFERENCES consultation_recording (workspace_id, epoch, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, epoch, source_turn_id)
    REFERENCES consultation_turn (workspace_id, epoch, turn_id) ON DELETE RESTRICT
) STRICT;
