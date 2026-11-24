# CPG-on-FHIR、CDS Hooks、CardX、mCODE 与专病包的对齐调研

核验日期：2026-11-24；证据范围：HL7 官方 IG 页面（hl7.org、cds-hooks.hl7.org）与 build.fhir.org 的公开页面，经网页抓取与摘要读取。未下载 IG 包，未逐个核对 Profile 的 differential；标“未核实”的条目没有取得一手页面证据。

目标架构见[标准化专病智能体平台目标架构](../decisions/proposed/architecture/2026-11-24-disease-specific-agent-platform.md)，调研依据见[国内外专病智能体调研](2026-11-17-disease-specific-agents-survey.md)。

## 1. HL7 CPG-on-FHIR

**版本与 FHIR 基线（事实）**

- 当前发布版为 2.0.0（STU2），页面标注 Active as of 2024-11-26，包名 `hl7.fhir.uv.cpg#2.0.0`。来源：https://hl7.org/fhir/uv/cpg/
- 基于 FHIR R4（4.0.1），页面说明可在 R4B 系统中不改动使用，并提供 R4 与 R4B 两个包。来源：https://hl7.org/fhir/uv/cpg/ 、https://hl7.org/fhir/uv/cpg/downloads.html
- 下载页与变更页（https://hl7.org/fhir/uv/cpg/changes.html）都没有提到 R5。对 2025 年 R5 版 CPG 的搜索没有找到任何一手页面。结论：截至核验日没有已发布的 R5 版 CPG；R5 版是否在 build.fhir.org 另有分支，未核实（`build.fhir.org/ig/HL7/cpg/` 返回 404；搜索结果中出现的 `build.fhir.org/ig/HL7/cqf-recommendations` 疑为其持续构建，内容未核实）。

**用哪些资源表达指南知识（事实，来源：https://hl7.org/fhir/uv/cpg/profiles.html 、https://hl7.org/fhir/uv/cpg/StructureDefinition-cpg-computableplandefinition.html ）**

- 制品类 Profile：CPGComputablePlanDefinition、CPGComputableActivity、CPGComputableQuestionnaire、CPGComputableGraphDefinition、CPGCaseFeatureDefinition（StructureDefinition）等，另有 Shareable 与 Publishable 两类通用约束。
- PlanDefinition 是核心载体。`type` 取 order-set、clinical-protocol、eca-rule、workflow-definition；`action` 带 `trigger`、`condition`（applicability／start／stop）、`definition[x]`（指向 ActivityDefinition、PlanDefinition 或 Questionnaire）、`dynamicValue`、`documentation`（RelatedArtifact）；`library` 指向存放逻辑的 Library（通常是 CQL）。
- 推荐等级：PlanDefinition.action 上有 strengthOfRecommendation、directionOfRecommendation、qualityOfEvidence、rating 四个扩展。
- 领域层：CPGPathwayDefinition、CPGStrategyDefinition、CPGRecommendationDefinition、CPGCase、CPGCarePlan，以及一批以 Task 承载的活动（CPGProposeDiagnosisTask、CPGRecordDetectedIssueTask、CPGRecordInferenceTask、CPGReportFlagTask、CPGQuestionnaireTask、CPGGenerateReportTask 等）。
- 数据与度量：CPGComputableMetric、CPGMetricReport（MeasureReport）；页面写 Metric，基底是否为 Measure 未核实。
- 表示层级 L1–L4（叙述 → 半结构化 → 结构化可执行 → 机构实施）和三档落地深度（叙述消息、可执行请求、流程集成）在 https://hl7.org/fhir/uv/cpg/methodology.html 说明。

**与 CDS Hooks 的关系（事实）**

