# Agent Note: 可插拔专病平台一期临床迁移、提示与考卷门禁

Status: implemented

## Problem

在确立专病包格式、临床事实总账、受控词表、知识发布状态机与 Agent 输出评分器底座之后，需要完成从既有心血管逻辑向纯数据专病包的真实迁移与端到端闭环：包括在不更改黄金基准行为的前提下迁出 `coronary-cad`、保持临床算子零硬编码并补充多病种/多时期提示时机（排雷清单与审计退出、混淆包互斥合并、不适用人群边界、检查开单适应症黄牌、非阻断跨时间表型识别），提供机器考卷门禁与五层失败归因报告，并通过独立追加无冠心病前提的 `t2dm-renal-care` 专病包与静态代码守卫，确证“加病种不改平台代码与合同”。

需求与验收边界见 [标准化专病智能体平台一期父需求（Issue #553）](https://github.com/CaiZongyuan/clinmesh/issues/553)。

## Decision

1. **临床算子去硬编码与冠心病包迁移**：将 `coronary-cad`（含五个诊疗阶段、五项既有心血管指南专题、四套心血管组套及术后重整、住院术前九项与随访跨就诊核对）沉淀为纯数据专病包，医院层保留通用检验组合与全科设施隔离；临床评分服务按患者总账事实与声明式规则解析，不再硬编码冠心病流程判断，全链路保持十例黄金病例搬迁基准零差异，并将冠脉 CTA 基线医疗服务（`hospital-service-coronary-cta`）同步纳入参考数据夹具与性能预算基线。
2. **六类同步诊疗时机、异步报告回调、安全过滤与多态临床边界**：在 `@clinmesh/contracts/clinical-prompt-cards` 与 `@clinmesh/core/clinical-prompt-cards` 实现六类同步诊疗时机（`encounter-open`、`order-draft-select`、`order-sign`、`encounter-complete`、`pci-plan`、`discharge`）及异步 `report-arrived` 统一提示卡装配、历史知识快照回放比对、陈旧版本标记与展示前安全拦截；通过迁移 `0129_pack-exit-state.sql` 与 `@clinmesh/core/indication-rules` 落地高危排雷清单缺项引导、满足 `exitCriteria` 后一次退出并全时机静默、混淆包互斥工作卡合并、不适用人群“超出本包范围”静默边界及检查开单 `INVESTIGATION_WITHOUT_INDICATION` 黄牌（与 DRG 参考余量严格隔离）。无指征黄牌以结构化 `basis`（`needZh`、`foundZh`、`judgementZh`）表达依据、内部规则编号单独置于 `ruleId`；适应症前置资料未齐时以 `pendingIndications` 返回“缺项待补”提示而不拦截保存；在 `timing=order-sign` 且传入 `catalogItemId` 时预先执行 `checkOrderIndication`，于保存前返回 `pendingIndications` 或带 `indicationBasis`/`ruleId` 的 `indication-alert` 提示卡（不修改开单成功响应）。此外，Agent 起草授权结果在任务就绪处于“缺次要项”档时携带 `readinessAnnotations`。提示卡合同：床旁缺项只在住院出现，床旁问卷状态同时按包返回 `packMissing`（门诊恒为空，首份已签 12 导联心电图已有 ST 结论时 ST 项不计缺项）；排雷清单卡返回逐项 `ruleOutItems`（未开立、已开立、已出结果，含排查目的、结果文字、依据事实与检查项目代码）；风险标签只挂在同包提示卡的 `riskTags` 上，不为 `encounter-open` 单独成卡，组套风险卡以 `attachTargets` 标明对应药品类别与目录项；退出摘要为固定短句，完整原因在 `detail`；专病包运行时条目除 `matchedTriggerIds`、`matchedInapplicableIds` 外，另以 `matchedTriggers`、`matchedInapplicables` 返回每个命中条件的说明与依据事实版本引用，不适用人群卡带同一批引用。
3. **跨时间表型匹配与非阻断识别包**：新增纯数据 `recognition` 专病包 `familial-hypercholesterolemia` 与确定性跨时间表型匹配器，在 `ClinicalPromptCardService` 的 `encounter-open` 与 `report-arrived` 时机将多年份异常事实投影为非阻断 `phenotype-candidate` 与 `recognition` 提示卡（零模型调用），当患者存在继发性高脂血症等不适用诊断时自动抑制。同包已有识别卡时，表型候选卡的依据事实、建议检查与跨时间线索并入识别卡，不再另出一条候选卡。
4. **纯机器考卷门禁、五层失败归因与标准化报告**：新增 `@clinmesh/contracts/disease-pack-exam`、`@clinmesh/core/disease-pack-exam` 与 `DiseasePackExamService`，通过管理员 HTTP（`POST /api/his/v1/admin/disease-packs/exam/run` 与 `/activate`）和 CLI（`clinmesh admin disease-packs exam-run` / `activate`）运行各包六类考题（含轻症多查同等扣分）及七类公共陷阱，失败按五层（`data-normalization`、`terminology-mapping`、`knowledge`、`agent-safety`、`workflow`）归因并以 `409 DSAP_EXAM_GATE_FAILED` 阻断启用；通过完整字段夹具包 `synthetic-test-syndrome-pack`（仅在显式加载目录时评测、普通运行时不启用）与全格式契约校验确证扩展点完整性。
5. **独立追加糖尿病包与 CI 静态防硬编码守卫**：在独立隔离变更中仅新增 `apps/server/disease-packs/t2dm-renal-care/` 并移除 `apps/server/src/application/guideline-topic-registry.ts` 中最后一条写死专题定义，确证“无冠心病仅 2 型糖尿病肾病”激活、共病双包并排展示（带来源包和风险标签、不自动取舍）与黄金基准零差异；同时新增 `scripts/verify-no-hardcoded-pack-ids.ts` 接入 `scripts/verify-package-boundaries.ts`，在 CI 边界检查期拦截非测试生产源码中任何专病包与专题标识硬编码。

## Alternatives considered

- **在服务层继续维护专题或病种特例映射并在加糖尿病包时顺带增加专属 FHIR/Prompt 适配**：会掩盖“加包必须改平台”的耦合问题，破坏后续多专病并发扩展；坚持将 `t2dm-renal-care` 的合入提交严格隔离为“纯数据目录 + 删除旧注册表硬编码行”两处变更并用回归测试和静态扫描锁定，才能长期保住零平台改动承诺。
- **将 Agent 输出评分器结果直接纳入专病包启用关卡**：模型辅助文书草拟存在主观波动，将其混入基础规则启停门禁会导致确定性能力被模型噪声阻断；保持考卷启用关卡仅考核机器确定性部分并保持 `llmInvocationCount === 0`，主观评分单独产出报告。

## Consequences

ClinMesh 一期已完成向“平台通用能力 + 医院基线层 + 纯数据可插拔专病包”架构的完整过渡：现有 `coronary-cad`、`familial-hypercholesterolemia` 与 `t2dm-renal-care` 均无一硬编码出现在非测试生产源码中，由 `pnpm verify:boundaries` 持续守护，新增专病包经机器考卷与七类公共陷阱门禁校验即可接入并在多病共存时并排输出受审计提示卡；相关契约说明见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)与[仿真、病例与素材](../../../architecture/simulation.md)。
