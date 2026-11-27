# FHIR R5 只读投影

通过 Visitor Gate 后，`GET /fhir/R5/metadata` 返回 R5 `5.0.0` CapabilityStatement，其中列出资源、交互和各类型的搜索参数。医生可读责任就诊，工作区管理岗位可读本 Epoch 的临床事实与 AuditEvent。启用状态随 Hospital Data Pack 生效。

从 `/fhir/R5/Patient` 开始，使用资源逻辑 ID 访问 `/<type>/<id>`、`/<type>/<id>/_history` 或 `/<type>/<id>/_history/<version>`。也支持类型历史与全局历史。`_id` 精确匹配，`patient` 和 `encounter` 可使用裸 ID 或相对资源引用。未知搜索参数返回 `400 OperationOutcome`，写入返回 `405 OperationOutcome` 及 `Allow: GET`。

查询直接投影规范化 Store 事实。正式诊断、签署病历、签发报告和床旁评估使用其业务修订。可更新实体自 SQLite schema v8 起保存历史状态，升级前仅可查询实际留存版本。报告引用精确观察版本，草稿和私有病例资料不进入投影。

住院 MedicationRequest 读取签发医嘱与当期目录的用法。每笔药房实际交付单独生成 MedicationDispense，通过 authorizingPrescription 引用对应医嘱。临时医嘱的给药完成状态随业务版本更新。
