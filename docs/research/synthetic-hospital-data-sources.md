# 合成医院数据来源研究

## 范围与执行结论

本文研究 ClinMesh 在患者生成之外，如何获得诊断、药品、检验、检查/影像、医疗服务价格、耗材、术语和组织主数据。结论来自截至 2026-08-26 可核验的官方规范、官方公开数据、项目文档和固定 commit 源码；它们是 Scenario 数据编译的设计输入，不定义当前产品行为。病例真值、揭示策略与运行留痕的完整边界见[虚拟患者与病例创作系统研究](./virtual-patient-and-case-authoring-systems.md)，FHIR ownership 和业务状态机见[系统架构](../architecture.md)。

ClinMesh 不存在一个可以直接下载的“中国仿真医院数据集”。患者纵向病史、国家或行业术语、医院目录、地方价格、库存事实和病例结果属于不同 authority、地域、时间与许可边界，必须分别取得、版本化并在离线 compiler 中组合。

可执行方案是四层：患者语料 provider 只生成纵向患者素材；Reference Data Package 固定外部术语和目录；Hospital Baseline 用项目自有合成数据形成虚构医院 overlay；Scenario compiler 最后生成不可变 CaseTruth 和 Scenario Package。Server 运行和 reset 只读取已安装快照，不联网查询“最新目录”。

首期不应先建设全国全量目录。应围绕发热门诊与 2 型糖尿病两个病例，提交一套小型、可人工审阅、完全合成的本院目录，并保留到官方代码或标准术语的可选映射。它先证明跨域一致性合同，再逐步接入获授权的官方参考包。

## 与当前 Issue 和患者 provider 的关系