- CPG 不规定用 CDS Hooks 投递。方法页只把 CDS Hooks 列为“可选的标准机制”之一：在“可执行请求”档，只规定到 request 资源层，示例是 CDS Hooks 请求；另提到 CQF Ruler 可把 L3 内容的求值能力暴露为 CDS Hooks 服务。来源：https://hl7.org/fhir/uv/cpg/methodology.html
- 变更日志显示 2.0.0 删除了 cpg-indicator 值集，改用 THO 的 cdshooks-indicator，并注明“应放进 Using CDS Hooks IG”（FHIR-44234、FHIR-44240）。来源：https://hl7.org/fhir/uv/cpg/changes.html
- `PlanDefinition/$apply` 是 CPG 对“应用知识”的主要运算，结果是建议活动的集合，由调用方决定是否执行；其 `prefetchData` 与 CDS Hooks 的 prefetch 命名对应。来源：https://hl7.org/fhir/uv/cpg/OperationDefinition-cpg-plandefinition-apply.html（经搜索摘要，未逐字读全）。

**我们的包各部分能否映射到 CPG（推断，按上述 Profile 的字段含义对照）**

| 包内容 | CPG 对应 | 评价 |
| --- | --- | --- |
| 触发条件 | PlanDefinition.action.trigger（事件）与 condition(applicability)；CQL 表达式 | 自然，但 CPG 的条件靠 CQL，而我们要求结构化条件可被考题直接判对错，需要决定条件 DSL 是否可无损翻成 CQL |
| 诊疗阶段 | CPGPathwayDefinition 或嵌套 action，用 start／stop condition 表示阶段进出 | 自然 |
| 知识主张（带原文锚点、适用条件、审核状态） | CPGRecommendationDefinition + RelatedArtifact（引用、页码）+ 推荐等级扩展 | 自然；原文 SHA-256、页码片段、逐条停用需用扩展或 Provenance 补 |
| 专题页 | Composition／Citation／RelatedArtifact 之类的文档资源 | 无专门 Profile，未核实有无推荐用法 |
| 组套 | PlanDefinition type=order-set + ActivityDefinition | 自然；我们的“档位与解锁条件”可用嵌套 action 与 condition 表达，但约定需自定 |
| 排雷清单、退出条件 | PlanDefinition 的 condition 与 CPGRecordDetectedIssueTask／CPGReportFlagTask | 可映射，语义较松 |
| 问卷题 | Questionnaire（CPGComputableQuestionnaire）+ CPGQuestionnaireTask | 自然 |
| 打钩量表 | Questionnaire + CQL 计分，或 Library | 可映射；公式库按版本引用在 CPG 中对应 Library 的 canonical 版本引用 |
| 质控收紧项 | 无直接对应；可用 PlanDefinition 条件 + DetectedIssue 任务近似 | 无自然对应 |
| 不适用人群 | applicability condition 或 Group（CPGGroupDefinition） | 可映射 |
| 易混淆病、风险标签 | 无直接对应 | 无自然对应 |
| 工具白名单与禁止动作 | 无；CPG 面向临床活动而非 Agent 工具 | 无对应 |
| 考卷 | 无；CPG 的验证靠测试用例与示例，不定义考卷 | 无对应 |
| 说明书、版本与指纹 | Shareable／Publishable 元数据（version、status、publisher）| 自然 |
| 三层叠加（公共 → 病种 → 医院，“只收紧”） | CRMI 的衍生与依赖（relatedArtifact depends-on／derived-from）| 有机制但无“只收紧”的语义，需自定 |

**两条路线的代价（推断）**

- 内部自定义格式 + 可导出为 CPG：内部结构按我们的需要定（Agent 工具白名单、考卷、质控收紧、阶梯解锁都能一等表达）；代价是写并维护一个导出器，且导出只能覆盖上表中“自然”的部分，其余用扩展或丢弃。符合目标架构 L5“结论只影响导出格式，不改变包的内部结构”。
- 直接采用 CPG 结构：可复用 CPG 工具链和 CRMI 打包；代价有四项。基线是 R4，而平台固定 R5（`AGENTS.md`）；CQL 引擎要引入，与“包不含代码、只靠 schema 校验”相冲突；无对应的内容（白名单、考卷、质控收紧、风险标签、易混淆病）要全部走扩展，格式会变成“CPG 外壳加大量私有扩展”；加载校验需要完整 FHIR 校验链，而不是 JSON Schema。

