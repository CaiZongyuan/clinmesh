# 合成医院数据来源研究

## 范围与结论

本文核验 ClinMesh 能否使用 Synthea 生成中国患者数据，以及中国公立医院仿真还需要哪些数据来源。研究只判断外部项目和公开数据的能力边界，不定义 ClinMesh 当前实现。

官方 Synthea 当前不能开箱生成中国患者数据。它可以作为可替换的患者临床历史素材生成器，但完整 Scenario 仍需组合本地化患者身份、医院主数据、地域参考数据、业务事件、外部系统行为和评测真值。

## Synthea 能力边界

截至 2026-08-21，Synthea 最新正式版是 [`v4.0.0`](https://github.com/synthetichealth/synthea/releases/tag/v4.0.0)。官方 [`synthea-international`](https://github.com/synthetichealth/synthea-international) 没有中国数据目录，其 README 还说明多数地域包仍使用美国姓名和电话规则，部分数据并不完整。

Synthea 的 [Other Areas](https://github.com/synthetichealth/synthea/wiki/Other-Areas) 指南要求新地域自行提供人口统计、邮政编码、时区、医疗机构、姓名、费用和支付方数据，并列出社会保障号、电话号码和 FHIR profile 等尚需本地化的内容。主仓库的 [`names.yml`](https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/resources/names.yml) 只有英文和西班牙文姓名集合；语言映射中的中文代码不构成中国人口模型。

官方 README 只声明 FHIR R4、STU3 和 DSTU2 输出，当前 R4 exporter 使用 [`FhirContext.forR4()`](https://github.com/synthetichealth/synthea/blob/d9d07a6eef91ee5144293b42ab64224d84d124f8/src/main/java/org/mitre/synthea/export/FhirR4.java)。ClinMesh 固定使用 FHIR R5 `5.0.0`，因此不能直接导入 Synthea Bundle；接入层必须转换版本、重建引用并执行项目 profile 和业务不变量校验。

Synthea 的 provider、payer 和 claim 模型以美国机构标识、Medicare、Medicaid、premium、copay、deductible 和 coinsurance 为中心。它能够生成 Organization、Location、Practitioner、Coverage、Claim 和 ExplanationOfBenefit 等素材，但不能表达中国医院的科室树、排班号源、岗位权限、床位、处方审核、药房库存、院内支付和医保结算状态机。官方 [FHIR Transaction Bundles](https://github.com/synthetichealth/synthea/wiki/FHIR-Transaction-Bundles) 指南还要求先导入机构与人员资源，患者 Bundle 不是独立、可直接移植的数据单元。

可重复生成需要固定具体 Synthea commit、人口和临床种子、参考时间、结束时间、配置、模块、历史窗口与时区；种子本身不足以复现。完整条件见官方 [Recreating a Dataset](https://github.com/synthetichealth/synthea/wiki/Recreating-a-Dataset) 指南。

Synthea 与 `synthea-international` 使用 Apache-2.0，但其引用的地图、地理和临床术语可能具有独立许可。项目许可证不能替代对每个输入数据集和术语包的许可检查。

## 数据来源分层

| 数据类别 | 可参考的一手来源 | ClinMesh 必须合成或派生的内容 |
| --- | --- | --- |
| 患者临床历史 | Synthea 的疾病模块和 FHIR R4 输出 | 中国人口身份、R5 转换、本地术语映射、缺失与录入异常 |
| 人口与地域分布 | [第七次全国人口普查](https://www.stats.gov.cn/sj/pcsj/rkpc/7rp/indexch.htm)等国家统计局汇总表；行政区划国家标准 | 姓名、证件、电话、详细地址、家庭关系和患者级联合分布 |
| 医院组织与人员 | [国家卫生健康标准网](https://hbba.sacinfo.org.cn/stdList)发布的卫生信息分类和交换标准 | 虚构医院名称、科室树、人员、资质标识、岗位、排班和权限范围 |
| 疾病与手术 | [国家标准全文公开系统](https://openstd.samr.gov.cn/bzgk/gb/newGbInfo?hcno=8127A7785CA677952F9DA062463CBC41)的 GB/T 14396-2016；[国家医保信息业务编码标准数据库](https://code.nhsa.gov.cn/) | 患者诊断组合、病程、并发症及本院别名映射 |
| 药品、耗材与器械 | 国家医保信息业务编码标准数据库；[国家药监局医疗器械唯一标识数据共享](https://udi.nmpa.gov.cn/download.html) | 本院目录、供应商、批次、效期、库存移动及全部虚构业务标识 |
| 诊疗项目与价格 | [国家医保局医疗服务价格项目](https://www.nhsa.gov.cn/col/col201/index.html)及地方医保部门公开政策 | 固定地区和日期的本院价格表、调价、减免、欠费和结算事件 |
| 检验、检查与文书 | 国家卫生健康标准网发布的检验、报告和电子病历共享文档标准 | 本院可开立项目、标本与设备、结果值、报告结论和全部病历正文 |
| 号源、床位与队列 | 卫生信息交互标准只提供部分交换语义 | 容量日历、到诊、爽约、服务时长、排队、占床、转床和清床事件 |
| 收费、支付与医保 | 医保目录、结算清单代码和地方政策 | Charge Item、Payment Transaction、退款、医保请求与响应、拒付、对账和凭证 |
| 权限、审计与评分 | 卫生信息安全和国家网络安全标准 | User Account、Workspace Membership、岗位范围、审计事件、Hidden Fact 和评分规则 |

官方目录负责提供代码和政策参考，不能替代医院运行事实。患者病情、队列、库存、费用和外部响应必须来自同一组确定性真值与事件，否则不同页面会显示彼此矛盾的状态。

人口普查、卫生统计公报和标准中的汇总分布只能校准生成器，不能反推或拼接个人记录。姓名、证件号、电话号码和详细地址应使用项目维护的虚构词表与校验规则生成，并主动避开真实可投递地址和真实机构联系方式。

## 国家药监局数据

国家药监局提供[药品数据查询](https://www.nmpa.gov.cn/datasearch/home-index.html)，可用于核对药品批准信息；截至 2026 年 8 月 21 日，未在该入口发现有文档支持的结构化批量下载或开放再分发许可。它适合作为批准文号、注册名称、剂型、规格和生产企业等字段的人工或受控离线核验来源，不能成为 ClinMesh 运行时依赖。医保药品代码、药品批准信息和医院内部药品目录属于不同层次，不能按名称直接合并。

[医疗器械唯一标识数据库的数据共享页](https://udi.nmpa.gov.cn/download.html)则明确提供每日、每周、每月和全量 ZIP，并提供相应 RSS 地址；页面在 2026 年 8 月 21 日显示 `UDID_FULL_RELEASE_20260801.zip` 及后续增量包。这证明 UDI 有机器可取得的发布机制，但不自动授予重新打包发布的权利，也不覆盖药品、医院库存或单件流通事件。ClinMesh 可以为获授权的本地文件实现版本化 UDI adapter；场景中的库存批号、序列号和追溯事件仍必须完全合成。

## 国家医保药品编码平台

国家医保局将这项数据的正式名称表述为“医保药品分类与代码数据库”。官方的[2024 年五问五答](https://www.nhsa.gov.cn/art/2024/11/29/art_14_14901.html)将它定位为全国医保业务的统一分类与代码，用于异地就医结算、医保招采和支付等业务；它不是医院药品目录、库存数据或价格表。[2019 年编码规则](https://www.nhsa.gov.cn/art/2019/6/27/art_53_1436.html)规定西药代码由 6 部分共 23 位组成，中成药代码由 5 部分共 20 位组成；代码内含类别、名称、剂型或规格包装及企业等分段。

[`sysflag=1386`](https://code.nhsa.gov.cn/search.html?sysflag=1386) 对应“医保药品分类与代码数据库更新（截至 2026 年 8 月 7 日维护）”这一时点快照，而不是永久指向“最新数据”的稳定标识。官方[2026 年 8 月 19 日更新通知](https://code.nhsa.gov.cn/toDetail.html?infoId=5963&CatalogId=2)说明该批审核范围为 8 月 1 日至 8 月 7 日的维护信息。页面内部使用 `batchNumber=20260819`，数据行中的 `version` 也是 `20260819`；该值是发布批次，不应被当作数据截止日或政策生效日。

公开页面不要求账号登录。快照页面可以按药品代码、药品企业、注册名称和批准文号查询；它显示药品代码、注册名称、注册剂型、注册规格、商品名称、实际剂型、实际规格、包装材质、最小包装数量、最小制剂单位、最小包装单位、有无追溯码、药品企业、批准文号和药品本位码，并关联展示国家医保药品目录的甲乙类、编号、药品名称、剂型和备注。“医保药品分类与代码”和“国家医保药品目录”因此是两个独立概念，ClinMesh 不应用一个字段同时表示产品代码和医保支付属性。

平台还提供不带批次的当前[西药中成药信息公开查询](https://code.nhsa.gov.cn/toSearch.html?sysflag=1003)，其“药品分类和通用名查询”还显示药品类别代码与名称、通用名代码与名称、剂型代码与名称。当前查询初始不载入数据，必须至少提供一个查询条件；需要维护、申诉或提交数据时则进入平台的药品维护账号登录流程。

### 查询、分页与下载

浏览器网络请求显示，快照页的表格通过 `POST https://code.nhsa.gov.cn/yp/getPublishGoodsDataInfo.html` 加载。请求是 `application/x-www-form-urlencoded`，业务参数为 `goodsCode`、`companyNameSc`、`registeredProductName`、`approvalCode` 和 `batchNumber`，分页参数为 `rows`、`page`、`sidx` 和 `sord`；响应使用 jqGrid 形状的 `records`、`total`、`rows` 和 `page`。截至 2026 年 8 月 21 日，`batchNumber=20260819` 返回 280,531 条记录，快照页只提供每页 50 或 100 条；当前查询页提供每页 15、30、50 或 100 条。

该 `POST` 端点是网页内部实现，不是官方发布的公共 API：截至 2026 年 8 月 21 日，平台、操作指引和国家医保局公开页面中未发现接口文档、稳定性或兼容性承诺、机器客户端认证方式、调用配额或错误合同。响应还包含 `indication`、`usageDosage`、`drugValidityDate`、`marketState`、`isOtc` 和 `businessLicense` 等页面未展示字段，这些字段同样不是已公布的数据合同。结论是“网页会用 JSON 分页”，而不是“平台提供可依赖的数据 API”。

快照页弹窗提供名为“医保药品分类与代码数据（西药、中成药）截至 2026 年 8 月 7 日.pdf”的文件，页面标注 MD5 为 `299cf4249e45201aa125dd7cfe4df4bb`。这是官方可见的批量快照，但格式是 PDF；未发现 CSV、Excel、数据库 dump 或有文档支持的批量 JSON 下载。因此可查询、可由浏览器自动分页和可获得结构化批量数据是三个不同的能力。

| 能力 | 核验结论 |
| --- | --- |
| 可查询 | 是。快照和当前公开查询都不需要账号登录。 |
| 可自动获取 | 有限。浏览器可分页请求 JSON，也可下载 PDF，但前者是未公开成合同的网页端点，后者不是结构化数据包。 |
| 可再分发 | 未获授权。页面未附开放数据许可，网站声明还限制商业性原版原式转载和第三方内容的擅自转载。 |

### 平台目录范围

[平台首页](https://code.nhsa.gov.cn/) 在 2026 年 8 月 21 日显示了下列公开快速查询入口：

| 公开查询 | `sysflag` |
| --- | --- |
| [中药饮片信息](https://code.nhsa.gov.cn/toSearch.html?sysflag=1001) | `1001` |
| [医疗机构制剂信息](https://code.nhsa.gov.cn/toSearch.html?sysflag=1002) | `1002` |
| [西药中成药信息](https://code.nhsa.gov.cn/toSearch.html?sysflag=1003) | `1003` |
| [医用耗材信息](https://code.nhsa.gov.cn/toSearch.html?sysflag=1004) | `1004` |
| [中药配方颗粒信息](https://code.nhsa.gov.cn/toSearch.html?sysflag=1005) | `1005` |
| [体外诊断试剂信息](https://code.nhsa.gov.cn/toSearch.html?sysflag=1006) | `1006` |

首页另有医保疾病诊断与手术操作、医疗服务价格项目、医保系统单位与工作人员、定点医疗机构与各类人员、定点零售药店与药师、慢特病与按病种结算及日间手术病种、医保结算清单、长期护理保险和委托承办机构等维护入口。首页当日还列出医保药品 `1386`、体外诊断试剂 [`1387`](https://code.nhsa.gov.cn/search.html?sysflag=1387) 和医用耗材 [`1388`](https://code.nhsa.gov.cn/search.html?sysflag=1388) 三个最新发布快照。这些入口只证明平台的目录范围，不代表每个目录都有公开的机器可读批量下载。

### 使用和再分发边界

国家医保局的[网站声明](https://www.nhsa.gov.cn/col/col40/index.html)明确说明网站内容版权归网站所属，禁止媒体、互联网站和商业机构商业性地原版原式转载，禁止歪曲或篡改；其他单位提供的信息不得擅自转载，需直接获得提供单位授权。声明还规定网站资料与纸质文本不一致时以纸质文本为准。公开查询页和 PDF 上未发现允许整库再分发的开放数据许可，因此“可匿名查询”和“可提交到开源仓库或用于商业镜像”不等价。

ClinMesh 不应在运行时调用网页内部端点，也不应把官方 PDF 或完整查询结果提交到 Git。推荐的边界是一个离线 `nhsa-reference` adapter：它只从用户已获合法使用权的本地参考包导入数据，记录官方 URL、发布标题、发布日、数据截止日、批次号、官方 MD5、实际内容哈希、获取时间、许可状态和转换器版本。构建过程再生成一个小型本院药品目录，分开保存医保药品代码、批准文号、药品本位码和医保目录属性，而本院内部码、供应商、进价与零售价、批次、效期、库存和库存移动仍全部合成。未确认许可时，仓库只保存 schema、映射和来源元数据，不保存官方数据子集。

## OpenHIS 的数据边界

本地参考的 OpenHIS 源码不能作为可直接导入的中国药品、耗材或价格数据集。参考仓顶层使用 GPL-3.0，后端子仓声明 LGPL-3.0-or-later；软件许可证没有授予仓内第三方目录数据的再分发权。仓内没有国家药品、医保或 UDI 的 CSV、Excel 或数据库快照，也没有为演示 seed 标注权威来源或数据许可证。

OpenHIS 的价值在模型和导入流程。`med_medication_definition` 覆盖药品名称、厂家、批准文号、国家码、医保码、剂型、途径、频次和多级单位换算；`adm_device_definition`、`adm_charge_item_definition`、`wkf_activity_definition` 和 `wkf_inventory_item` 分别表达耗材、价目、诊疗项目和库存批次。ClinMesh 可以据此检查字段覆盖，但应使用类型化引用、明确的数据所有权和 FHIR R5 映射重新实现，不能复制其任意表名多态引用或 PostgreSQL 物理模型。

药品、耗材和诊疗项目的 Excel 导入采用版本化模板、列指纹、必填校验、行数上限、错误标注和批次审计，这个模式值得保留。OpenHIS 会把部分未知单位、途径或剂型自动补进本地术语；ClinMesh 应改为 quarantine 和人工映射，避免一次目录导入静默改变受控术语。给药频次还包含周期、执行时点和跨日语义，说明它是可执行的医院配置，不是只有显示文本的国家字典。

吉林医保模块通过需要机构授权的 13xx/1312 等接口同步国家和机构目录，包含下载游标、不可变国家镜像、原始来源行、机构 overlay、人工对码和应用审计。它不是 `code.nhsa.gov.cn` 的公开抓取器，其协议列位和匹配权重也不能当作官方规范。可借鉴的分层是 `SourceArtifact -> ExternalCatalogRelease/Entry -> HospitalCatalogItem -> CatalogMapping -> PriceSchedule -> InventoryLot`；每层分别记录 authority、jurisdiction、协议或目录版本、有效期、哈希、解析器版本、来源位置和许可状态。

OpenHIS 的开发 seed 含少量药品、价格、患者标识形态数据和库存示例，来源不足且存在看似真实的品牌、厂家或标识，不能整包复制。其吉林医保配置还含疑似真实的机构接入信息和凭证；ClinMesh 不读取或复用这些值，参考仓维护者应从当前版本和 Git 历史移除相关内容、吊销并轮换凭证并执行 secret scan。

## 来源处置等级

| 等级 | 允许用途 | 典型来源 | 仓库内容 |
| --- | --- | --- | --- |
| 可随项目使用 | 许可证兼容且逐项核验后，可固定生成器代码或必要输入 | Synthea 代码与自有合成规则 | 固定版本、许可证、输入和测试 |
| 受控离线导入 | 用户已取得合法使用权时，由 adapter 导入本地 artifact | 医保目录、NMPA UDI 或其他官方发布包 | schema、adapter、来源 manifest 和哈希，不提交未授权原始行 |
| 仅参考与人工映射 | 用于核对字段、代码或政策，不做自动同步 | 药品查询、药典、地方价格政策、OpenHIS 模型 | 人工审核的场景最小映射及引用 |
| 禁止进入 | 不得读取到生成管线、fixture、日志或版本历史 | 真实患者、真实交易、真实追溯码、真实机构凭证和来源不明 seed | 无；扫描发现即阻断发布 |

## 地域与使用限制

医疗服务价格和医保规则具有地区与生效日期。国家医保局提供[各省医疗服务价格项目映射入口](https://www.nhsa.gov.cn/art/2026/6/26/art_14_21122.html)，不能据此构造一个没有地域和日期的“全国统一价格表”。

公开查询或下载不等于允许把完整数据重新提交到开源仓库。国家医保局的[网站声明](https://www.nhsa.gov.cn/col/col40/index.html)对转载和商业使用设有限制；国家卫生健康标准网和国家药监局数据也需要在再分发前确认具体许可。许可未确认的目录应由安装或构建流程从官方来源获取，仓库只保存合成子集、映射规则、来源元数据和内容哈希。

所有患者、工作人员、医院业务标识、医保交易号、支付凭证和病历正文必须完全合成。公开目录中的真实机构或产品条目也不能与合成人物组合成可能被误认为真实就诊的记录。

## 对 Scenario 构建的影响

证据支持把 Synthea 放在离线输入边界，而不是运行时依赖或唯一 seed。一个可复现的 Scenario 构建过程至少需要固定 Hospital Baseline、Reference Data Package、生成器和映射版本、随机种子、虚拟时间、输入哈希及许可元数据，并在导入前验证所有引用、金额、数量、状态和项目 FHIR R5 profile。