[Issue #36](https://github.com/CaiZongyuan/clinmesh/issues/36) 已把工作拆为 Dataset 工作台、Synthea provider、中国化 CaseTruth compiler 和三级检查结果；[#38](https://github.com/CaiZongyuan/clinmesh/issues/38)只负责受控 Synthea R4 生成，[#39](https://github.com/CaiZongyuan/clinmesh/issues/39)负责中国化编译，当前最新的 [#40](https://github.com/CaiZongyuan/clinmesh/issues/40)负责 L1/L2/L3 检查结果。这一拆分与数据来源边界一致。

当前 `ScenarioGenerationProvider` 暴露 `capabilities()` 和 `generate()`，返回名为 `SourcePatientCorpus` 的对象。Synthea adapter 固定 commit，校验响应大小、R4 resource type、Bundle 内唯一患者、患者归属、内部引用和复现参数；随后把 R4 entry 放入 `longitudinalHistory`。但当前 `SourcePatientCorpus.content` 仍是完整 `ScenarioDatasetContent`：内置 provider 直接填入目录和库存，Synthea provider 则填入空目录和空库存。这个过渡合同适合 #38 隔离耗时且可能不可用的患者生成器，不应继续承担国家目录下载、地方价格更新或本院主数据维护。

建议保留两个不同的扩展面：

```text
ScenarioGenerationProvider
  -> SourcePatientCorpus
     Synthea R4 或项目内置合成病例素材

ReferenceDataAdapter
  -> NormalizedReferenceRelease
     已获合法使用权的本地 artifact，不接受运行时 URL

SourcePatientCorpus
+ Reference Data Package
+ Hospital Baseline
+ compiler/mapping/policy versions
  -> ScenarioDataCompiler
  -> editable Scenario Dataset
  -> immutable Scenario Package snapshot
  -> Workspace/Epoch
```

`ScenarioGenerationProvider` 的外部失败只影响一次生成任务；`ReferenceDataAdapter` 在管理员显式导入时解析本地 artifact；`ScenarioDataCompiler` 是所有 provider 共用的纯编译 seam。#39 应把患者语料与当前完整 Dataset wrapper 的过渡关系收敛成明确 compiler input，或把类型改成符合真实职责的名称；不能把 NHSA、NMPA、LOINC 或 OpenELIS 继续注册成同一种 Scenario provider。Synthea R4 到 R5、中国身份替换、目录映射、病例真值补齐和业务校验都属于 compiler，不属于 Synthea 容器。内置 provider 也必须经过同一个 compiler，避免形成“内置数据可绕过校验”的第二条路径。

Reference Data Package 与 Dataset 分开版本化。Dataset 编辑时引用固定 package release；安装时同时快照患者语料、参考包身份、Hospital Baseline、compiler 版本和映射，后续导入新目录或删除 Dataset 都不能改变既有 Scenario Run。

## 分层数据模型

| 层 | 内容与所有权 | 可变性与仓库边界 |
| --- | --- | --- |
| Source Artifact | 官方 PDF/ZIP/CSV、标准包、固定 commit 输出或自有合成输入 | 原样只读；记录哈希与许可。未授权 artifact 不进入 Git |
| Normalized Reference Release | 保留 source-native code、名称、属性、版本、停用状态与来源行定位的标准化目录 | 由领域专用 adapter 生成；不加入本院价格、库存或病例事实 |
| Terminology Package | CodeSystem、ValueSet、ConceptMap 及绑定元数据 | 按版本不可变；映射有方向、等价级别和审核状态 |
| Hospital Baseline Overlay | 虚构医院、科室、人员、本院代码、可开立目录、价格、容量、设备与库存策略 | 项目自有合成数据；受地域和生效日约束 |
| CaseTruth | 患者纵向历史、生理基线、疾病因果、检查真值、患者认知与可揭示证据 | 患者级；不能由互不相关的目录行随机拼接 |
| Scenario Package | 已编译的初始 FHIR R5 与领域事实、Hidden Fact、Reveal Policy 和模拟器规则 | 安装快照不可变；运行时不回查 Source Artifact |

`ExternalCatalogEntry`、本院 `HospitalCatalogItem`、病例中的 Clinical Request 和运行中的 Charge Item 是四个不同主体。一个国家代码不能自动成为可开立项目，一个本院项目也不能自动生成患者结果；这些关系必须由显式 mapping 和业务规则连接。

## 各领域的数据来源与生成策略

### 诊断、疾病与手术操作

中国业务编码优先参考国家医保信息业务编码标准数据库中的疾病诊断和手术操作目录，以及国家标准全文公开系统的 [GB/T 14396-2016 疾病分类与代码](https://openstd.samr.gov.cn/bzgk/gb/newGbInfo?hcno=8127A7785CA677952F9DA062463CBC41)。这些来源提供分类或结算语义，不提供某个合成患者会患什么疾病、病程如何发展或哪项诊断是病例真值。

Synthea 疾病模块可以提供共病、Encounter、Condition、MedicationRequest 和 Observation 的时间骨架，但其代码和模块内容面向美国语境。compiler 只转换白名单事实，把每个 source coding 解析为“保留、映射、降级为带来源文本或拒绝”之一；未知代码不能静默换成名称相近的中国代码。

本院诊断目录应使用稳定 local code 作为可编辑入口，并把医保诊断代码、GB/T 代码或其他术语放在有版本的 `ConceptMap` 中。一个病例的诊断空间由临床作者或确定性疾病模块产生，至少包含主诊断候选、鉴别诊断、并发症、明确阴性、发生时间和支持/反对证据。运行时确认的诊断仍是 `Condition`，不能写回 Hidden Fact。

首期只需要覆盖发热与 2 型糖尿病病例的人工审阅最小子集。手术操作、DRG/DIP 分组和全量 ICD 导入后置；它们不能成为构造患者临床事实的随机词库。

### 药品

[国家药监局药品数据查询](https://www.nmpa.gov.cn/datasearch/home-index.html)可用于核对批准文号、注册名称、剂型、规格和生产企业；国家医保平台的“医保药品分类与代码数据库”提供医保业务产品编码和关联目录属性。批准信息、医保产品代码、医保支付目录、本院药品目录和库存品项是五个不同层次，不能按名称直接合并。

本院药品目录至少分开保存通用成分、商品/制剂、剂型、规格、途径、多级单位换算、包装、可用状态、处方规则、医保映射和价格引用。适应证、禁忌、过敏、肾功能剂量和相互作用属于经临床审核的知识或病例规则，不能从医保代码、NMPA 注册名称或 Faker 推断。

首期药品名称、厂家、本院码、供应商、采购价、批号、效期和追溯码全部合成；若获授权，可在 Reference Data Package 中保留真实公开产品代码及其来源版本，但不得让真实厂家/批准文号与合成库存和患者记录组合成看似真实交易。FHIR R5 中目录产品映射为 `Medication`，知识属性可映射为 `MedicationKnowledge`；库存 lot 和移动仍由领域模型拥有。

### 检验

检验目录必须同时解决“开立什么”和“结果如何解释”。可参考国家卫生健康标准网发布的检验、标本和报告标准；国际交换可在接受对应许可后使用 [LOINC](https://loinc.org/license/) 标识观测项目、用 [UCUM](https://ucum.org/license) 表示单位。LOINC code 不能替代本院项目、方法、标本、仪器、组合、收费或参考区间，UCUM 也只解决单位语法和换算。

每个本院检验定义至少包含：local code、可选 LOINC mapping、标本和采集要求、方法、结果类型、UCUM 单位、按年龄/性别/妊娠/方法区分的参考区间、危急值、报告时限、组合成员、计算公式 DAG、执行科室、收费映射和有效期。FHIR R5 的 `ObservationDefinition` 与 `SpecimenDefinition` 可以承载互操作定义；运行事实仍使用 `ServiceRequest`、`Specimen`、`Observation` 和 `DiagnosticReport`。

检查结果采用 #40 定义的三级来源：L1 读取 CaseTruth 精确真值；L2 从同一患者生理基线和病理链派生；L3 只在有效正常域确定性采样并记录 `unmodeled_item`。复测键至少绑定 Scenario Run、患者、项目、方法和复测序号，受控测定噪声不能改变病理类别。BMI、肌酐/eGFR、血糖/尿糖和 Hb/RBC/HCT/MCV 等公式、单位维度、时间方向和病理耦合在发布前共同验证。

[OpenELIS Global](https://github.com/DIGI-UW/OpenELIS-Global-2/tree/0d22a2101957db7219671bb10c8727103ad06b24)展示了 test、panel、sample type、method、range、alert、analyzer、reagent 和 reflex/calculation 的独立管理，适合作为目录字段和工作流参考；其 MPL-2.0 软件许可不证明部署 seed 或检验值可以作为中国权威目录。

### 检查与影像

检查目录应分开保存 orderable、执行 protocol 和报告定义。至少包含 modality、部位、侧别、是否增强、造影剂/准备要求、禁忌、执行科室、预约容量、TAT、报告模板、收费映射和有效期。国际互操作可参考 [DICOM 标准](https://www.dicomstandard.org/current)、[LOINC/RSNA Radiology Playbook](https://loinc.org/usage/rsna-radiology-playbook/) 或 [RadLex](https://www.rsna.org/practice-tools/data-tools-and-standards/radlex-radiology-lexicon)，但每项内容仍需按其当前许可取得并固定版本；DICOM 标准和词表都不是可直接采用的中国医院检查目录。

病例结果由结构化 finding、结论、严重程度、部位/侧别和时间组成，并与 Hidden Fact 及其他检验结果一致。首期只生成文本和结构化结果，运行时使用 `ServiceRequest` 与 `DiagnosticReport`；未来只有确实保存影像实例时才创建 `ImagingStudy` 和 DICOM artifact。

公开的 DICOM 数据集、TCIA、MIMIC-CXR 或厂商 demo 影像不能因“已去标识”就进入 ClinMesh。需要影像像素时，应使用项目生成的 phantom/合成图像，并同时生成虚构 accession number、Study/Series/SOP Instance UID、机构和设备元数据。

### 医疗服务项目、价格与收费

[国家医保局医疗服务价格项目立项指南](https://www.nhsa.gov.cn/col/col201/index.html)提供项目边界、计价单位和规范方向，不是全国统一价格表。价格由地方医保部门管理并随地区、机构等级和生效日期变化；国家医保局的[省级映射入口](https://www.nhsa.gov.cn/art/2026/6/26/art_14_21122.html)也不能消除这一差异。

Reference Data Package 应分别保存国家立项语义、选定省市的来源项目和有效期；Hospital Baseline 再生成本院 service、billable item、价格表和 mapping。Clinical Request、Healthcare Service、收费项目与价格版本不能共用一个 ID。FHIR R5 可用 `HealthcareService` 表示可提供服务、`ChargeItemDefinition` 表示计费定义、`ChargeItem` 表示运行中的费用事实；支付和退款仍属于领域交易。

许可未确认时，首期使用标记为“仿真、非政策价格”的项目自有整数分价格，只用官方政策校准结构和量级。Scenario 必须固定 `jurisdiction + hospital class + effective date + price schedule hash`，不能在运行中抓取当前网页，也不能在目录升级后重算既有费用。

### 耗材、器械与体外诊断试剂

国家医保平台公开查询医用耗材和体外诊断试剂；[国家药监局医疗器械唯一标识数据共享](https://udi.nmpa.gov.cn/download.html)明确提供每日、每周、每月和全量 ZIP/RSS 发布。它们提供产品或医保目录信息，不提供本院供应商、采购价、批次、序列号、库存余额或患者使用事件。

规范化模型应区分 product/device definition、医保耗材代码、UDI-DI、包装层级、本院 inventory item、lot/serial、trace code 与 Inventory Movement。获授权的 UDI artifact 可经离线 adapter 导入；本院码、供应商、价格、lot、serial、追溯码和全部库存事件必须合成。FHIR R5 可投影 `DeviceDefinition`、`InventoryItem`、`DeviceRequest` 和 `DeviceDispense`，但只有架构能力注册表实际加入后才能对外声明支持。

### 术语与映射

术语不是附在 UI 上的 display 字典，而是跨目录一致性的依赖。每个 coding 必须固定 `system + version + code`；每个 `ConceptMap` 必须记录方向、关系强度、是否可自动应用、审核人/规则和 source/target package hash。多对一、一对多、近似、上位映射和无法映射必须显式区分。

[Open Concept Lab](https://github.com/OpenConceptLab/oclapi2/tree/6a4204ce42cc2a94ee5ee43c92598bec4c859531)把 organization、source、collection、concept、mapping 和 release 分开，[OHDSI Vocabulary](https://ohdsi.github.io/CommonDataModel/vocabulary.html)明确 source concept 到 standard concept 可能是一对多或退化到更一般概念。二者可作为版本发布和 mapping QA 参考，但 OCL/OHDSI 软件许可不覆盖其中托管的每套术语。

SNOMED CT、LOINC、UCUM、WHO ICD、医保编码、国家标准和地方目录分别受自己的许可与地域规则约束。未知或未获授权的术语只能处于 `reference-only` 或 quarantine，不能因为可在网页查询、Athena 下载或开源软件中看到就提交到仓库。首期用项目自有 local codes 驱动业务，用合法的最小外部映射提高互操作性。

### 组织、人员与容量主数据

国家卫生健康标准和国家医保平台中的机构、科室、人员分类可以校准字段和代码，但真实医院、医生、执业标识、地址、电话和排班不能成为演示主数据。Hospital Baseline 应完全生成虚构的 `Organization -> department/ward -> Location -> HealthcareService` 层级，以及 Practitioner、PractitionerRole、Schedule、Slot、床位、设备、容量和岗位权限。

组织生成必须先固定医院类型、地区、等级、规模和服务范围，再派生科室树、人员能力、地点、号源和设备；不能独立随机生成后靠名称关联。真实机构名录只可做汇总校准或人工结构参考，不能与合成患者就诊拼接。

## 可参考项目的准确定位

| 项目 | 一手证据与许可 | 可借鉴 | 不可作为 |
| --- | --- | --- | --- |
| Synthea | [固定 commit `d9d07a6`](https://github.com/synthetichealth/synthea/tree/d9d07a6eef91ee5144293b42ab64224d84d124f8)，Apache-2.0 | 疾病状态机、人口/临床双 seed、纵向 R4 语料 | 中国目录、FHIR R5 包、完整 CaseTruth 或医院运行事实 |
| OHDSI CommonDataModel / Athena | [CDM 固定 commit `4a91030`](https://github.com/OHDSI/CommonDataModel/tree/4a910305b2cb74a4fc2b2c34baf44eb0542ff03f)，Athena 各词表许可独立 | 分析 schema、source-to-standard mapping 和 coverage QA | 事务型 HIS、患者生成器、可无条件再分发的术语整包 |
| OHDSI ETL-Synthea | [固定 commit `9ee6eb1`](https://github.com/OHDSI/ETL-Synthea/tree/9ee6eb1b933c70af7b80711332aa92327af1f7c5) | Synthea CSV 到 OMOP 的显式 mapping/roll-up 流程 | R4 到 R5 转换、中国业务状态机或目录 authority |
| Eunomia / EunomiaDatasets | [Eunomia `f546284`](https://github.com/OHDSI/Eunomia/tree/f5462843b10e47bead3fa51a1235ec3aeb87676f)、[Datasets `3efd533`](https://github.com/OHDSI/EunomiaDatasets/tree/3efd533eb95a41a56d5b0758b0d7c8fa57e1303e)，Apache-2.0 工具/仓库 | OMOP 查询和小数据集 contract test | 中国 HIS seed；Datasets 同时含 MIMIC，不能整仓导入 |
| OpenMRS / OCL | [OpenMRS `6d787a1`](https://github.com/openmrs/openmrs-core/tree/6d787a1e60899e39377ce5011b298a188b3354c6)、[OCL `6a4204c`](https://github.com/OpenConceptLab/oclapi2/tree/6a4204ce42cc2a94ee5ee43c92598bec4c859531)，软件 MPL-2.0 | 本地 concept dictionary、source/collection、mapping 与 release 工作流 | 中国权威术语；CIEL/SNOMED 等内容许可不能由软件许可代替 |
| Bahmni default config | [固定 commit `f6db31d`](https://github.com/Bahmni/default-config/tree/f6db31d92ae2db022711407f321ab65c39fe0c04)，MIT | concept set、order template、drug rule 和配置包形状 | 中国目录、临床正确值或可直接复制的生产 seed |
| OpenELIS Global | [固定 commit `0d22a21`](https://github.com/DIGI-UW/OpenELIS-Global-2/tree/0d22a2101957db7219671bb10c8727103ad06b24)，MPL-2.0 | 检验目录、标本、panel、range、alert、analyzer 与结果生命周期 | 中国检验项目/参考区间数据源 |
| HAPI FHIR JPA Starter | [固定 commit `07edf2a`](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/tree/07edf2a06fdc2024209ebf64b2d85129c19ffa75)，Apache-2.0 | FHIR package 安装、validator 和 terminology server 的测试参考 | 合成数据源或 ClinMesh R5 业务内核 |
| Medplum mock | [固定 commit `ed1af10`](https://github.com/medplum/medplum/tree/ed1af10ffbd2ee13428936e1688782d8b858eb0c/packages/mock)，Apache-2.0 | R4 API client unit-test mock | 临床一致患者、R5 fixture 或中国目录 |
| MIMIC / MIMIC demo | [官方说明](https://physionet.org/content/mimic-iv-demo/2.2/)明确 demo 是 100 名真实患者的去标识子集 | 只读其公开 schema/研究方法，且不导入患者行 | 任何 ClinMesh 数据、fixture、提示词、日志或生成校准输入 |

软件许可证只覆盖对应源码，不自动覆盖仓库内 seed、术语、影像或第三方目录。引用项目的数据必须逐 artifact 追溯；无法分离代码许可与内容许可时，只借鉴模型，不复制内容。

## 中国官方来源的已核验边界

### Synthea 中国化缺口

截至核验日，Synthea 最新正式版是 [`v4.0.0`](https://github.com/synthetichealth/synthea/releases/tag/v4.0.0)。官方 [`synthea-international` 固定 commit](https://github.com/synthetichealth/synthea-international/tree/4d406f4d3b06adfb12d57c365651e41eb11d1302)没有中国目录，README 说明多数地域包仍使用美国姓名和电话规则，部分数据并不完整。

Synthea 的 [Other Areas](https://github.com/synthetichealth/synthea/wiki/Other-Areas)指南要求新地域自行提供人口统计、邮政编码、时区、医疗机构、姓名、费用和支付方数据。固定 commit 的 [`names.yml`](https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/resources/names.yml)只有英文和西班牙文姓名集合；语言映射中的中文代码不构成中国人口模型。

官方 README 只声明 FHIR R4、STU3 和 DSTU2 输出，固定 commit 的 exporter 使用 [`FhirContext.forR4()`](https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/java/org/mitre/synthea/export/FhirR4.java)。ClinMesh 固定 FHIR R5 `5.0.0`，因此必须显式转换支持的资源、重建引用并验证业务不变量，不能用类型断言伪装完整 R4/R5 兼容。

Synthea 的 provider、payer 和 claim 模型以美国机构标识、Medicare、Medicaid、premium、copay、deductible 和 coinsurance 为中心。官方 [FHIR Transaction Bundles](https://github.com/synthetichealth/synthea/wiki/FHIR-Transaction-Bundles)指南还要求先导入机构与人员资源；这些内容不能表达中国医院科室、排班、床位、处方审核、库存和医保状态机，compiler 应删除或替换相应美国语义。

复现需要固定 commit、人口 seed、临床 seed、参考/结束时间、配置、模块、历史窗口与时区；种子本身不足以复现，完整条件见 [Recreating a Dataset](https://github.com/synthetichealth/synthea/wiki/Recreating-a-Dataset)。Synthea 和 `synthea-international` 使用 Apache-2.0，但输出引用的临床术语和地域输入仍有独立许可。

### 国家医保编码平台

国家医保局将药品数据正式称为“医保药品分类与代码数据库”。官方[五问五答](https://www.nhsa.gov.cn/art/2024/11/29/art_14_14901.html)将它定位为全国医保业务统一分类与代码，用于异地就医结算、医保招采和支付；它不是医院药品目录、库存数据或价格表。[2019 年编码规则](https://www.nhsa.gov.cn/art/2019/6/27/art_53_1436.html)规定西药代码由 6 部分共 23 位组成，中成药代码由 5 部分共 20 位组成。

2026-08-21 核验时，[`sysflag=1386`](https://code.nhsa.gov.cn/search.html?sysflag=1386)对应“截至 2026 年 8 月 7 日维护”的药品快照；官方[更新通知](https://code.nhsa.gov.cn/toDetail.html?infoId=5963&CatalogId=2)和页面内部 `batchNumber=20260819` 表示发布批次，不是永久“最新”标识、数据截止日或政策生效日。快照页展示药品代码、注册名称、剂型、规格、包装、企业、批准文号、本位码和医保目录关联，进一步证明产品代码与医保支付属性应分字段保存。

该页通过未公开的网页内部 `POST /yp/getPublishGoodsDataInfo.html` 分页返回 jqGrid JSON。核验时批次有 280,531 条记录，页面另提供带 MD5 的 PDF；未发现文档化公共 API、稳定性/配额/错误合同或 CSV/数据库 dump。网页可匿名查询、浏览器可分页请求和获得合法可再分发的结构化批量数据是三件不同的事。

[平台首页](https://code.nhsa.gov.cn/)还提供中药饮片、医疗机构制剂、西药中成药、医用耗材、中药配方颗粒、体外诊断试剂、疾病诊断与手术操作、医疗服务价格和医保结算清单等入口。入口证明目录范围，不证明每个目录都有公开机器下载或开放许可。

国家医保局[网站声明](https://www.nhsa.gov.cn/col/col40/index.html)限制商业性原版原式转载和第三方内容的擅自转载。ClinMesh 不在运行时调用网页内部端点，也不把 PDF 或完整查询结果提交到 Git；只允许从用户已获合法使用权的本地 artifact 离线导入。

### 国家药监局数据

国家药监局药品查询适合人工或受控离线核验；截至 2026-08-21，未发现该入口提供有文档支持的结构化批量下载和开放再分发许可，因此不能成为运行时依赖。

UDI 数据共享页则明确提供全量与增量 ZIP/RSS，核验时页面显示 `UDID_FULL_RELEASE_20260801.zip` 及后续增量包。这证明机器可取得的发布机制，不自动授予重新打包权，也不覆盖药品、本院库存或单件流通事件。adapter 必须同时记录官方发布信息和实际下载内容哈希。

### 国家卫生、人口与地域数据

[第七次全国人口普查](https://www.stats.gov.cn/sj/pcsj/rkpc/7rp/indexch.htm)等统计局汇总表可以校准人口边际分布，[国家卫生健康标准网](https://hbba.sacinfo.org.cn/stdList)可以核对卫生信息分类、数据元和交换结构。汇总分布不能反推、拼接或模拟真实个人联合记录，标准中的代码也不能在许可未确认时整包再分发。

患者姓名、证件、电话、详细地址、家庭关系、医院人员和联系方式使用项目自有虚构词表与校验规则生成，并主动避开真实可投递地址和真实机构标识。

## OpenHIS 的数据边界

本地 OpenHIS 参考源码不能作为可直接导入的中国药品、耗材或价格数据集。软件许可证不授予第三方目录数据的再分发权；仓内未发现带权威来源和数据许可的国家目录快照。

它的价值在模型和导入流程：药品定义覆盖名称、厂家、批准文号、国家码、医保码、剂型、途径、频次和多级单位；耗材、收费项目、诊疗活动与库存 lot 分开。Excel 导入采用版本化模板、列指纹、必填校验、行数上限、错误标注和批次审计。ClinMesh 可借鉴字段覆盖和 quarantine 工作流，但不能复制任意表名多态引用、PostgreSQL 物理模型或遇到未知单位时自动扩充受控术语的行为。

其医保模块体现了 `SourceArtifact -> ExternalCatalogRelease/Entry -> HospitalCatalogItem -> CatalogMapping -> PriceSchedule -> InventoryLot` 的有效层次，但机构授权协议、接口列位和匹配权重都不是公开国家规范。开发 seed 中来源不足或看似真实的品牌、厂家、标识和配置不得进入生成管线；任何疑似凭证也不得读取、记录或复用。

## 许可、血缘与发布门禁

### 来源处置等级

| 等级 | 允许用途 | 仓库内容 |
| --- | --- | --- |
| `redistributable` | 许可与本项目用途兼容，可固定生成器或必要输入 | 固定版本、LICENSE/NOTICE、合法最小数据和测试 |
| `controlled-import` | 用户已经取得合法使用权，可从本地 artifact 导入 | schema、adapter、manifest、哈希和合成测试，不提交原始行 |
| `reference-only` | 人工核对字段、代码、政策或模型 | 来源引用、人工审核的自有映射，不缓存或镜像原文 |
| `forbidden` | 真实患者、去标识真实患者、真实影像/交易/追溯码、凭证和来源不明 seed | 不进入文件、数据库、fixture、提示词、日志或 Git 历史 |

任何 `unknown` 许可默认按 `reference-only` 处理。公开访问、无需登录、网站返回 JSON、软件仓库使用开源许可证或数据已去标识，都不能自动提高等级。

### Reference Data Package manifest

每个包至少记录：

- `packageId`、domain、schema version、authority、jurisdiction 和语言；
- 官方标题、release/version、发布日、数据截止日、effective period，禁止只写 `latest`；
- source URI、获取时间、media type、官方 checksum、实际 SHA-256 和字节数；
- license/terms URI、版权 notice、允许用途、再分发结论和作出结论的依据；
- adapter 名称/版本/源码 commit、转换参数、父 artifact hash、规范化内容 hash；
- code system canonical/version、依赖包及其 hash、mapping 版本与审核状态；
- clinical review、导入诊断、quarantine 数量和批准发布者。

获取时间等非业务元数据保留在血缘中，但不参与相同输入的 canonical content hash。官方 checksum 与实际 SHA-256 都保存：前者证明对上发布说明，后者覆盖实际取得的字节。来源没有版本时，以内容 hash 和获取日期形成不可变内部 release，仍不得称为官方版本。

## Compiler 与一致性验证

编译按固定顺序执行，任一 error 都不得发布部分 Scenario Package：

1. 验证 artifact 大小、媒体类型、hash、许可状态和 parser 版本，把未知列、重复主键和坏编码隔离到 quarantine。
2. 规范化 source-native entry，但保留原 code、version、有效期、停用状态和来源定位；禁止先按 display 合并。
3. 应用显式 `ConceptMap` 和本院 overlay；无法映射、近似或一对多映射产生稳定诊断，不静默丢弃。
4. 合成 Hospital Baseline、本院代码、价格、库存和容量，再把患者语料映射为 CaseTruth。
5. 只转换白名单 FHIR R4 事实到 R5；验证 resource type、引用、Patient/Encounter 归属、时间、identifier system 和 synthetic-data 标记。
6. 验证术语与目录：code system/version 存在且 active，单位维度正确，药品规格/途径/单位可执行，检验 panel/公式无环，服务与收费 mapping 唯一且在有效期内。
7. 验证病例医学一致性：年龄/性别与范围匹配，诊断、症状、检查、用药、过敏、肝肾功能、结果时序和处置不存在已编码矛盾。
8. 验证运营与财务一致性：每个可开立项目有执行科室、TAT、计费触发点和可用状态；库存数量与基准单位守恒；同一费用引用固定价格 schedule。
9. 使用固定 seed、虚拟时间、package hashes、compiler 和 policy version 重复编译，要求 canonical state hash 相同；然后安装不可变快照。

FHIR validator 只能证明结构和 profile；临床耦合、目录可执行性、金额、库存、时序与 Hidden Fact 泄漏需要 ClinMesh 自己的验证器。项目尚未发布正式 R5 IG 时，不得用 `meta.profile` 或 TypeScript 类型声称 conformance。

## 实施优先级

### P0：完成 #39 所需的最小参考包合同

- 在 compiler 输入中显式加入 Reference Data Package 与 Hospital Baseline 的 ID、版本和 hash，不把目录塞进 Synthea 请求。
- 为发热与 2 型糖尿病建立完全合成、临床人工审阅的最小诊断、药品、检验、服务价格、科室和库存 overlay。
- 为 Synthea code 建立小型显式 mapping 表；未映射代码形成可编辑诊断并阻止安装所需事实缺失的数据集。
- 安装快照固定 patient corpus、参考包、compiler/mapping/policy 和 FHIR R5 输出。

### P1：完成 #40 的检验定义与结果引擎

- 建立检验 definition、panel、specimen、method、UCUM unit、分层参考区间、危急值、TAT、价格和 formula DAG。
- 实现 L1/L2/L3 来源、复测噪声、跨项目公式/病理/时间校验和原子报告发布。
- 用 OpenELIS 只校准目录字段和工作流；不导入其 seed。需要 LOINC/UCUM 时先完成固定版本与许可清单。

### P2：受控官方目录 adapter

- 优先实现通用本地 artifact + manifest + quarantine 框架，再分别加入 NHSA、NMPA UDI、LOINC/UCUM 等窄 adapter。
- 选择一个明确地区和生效日建立医疗服务价格包；不建设伪“全国价格表”。
- 将药品批准信息、医保产品码、医保目录属性、本院 Medication、价格和 Inventory Lot 保持分层。

### P3：扩大检查、耗材和组织容量

- 增加结构化影像报告、检查 protocol、侧别/部位一致性；影像像素仍只使用合成 phantom。
- 增加耗材/器械 definition、包装、lot/serial/trace 与领用移动，不导入真实流通记录。
- 从 Hospital Baseline 派生科室、人员、地点、服务、排班、床位和设备容量，再扩展更多垂直病例。

每个阶段都以完整纵向 Scenario 验收，而不是以“导入了多少万条目录”验收。对仿真系统而言，小型、有血缘、可执行且医学一致的本院目录，比全量但许可和映射不清的镜像更有价值。
