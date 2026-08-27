# 参考数据映射与场景编译系统研究

## 范围与结论

本文调查是否存在与“多源参考数据 -> 显式映射 -> 本地医院目录和病例 -> 可复现运行包”相同的外部系统。证据来自截至 2026-08-28 可核验的论文、官方文档和固定 commit 源码；它们是设计输入，不定义 ClinMesh 当前行为。ClinMesh 的数据来源与分层建议仍由[合成医院数据来源研究](./synthetic-hospital-data-sources.md)维护，病例真值、揭示和运行留痕由[虚拟患者与病例创作系统研究](./virtual-patient-and-case-authoring-systems.md)维护。

核验范围内没有完整相似的外部实现。最接近的系统各自只覆盖一段：OHDSI 和 Open Concept Lab 解决标准化映射与版本发布，CohGenT 解决独立术语库辅助的版本化合成病例配置，Synthea 解决可组合病种状态图与代码清单，EHRGym 解决小型本地目录和病例重置，PhysicianBench 与 HealthAdminBench 解决冻结环境和最终状态验收，HealthAgentBench 解决固定输入、隔离构建和隐藏验证器。OpenHIS 和 Medplum 分别提供医院业务目录与通用 FHIR/术语基础设施，但也没有把全部环节编译成不可变、可重放的医院运行包。

因此，#42 不能以“某个成熟项目已有同款架构”为依据。可复用的是各项目已经验证的局部机制；仍需 ClinMesh 自己定义的是本院启用范围、可执行属性、病例一致性和旧运行冻结方式。

## 判定标准

只有同时满足以下四项才算完整相似：

1. 从两个或以上有独立版本和许可边界的参考来源取得数据。
2. 以可审计的 source-to-target 关系转换代码或概念，且未知、近似、一对多和失效映射不会静默通过。
3. 形成某个具体医院可查询、可开立、可计费或可执行的本地目录，并由病例实际引用。
4. 固定患者、目录、映射、病例规则、编译器和验证器的版本或内容哈希，安装后不依赖上游即可重置和重放。

仅有 FHIR 资源、术语服务器、合成患者、病例文件、Docker 镜像或测试任务中的任意一项，不足以构成完整相似。

## 系统分类