## 2. CDS Hooks

**版本与成熟度（事实）**

- 当前发布版为 2.0.1（STU 2 Release 2），标注 Trial-use，页面写明是当前发布版。来源：https://cds-hooks.hl7.org/ 。发布日期未在页面上取得，未核实。
- Hook 库及成熟度（0 草稿至 6 规范）。来源：https://cds-hooks.hl7.org/ 和 https://cds-hooks.hl7.org/hooks/index.html

| Hook | 成熟度 |
| --- | --- |
| patient-view | 5（成熟） |
| order-sign | 5（成熟） |
| order-select | 4（已文档化） |
| encounter-start、encounter-discharge、appointment-book | 1（已提交） |
| allergyintolerance-create、problem-list-item-create、medication-refill | 1（已提交） |
| order-dispatch | 0（草稿） |
| medication-prescribe、order-review | 已弃用 |

- 含义（推断）：只有 patient-view 与 order-sign 称得上稳定，order-select 次之；encounter-start、encounter-discharge 仍是早期提交。目标架构 L6 的“打开病历、勾选医嘱草稿”对应前三者，没有问题；若“四个质控关口”要借名 encounter-discharge，需知其成熟度只有 1，字段随时可能变，我们只借名称与卡片格式，风险可控。

**Card 字段（事实，来源：https://cds-hooks.hl7.org/2.0/ ）**

- Card：`summary`（必填，140 字内）、`indicator`（必填，info／warning／critical）、`source`（必填，其中 `label` 必填，`url`、`icon`、`topic` 可选）、`detail`（可选，Markdown）、`uuid`（可选，反馈时需回传）、`suggestions`（可选）、`selectionBehavior`（有 suggestions 时必填，at-most-one 或 any）、`overrideReasons`（可选，Coding 数组，须含 display）、`links`（可选）。
- Suggestion：`label`（必填）、`uuid`、`isRecommended`、`actions`（多个动作按事务规则：先删、再建、后改）。
- Action：`type`（create／update／delete）、`description` 必填，`resource` 或 `resourceId` 视类型而定。
- 响应顶层另有 `systemActions`（可选）：不展示给用户、客户端可自动应用。
- Feedback：`outcome`（accepted／overridden）、`acceptedSuggestions`、`overrideReason.reason` 与 `userComment`、`outcomeTimestamp`。
- 对我们的影响（推断）：
  - 卡片的“依据、来源包与版本、风险标签、投递模式、依据事实版本”在标准里没有字段。可放进 `source.topic` 或自定扩展，我们自己的卡片合同需要明确这些扩展字段，并注明“借用格式，非完整兼容”。
  - `systemActions` 与我们的“不允许系统自动写入”冲突，应明确不使用。
  - `suggestions.actions.resource` 要求完整 FHIR 资源；我们的草稿动作走共享 Command，需要决定卡里放 FHIR 草稿资源还是放 Command 引用。
  - 标准的 `overrideReasons` 与 feedback 恰好对应目标架构“否决理由汇总”，可直接借用。
- FHIR 版本：规范页没有写明支持 R5，也没有 `fhirVersion` 字段的说明（页面只要求“上下文中的 FHIR 资源须同一版本”）。能否直接装载 R5 资源：未核实。我们不对外提供服务，无影响。

## 3. CardX

**当前有哪些 IG（事实）**

- CardX Hypertension Management：1.0.0（STU1），基于 R4（4.0.1），为当前发布版。页面日期显示 2024-12-12。来源：https://www.hl7.org/fhir/uv/cardx-htn-mng/
- CardX Cardiac Implantable Electronic Devices（CIED）：已看到 1.0.0-ballot（STU 1 Ballot 1，生成日 2025-07-31），基于 R5（5.0.0），页面提示 1.0.0 将取代它；搜索结果另显示一个标注 2.0.0 的构建页，版本关系未核实。来源：https://hl7.org/fhir/uv/cardx-cied/2025Sep/index.html
- CardX 用例 IG（`build.fhir.org/ig/HL7/cardx-ig`）是 0.1.0 持续构建，版本为 R4，非正式发布，用例章节留有“TO DO”，目标是统一高血压词汇（人口学、生命体征、诊断、评估、检验、用药、照护计划）。来源：https://build.fhir.org/ig/HL7/cardx-ig
- 血脂、心衰、心血管风险等 CardX IG：本次检索没有找到，视为未核实，不能当作存在。

