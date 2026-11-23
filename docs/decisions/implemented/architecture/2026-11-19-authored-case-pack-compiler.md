# Agent Note: 固定来源直接住院、通用多病例 Authored Case Pack 编译器与分阶段真值解析

Status: implemented

## Problem

Synthea 随机生成患者既不能稳定产出特定冠脉病变与多阶段慢病组合，早期 `Synthetic Case` 物化又强制走门诊挂号收费而无法表达择期直接入院，且若要求管理员照手册逐字段手填首个 `Patient Persona` 或调用外部模型生成固定演示自述，会增加演示前置负担或引入输出漂移。进一步扩展至多病种专病闭环时，原单病例 `PciCaseSource` 硬编码了男性、单枚支架、空既往史与固定 FM39 目标，且原检验／功能检查解析器仅按时间戳取单条隐藏 `Observation`，无法在同一病例来源下确定性区分门诊首诊、住院基线、同次复测（如连续 `hs-cTnI` 或水化后复查血肌酐）与出院后门诊随访（如复查 `LDL-C` 与心电图 ST 段回落）。

## Decision

在保留固定单病例 PCI 入口完全向后兼容的基础上，构建直接住院实体化、模板 Persona 一次就绪、通用多病例 `Authored Case Pack` 编译器与分阶段 `Case Truth` 解析体系，领域词汇与架构合同见[领域词汇](../../../../CONTEXT.md)及[仿真、病例与素材](../../../architecture/simulation.md)：

1. **`clinmesh-authored` 直接住院实体化与模板 Persona 同事务就绪**：作者底稿编译为独立的 `clinmesh-authored` 来源（精确检验快照标记 `case-truth-exact` 以区别于 `synthea-exact`，底稿不含已执行手术，本院诊疗事实均由真实岗位 Command 产生）。直接住院在共享事务内校验病例与 Persona 版本及一次消费门禁，创建住院型 materialization 并调用住院登记，不产生虚假门诊挂号或门诊费（Epoch 重置按原修订重放直接住院；清空患者库重置后再次准备时自动恢复归档 Profile 并递增 `profileRevision` 建立新 `brief-ready` 实例）。准备事务同步创建并首次选定经 `personaLeaksDiagnosis` 编译期校验的版本化模板 `PatientPersona`（`model: 'clinmesh-authored-template'`），零模型调用即达待挂号／待入院态；重复准备优先保留人工编辑修订与既有就诊绑定，遇运行中异步 Persona 任务返回 `409` 拒绝、排队任务标为 `PERSONA_JOB_SUPERSEDED`。
2. **通用多病例 `AuthoredCasePackCompiler` 与幂等管理入口**：通过 `authored-case-pack-compiler.ts` 与 `AuthoredCasePackService`（`synthetic-case.authored-pack.prepare`，`hisOperationCatalog` 映射 `admin.authored-case-pack.{read,prepare}`）在既有 `synthetic_patient_profile`／`synthetic_case_instance` 表上零数据库迁移交付五例心肾专病合成病例（覆盖男女人口学、`0 | 1 | ...` 支架计划、早于 `indexDateTime` 的可见慢病史、WS/T 886 + LOINC 双编码检验、独立 `ECG`/`TTE` 精确结论及含 FFR/iFR 与 QCA 的多支冠脉造影；病例正文仅驻留 `apps/server/`）。`pci-preparation.tsx` 原位扩展紧凑准备面板并复用持久写意图恢复，保持 `apps/dsh-web/lib/client.js` 在 5,500,000 字节预算内（见[DSH 客户端语法压缩](../testing/2026-11-13-dsh-client-syntax-compaction.md)）。
3. **分阶段确定性 `Case Truth` 解析与院后随访挂号放行**：引入隐藏 `Observation` 扩展 `urn:clinmesh:synthetic:truth-stage`（`initial | inpatient | repeat | follow-up`），在 `InvestigationService`（使用无条数截断的当前就诊终态编码查询判定复测，补充肌酐 `umol/L <-> mg/dL` 换算）与 `ExaminationResultResolver`（按 `exam-code` 隔离 ECG 与 TTE 精确结论）中统一执行阶段优先级：跨就诊门诊复诊优先 `follow-up -> 未标记`；住院首次 `inpatient -> initial -> 未标记`、同住院复测 `repeat -> inpatient -> initial -> 未标记`；门诊首次 `initial -> 未标记`、同门诊复测 `repeat -> initial -> 未标记`。阶段上下文纳入快照 `inputHash` 防止跨阶段串用。同时 `activeCaseByPatient` 对已完诊、已记录无需用药且无未结处方或待缴费用的门诊病例解除活动阻塞，打通“首诊转住院 → 出院 → 门诊随访挂号”全链路。

## Alternatives considered

- **先伪造一次门诊再转住院，或每次由外部模型动态生成固定病例的首个 Persona**：前者产生虚构门诊账单，后者引入模型配置依赖与文本漂移。
- **直接改写原 `PciCaseSource` 替换单病例底稿，或为五例病例新建独立数据库表／五个端点**：破坏既有 `pciDataPackage` 内容哈希与[PCI 从零岗位旅程](../testing/2026-10-27-pci-from-zero-journey.md)黄金账本，或增加无谓表结构冗余。
- **依赖虚拟时钟推进快慢或手工改库模拟复测与随访指标变化**：缺乏确定性与跨 Epoch 重放一致性；内置 `truth-stage` 扩展可在零模型、零临床 DTO 污染下精确表达病程演变。

## Consequences

管理员可一键零模型幂等就绪单病例 PCI 与五例心肾专病病例包，完整支撑首诊、同次复测、造影 FFR 决策、围术期护肾、药事红线拦截及院后随访的确定性端到端回归，所有公开临床、历史与管理摘要接口维持零 `Case Truth` 泄漏（三端同源内核与无像素边界见[同源专病临床内核与像素暂缓边界](2026-11-19-shared-specialist-clinical-kernel-and-pixel-deferral.md)）。