| 分类 | 系统 | 已证明的机制 | 缺失环节 |
| --- | --- | --- | --- |
| 完整相似 | 无 | 无被核验系统同时覆盖四项判定标准 | 不适用 |
| 部分相似 | OHDSI ETL-Synthea | Synthea CSV 与 OMOP Vocabulary 分开装载，通过 `concept_relationship` 和 `source_to_concept_map` 建 source-to-standard 表，再输出含事件与词表的 SQLite 数据库 | 目标是分析型 OMOP 数据，不是本院可开立目录；没有医院价格、库存、病例真值或运行状态机 |
| 部分相似 | Open Concept Lab | Source、Collection、Concept、Mapping 和 release 独立版本化；Mapping 保存来源/目标 source version 和关系类型，发布版本可生成快照、checksum、diff 和导出 | 不决定医院启用什么，也不提供病例、价格、库存或运行包 |
| 部分相似 | CDC CohGenT | 独立 OMOP/Athena 术语库保存多词表概念和关系；版本化 Use Case、可复用 FHIR entity template、用户选择的代码、时间线和 seed 共同生成 FHIR-shaped 合成病例 | 没有中国词表、本院目录、映射审核、业务状态机、不可变依赖闭包或长期 reset 合同 |
| 部分相似 | Synthea | 可组合病种状态图、共享子模块、标准编码清单、固定 seed 和缺失映射统计 | 不是医院目录；映射按裸 code 且允许带权随机目标，不满足中国正式对码和运行目录要求 |
| 部分相似 | EHRGym | 受约束的诊断、问题和医嘱目录与 25 个手工病例共同进入 SQLite reset；任务文件声明患者、医嘱、病历要点和评分，并保存运行轨迹 | 目录直接手工编写，没有参考目录导入、显式对码、版本化发布或目录依赖哈希 |
| 部分相似 | PhysicianBench | 100 个任务共享一个预载 FHIR 数据镜像；每项任务启动全新容器并用 670 个 checkpoint 验证真实查询和写入结果 | 镜像构建和全局映射不在源码中；病例测试仍大量手写名称别名和编码，且没有 HIS 收费、库存与审核状态机 |
| 部分相似 | HealthAdminBench | 合成医疗行政环境、任务 JSON 和确定性最终状态断言；每次运行清理状态并记录步骤、时间和 token | 临床数据在任务和前端常量中重复，已出现漂移；没有共享参考目录或病例 compiler |
| 部分相似 | HealthAgentBench | 固定上游源码和数据版本，确定性 ETL 或病种切片，容器化任务，隔离 gold/verifier，并按规范化内容哈希验证输出 | 没有本院可开立目录、价格、库存、病例真值或 HIS 状态；部分上游下载未校验已下载的 checksum 文件 |
| 部分相似 | MedBiquitous Virtual Patient / OLab | 患者资料、证据揭示、活动图、导出包和运行轨迹分层 | 没有参考目录映射和真实医院目录；核验源码未证明发布后不可变且运行固定 revision |
| 部分相似 | [OpenHIS ITAI Pro 研究](./openhis-itai-pro-architecture.md) | 本院诊断、药品、诊疗、价格和库存是一等业务对象，并有医保目录导入和人工对码工作台 | 映射主要维护当前业务状态，不提供患者素材、病例编译或旧场景依赖冻结 |
| 部分相似 | [Medplum][medplum] | CodeSystem、ValueSet、ConceptMap、术语索引、导入、校验、展开和 `$translate` 提供通用术语基础设施 | 不提供中国参考内容、本院目录选择、合成病例或运行包 |
| 相邻但不能作为先例 | [MedAgentBench][medagentbench]、[AI Hospital][ai-hospital]、[AgentClinic][agentclinic]、[MedAgentSim][medagentsim] | 固定病例、FHIR 测试环境、患者/医生/检查 Agent、答案或 evaluator 可用于 Agent 评测 | 不处理参考数据到本院目录的映射，也没有病例编译依赖闭包；部分实现用名称模糊匹配或在缺失检查时生成“正常”结果 |
| 已筛查但不相关 | [AutoMedBench][automedbench]、[Camyla][camyla]、[simple-evals][simple-evals] | 医学自动研究、影像分割研究或对话 rubric 评测 | 不提供患者/HIS 运行环境、参考目录或多病种 compiler |
| 概念设计，不是实现证据 | `references/docs/Hospital_Agent_Platform_Design_v0.1.md` | 分别提出 Adapter mapping assets、三层模拟患者和 Scenario Package | 没有把参考目录、本院选择、映射版本、病例和安装快照连成已实现链路 |

## 最接近的局部机制

### OHDSI：显式映射和覆盖检查

[ETL-Synthea README][etl-synthea-readme]要求分别提供 Synthea CSV 与 Vocabulary CSV，并按顺序创建源表、装载词表、创建 mapping/roll-up 表和装载事件表。[source-to-standard SQL][etl-synthea-map]从 OMOP `concept_relationship` 的 `Maps to` 关系以及 `source_to_concept_map` 生成统一映射表，保留 source code、source vocabulary、source domain、target concept、target vocabulary 和有效状态。[SQLite export][etl-synthea-sqlite]又把事件表与 vocabulary 表一起导出为可携带数据库。

这证明“完整参考词表不必混入业务写库”和“编译前可以先物化可查询映射表”都是成熟做法。它不能直接回答 #42，因为 OMOP 标准概念是分析语义，不是某家医院能够开立、收费、执行和发药的目录；相同 Synthea code 成功映射到 OMOP 也不等于已经映射到中国药品产品或本院项目。