**数据元素（事实）**

- HTN IG 只定义三个 Profile：自测血压（SMBP，派生自 R4 血压 Profile）、平均自测血压（派生自 Observation）、SMBP 伴随心率（派生自心率 Profile）。要点：必须用血压 LOINC 码与 UCUM 单位；执行者为患者，经设备网关或个人健康中介；平均值带测量方案的时间窗；患者来源的资料打 `meta.tag = patient-supplied`。来源同上。
- Must Support 清单、扩展与值集：页面未列，未核实。
- CIED 页面未列出 Profile 与数据元素，未核实。

**对冠心病包“核心指标清单”可参考的元素（推断与建议）**

- 可直接参考：血压须区分诊室测量与自测、自测均值要带方案与时间窗、来源标记（患者提供与机构测量）。这三点与我们总账“本院／外院”“方法不同的同类项目不合并成一个值”一致。
- 不能从 CardX 取得：LDL、心血管风险评分等元素。现有 CardX 发布内容没有覆盖，冠心病核心指标仍需靠指南原文与现有 ClinMesh 评分定义。
- 建议：CardX 只作为血压元素的参考，不做为“冠心病核心指标”的主来源。

## 4. mCODE

**版本（事实，来源：https://hl7.org/fhir/us/mcode/ ）**

- 4.0.0（STU 4），Active as of 2025-02-16，基于 FHIR R4（4.0.1）。
- 页面把内容分为六组，称仅为教学用的分组：Patient Information、Disease Characterization、Health Assessment、Genomics、Cancer Treatments、Outcomes。

**Profile（事实，来源：https://hl7.org/fhir/us/mcode/profiles.html ）**

- 已发布 25 个，草稿 9 个。与乳腺癌相关的有：PrimaryCancerCondition、CancerStage、TNMStageGroup 与 TNM 三类别、TumorMarkerTest、TumorSize、CancerDiseaseStatus、ECOGPerformanceStatus、GenomicsReport、GenomicVariant、CancerRelatedSurgicalProcedure、CancerRelatedMedicationRequest、RadiotherapyCourseSummary、HumanSpecimen、Comorbidities。
- ER、PR、HER2 没有专门的 Profile；页面只有通用的 TumorMarkerTest，具体受体如何用它表达，需查单个 Profile 页（未核实）。Oncotype 类检测同样没有专门 Profile。
- 组织学分级（HistologicGrade）与形态学（TumorMorphology）仍是草稿（成熟度 0）。

**对二期乳腺癌核心指标的要点（建议）**

- 可参考元素：原发灶诊断、分期（TNM 与分期分组）、肿瘤大小、受体与肿瘤标志物检验、体能状态（ECOG）、基因报告、手术／药物／放疗、疾病状态（疗效评价）。
- 受体状态和组织学分级这两个乳腺癌最核心的元素，mCODE 覆盖较弱，二期需按指南与国内病理报告规范自定。

## 5. 与 FHIR R5 的兼容性

- 事实：CPG 2.0.0、CardX HTN 1.0.0、mCODE 4.0.0 都基于 R4（4.0.1）；CardX CIED 的 ballot 版基于 R5。CPG 页面只声明 R4B 可用，没有 R5 声明。
- 事实：R4 到 R5 有破坏性变化。本次没有逐条核对这些变化与这三个 IG 用到的资源的交叉点；FHIR 官方有 R4→R5 的跨版本分析页，可作为后续核对入口，本次未读取，未核实。
- 推断：R4 Profile 不能直接作为 R5 系统的 Profile 使用——StructureDefinition 的基类版本不同，校验器会报版本不一致；CPG 的 PlanDefinition、Library 等，在 R5 中字段名与取值集有变动，直接搬用需要转换。
- 建议：对 R5 系统，把这些 IG 当作“元素清单与术语选择的参考”，不当作可直接加载的 Profile。这与目标架构 L3“mCODE、CardX 基于 FHIR R4，只参考其中的数据元素清单，不引入 R4 Profile”一致。导出为 CPG 时，也要明确导出目标版本为 R4／R4B。

