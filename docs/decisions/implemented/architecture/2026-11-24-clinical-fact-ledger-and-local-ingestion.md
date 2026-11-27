# Agent Note: 只读临床事实总账与院内多源受控接入

Status: implemented

## Problem

ClinMesh 原有的临床评分、事中质控与专题依据各自直接查询 `fhir_resource` 原始表或床旁评估 JSON，存在四类结构性缺口：外院历史（`Visible Source History`）不进入评分且缺乏“外院待核实”语义；不同检测方法或单位写法不同的同类项目缺乏统一口径与方法隔离（例如高敏肌钙蛋白 I 与肌钙蛋白 T）；缺少时间反转（报告早于开单）、超范围、同标本结果矛盾等确定性质检拦截，以及基于 `ingestedAt` / `reportedAt` 的严格 `asOf` 历史回看能力；同时尚未支持接入字段命名不同的院内第二套模拟检验系统，也缺乏跨系统患者认人隔离与未完成批次屏蔽机制。

需求背景与设计约束见 [标准化专病智能体平台一期父需求（Issue #553）](https://github.com/CaiZongyuan/clinmesh/issues/553)、[临床事实总账（Issue #555）](https://github.com/CaiZongyuan/clinmesh/issues/555) 及 [本院第二模拟来源与认人批次门禁（Issue #556）](https://github.com/CaiZongyuan/clinmesh/issues/556)。

## Decision

1. **按需只读总账不建镜像正本，核实状态独立受审计落库**：在 `@clinmesh/contracts/clinical-fact-ledger` 与 `@clinmesh/core/clinical-fact-ledger` 定义覆盖八类临床数据的 14 字段事实模型与三套按来源区分的确定性誊写规则（本院 FHIR R5、`Visible Source History`、`Clinical Risk Assessment`）。总账每次请求实时从原始正本按 `asOf` 截止时刻与 `Workspace/Epoch` 投影计算，不持久化副本，也不收录草稿、未签发报告、病历全文、收费或 `Case Truth`；仅医生通过 `CommandExecutor` 提交的正式核实决策写入 SQLite 迁移 `0124_clinical-fact-verification.sql`（`clinical_fact_verification`）并留存 `AuditEvent` 与 `Action Trace`，以支持同一 `asOf` 回看时核实记录亦受时间截断控制。
2. **方法隔离、同标本冲突并列与默认拦截联动下游算子**：高敏肌钙蛋白 I、常规肌钙蛋白 I 与肌钙蛋白 T 按独立 `itemCode` 与 `method` 记账，永不合并；同标本同项目矛盾数值双双保留并标为 `conflict`；非白名单单位、超生理合理范围、报告时间早于开单时间或性别矛盾标为 `suspicious`；外院事实默认标为 `external-unverified`。上述被标记或超出公共层默认有效期的事实自动设置 `eligibleForScoringAndRedLine: false`，并联动 `ClinicalScoreService` 与 `ClinicalQualityService` 排除其输入，直至负责医生完成正式核实。
3. **院内 L0 适配器契约、认人置信隔离区与批次完整性门禁**：新增迁移 `0125_local-source-ingestion.sql`（`local_ingestion_batch`、`local_ingestion_quarantine`、`local_ingestion_record`），允许院内第二模拟检验系统（`clinmesh-sim-lis-v2`）以不同字段名与单位（如 `mg/dL` 肌酐）经纯函数适配器规整为统一 FHIR R5 `Observation` 与 `Provenance`（保留各自的 `sourceSystemId` 以便检验来源无关性）。患者匹配绝对禁止仅凭姓名合并（同名不同出生日期直接判定为 `distinct-patient`）；系统标识不同但存在属性差异的候选人落入隔离区（`pending-review`），必须由 `administrator` 或 `registrar` 经受审计 Command 确认合并后，且所属批次达到 `received_count === expected_count` 标为 `complete` 时，总账、Agent 查询与临床评分才可读取该批数据。

## Alternatives considered

- **把总账物化为独立同步表定时增量更新**：读取延迟略低，但容易在报告更正、`asOf` 历史回溯、FHIR 删除与重置 Epoch 时与正本漂移，并引入双写维护成本；按需从已索引本院表实时投影可保证单一事实源与精确时间截断。
- **在誊写或入库阶段自动挑选“更可信”的同标本矛盾值或按姓名自动合并跨系统患者**：虽然减少人工介入，但一旦自动选错或将同名异人混入同一病历将直接污染红线与肾功能计算；采用并列标记与认人隔离区将最终临床与身份裁决权明确留给受审计人工操作。
- **直接覆盖原 `fhir_resource` 跳过 L0 批次与隔离态**：无法拦截尚未传送完毕的 6/10 残缺检验批次，也无法保证合并前的患者隔离；通过 L0 独立表门禁并在总账读取层联接校验可做到零污染且全程可审计。

## Consequences

ClinMesh 在不修改原有正本存储与 `Case Truth` 隔离边界的前提下，为所有临床评分、事中红线与后续专病包运行时提供了来源无关、方法清晰、时点可复现且带质控阻断的统一事实底座；未来接入更多院内来源系统只需扩展 L0 适配器与映射版本，不影响上层总账与评分接口。完整契约与接口行为见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)与[仿真与病例数据](../../../architecture/simulation.md)。
