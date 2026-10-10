# Agent Note: 问诊病史自动记录归属

Status: implemented

## Problem

医生在 DSH 问诊后仍需主动要求宿主助手填写草稿，自动记录如果依赖主会话指令或浏览器存活，就无法保证每个已保存回答得到处理。模型重写整篇病历又容易覆盖人工判断、丢失来源或绕过签署责任。[规格](../../../../docs/spec/2026-10-08-consultation-auto-record.md)要求患者回复不等待整理，并在刷新、并发编辑与签署期间保持可恢复且可审计的状态。

## Decision

ClinMesh 在完整患者回答保存后主动编排病史提取，使用既有 DSH 辅助模型桥接。业务输入是 Consultation Record，宿主 Session transcript 和 Assistant reasoning 不参与。ClinMesh 拥有提取范围、来源校验、部分编辑保护、增量合并、持久处理进度及共享 Command；DSH 拥有模型调用能力，医生保留核对、修改与签署责任。

持久 outbox 将患者回复与整理分离，可信行动上下文、Workspace/Epoch、Scenario Run 及病例归属在执行与写入时重新校验。来源和编辑归属由服务端持久化，迟到结果按当前草稿和签署状态决定能否写入。后台不直接生成正式文书，也不通过新的任意 HTTP、SQL 或 FHIR write 工具绕过现有边界。

各细节由独立决策拥有：[来源与保守增量](2026-10-08-consultation-history-increments.md)、[片段归属与更正](2026-10-08-consultation-history-ownership.md)、[暂停补录与恢复](2026-10-08-consultation-recording-recovery.md)、[来源审阅与局部撤销](2026-10-10-consultation-history-review-undo.md)、[签署准备冻结与取消恢复](2026-10-10-consultation-signing-preparation.md)。完整旅程与原生平台的验证取舍由[组合验收决策](../testing/2026-10-10-native-consultation-recording-journey.md)拥有。

## Alternatives considered

- 仅在 DSH preset 要求每次填写：依赖主会话 Agent 的后续工具调用与页面工具可见性，不能保证每个患者回答触发。
- 监听 DSH 全部 Session transcript：容易混入助手推理和非问诊内容，也重复宿主所有权。
- ClinMesh 新建自有模型配置：重复现有辅助模型能力，本次没有必要。
- 每轮重写整篇草稿：难以保护人工编辑、关联来源和撤销局部变化。
- 只在浏览器保存编辑保护：刷新、重连与并发入口会丢失归属，不能约束后台写入。

## Consequences

自动记录不依赖原生主会话的额外填写指令，也不要求浏览器持续打开。失败保留患者回答并允许补录，草稿可不完整，正式签署继续校验既有前置条件。签署准备冻结后台写入，取消后恢复未完成记录；不同病例和 Epoch 的旧结果不能污染当前上下文。

结构化来源约束能拒绝非法输出和伪造引用，但引用存在仍不足以保证语义正确。确定性 HTTP/SQLite 错误矩阵、Web 与 React 18/19 ShadowRoot 合同、实际原生工具链和真实模型有限样本分别提供不同证据，不能把一次 live 成功当成医学质量保证。