可复用机制是为每个输入 code 生成稳定覆盖结果：唯一可用映射、需要人工裁决的一对多或近似映射、允许保留来源编码、禁止安装的缺失映射。覆盖报告应面向病例和业务能力，而不是只统计映射表总行数。

### Open Concept Lab：映射本身也要发布

[OCL Mapping 模型][ocl-mapping]把 mapping 作为版本化资源，保存 `map_type`、来源和目标 concept、source URL 及 source version，并为内容建立 checksum。[OCL 通用版本模型][ocl-version]区分 HEAD、普通版本、released version 和 latest released version，Source/Collection 版本可生成 child snapshot、导出和版本 diff。[Collection 模型][ocl-collection]还固定被引用 Source/Collection 的具体版本并生成 expansion。

这比“本院表里多放一个外部 code 字段”更接近 #42：映射有自己的生命周期，目录发布可以固定映射版本，而不是永远读取当前 HEAD。OCL 仍然不判断哪种药能开、检验由哪个科室执行或一个病例是否医学一致；这些属于本院目录和病例 compiler。

可复用机制是把映射候选、审核通过的映射和已发布映射分开；发布版本记录来源与目标 release、方向、关系类型和内容 checksum。OCL 的通用数据模型可作为机制证据，但其软件许可证不授予其中每套术语内容的再分发权。

### CohGenT：参考库、病例模板和生成输入分开

[CohGenT README][cohgent-readme]把主应用数据库与可选 OMOP terminology database 分开，后者从 Athena 装载 ICD、LOINC、SNOMED、RxNorm、NDC 等词表，只用于 Concept Finder。[OMOP 模型][cohgent-omop]保留 vocabulary、domain、concept class、有效期、标准概念、概念关系和祖先关系；[terminology search][cohgent-search]按 system、domain、code/name 和有效状态分页查询概念。[Use Case 模型][cohgent-use-case]固定版本、FHIR 版本、FHIR entity template、可复用检验/操作/药品实体、引用和时间规则；[Cohort Settings][cohgent-settings]再保存作者选择的 `system + code + display`、患者分布、检验/操作事件组、药物组合、时间范围和 random seed。[官方用户指南][cohgent-guide]展示同一病种配置中组合 SNOMED 条件、LOINC 检验和 RxNorm 药物后生成 FHIR Bundle。

这是“多源标准数据辅助病例制作”的最接近实现，也直接证明完整词表可以位于独立数据库，普通生成服务在该库未配置时仍可运行。它没有 source-to-hospital mapping：作者选中 RxNorm 药物后，系统不会得到中国具体制剂、本院可开状态、价格或库存；选中 LOINC 后也不会得到本院检验组合、标本、参考区间、执行科室和报告时限。其[检验值 preset][cohgent-lab-presets]按 `system + code` 另行维护低、正常和高值域，说明标准概念与生成数值规则也不是同一个数据层。

可复用机制是让作者在受控搜索中明确选择编码，并把选择写入版本化结构输入；不可复用的是把搜索结果本身视为已审核映射或可执行医院项目。

### Synthea：多病种核心是可组合状态图，不是重复映射表

[Synthea module loader][synthea-module]扫描所有顶层病种模块并允许通过 `CallSubmodule` 复用共享子模块；[高血压模块][synthea-hypertension]把发病、诊断、随访、血压观察和用药调用写成版本控制内的状态图，诊断使用 SNOMED CT，观察使用 LOINC 与 UCUM，用药子模块使用 RxNorm。[Concepts 工具][synthea-concepts]遍历模块和子模块，输出每个 `system + code + display` 被哪些模块使用；这正是 #42 static inventory 应参考的机制。

[CodeMapper][synthea-codemapper]证明一个生成器可以合并多份 mapping、统计实际缺失次数并在固定随机源下选择多个候选目标。但它以裸 source code 为 key，允许带权随机选择正式目标，无法表达中国目录所需的 source version、审核状态和本院可执行性。ClinMesh 应借鉴模块依赖扫描和覆盖报告，不照搬其 mapping identity 与随机 promotion。