## 6. 对专病包格式的建议

**推荐方案（建议）**：内部自定义格式，不直接采用 CPG 结构；预留“导出为 CPG-on-FHIR R4（或 R4B）”的导出器位置，导出只覆盖能自然映射的部分（触发条件、阶段、知识主张、组套、问卷、量表、元数据），不能映射的部分（工具白名单、禁止动作、考卷、质控收紧、风险标签、易混淆病、三层叠加的“只收紧”语义）不导出或走命名空间扩展。

**理由**

1. 目标架构要求包不含代码、仅靠 schema 校验；CPG 的逻辑靠 CQL Library，直接采用会引入表达式引擎。
2. 平台固定 R5，而 CPG 只有 R4／R4B，直接采用要么降版本，要么自行迁移。
3. 包里近一半内容（白名单、禁止动作、考卷、质控收紧、风险标签、易混淆、三层只收紧）在 CPG 里没有对应；强行入 CPG 等于“外壳加私有扩展”，互操作收益很低。
4. 目前没有外部消费方，内部格式晚点再导出不会破坏已有数据；而 CPG 的 R5 版尚不存在，现在对齐是追一个会变的目标。
5. 借鉴点值得保留：知识主张字段按 CPG 的 Recommendation 概念命名（推荐方向、强度、证据质量、引用）；阶段用“start／stop condition”的语义；公式库引用沿用“带版本的 canonical”思路。这样将来导出是改写格式而不是重新设计。

**需要改目标架构 Note 的位置（建议，若采纳）**

1. L5“CPG-on-FHIR 对齐【预留：待调研】”一节：把状态从“待调研”改为“预留：已调研，结论为内部格式加导出”，写明导出目标是 R4／R4B 的 CPG 2.0.0，覆盖范围与不覆盖范围见本调研，并保留“不改变包的内部结构”。
2. L6“时机与提示卡”：补充卡片字段合同——哪些字段沿用 CDS Hooks（`summary`、`indicator`、`source`、`suggestions`、`overrideReasons`），哪些是自定扩展（依据事实版本、包与知识版本、风险标签、投递模式），并明确不使用 `systemActions`。同时在 L6 或 Alternatives 中注明 encounter-start、encounter-discharge 成熟度仅为 1，只借名称。
3. L3“标准术语库”一条：mCODE、CardX 的描述补上版本与 FHIR 基线（mCODE 4.0.0 R4、CardX HTN 1.0.0 R4），并注明乳腺癌受体与分级在 mCODE 中覆盖弱，二期需自定。
4. Alternatives considered“对外提供完整的 CDS Hooks 服务”一条：补充 CPG 并不规定用 CDS Hooks 投递（只是可选机制），对外服务与 CPG 导出相互独立评估。
5. 调研文档逐节归属表的 5.1 行：“L5 CPG 对齐（预留：待调研）”同步改为已调研。

**未核实事项**

- CPG 是否存在 R5 的持续构建分支，以及 `cqf-recommendations` 与 CPG 的关系。
- CPG Library／Metric 的具体基底和“专题页”类内容的推荐表示。
- CDS Hooks 2.0.1 的发布日期、对 R5 资源的支持。
- CardX CIED 的最终发布版本号；CardX 血脂、心衰、风险类 IG 是否存在；CardX HTN 的 Must Support 清单。
- mCODE 受体（ER／PR／HER2）具体如何用 TumorMarkerTest 表达。
- R4 到 R5 对上述 IG 所用资源的具体破坏性变化。
