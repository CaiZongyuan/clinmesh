-- 归档时冻结 DRG 分组结果：与首页快照同事务落盘，规则包升级不回写历史归档。
ALTER TABLE inpatient_record_archive ADD COLUMN drg_result_json TEXT;
