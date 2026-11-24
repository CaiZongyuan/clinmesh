# Agent Note: 专病包纯数据格式、三层叠覆与受控运行时

Status: implemented

## Problem

ClinMesh 既有专病能力（指南专题、心血管医嘱组套、事中质控与风险评分）在 `@clinmesh/contracts` 中以封闭枚举（`guidelineTopicIds`、`orderSetTemplateIds`、`cardiology`/`endocrinology` 专科枚举）硬编码绑定心血管，导致每增加一个病种都必须同步改动契约包、服务端注册表、前端下拉选项与 Agent 工具定义；同时缺少声明式跨时间触发条件、诊疗阶段划分、按任务分级就绪门禁与包级工具策略隔离，且合成黄金病例在未预置某些检验检查时可能回落至成人正常基线或模型补造。

需求与边界见 [标准化专病智能体平台一期父需求（Issue #553）](https://github.com/CaiZongyuan/clinmesh/issues/553)、[合成医院改名与黄金病例基准（Issue #554）](https://github.com/CaiZongyuan/clinmesh/issues/554) 及 [专病包格式与运行时（Issue #557）](https://github.com/CaiZongyuan/clinmesh/issues/557)。

## Decision

1. **解除契约闭集枚举耦合，改为纯数据专病包与注册表校验**：将 `guidelineTopicIdSchema`、`specialty` 与 `orderSetTemplateIdSchema` 放开为受控 slug 校验，避免因新增病种修改 `@clinmesh/contracts` 合同；将“未注册专题或组套返回 404”的严格性保留在服务端动态注册表解析层。在 `@clinmesh/contracts/disease-pack` 与 `@clinmesh/core/disease-pack` 定义纯 JSON 数据包格式（在格式层面即预留 `packType: 'full' | 'recognition'`、跨时间跨就诊组合触发条件及显式 `timestampField` 字段），加载时以代码扫描器拦截任何可执行代码片段并核对版本化平台公式库引用（如 `ckd-epi-2021@1`、`grace-acs@1`），绝不在数据包中内嵌脚本或计算代码。
2. **三层叠覆严格执行“本地化可替换、安全类只准收紧”**：公共层默认策略、专病包规则与医院适配层（`HospitalOverlay`）在加载期执行纯函数确定性合并。医院适配层可替换编码映射、目录绑定、审批人或报告模板等本地化项，但一旦试图删减红线、削弱触发或禁用动作、放宽有效期天数上限或降低考卷门槛，加载器立即以 `HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN` 拒绝并指出具体越界字段。
3. **结构化激活、阶段、三档就绪门禁、任务视图与包工具网关**：`DiseasePackRuntimeService`（搭配迁移 `0123_disease-pack-runtime.sql` 保存受审计医生手动启停覆写与阶段切换记录）直接求值 `Clinical Fact Ledger`，驱动跨就诊顺序激活与诊疗阶段状态；对起草类任务在服务端与 Agent 通道统一实施 `ready` / `missing-secondary` / `missing-critical` 三档判定（标为可疑、冲突或未核实的外院事实视同缺失，缺关键项时直接以 `409 TASK_READINESS_CRITICAL_MISSING` 拒答，缺次要项时允许带逐项缺口标注起草）；提供严格裁剪为任务声明字段的最小事实视图（屏蔽无关护理与费用）；并通过白名单与不可越权禁止动作网关（`auto-prescribe-medication`、`sign-clinical-document`、`autonomous-treatment-decision`）控制通用包工具（保持不向接近 32 上限的门诊检验栏位追加工具，所有越权拒绝均写 `AuditEvent`）。
4. **冻结黄金病例与零兜底基准先行**：同步将合成医院及药厂统一更名为 ClinMesh，保持既有五例专病包不变并冻结十例黄金病例与搬迁前基准快照，对 `clinmesh-authored` 病例未预置检验检查统一拒绝并呈现“本病例未预置该检查”，以作为后续迁移阶段零回归的硬对照。

## Alternatives considered

- **继续在 TypeScript 中按 `switch (specialty)` 或数据包内置计算表达式（如 CQL / JS 钩子）扩展病种**：虽然表达自由度高，但加载器无法在不执行代码的情况下静态校验安全性，也无法静态判定医院适配层是否放宽了安全阈值；将复杂生理与危险评分公式沉淀于平台版本库并让专病包按版本引用数据，兼顾了可扩展性与静态安全门禁。
- **直接修改既有五例病例包并立即替换心血管运行时**：会在搬迁前破坏既有五例全链路测试基线并提前卷入未合并的上游组套变更（#520）；独立冻结扩展黄金病例及基准快照、并以纯数据测试假病种包先行验证运行时契约，能把平台框架风险与专科迁移风险彻底解耦。

## Consequences

专病平台底座已具备在不更改 `@clinmesh/contracts` 枚举与工具总数的前提下加载、校验、激活并门禁新专病包的能力，并为后续冠心病迁移、知识主张状态机、统一提示卡与自动化考卷保留了全部必需格式位置。新增专病包时必须全部以数据文件交付并接受三层叠覆与公式版本校验；完整合同见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)与[仿真与病例数据](../../../architecture/simulation.md)。