Synthea 还表明病种状态图和参考目录解决不同问题。病种图决定患者会发生什么；中国参考库和本院目录决定这些事件能否被当前医院解释、开立和执行。新增病种应组合共享病例模块并触发目录闭包编译，不能为每个病种复制一份映射表。

### EHRGym：目录规模由病例闭包产生

[EHRGym README][ehrgym-readme]定义 `patient + scenario + objective + scoring rubric` 的任务，SQLite reset 会重建患者、就诊、检验、病历、医嘱和 scenario ground truth。[reset 实现][ehrgym-reset]同时装载本地诊断、问题、医嘱和人员目录。[固定 commit 的诊断目录][ehrgym-diagnoses]只有 25 个场景诊断，[医嘱目录][ehrgym-orders]有 77 行非空数据且覆盖这些病例需要的检验、影像、药品、操作、会诊和护理项目；[DKA task][ehrgym-dka]只声明该病例实际需要的医嘱、病历要点和评分。[轨迹 manifest][ehrgym-manifest]记录 reset 请求、步骤文件和最终场景状态。

EHRGym 没有参考目录导入和映射治理，目录中还存在别名或重复项，也没有证明轨迹绑定了目录、seed、compiler 和应用的内容哈希，因此不是完整先例。它有力反驳了“麻雀虽小五脏俱全必须先规定几百个条目”的假设：可工作的最小环境先覆盖明确病例和操作，目录数量是需求闭包的结果，不是设计输入。

可复用机制是从每个病例声明的诊断、检查、检验、药品和操作反向计算目录闭包，并在 reset 时只安装该闭包与基础医院能力。背景搜索噪声和性能放大量应由独立 profile 添加，不能通过无用项目凑目录数量。

### PhysicianBench 与 HealthAdminBench：完整性由状态变化证明

[PhysicianBench README][physicianbench-readme]声明 100 个长流程任务、670 个 checkpoint 和 21 个专科，全部运行于同一个预载患者记录的 FHIR image；[runner][physicianbench-runner]为每项任务启动全新容器、执行 Agent、运行 pytest verifier 后销毁环境。[甲状腺任务 verifier][physicianbench-thyroid]不仅检查最终文本，还验证 Agent 实际查询了指定 LOINC 结果并创建了 ServiceRequest。这证明一个固定临床数据快照可以支撑许多病种，且病种验收必须观察真实状态变化。

PhysicianBench 没有公开该 FHIR image 的构建器和全局映射表，部分 verifier 还为同一医嘱手写多个名称别名和可选编码，因此不能回答 #42 如何生成目录。可复用的是“冻结初始状态 + 窄任务 + 独立状态断言”，不是其自由 FHIR 写入和任务级别名。

[HealthAdminBench README][healthadminbench-readme]以 135 个合成任务和 1,698 个可验证子步骤覆盖四个医疗行政环境；[任务文件][healthadminbench-task]使用确定性查询检查诊断、服务、外部提交和清单状态，而不是只判断页面或回答文本。其临床数据同时复制在前端常量和任务 JSON 中，固定源码已出现 metadata 与环境值不一致的漂移，反向证明 ClinMesh 的病例、目录和 verifier 必须从同一编译输入产生。

### HealthAgentBench：可复现任务包和隐藏验证器

[HealthAgentBench 论文 §3][healthagentbench-paper]说明任务来自经审核的数据源，每个任务封装为 terminal environment，gold 和 verifier 对 Agent 隔离，受限数据在用户取得授权后从原始来源下载。论文选择每个任务类别 5 至 15 个代表样本，而不是用固定总量表示“完整”。这支持以能力与失效模式覆盖定义规模，不支持固定的诊断、药品或服务条目配额。

