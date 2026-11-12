# Agent Note: 门诊独立检查的逐项确认与原回执恢复

Status: implemented

## Problem

同类独立检查可以分别形成临床申请及费用，整批回滚会丢弃已经合法完成的项目。连续准备多项手动检查后，单草稿字段也无法保存各行输入；响应丢失时把剩余清单当成新开立，会重复产生申请与费用。[批量办理需求（Issue #407）](https://github.com/CaiZongyuan/clinmesh/issues/407)明确要求独立检查逐项报告结果，诊断组与整张处方继续保持整体边界。

## Decision

三类门诊独立检查继续使用 `doctor.recommendations.confirm` 和现有事务内单项领域内核。最外层 Command 先核对负责身份、Encounter、草稿版本及全部 Agent 项目的建议身份、代次和完整资料指纹；每个检查再以 SQLite savepoint 独立核对审阅价目、保存草稿及开具，失败只回滚该项的资源、费用和 outbox。非预期错误及权限失败使整个 Command 回滚。只有外层写一份审计、Action Trace 和幂等回执，响应按原请求下标报告每项成功记录或确定失败。

已有单草稿的替换仍要求显式处理与正确版本。删除原草稿放在首个成功项目的 savepoint 内；全部失败时保留原草稿。成功记录不因其他项目失败撤销。该决定仅接替[准备确认决策](2026-10-18-prepared-clinical-confirmation.md)对独立检查的整批回滚保证，诊断组、整张处方及自动项目防过期边界继续有效。

浏览器 `sessionStorage` 私稿作用域、上限 8 项同窗连续添加、已发送原意图分离与退出清理遵循[临床连续办理私稿与回执恢复](2026-11-10-clinical-batch-draft-and-receipt-recovery.md)。修改 Agent 项目的临床字段继续保留其来源和证明，不能因编辑暗中绕过建议时效校验。限定医生 Session 的 `GET recommendations/:kind/confirmations/:idempotencyKey` 只返回同账号岗位、Workspace/Epoch、病例和类别的原回执，显式排除在 Operation Catalog 外（不扩展 CLI 或 Agent Grant）；原 POST 若在回执创建前因就诊预期版本、资料或目录冲突明确拒绝，则释放旧意图并保留输入供医生刷新重审。退出后查到部分成功或失败回执时，缺失的失败行从冻结请求恢复回原作用域草稿，保存完成后才释放原意图。

## Alternatives considered

- 延续同类独立检查整批回滚：与独立项目成功保留的业务边界冲突；仍适用于诊断组和整张处方。
- 浏览器逐次覆盖单草稿并调用多个完整 Command：容易覆盖其他人工输入，且不能形成一份稳定、可恢复的逐项回执。
- 给通用 CLI receipt 放开页面组合操作：扩大 Agent 能力面。采用病例和检查类别限定的 Session 查询，复用既有回执存储与身份隔离。
- 只在内存保存幂等键，或查询失败后重新构造请求：刷新及目录变化后无法证明恢复的是原操作。

## Consequences

整次提交有一个受信意图和回执，每个独立检查内部仍完整生效或回滚。失败项修正后使用新意图；未知结果必须先恢复原意图。公开 HTTP 验证部分成功、原草稿保留、费用与幂等重放，组件及真实入口验证连续添加、输入隔离、刷新恢复与失败保留。当前合同由[临床流程](../../../architecture/clinical-workflows.md#门诊独立检查的应收与执行门禁)拥有。
