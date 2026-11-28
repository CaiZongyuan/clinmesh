# Agent Note: 概念词表映射门禁、知识主张发布与离线知识治理

Status: implemented

## Problem

随着专病包从单一硬编码专题扩展至可插拔多病种知识支撑，原有的硬编码药理分类数组与纯文本指南引用无法支撑三项平台要求：第一，无法在临床评分与高危安全红线中区分严格等价与近似/上下位概念，更缺少人工复核门禁；第二，专题引导文字与带逐字原文锚点的临床规则耦合在一起，既无法展示“未经医生检查”的试用版边界，也无法在指南修订或撤回时按就诊时点重放历史知识或立即停用失配引文；第三，若允许在线运行时由 Agent 直接改写知识库或按新版指南覆盖既有条款，将带来未经核验的规则漂移风险。需求与边界见 [标准化专病智能体平台一期父需求（Issue #553）](https://github.com/CaiZongyuan/clinmesh/issues/553)、[概念词表与知识主张（Issue #559）](https://github.com/CaiZongyuan/clinmesh/issues/559) 与 [离线知识治理流水线与检索（Issue #560）](https://github.com/CaiZongyuan/clinmesh/issues/560)。

## Decision

1. **三层受控词表与 SKOS 映射安全门禁**：在 `@clinmesh/contracts/concept-vocabulary` 与 `@clinmesh/core/concept-vocabulary` 建立本院项目（`hospital`）、平台概念（`disease-pack`）与公共标准编码（`public`）三层结构，并将既有药理分类体系迁移为受控词表节点（保留兼容导出）；显式约定 SKOS 四类关系（`exact`、`close`、`broader`、`narrower`）与四态复核生命周期（`proposed`、`reviewed`、`approved`、`deprecated`），仅 `approved + exact` 允许用于临床评分与安全红线计算，近似、上下位或未复核映射一律给出明确拒绝原因码。
2. **“专题导航 + 原子主张”双层模型、九状态发布机与 `asOf` 不可变快照**：在 `@clinmesh/contracts/knowledge-claims` 与 `@clinmesh/core/knowledge-claims` 将面向医生的导航说明与绑定适用条件、概念编码和来源 `sha256` 引文锚点的原子主张解耦，使用九状态发布状态机与医生执业审核门禁控制 `auto-verified`（强制展示 `试用版` 与 `未经医生检查，仅用于仿真`）向 `clinician-reviewed`／`published` 演进；查询侧支持按就诊时间 `asOf` 重放历史生效快照及对比最新版差异，并在底层指南撤回或段落失配时立即将引文与主张判定为失活而不覆写历史版本。
3. **受控离线制卡、差异仲裁队列与零在线写知识工具边界**：在 `@clinmesh/contracts/knowledge-pipeline` 与 `@clinmesh/core/knowledge-pipeline` 收敛受控确定性流制卡与五类结构门禁（缺锚点、来源失配、引文失配、越界未证实细节、概念未映射），为合成测试指南强制要求 `SYNTHETIC_TEST_GUIDELINE_NOT_CLINICAL` 声明以防混淆临床正本；指南升级与映射降级分别产出影响差异报告与专家仲裁队列而不自动修改已有发布主张；指南全文检索自动通过已批准精确同义词扩展召回，而所有离线知识治理 HTTP 入口均归入受控排除路由，保持临床运行时零在线写知识 CLI 或 Agent 工具。

## Alternatives considered

- **允许在线诊疗 Agent 工具通过受限接口提交“待审核知识草稿”**：虽然可以缩短临床反馈到入库的路径，但会扩大临床会话工具面并模糊“患者个体诊疗决策”与“跨患者公共知识编辑”的权限隔离，因此在临床运行时完全禁止写知识工具，统一收敛为离线治理流水线与专家仲裁流程。
- **在词表同义词检索中直接沿用近似（`close`/`broader`/`narrower`）映射用于风险评分**：近似同义扩展能提升文书或文献检索召回率，但直接带入临床红线与剂量/排雷评分会误触发或漏放高危禁忌，因而把检索同义扩展与 `approved + exact` 安全门禁拆成两个严格正交的策略路径。

## Consequences

平台具备了可审计、可回放且带有明确试行免责与引文失效防护的知识工程底座，既防止未审核知识直接进入正式临床发布态，也防止新版指南发布或映射降级静默破坏既有规则与题库。新增或升级知识包须通过受控离线流水线校验或专家仲裁队列，不得绕过医生身份签署或引入在线写知识工具；完整架构与只读契约见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)。