对应源码的 [MIMIC-IV 到 MEDS Dockerfile][healthagentbench-docker]固定 `MIMIC_IV_MEDS` commit；[数据准备脚本][healthagentbench-stage]下载 MIMIC-IV demo v2.2 以及 LOINC、RxNorm 等显式 concept-map 文件；固定上游的 [event config][mimic-meds-map]把本地 item 映射为标准 parent code。[输出 verifier][healthagentbench-verify]检查配置语义、文件集合、行数和排序后的 canonical content hash。EHR event modelling 任务还会[按病种和时间切分事件][healthagentbench-slice]，并通过独立挂载让 raw cache、凭证和 test labels 不进入 Agent 可见环境。

这套机制适合 Scenario Package 的构建验证：固定工具链，受限数据不进仓库，运行包包含合法子集，隐藏事实只交给 verifier，最终用规范化内容而不是 ZIP 字节做稳定哈希。它没有本院目录、医院状态机和长期离线 reset，因此不能照搬为 #42 的完整数据模型。

源码还有一个需要修正后再借鉴的缺口：[数据准备脚本][healthagentbench-stage]下载了 `SHA256SUMS.txt`，但没有实际用它校验下载文件。#42 的来源 manifest 不能只保存 checksum 文件名，必须在导入时验证每个 artifact 的实际摘要。

### 虚拟患者系统：病例包不是医院运行包

[MedBiquitous Virtual Patient Data][medbiq-vpd]能表达人口学、问诊、查体、诊断、检验、药物和干预，[Data Availability Model][medbiq-dam]将具体病例资料绑定到立即、触发、延迟或请求后显示，[Activity Model][medbiq-activity]定义节点、链接、计时器和规则。OLab 在此类模型上增加作者图、包导出和用户轨迹，详见[病例创作系统研究](./virtual-patient-and-case-authoring-systems.md)。

这些系统证明病例真值、资料揭示、活动流程和运行轨迹需要分层，但其 orderable 不是医院真实 Clinical Request，其节点跳转也不是处方、收费、标本、报告和发药状态机。核验范围还没有证明导出包发布后不可变，并且每次运行固定到该 revision。

本地筛查的 AI Hospital、AgentClinic 和 MedAgentSim 更弱：它们把固定病例文本交给 Patient、Doctor 和 Measurement/Reporter LLM，不维护诊断、检验、药品和服务目录。AI Hospital 的 ICD 仅用于离线评分，先由 LLM 归一疾病名再做名称模糊匹配；AgentClinic 与 MedAgentSim 的 Measurement Agent 在病例未提供请求项目时返回正常结果。[AI Hospital 评测][ai-hospital-map] [AgentClinic 环境][agentclinic-runtime] [MedAgentSim 环境][medagentsim-runtime] 可借鉴的是患者可知信息与检查真值分离；模糊对码和缺项默认正常是 ClinMesh 必须禁止的反例。

## 真正的难点

### 映射难在语义层级，不难在批量导入

批量导入、索引、分页查询、SQLite 文件大小和固定输入哈希都有成熟实现。困难在于来源概念和目标对象经常不是同一种东西：RxNorm clinical drug、中国药品注册产品、本院药品目录和库存批次处于不同层级；LOINC observation、本院检验单项、组合医嘱、收费项和具体结果定义也不等价。只有一对一且语义等价的映射才能自动执行，其他关系必须显式保留方向、条件和裁决。

### 本院选择不是术语翻译

国家或国际目录只说明“存在什么标准项”，不说明某所医院实际开展什么。启用一个项目还需要科室、地点、可用状态、价格、报告或执行时限、处方规则、包装换算和库存策略。OCL、OHDSI、Medplum 和 CohGenT 都不会生成这些医院事实；OpenHIS 会维护这些事实，但不会替仿真医院选择合理集合。

### 病例一致性比目录总量更重要

病例引用的项目必须在本院目录中可开立，执行后必须产生与病例真值一致的结果，并沿真实业务状态变化。随机添加数百个未被病例或流程使用的目录行既不能增加临床完整性，也不能发现映射错误。每个 golden 病例的关键诊断、必要检查、实际用药和预期操作应达到 100% 可解析、可开立、可执行和可验证。

