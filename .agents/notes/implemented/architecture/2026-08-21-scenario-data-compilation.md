# Agent Note: Scenario 数据编译与参考数据接入

Status: implemented

## Problem

Synthea 能提供纵向合成病史，但其 FHIR R4 产物包含美国地址、机构、付款方和标识语义，也不包含中国公立医院目录、患者认知、问诊应答、检查费用或仿真揭示规则。直接安装原始 Bundle 会把来源模型误当成 ClinMesh 运行事实；由各业务模块分别补数据又会使患者、诊断、检查、处方、库存和 reset 快照互相矛盾。本决策由 [issue 39](https://github.com/CaiZongyuan/clinmesh/issues/39) 交付，并延续[场景数据集与安装快照分离](./2026-08-26-scenario-dataset-and-package.md)和[可选 Synthea 生成 Provider](./2026-08-26-optional-synthea-provider.md)的边界。

## Decision

`compileSyntheaR4Bundle` 是来源病史进入 Scenario Dataset 的编译边界。它先以严格运行时 schema 验证单患者 R4 collection Bundle，只转换 Patient、Encounter、Condition、Observation、MedicationRequest 和 AllergyIntolerance 白名单事实。Organization、Coverage 和其他美国运行语义不进入 CaseTruth；患者姓名、标识、医院和目录由固定 seed 下的 ClinMesh 合成规则重建。未映射代码保留来源键并产生诊断，不能通过模糊文本匹配静默伪造目标编码。

CaseTruth 使用 `scenarioDatasetContentSchema` 作为持久合同。每名患者包含复现元数据、虚构身份、纵向病史、最小 R5 历史表示、本次就诊、人设、患者认知、症状应答、查体、生理生成器、三级检查来源、诊断空间、处置空间和费用基准。患者认知与客观真值分开保存；`passive`、否认项、回避项和第二次追问后让步是结构化字段，不依赖 prompt 约定。检查行保存结果、报告、TAT、费用和危急值标记；Hospital Baseline 保存虚构医院、科室、诊断、检查、药品和库存目录。

Hospital Baseline 的字段形状参考 OpenHIS 的中国医院目录关系和状态语义，但不复制其 seed、生产配置、凭证、患者数据或 PostgreSQL 物理模型。检查目录显式记录本院是否开展、适应证、过敏禁忌、参考区间、正常分布、TAT 和价格。药品目录显式记录剂型、给药途径、剂量、频次、适应诊断、疗程、数量、联用约束和库存批次，使安装转换不需要从中文处置文本猜测工作流规则。

Dataset 更新后由 `validateScenarioDataset` 重新生成稳定诊断。未映射代码是 warning；悬空患者、就诊、目录、Hidden Fact、药品适应诊断或联用引用，以及时间倒置、费用范围倒置、非法血压和检查结果冲突是 error。管理员可以继续保存带诊断的 Dataset；任何 error 都阻止安装。

`resolveScenarioInvestigation` 是活动 Package 检查结果的共享运行时边界。它按 L1 CaseTruth 精确结果、L2 患者生理生成器或派生链、L3 正常域确定性采样的顺序解析叶子项目；检查组合只通过显式 `componentItemIds` 递归展开。BMI、CKD-EPI 2021 eGFR、RBC/MCV/HCT 和血糖/尿糖使用受控公式及命名依赖，Validator 在安装前拒绝检查组合环、生理依赖环和悬空引用。相同 Scenario Run、患者、项目与复测序号得到相同结果；复测只在生理叶子上增加截断到三倍标准差的 assay CV 噪声。L3 记录 `unmodeled_item`，限制在正常域且不产生危急值。

活动 Package 的检查申请继续使用现有 Laboratory Request、LIS outbox 和报告生命周期。resolver 在签发事务中同时提供结构化或定性结果、报告、TAT、费用、危急值和一致性诊断；Observation、DiagnosticReport 扩展、Provenance 与申请终态一起提交。任一组件无法解析时整个事务回滚，不留下部分 Specimen、Observation 或 DiagnosticReport。已报告项目可以复测，唯一索引只阻止 `issued`、`accepted` 和 `in-progress` 的同项目并发申请；旧内置 Scenario 继续读取原 Hidden Fact。

安装仍由共享 `ScenarioService` 执行。不可变 Package 中的患者认知、症状和生命体征进入现有 Virtual Patient；白名单病史进入 FHIR R5 Repository；医院目录进入现有门诊、诊断和库存表，并生成 Medication 与 InventoryItem 投影。通用挂号目录由运行时保留。管理员 Web 工作台以 TanStack Query 拥有服务端状态，并提供患者与就诊、问诊应答、查体与检查、诊断与处置、目录与库存、Hidden Fact 与 Reveal Policy 的结构化编辑，不暴露通用 JSON 编辑器。

## Alternatives considered

**直接安装 Synthea FHIR Bundle。** 这种方式保留最长的来源病史，但会把 R4、美国机构和付款方语义带入 R5 中国医院运行时，也不能提供共享问诊真值、目录、费用和库存规则。

**把完整 OpenHIS seed 或数据库模型复制进 ClinMesh。** 这种方式能快速获得大量目录字段，却会混入生产配置和外部协议假设，并把 PostgreSQL 物理模型耦合到当前 SQLite 模块化单体。

**让各岗位页面在缺字段时随机补值。** 这种方式局部实现简单，但同一患者在问诊、检查、诊断、收费和库存中的事实无法对齐，固定 seed 和 Package reset 也不再可验证。

**让 LLM 直接生成临床数值和完整 CaseTruth。** 这种方式文本丰富，但无法稳定验证剂量、金额、引用、时间和病理一致性。LLM 因此不拥有结构化真值；未来若用于叙述，只能口语化已经授权的事实。

## Consequences

新增来源资源或映射必须扩展编译器白名单、运行时 schema、诊断和安装投影，不能以类型断言声称完整 R4/R5 兼容。FHIR 历史表示保持最小且只声明实际安装的资源。

CaseTruth 和 Hospital Baseline 是 Dataset 与 Package 的持久格式。字段变化需要显式迁移，并验证旧 Package reset；不能重新调用 Synthea 或当前编译器来重建已安装快照。

OpenHIS 和外部参考材料只校准字段、关系与状态。`references/` 保持只读，真实患者、真实机构目录、医保或支付凭证和来源受限数据不能进入生成产物或仓库。

三级检查运行时只解析活动 Package 声明的目录、CaseTruth 和生理生成器，不从显示文本猜测公式或项目组合。新增公式、结果类型或组合语义必须同时扩展持久 schema、Validator、共享 resolver、FHIR 投影和固定 worked example；不能在 Web、HTTP adapter 或 LIS consumer 中各自补随机值。
