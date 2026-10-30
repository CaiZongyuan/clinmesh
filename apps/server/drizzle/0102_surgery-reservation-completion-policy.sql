-- 旧完成动作已关闭本手术的全部余量；全耗尽项此前未留下关闭说明。
-- 保存原关闭策略，使升级后的追加更正不会重新打开旧预留。
UPDATE inpatient_material_reservation AS r
SET release_reason='历史手术已完成，沿用原预留关闭策略',version=version+1
WHERE r.status='replaced' AND r.consumed_quantity=r.quantity AND r.release_reason IS NULL
  AND EXISTS (
    SELECT 1 FROM inpatient_surgery_execution e
    WHERE e.workspace_id=r.workspace_id AND e.epoch=r.epoch
      AND e.admission_id=r.admission_id AND e.request_id=r.request_id AND e.status='completed'
  );