### 多病种的最小单位是需求闭包

一个病种应声明病例状态图、关键诊断、允许与必要检查、实际用药、服务和预期业务结果；共享 mapping 只维护一次。Compiler 递归扫描病种及其子模块后，应分别报告：来源 code 没有可信中国映射、已有中国映射但本院未启用、存在多个未裁决目标、允许仅保留来源历史，以及明确忽略的来源语义。前四类不能压成一个 `unmapped` 计数。

本院目录是选定病种与基础医院工作流需求的并集，再补齐检验组合成员、UCUM 单位、执行科室、药品产品、处方规则、价格和合成库存等传递依赖。这个闭包经过验证后冻结进 Scenario Package；它的条目数是编译结果和回归基线，不是事先拍定的完整性指标。

### 可复现需要冻结传递依赖

固定 Scenario 文件或 random seed 不够。只要患者素材、参考 release、映射、Hospital Baseline、compiler、schema、策略或应用版本中的任一项仍读取 latest，旧运行就可能漂移。HealthAgentBench 的内容哈希、OCL 的 release/checksum 和 EHRGym 的 reset 可以组合成机制，但没有一个外部系统替 ClinMesh 定义完整的传递依赖闭包。

## 对目录规模问题的证据结论

没有被核验论文或源码支持“400 个诊断、350 个药品、700 个服务”等固定配额。`references/docs/Hospital_Agent_Platform_Design_v0.1.md`只给出 20 至 50 个 golden patients、2,000 至 10,000 个 background patients 和 100,000 以上 load patients，并未给医院目录条目数；HealthAgentBench 按每类 5 至 15 个代表样本控制评测规模；EHRGym 则以 25 个场景反向形成 25 个诊断与 77 行非空医嘱目录数据。

更可验证的规模定义应分三类：

| 数据层 | 数量如何产生 | 验收依据 |
| --- | --- | --- |
| Golden 能力闭包 | 支持的病种、角色和端到端流程所需项目的并集，再加挂号、诊察、收费、退费等基础能力 | 每个关键病例 100% 映射并能跑完整业务闭环；没有占位项目 |
| Background 目录 | 为搜索、常见鉴别和医院环境提供的合法合成项目 | 按科室与类别覆盖、搜索干扰度和人工审阅结果验收，不冒充已实现能力 |
| Load profile | 从合法 schema 确定性放大的患者、事件、库存移动和目录查询负载 | 按数据库体积、并发、P95/P99、写放大和失败率验收，不计入临床内容完整性 |

如果 spec 仍需要数字，数字应由选定医院能力矩阵和病例清单经 compiler 生成并作为基线结果保存；新病种或流程使闭包增长时更新基线。性能目标另用可配置倍数扩容，不能改变 golden 目录或病例语义。

## 可复用的组合方案

以下组合来自外部机制证据，不表示 ClinMesh 已经实现：

```text
OCL-style versioned source/mapping/release/checksum
                     |
                     v
OHDSI-style materialized mapping and coverage report
                     |
                     v
CohGenT-style separate terminology DB and versioned author input
                     |
                     v
Synthea-style composable disease modules and dependency inventory
                     |
                     v
EHRGym-style case-required local catalog closure and reset seed
                     |
                     v
PhysicianBench/HealthAdminBench-style state assertions
                     |
                     v
HealthAgentBench-style isolated build, hidden verifier and canonical hash
```

这条链路中，AI 或相似度算法只能提出 mapping candidate。正式编译必须消费已审核 release；compiler 应阻止关键病例依赖存在未决、近似但未批准或指向未启用本院项目的映射。最终包只携带运行需要的本院目录子集和病例事实，并记录完整依赖 manifest；全量参考库可以留在独立 authoring 数据库或 artifact store。

## 未核实缺口

