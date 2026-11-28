# Agent Note: Agent 输出双轨评测与医生修改统计

Status: implemented

## Problem

在仿真评测与专病 Agent 辅助起草场景下，传统单一综合百分比得分会掩盖致命医疗安全隐患：系统可能因为漏报少量条件必答风险或因“把未被证实甚至完全捏造的检验检查写进推荐结论”被常规命中项平均掉，也难以量化医生在实际采纳过程中究竟改写了多少字段内容；此外，若未经授权就默认触发真实大模型评测或把未跑分草稿展示为无标识结论，既不经济也容易误导评估者。需求与边界见 [标准化专病智能体平台一期父需求（Issue #553）](https://github.com/CaiZongyuan/clinmesh/issues/553) 与 [Agent 输出评分器与医生修改量统计（Issue #565）](https://github.com/CaiZongyuan/clinmesh/issues/565)。

## Decision

1. **双轨正分与漏报扣分 + 捏造事实独立成表**：在 `@clinmesh/contracts/agent-output-scorer` 与 `@clinmesh/core/agent-output-scorer` 以指定 `asOf` 截止时刻的 `Clinical Fact Ledger` 为唯一患者客观事实参照（仅采信 `eligibleForScoringAndRedLine: true` 正式核实事实），将评分拆分出正分覆盖条目（`coverageItems`）与条件必答漏报明细（`omissions`），并将捏造不存在检验检查（`NONEXISTENT_LAB_OR_EXAM`）、违背总账数字/单位（`CONTRADICTORY_VALUE`）与引用未核实外院事实（`UNVERIFIED_EXTERNAL_USED_AS_FACT`）独立归集到 `fabrications[]` 列表与 `fabricationPenalty`，确保高风险幻觉在报告中始终显性可见。
2. **字符级最长公共子序列衡量医生逐字段修改量**：围绕结构化字段键对比 Agent 草稿与医生最终定稿的 `addedChars`、`removedChars`、`editRatio` 及字段增删改状态（`unchanged` / `modified` / `added` / `deleted`），以确定性、纯函数方式反映真实人工纠偏成本，而非依赖主观打分。
3. **默认未评测标签与真实模型双门槛隔离**：对外输出状态默认通过 `createUnevaluatedAgentOutputState()` 标记为 `Agent 输出未评测`；离线或仿真评测默认使用受控流模式并附带“仿真评测（受控模型流），不代表真实模型临床效果”提示，任何 `live-model` 请求若缺少绑定当次 `runId` 且明确授权的许可记录，在服务端统一以 `403 LIVE_MODEL_SCORING_PERMISSION_REQUIRED` 拦截，且评测路由不暴露为临床在线 CLI 或 Agent Grant。

## Alternatives considered

- **直接基于最终病例隐含状态（`Case Truth`）或仅以通用加权总分排序**：依赖 `Case Truth` 会把医生当下客观上尚不可知的信息算作 Agent 失误或纵容跨权限读取私有真值；使用 `Clinical Fact Ledger` 作为评分基准既保持了与医生同源的公平信息集，又把外院未核实事实单独拦截为 `UNVERIFIED_EXTERNAL_USED_AS_FACT`。
- **仅在 UI 层面提示模型评测风险而不做服务端 403 门禁**：界面提示无法约束直连 API 或批处理脚本的调用行为，因此在契约与服务端应用层统一强制校验当次授权许可，保证零未授权真实模型触发。

## Consequences

专病平台获得了一套可复现、与 `Clinical Fact Ledger` 同源且零实时模型依赖的双轨自动化评估能力，能够明确揭露临床捏造项并精确度量医生人工改写工作量；任何接入真实模型的评测运行都必须先取得当次明确授权凭证，评测服务边界见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)与[仿真、病例与素材](../../../architecture/simulation.md)。
