# Agent Note: 待核实思路的医生处置闭环

Status: implemented

## Problem

"依据与说明"弹窗中的待核实思路此前只读：医生无法标记已核实或忽略，每轮刷新原样重现；叙述文本中的 `evidence:<哈希>` 引用与整段病例原文也让弹窗难以阅读。需求与验收见[待核实思路规格](../../../spec/2026-10-22-doctor-consideration-disposition.md)。

## Decision

处置写入独立表 `doctor_consideration_disposition`（主键 actor_id、case_id、kind、label_key），不写入建议状态的持久 JSON；读取与生成响应由服务按当前医生合并可选字段 `considerationDispositions`，旧持久化行无需迁移。生成响应同样合并，避免重新生成完成到刷新之间已处理思路短暂重现。

`label_key` 是归一化标题（trim 并压缩空白）的字面匹配：思路 id 由模型生成、跨轮不稳定，标题相同即视为同一条思路；重新生成后标题不同即视为新思路，不做语义模糊匹配。动作只有"已核实""忽略"与撤销（clear），只写本表，不创建或修改任何 Encounter 上的临床事实；幂等由主键 upsert 提供，不要求 Encounter 版本或幂等键。处方类没有思路通道，契约按 kind 排除 prescription，迁移表的 CHECK 同步收窄。

前端把叙述文本（结论、支持、反对、待核实事项）中的证据 id 引用映射为来源 label，病例证据默认折叠为"来源 label · 摘要"行（问诊附时间、历史附条数），展开显示既有 EvidenceContent；已处置思路收进弹窗内"已处理"折叠区，可撤销恢复。

验证：服务端 HTTP + SQLite 覆盖 set/clear/读回合并、归一化 upsert、kind 隔离、重启保留、授权与 prescription 拒绝；Web 组件测试覆盖映射、折叠、动作、计数排除与撤销；standalone Web e2e 与 DSH React 18/19 浏览器合同在 ShadowRoot 双版本上执行真实入口的已核实与撤销闭环。

## Alternatives considered

- 把处置写进 `doctor_recommendation_state` 的持久 JSON：需要迁移旧状态行并在每轮生成时保留字段，读写路径与生成管线耦合。
- 用模型生成的思路 id 作为处置键：id 跨轮不稳定，会留下永不匹配的孤儿处置。
- 语义模糊匹配标题：无法向医生解释某条思路为何"继承"了旧处置，字面规则更可预期。
- 自动打勾或要求填写核实理由：医生确认只要"已核实/忽略"两个动作。
- 处置键加 workspace/epoch：病例身份已含在 case_id 中，处置跟随医生与病例；epoch 重置产生新病例后旧处置自然失联，孤儿行只占存储。

## Consequences

标题相同但内容变化的重新生成会继承旧处置，这是字面匹配的已知边界；处置表无外键，病例删除后行成为孤儿，只占存储不影响读取。处置数量有界（每 kind 最多等于历史思路数），不构成存储风险。