- 没有发现公开实现同时包含中国国家目录、本院目录、合成病例、医院业务状态机和不可变运行包；受限目录和真实医院配置很可能存在于非公开交付中，本文不能据此推断其机制。
- HealthAgentBench 论文和当前固定源码发布时间很新，本文核验了任务结构和代表性代码路径，没有复跑其受限数据下载或完整 benchmark。
- EHRGym 没有被本文核验到配套论文或临床审核流程；其目录和病例只能作为可执行结构参考，不能作为医学内容 authority。
- CohGenT 固定 commit 未见顶层软件许可证或正式 release tag；本文只引用其公开机制，不建立代码或数据依赖。
- OpenHIS 和 Medplum 的详细边界已有各自研究记录；本文没有重复动态运行它们，也没有将其当前数据库状态当作可重放证据。
- ClinMesh 仓库不存在 `docs/papers/`；论文阅读版来自本地 `/home/caii/projects/his-agent-os/docs/papers/`，影响结论的机制均回到上游固定 commit 源码、论文原文或官方文档核验。

## 固定版本来源

[etl-synthea-readme]: https://github.com/OHDSI/ETL-Synthea/blob/9ee6eb1b933c70af7b80711332aa92327af1f7c5/README.md
[etl-synthea-map]: https://github.com/OHDSI/ETL-Synthea/blob/9ee6eb1b933c70af7b80711332aa92327af1f7c5/inst/sql/sql_server/cdm_version/v540/create_source_to_standard_vocab_map.sql
[etl-synthea-sqlite]: https://github.com/OHDSI/ETL-Synthea/blob/9ee6eb1b933c70af7b80711332aa92327af1f7c5/R/exportToSQLite.r
[ocl-mapping]: https://github.com/OpenConceptLab/oclapi2/blob/6a4204ce42cc2a94ee5ee43c92598bec4c859531/core/mappings/models.py
[ocl-version]: https://github.com/OpenConceptLab/oclapi2/blob/6a4204ce42cc2a94ee5ee43c92598bec4c859531/core/common/models.py
[ocl-collection]: https://github.com/OpenConceptLab/oclapi2/blob/6a4204ce42cc2a94ee5ee43c92598bec4c859531/core/collections/models.py
[cohgent-readme]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/README.md
[cohgent-omop]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/api/database/db_omop_tables.py
[cohgent-search]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/api/features/terminologysearch/concepts.py
[cohgent-use-case]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/api/models/use_case.py
[cohgent-settings]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/api/models/cohort_settings.py
[cohgent-lab-presets]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/data/lab_value_presets.csv
[cohgent-guide]: https://github.com/CDCgov/CohGenT-Synthetic-FHIR-Record-Generator-Backend/blob/32e2821c933b81b1250d306bb7f7c78bbf123818/docs/userguide.md
[synthea-module]: https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/java/org/mitre/synthea/engine/Module.java
[synthea-hypertension]: https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/resources/modules/hypertension.json
[synthea-concepts]: https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/java/org/mitre/synthea/helpers/Concepts.java
[synthea-codemapper]: https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/java/org/mitre/synthea/export/rif/CodeMapper.java
[ehrgym-readme]: https://github.com/adtserapio/ehrgym/blob/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a/README.md
[ehrgym-reset]: https://github.com/adtserapio/ehrgym/blob/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a/shared/reset-database.ts
[ehrgym-diagnoses]: https://github.com/adtserapio/ehrgym/blob/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a/apps/ehr/data/diagnosis-catalog.csv
[ehrgym-orders]: https://github.com/adtserapio/ehrgym/blob/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a/apps/ehr/data/order-catalog.csv
[ehrgym-dka]: https://github.com/adtserapio/ehrgym/blob/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a/tasks/examples/dka-management.json
[ehrgym-manifest]: https://github.com/adtserapio/ehrgym/blob/5985db28d44e07d6298dbbb5a4ce00daa4c5a95a/runs/trajectories/20260308-171908-dka-management-rollout/manifest.json
[physicianbench-readme]: https://github.com/HealthRex/PhysicianBench/blob/c7efa8fd5b1e4744ada50668efe4b7e84023cbb0/README.md
[physicianbench-runner]: https://github.com/HealthRex/PhysicianBench/blob/c7efa8fd5b1e4744ada50668efe4b7e84023cbb0/scripts/run_task.py
[physicianbench-thyroid]: https://github.com/HealthRex/PhysicianBench/blob/c7efa8fd5b1e4744ada50668efe4b7e84023cbb0/tasks/v1/thyroid_medication_management/tests/test_outputs.py
[healthadminbench-readme]: https://github.com/som-shahlab/health-admin-bench/blob/e71a8f4d6923037805b7f51fbbf608d12ea56cf5/README.md
[healthadminbench-task]: https://github.com/som-shahlab/health-admin-bench/blob/e71a8f4d6923037805b7f51fbbf608d12ea56cf5/benchmark/v3/tasks/prior_auth/emr-hard-8.json
[healthagentbench-paper]: https://arxiv.org/html/2606.31179#S3
[healthagentbench-docker]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_to_meds_etl/environment/Dockerfile
[healthagentbench-stage]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_to_meds_etl/environment/workspace/scripts/stage_demo_data.py
[mimic-meds-map]: https://github.com/Medical-Event-Data-Standard/MIMIC_IV_MEDS/blob/9699e0865b050325459b11f3c4e226a9dbe5b496/src/MIMIC_IV_MEDS/configs/event_configs.yaml
[healthagentbench-verify]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_to_meds_etl/tests/verify_output.py
[healthagentbench-slice]: https://github.com/microsoft/HealthAgentBench/blob/ce89def2edf56f4a2ef068f37c8544bff944d5fc/tasks/ehr_event_modelling_new_hypertension/environment/stage_data.py
[medbiq-vpd]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/virtualpatientdata/v1/virtualpatientdata.xsd
[medbiq-dam]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/dataavailabilitymodel/v1/dataavailabilitymodel.xsd
[medbiq-activity]: https://github.com/medbiq/medbiq/blob/8f5c74a51bf6721fa1f0b57f2d9c4b51496bb566/activitymodel/v1/activitymodel.xsd
[medplum]: https://github.com/medplum/medplum/tree/e3ab98e55feab99013133e6e3bd92b147cb74d73/packages/server/src/fhir/operations
[medagentbench]: https://github.com/stanfordmlgroup/MedAgentBench/tree/99260117137b09f04837a8c18d18a1107efa55ae
[ai-hospital]: https://github.com/LibertFan/AI_Hospital/tree/870fc38c1daffa549c20332d273a8ad71b9d9fe1
[ai-hospital-map]: https://github.com/LibertFan/AI_Hospital/blob/870fc38c1daffa549c20332d273a8ad71b9d9fe1/src/evaluate/eval_db.py
[agentclinic]: https://github.com/SamuelSchmidgall/AgentClinic/tree/b6570edefb940857a7c334350656b29f9d984f24
[agentclinic-runtime]: https://github.com/SamuelSchmidgall/AgentClinic/blob/b6570edefb940857a7c334350656b29f9d984f24/agentclinic.py
[medagentsim]: https://github.com/MAXNORM8650/MedAgentSim/tree/6d1409724ca247dc50be1827818f2132a277e68b
[medagentsim-runtime]: https://github.com/MAXNORM8650/MedAgentSim/blob/6d1409724ca247dc50be1827818f2132a277e68b/medsim/core/agent.py
[automedbench]: https://github.com/AutoMedBench/AutoMedBench/tree/5394fe7aa73e6b5891fe43942c99f4b0c2b50873
[camyla]: https://github.com/yifangao112/Camyla/tree/df4434f9d4aef5b7394ed03a4e877a8130c1b6cf
[simple-evals]: https://github.com/openai/simple-evals/tree/652c89d0ca9df547706735883097e9537d40dc47
