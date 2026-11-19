# Agent Note: 通用多病例 Authored Case Pack 编译器与分阶段 Case Truth 解析

Status: implemented

## Problem

既有 `PciCaseSource` 固定单病例底稿硬编码了男性性别、单枚支架、固定 FM39 分组目标、空可见病史以及单病例准备入口，无法表达女性患者、零支架保守管理（GDMT）、纯门诊慢病病例以及带既往慢性病史的跨阶段临床路径。此外，原检验与功能检查解析器仅按时间戳取最新隐藏 `Observation`，同一 `source_case_id` 无法在首诊、同就诊复测（如连续高敏肌钙蛋白 I 或水化后复查血肌酐）以及出院后门诊随访（如复查 LDL-C、肌酐与心电图 ST 段回落）之间确定性切换真值，也无法为同一病例同时提供独立的 ECG 与 TTE 精确结论。

## Decision

1. **通用版本化 `Authored Case Pack` 编译器与幂等准备服务**：
   - 新增 `AuthoredCasePackCompiler`（`apps/server/src/application/scenario-data/authored-case-pack-compiler.ts`），将声明式版本化多病例定义编译为不可变 FHIR R4 来源 Bundle、`CompiledSyntheaIndexCase`、`SyntheticPatientProfile` 模板与版本化 `PatientPersona`（`model: 'clinmesh-authored-template'`）。
   - 支持男女人口学、`0 | 1 | ...` 支架计划、可选冠脉造影、早于 `indexDateTime` 的定制 `Visible Source History`（既往就诊、诊断、检验与用药），以及覆盖 WS/T 886-2026 + LOINC 双编码检验、`ECG`/`TTE` 完整指标与分检查精确结论、多支冠脉造影（含可选 FFR/iFR 与 QCA）的隐藏 `Case Truth`。编译期复用 `personaLeaksDiagnosis` 强制校验所有模板 Persona 不泄漏未确诊隐藏诊断。
   - 新增 `AuthoredCasePackService`（`apps/server/src/application/scenario-data/authored-case-pack-service.ts`），经由共享 `CommandExecutor`（`operation: 'synthetic-case.authored-pack.prepare'`，`idempotencyScope: 'workspace'`）在同一事务内幂等准备全部病例，挂载管理员专属接口 `GET /api/sim/v1/synthetic-cases/authored-pack`（只返回无真值泄漏的就绪摘要）与 `POST /api/sim/v1/synthetic-cases/authored-pack/prepare`。重复准备保留人工 Persona 修订和既有就诊绑定；清空患者库重置后自动恢复归档 Profile 并递增 `profileRevision` 创建新的 `brief-ready` 实例；运行中 Persona 任务返回 `409 AUTHORED_CASE_PACK_PERSONA_RUNNING`，排队任务标记 `PERSONA_JOB_SUPERSEDED`。
   - 原 `inpatient.pci-data.*`、`pciDataPackage` 与 `POST /api/sim/v1/synthetic-cases/pci/prepare` 保持 100% 向后兼容不变。

2. **分阶段确定性 `Case Truth` 解析**：
   - 引入隐藏 `Observation` 阶段扩展 `urn:clinmesh:synthetic:truth-stage`（`initial` | `inpatient` | `repeat` | `follow-up`，未标记作为通用兜底），在 `InvestigationService` 与 `ExaminationResultResolver` 中共用统一优先级：
     - 跨就诊门诊复诊（`outpatient_case_source` 命中）：始终优先 `follow-up -> 未标记`，绝不落入住院/首诊 `repeat`。
     - 住院阶段：首次优先 `inpatient -> initial -> 未标记`，同住院已有同编码终态报告/检验时优先 `repeat -> inpatient -> initial -> 未标记`。
     - 门诊首诊：首次优先 `initial -> 未标记`，同门诊已有同编码终态报告/检验时优先 `repeat -> initial -> 未标记`。
   - 为避免住院多项检查超出 `#formalEvidence` 的 `LIMIT 20` 截断，`InvestigationService` 使用独立的无上限当前就诊终态检验编码查询判定复测，严格按包含阶段上下文的 `inputHash` 命中快照（不跨阶段回退最新快照），并补充肌酐 `umol/L -> mg/dL` 换算以同时兼容 `laboratory-cn` 与 `pci-data`。
   - `ExaminationResultResolver` 同时接受 `urn:clinmesh:examination:ecg` / `tte` 体系与按 `urn:clinmesh:examination:exam-code` 区分的 `urn:clinmesh:examination:conclusion` 精确结论；所选阶段写入 `inputHash`，在保持 `clinmesh-authored` 零正常兜底与同阶段冲突拦截的前提下，实现首诊、复测、随访快照分离及 Epoch 重放复用。
   - 无用药门诊在 `encounter.complete` 且确认无未结处方或待缴费项时将 `outpatient_case.status` 推进为 `completed`，既允许后续出院门诊随访再次挂号，又保持未缴费/未发药处方病例对重复挂号的拦截。

3. **五例心血管与慢病专病合成病例包及紧凑管理入口**：
   - 在 `apps/server/src/application/scenario-data/cardiorenal-authored-case-pack.ts` 交付五例合成病例，完整对齐 `@clinmesh/core` 临床评分、医嘱组套与事中临床质控红线/警示边界；所有病例定义与 Persona 文本仅保存在 `apps/server/`，不进入 `packages/contracts/`。
   - 在 `apps/web/src/app/pci-preparation.tsx` 原位扩展紧凑的专病病例包就绪面板与一键准备按钮（经由 `useInpatientWriteIntent` 与 `synthetic-case.authored-pack.prepare` 持久写意图及 `/api/his/v1/command-receipts` 恢复回执，仅使用 React 18.3.1 / 19.2 共有 API），确保 `apps/dsh-web/lib/client.js` 严格维持在 5,000,000 字节上限之下。

## Alternatives considered

- **直接改造 `PciCaseSource` 替换原固定 PCI 病例**：会破坏既有 `pciDataPackage` 内容哈希与固定 PCI 黄金链路回归测试，因此保留旧入口并新增通用多病例编译器与 `/api/sim/v1/synthetic-cases/authored-pack`。
- **把五例病例拆分注册为五个独立准备端点或写入 SQLite 新表**：增加无关迁移成本且破坏与现有 `synthetic_patient_profile` / `synthetic_case_instance` 表的统一重放语义，因此完全复用现有表结构实现零迁移交付。
- **靠虚拟时钟顺序或人工改库模拟复测与出院随访变化**：缺乏确定性且无法在单次病例真值中清晰表达跨阶段演变；通过 FHIR 扩展 `urn:clinmesh:synthetic:truth-stage` 将阶段规则内聚在解析边界，既不污染临床 DTO，又确保零 LLM 调用与 Epoch 重放一致。

## Consequences

- 管理员可在单一入口幂等准备全部五例心血管与慢病专病病例，并在不调用任何外部模型的情况下完成门诊首诊、复测、住院造影/PCI 决策、肾功能红线拦截及出院后门诊随访全链路验证。
- 临床接口、可见病史、FHIR Search 与管理摘要均保持零 `Case Truth` 泄漏；后续 CLI Operation Catalog 暴露由 P13 (#475) 统一登记。
- 当前领域词汇归 [领域词汇](../../../../CONTEXT.md)，架构规则归 [仿真、病例与素材](../../../architecture/simulation.md#103-场景定义)。
