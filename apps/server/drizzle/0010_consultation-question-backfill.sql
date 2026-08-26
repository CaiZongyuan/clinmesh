-- Backfill the only Virtual Patient blueprint shipped before question rules were persisted.
WITH candidate_question (
  question_code, rule_version, ordinal, question_text,
  answer_text, fact_code, revealed_answer_text
) AS (
  VALUES
    (
      'symptom-onset', 1, 1, '什么时候开始发热？',
      '昨天傍晚开始发热，最高量到 38.7 °C。', NULL, NULL
    ),
    (
      'associated-symptoms', 1, 2, '除了发热，还有哪里不舒服？',
      '咽痛，吞咽时更明显，没有气促。', NULL, NULL
    ),
    (
      'infection-cause', 1, 3, '知道是什么感染引起的吗？',
      '目前还不知道，需要等检查结果。', 'respiratory-pathogen',
      '检验结果显示是甲型流感病毒感染。'
    )
)
INSERT INTO virtual_patient_question_rule (
  workspace_id, epoch, virtual_patient_id, question_code,
  rule_version, ordinal, question_text, answer_text,
  fact_code, revealed_answer_text
)
SELECT
  patient.workspace_id,
  patient.epoch,
  patient.virtual_patient_id,
  question.question_code,
  question.rule_version,
  question.ordinal,
  question.question_text,
  question.answer_text,
  question.fact_code,
  question.revealed_answer_text
FROM virtual_patient AS patient
JOIN scenario_epoch_state AS state
  ON state.workspace_id = patient.workspace_id
 AND state.epoch = patient.epoch
CROSS JOIN candidate_question AS question
WHERE state.scenario_id = 'candidate-fever-outpatient-v1'
  AND patient.virtual_patient_id = 'virtual-patient-fever-001'
  AND NOT EXISTS (
    SELECT 1
    FROM virtual_patient_question_rule AS existing
    WHERE existing.workspace_id = patient.workspace_id
      AND existing.epoch = patient.epoch
      AND existing.virtual_patient_id = patient.virtual_patient_id
      AND existing.question_code = question.question_code
  );
