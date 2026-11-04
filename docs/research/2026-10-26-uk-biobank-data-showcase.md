# UK Biobank Data Showcase 的用途与访问边界

核验日期：2026-10-26。范围：用户给出的公开分类页、Showcase 首页与帮助、具体字段页、官方数据访问指南、Research Analysis Platform（RAP）说明和公开合成测试数据说明。仅查看公开网页及官方用户指南文本，未登录、申请访问、下载参与者数据或读取影像像素。本文保存外部来源证据，不声明 ClinMesh 已接入该资源。

## 网站是什么

[UK Biobank Data Showcase](https://biobank.ndph.ox.ac.uk/showcase/browse.cgi?id=-2) 是英国生物样本库 UK Biobank 的公开数据目录与说明入口。其目标是让研究者先了解安全数据仓库中有哪些变量、测量、结局和资源，判断能否支持研究，再申请访问；公开 Showcase 仅包含匿名汇总信息，真实参与者数据另存于安全服务器。依据：[Showcase Help](https://biobank.ndph.ox.ac.uk/showcase/help.cgi)、[首页](https://biobank.ndph.ox.ac.uk/showcase/index.cgi)。

UK Biobank 跟踪约 50 万名志愿参与者的健康，向英国及海外获批的学术和产业研究者提供不直接识别参与者的健康信息，支持疾病预防、诊断与治疗研究；官方列举癌症、心脏病、中风、糖尿病、抑郁和痴呆等研究方向。依据：[RAP 官方平台文档](https://dnanexus.gitbook.io/uk-biobank-rap/)。

该队列在 2006—2010 年于英国招募，招募时年龄为 40—69 岁；年龄描述指入组时，不能理解为参与者现在仍处于该年龄段。依据：[Showcase User Guide，2017 年 8 月版，第 1 页](https://biobank.ndph.ox.ac.uk/showcase/ukb/exinfo/ShowcaseUserGuide.pdf)。该指南用于核实历史队列事实，当前访问政策以下文最新指南为准。

## 用户链接的具体功能

用户链接对应 `Browse by Primary Category`，按主要来源和性质组织数据字段。它是一棵可继续展开的分类树，并非单份可直接下载的病例数据集。分类与例子来自[指定页面](https://biobank.ndph.ox.ac.uk/showcase/browse.cgi?id=-2)。

| 一级类别 | 内容与例子 |
| --- | --- |
| [Population characteristics](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=1) | 人群及基线特征、社会经济剥夺指数、持续更新的特征 |
| [Assessment centre](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100000) | 评估中心采集的问卷、生活方式、既往病史、用药、认知测试、血压、体格测量、心电图，以及脑、心脏和腹部 MRI 等影像相关字段 |
| [Biological samples](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100078) | 血常规、生化、尿液检测、代谢组、蛋白生物标志物等 |
| [Genomics](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100314) | 基因分型、填补、外显子组、全基因组、遗传风险评分等 |
| [Online follow-up](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100089) | 线上随访的睡眠、心理健康、认知、饮食、疼痛及工作环境等信息 |
| [Additional exposures](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100088) | 居住环境、空气或噪声污染、绿地、加速度计活动测量及心脏监测等 |
| [Health outcomes](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=91) | 基层医疗、住院、死亡和癌症登记、算法定义结局及疾病首次出现等；具体来源见[外部健康结局](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100091) |

目录中的类别不意味着每位参与者都完成过相同检查。[Participant 帮助](https://biobank.ndph.ox.ac.uk/showcase/help.cgi?cd=participant) 说明，不同字段的参与者数量通常不同，因为并非所有人都参加了每项调查或测量。影像类别存在于目录中，也不表示该公开页面允许直接浏览全部参与者影像。

该分类页页尾显示 `Summary generated 30 September 2025`。这是此处分类汇总标注的生成日期，不应据此判断整个 UK Biobank 数据库最后更新时间或实时数据规模。依据：[分类页](https://biobank.ndph.ox.ac.uk/showcase/browse.cgi?id=-2)。

## 具体字段示例

在 Search 搜索 `Systolic blood pressure` 可找到[字段 4080：Systolic blood pressure, automated reading](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=4080)。该页说明自动测量收缩压的字段类型为 Integer、单位为 mmHg，并提供参与人数、数据项数量、重复测量实例与数组结构、均值、分位数、范围、相关字段及说明资源。2026-10-26 核验时页面显示 476,030 名参与者、1,155,218 个数据项、4 个 instances 和 2 个 array 位置。

这些数字是该字段公开页面的汇总，不能当作全库参与人数、独立患者数或实时累计量。一名参与者可能对应多次测量，因此 items 与 participants 不相等。该类页面适合判断变量含义、覆盖范围及分析可行性；公开汇总不足以重建个体纵向记录。

## 怎么用于研究

研究者可以先按 Browse 分类或 Search 关键词定位变量，阅读字段定义、单位、编码、测量时间和覆盖人数，再判断研究所需的暴露、协变量及结局能否对应。例如研究血压与后续心血管事件的关系，可以先确认血压、吸烟、用药和疾病结局字段是否存在；实际进行个体关联分析仍需获批访问参与者数据。浏览、搜索、目录及正式申请的定位依据：[Showcase Help](https://biobank.ndph.ox.ac.uk/showcase/help.cgi)。例子是用途说明，不代表已经执行分析或确认所有变量均满足某项研究方案。

UK Biobank 包含前瞻及回溯信息，健康结局可来自死亡登记、癌症登记和住院事件等外部来源；其结构更适合人群队列、风险因素、遗传学、影像与生物标志物等研究。依据：[Understanding UK Biobank](https://biobank.ndph.ox.ac.uk/showcase/exinfo.cgi?src=UnderstandingUKB)、[2017 用户指南第 10 页](https://biobank.ndph.ox.ac.uk/showcase/ukb/exinfo/ShowcaseUserGuide.pdf)、[RAP 平台介绍](https://dnanexus.gitbook.io/uk-biobank-rap/)。

## 公开浏览与实际数据访问

无需登录即可浏览公开目录和匿名汇总；正式研究访问通过申请体系管理。[Showcase 首页](https://biobank.ndph.ox.ac.uk/showcase/index.cgi) 的 Login 指向 [Access Management System](https://ams.ukbiobank.ac.uk/ams/resApplications)，帮助页说明研究者须申请访问，研究须符合 UK Biobank 健康研究条件。[Downloads 页面](https://biobank.ndph.ox.ac.uk/showcase/download.cgi) 可见工具与 schema，同时明确含真实数据的数据集仅供已登录的授权研究者访问；字段附加资源中的公开示例不能据此推断全部个体数据公开。

当前[UK Biobank Data Access Guide 首页](https://uk-biobank.gitbook.io/data-access-guide/) 明确说明，旧指南描述的是过去默认可以下载数据时的流程；现在数据通过 UK Biobank Research Analysis Platform 访问。只有特别获批下载豁免的项目，或处理政策改变前已下载数据的情形，才应继续使用该指南中的旧下载流程。不能因为 Showcase 存在 Downloads、旧 basket 或旧下载说明，就认为任何访客可下载真实参与者记录。

[RAP 平台文档](https://dnanexus.gitbook.io/uk-biobank-rap/) 将其定义为向注册研究者社区提供 UK Biobank 数据访问和分析的信息平台。此次未登录，也未核验具体项目的资格、收费、审批时长或豁免结果。

## 公开合成测试数据的特别说明

官方另提供 [UK Biobank Synthetic Dataset](https://biobank.ndph.ox.ac.uk/showcase/exinfo.cgi?src=UKB_Synthetic_Dataset.html)，目的是使用与真实库规模和组成相近的数据进行大规模系统测试。说明页列出的表格数据约为 60 万行、2.7 万列，并另有医疗记录与遗传记录文件；这些是合成测试数据的规模，不能替代真实队列人数。

该合成集随机生成，官方明确不保证正确性或准确性，也不保证内部一致：可能出现女性参与者的前列腺癌、死亡后发生医疗事件、疾病日期没有对应诊断等情况。因此它可以作为导入、存储或处理流程的工程测试候选，不能直接作为临床合理病例、医学关联或诊疗逻辑的依据。此次只阅读说明与文件清单，未下载文件或运行测试。依据：[合成数据官方说明](https://biobank.ndph.ox.ac.uk/showcase/exinfo.cgi?src=UKB_Synthetic_Dataset.html)。

## 数据内容对合成病例的价值

UK Biobank 的内容包括实际采集的检查结果、住院诊断、既往操作、用药访谈和长期健康结局。它对合成病例的医学内容有参考价值，不能仅因公开页面不提供完整参与者记录，就将其价值缩减为网站布局或目录组织。公开页面可以核实字段、编码、单位、覆盖人数及边际分布；同一人的共病、用药、检查和后续事件之间的关联则需要获批的个体关联数据才能研究。

| 已核实数据 | 具体内容 | 对 ClinMesh 的参考用途与限制 |
| --- | --- | --- |
| [血液生化](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=17518) | 30 项，包括血糖、糖化血红蛋白、LDL/HDL 胆固醇、甘油三酯、肌酐、尿素、ALT、AST、CRP 等 | 可核对糖尿病、心血管病、肾功能异常等合成病例涉及的指标、单位和分布；公开单项分布不能证明某个疾病组合应取什么结果。 |
| [肌酐 30700](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=30700) | 单位 umol/L；核验时公开页显示 470,092 名参与者、486,655 个数据项和 2 个测量实例 | 是实际测量的汇总，不是单纯的指标名称；数据覆盖与中位数等描述只适用于该字段及其队列，不能直接替换临床参考区间。 |
| [住院诊断 41270](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=41270) | ICD-10 住院诊断汇总中包括 I20 心绞痛、I21 急性心肌梗死及亚型、I25 等 | 可作为冠心病合成病例疾病谱的参考；仍需单独处理中国临床版编码映射。 |
| [住院操作 41272](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=41272) | 英国 OPCS-4 操作汇总包括冠脉球囊成形术、冠脉搭桥等；[操作说明](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=2005)解释实际实施记录及汇总日期口径 | 可丰富既往干预史；编码和日期不能直接当作本院手术编码与精确实施时间。 |
| [用药访谈](https://biobank.ndph.ox.ac.uk/showcase/label.cgi?id=100075) | 规律服用处方药的自报信息；[20003 字段](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=20003)列有阿司匹林、辛伐他汀、阿托伐他汀、氨氯地平等 | 可参考长期服药史的内容；该访谈未记录剂量和剂型，不能替代完整处方、药房发药或护士给药记录。 |
| [心梗首次报告日期 131298](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=131298) | 多来源映射后的最早心梗记录日期，并有独立来源字段和特殊日期编码 | 可参考纵向病程与结局的组织；最早记录日不等于真实发病时刻。 |

例如要设计单纯冠心病、冠心病合并糖尿病、冠心病合并肾功能异常三类合成病例，可以用这些资料核对相关诊断、检验指标、既往干预和长期用药有哪些，再用适用临床依据确定病例内部的合理组合。公开汇总不能直接证明这些组合的联合分布，彼此独立抽取各指标也不能证明临床合理性。本项目继续使用合成患者，UKB 的真实参与者记录不直接进入演示数据库；实际采用范围须分别核对来源条件及项目约束。

## 公开汇总辅助核对的操作示例

辅助核对先验证指标含义、单位、标本、采样条件、测量方法与时间，再判断数值是否可比较。核验时读取 UKB 字段页的 Data、Notes 和 Instances，并为合成资料记录字段链接、页面版本及核验日期。单位相同且条件可比后，分位数只能用于发现需追查的量级或分布差异，不能代替临床判断，也不自动改变生成结果。

2026-10-26 本地源码基线 `0ec0f38f` 的实际资料对照如下；这是代码配置与公开资料的离线核对，没有读取某位患者的运行结果。

| 项目 | 本地资料或核对问题 | UKB 公开证据 | 应采取的动作 |
| --- | --- | --- | --- |
| 肌酐 | [PCI 底稿](../../apps/server/src/application/scenario-data/pci-data.ts)的合成基线为 0.9 mg/dL，编码 2160-0 明确为质量浓度 | [30700](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=30700)使用 umol/L，中位数 70.5，P10 为 54.9、P90 为 91.1；Notes 为 AU5800 酶法测量 | 先核实语义与换算规则；单位对齐前不直接比较 0.9 与 70.5。本次只确认单位差异，未完成换算规则的一手核验。 |
| 糖化血红蛋白 | [既有示例配置](../../apps/server/src/application/scenario-data/hospital-baseline.ts)使用 %；这不代表当前每项已发布服务都用同一单位 | [30750](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=30750)使用 mmol/mol，Notes 为 Bio-Rad VARIANT II Turbo 的 HPLC 测量 | 标记待单位对齐；不能直接把项目中的百分数与 UKB 数字比较。 |
| 血糖 | 需要明确本地结果属于空腹还是随机测量 | [30740](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=30740)使用 mmol/L，Notes 为己糖激酶法；所查字段页未声明空腹或禁食时长 | 记录采样条件尚不足，不能把该汇总直接标作空腹血糖参考。 |
| LDL 胆固醇 | 本地结果须确认是直接测定还是计算结果 | [30780](https://biobank.ndph.ox.ac.uk/showcase/field.cgi?id=30780)为 LDL direct，单位 mmol/L，Notes 为 AU5800 enzymatic protective selection analysis | 记录直接测定的语义；本地采用计算 LDL 时需另行确认可比性，不能只凭中文名称相近判为同一测量。 |

比如某份待核对的合成资料写肌酐 75 umol/L，在指标语义和采样条件可比的前提下，可以记录该数字处于上述汇总的 P10—P90 之间，未显示明显数量级差异；这仍不能证明该患者肾功能正常。若病例声明无肾功能问题而结果与该设定明显不相称，应核查单位、来源、时间和其他肾功能证据，交由适用临床规则判断，不自动改回队列中位数。75 是说明操作的假设值，不是此次从运行库读到的患者结果。

实际产物应是一份逐项对照记录，至少包括本地病例资料版本、指标与值、单位、UKB 字段链接及版本、可比性结论和待处理问题。可使用“可进行量级比较”“待单位对齐”“采样条件待确认”等结论；“临床合理性已确认”需要额外的适用医学依据。公开页的总体汇总也不直接表示男性、女性、特定年龄或冠心病亚组的分布。

## 对 ClinMesh 的参考价值

以下为基于 2026-10-26 当前源码基线 `91f3cce7` 的采用建议，不是已批准需求或当前实现合同。ClinMesh 面向中国公立医院多岗位业务仿真，UK Biobank 面向人群研究；最有价值的交集是字段可解释性、实际覆盖度和纵向证据质量。项目定位见[系统范围](../architecture/system.md)。

| 优先级 | 可借鉴内容 | 当前基础与建议 |
| --- | --- | --- |
| 高 | 字段定义与来源集中展示 | 当前已保存编码、标本、UCUM 单位、成人参考规则、panel 成员及来源版本，并提供完整记录查询；可核对管理入口是否便于集中检查这些信息，复用现有查询与合同，避免另建平行数据字典。依据：[Reference 合同](../../packages/contracts/src/reference-data.ts)、[查询服务](../../apps/server/src/application/reference-data-service.ts)、[检验目录合同](../architecture/fhir-and-commands.md)。 |
| 高 | 展示实际病例覆盖与缺项 | 当前 Reference 汇总统计的是目录记录数；可以补充管理员可见的病例覆盖清单，分别说明参考概念存在、本院服务启用、病例有兼容来源、报告能产生、住院价目已配置。现有住院目录已按开展条件与价目判断可用，新增说明应消费这些机制。依据：[Reference 合同](../../packages/contracts/src/reference-data.ts)、[住院检查服务](../../apps/server/src/application/inpatient-investigations.ts)。 |
| 高 | 合成病例的一致性核查 | 在现有来源校验、病例冻结及隐藏事实隔离之上，针对目标病例检查结果单位、年龄适用性、事件先后、重复检查和来源引用，保留未采集、不适用与不支持的区别。疾病相关证据需要病例依据；队列统计或健康基线不能自动证明某个病例的疾病状态。依据：[病例编译](../../apps/server/src/application/scenario-data/synthea-index-case.ts)、[仿真合同](../architecture/simulation.md)、[成人参考生成](../../apps/server/src/application/laboratory-adult-reference.ts)。 |
| 中 | 纵向病史与多次测量的组织 | 当前已有按临床时间排序的 Visible Source History、私有 Case Truth、Virtual Time 和不可变结果快照；可沿用这些基础设计慢病、多次复诊及住院前后的合成时间线。历史来源与本院当前正式检查需要保持区分，后续随访能力另行明确范围。依据：[仿真合同](../architecture/simulation.md)、[病例编译](../../apps/server/src/application/scenario-data/synthea-index-case.ts)。 |
| 后置 | 人群分布对照及大规模系统测试 | UKB 公开汇总可提供分布检查思路，但其英国、入组时 40—69 岁的研究队列不能直接代表中国全龄医院患者；分位数也不能替代临床参考区间。公开随机合成集可作为未来工程测试候选，其内部一致性限制见上文。此次未下载、接入或运行测试。 |

当前检验规则已经分别保存临床参考界限与仿真采样范围，成人健康结果使用确定性采样；这些事实不能被描述为已经具备经真实人群校准的疾病轨迹。后续若评估分布，应针对明确人群与用途建立独立证据，不能把 UKB 字段的均值、分位数或极值直接写成本院正常范围。依据：[规则 schema](../../packages/contracts/src/reference-data.ts)、[成人生成器](../../apps/server/src/application/laboratory-adult-reference.ts)。

对当前 PCI 住院与 DRG 工作，建议优先把既有病例准备和目录能力汇成可检查的清单：血常规、肾功能、凝血等证据分别来自哪里、何时采集、能否生成本次报告、所需服务与价目是否齐全。底稿、来源病史、实际报告、手术实施、费用及病案继续由各自既有业务合同管理。UKB 不能补齐中国医院收费、医保结算、CHS-DRG 条件规则或实际岗位操作证据；这些应沿用项目的中国标准、Hospital Baseline 和正式 Command。当前 PCI 就绪度的固定核查见[既有研究](2026-10-26-pci-golden-case-readiness.md)，具体状态仍以当前 owning 合同和实现为准。

## 核验限制

主官网 `www.ukbiobank.ac.uk` 在本次 HTTP 访问中返回 Cloudflare 验证页，因此未把未实际读到的主官网内容作为已核实证据；本记录主要依据可直接读取的 Oxford Showcase 与其链接的官方指南。分类、字段与访问政策均可能变更，正式选题或申请时应重新核对对应页面。本文不评价某项具体研究的审批可行性，也不构成临床数据使用或接入授权。
