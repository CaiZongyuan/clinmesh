# OpenDRG 公开资料包核验

静态包核验日期：2026-10-21；固定病例对照与公开使用说明核验日期：2026-10-25。输入为用户提供的 `opendrg-public-data-2026-10-20.zip`，47,369,362 字节，SHA-256 为 `8aac49166dad394d3c6f2af2b298728363011d02859d6fca101f6c2b4851c33f`。本记录保存外部资料身份、覆盖及有界对照证据，未逐项重新下载全部官方资料，不表示已批准业务启用；需求归属[支付与 DRG 规格](../spec/2026-10-15-drg-prescription-budget.md)，当前运行时合同见[运行时 DRG 规则启用](../deployment.md#运行时-drg-规则启用)。

## 来源与核验方法

ZIP 内统一根目录为 `opendrg-2026-10-20/`。`README.md` 与 `manifest.json` 声明来源为 [OpenDRG CE 演示站](https://www.opendrg.cn/demo/drg/ce/index.html)，采集快照日为 2026-10-20；公开网页可访问不等于内容已获独立官方或使用条件核验。包内没有 LICENSE、官方 PDF 或医保局原文，程序帮助文案说明测算用于院内管理与模拟，正式医保结算以医保部门核定结果为准。

直接读取 ZIP 目录、文本与 JSON，独立计算 ZIP 和 `checksums.json` 中 2,300 个文件的 SHA-256，全部匹配。ZIP 共 2,301 个文件，逐表重新统计 154 份数据集共 766,146 条记录。文件哈希一致证明本包内部完整性，不证明上游规则正确性、官方适用性或使用授权。`catalog/validation.json` 的 423 项校验为制包者报告，不计作本次独立运行结果。

| 证据路径，均相对于包根目录 | 内容 |
| --- | --- |
| `README.md`、`manifest.json` | 来源说明、192 份原始 HTML／JS／数据文件的 URL、采集时间、哈希及排除项 |
| `catalog/coverage.json` | 覆盖与缺失项 |
| `catalog/datasets.json` | 154 份数据集的逐表数量、原始表头与来源 |
| `catalog/schemes.json` | 61 个方案的页面标签、地区、程序和支付表可用性 |
| `catalog/groupers.json` | 32 套实现及参数统计、原程序对应关系 |
| `catalog/rules.json` | 1,475 份规则文本目录 |
| `checksums.json` | 本次独立核验的 2,300 个文件哈希 |
| `config/index.json` | 配置原变量与源码位置 |

## 实际覆盖

| 类别 | 重新核对结果 |
| --- | --- |
| 方案及分组程序 | 61 个方案；39 个有公开程序，共 32 套实现；22 个缺失 |
| 支付及病组表 | 62 张，46,646 条 |
| 字典、映射及关联表 | 65 张，578,247 条 |
| 其他参考 JSON | 27 份，141,253 条 |
| 编码质控 | 499 条 |
| 2.0／3.0 规则文本 | 676／799 个文件 |
| 常用字典 | `ZD_INFO` 34,713 条、`YB_ZD_INFO` 33,304 条、`SS_INFO` 13,744 条、`YB_SS_INFO` 13,777 条 |

`groupers/*.json` 只有 CC、MCC、CCE 与 SS_VALID，不能单独作为完整分组器。完整算法保存在 `raw/*.js`，静态阅读可确认导出 `group_record` 与 `group_record_str`，包含 MDC、ADRG、DRG 判定、CC/MCC 排除与判定说明。输入含性别、年龄、日龄、体重、科室、住院日、离院方式、有顺序的诊断和操作列表；主诊断与主操作顺序会影响结果。输出区分信息校验失败、成功、无法入组和歧义病案。2026-10-21 的静态核验未执行这些函数；下述固定病例对照执行了公开演示程序，但未验证其与正式分组器一致。

字典未提供明确的 ICD 年份／版次、生效期和编码许可元数据；页面“正式版”“征求意见稿”等原标签不能代替官方版本证据。

## CHS-DRG 3.0 与浙江覆盖

| 项目 | CHS-DRG 3.0 | 浙江 |
| --- | --- | --- |
| 方案 | `chs_drg_30`，页面标为“CHS-DRG 3.0正式版” | 仅 `zhejiang_2024`，页面标为“浙江2024(CHS-DRG 2.0)” |
| 完整程序 | `raw/3258.b47bba5f.js` | 无公开完整程序 |
| 参数 | `groupers/chs_drg_30.json`：CC 6,337、MCC 1,581、CCE 21,036、有效操作 9,514 条 | 无对应完整参数包 |
| 病组表 | `payments/chs_drg_30.json` 共 825 组，818 组有参考权重及参考费用，7 组缺失 | 没有浙江病组权重、点数或支付标准表 |
| 生效期与医保身份 | 无明确实施年度，通用表不区分职工／居民 | 页面年度不能替代正式生效期，部分城市参数区分职工／居民 |

CHS-DRG 3.0 原程序 URL 为 `https://www.opendrg.cn/demo/drg/ce/3258.b47bba5f.js`，病组表原始来源为 `https://www.opendrg.cn/demo/drg/ce/2618.cca9d51b.js`，规则文本在 `rules/files/30/`。

浙江四张关联表位于 `dictionaries/`：`SS_ADRG_RULE_ZJ.json` 9,094 条、`ZD_ADRG_RULE_ZJ.json` 29,271 条、`ZD_ADRG_RULE_WK_ZJ.json` 34 条、`ZD_MDC_RULE_WK_ZJ.json` 287 条；没有明确年度，不能组成完整浙江分组器。`config/point-values.json` 有若干浙江城市点值，部分区分职工／居民，但缺年度与生效期；`config/city-base-values.json` 的城市基础数值不能用来填点值或费率缺口。通用 3.0 结果与浙江零散参数不能拼成浙江正式结算方案。

## 支付资料的语义与缺口

包内有地区费率 82 项、点值 70 项、医院系数 57 项及地区基础数值 71 项，部分表按医院等级及职工／居民区分。权重、参考费用、平均费用和支付标准保留各自语义及方案身份；表名未必等于页面年度，例如 `yantai_2024` 页面名称为烟台 2026。

这些数据属于病组参数或统计，不含完整医疗服务项目价格、药耗实际成本或患者医保待遇规则，不能推出患者起付线、封顶线、自付比例、个人账户、年度累计、大病或异地结算。CHS 2.0 的 654 条非空病组中有 26 条缺参考权重或费用；CHS 1.1 表仅含编码和名称。缺项应保留为缺项，不跨方案借参数填充。

## 固定输入与病例对照

2026-10-25 使用以下三份固定输入做有界对照。组层级来自另一个 r3 清洗包，其来源身份与 OpenDRG 快照分别保留；不能把两者都称为同一官方分组器。表中路径以离线输入根目录为起点，SHA-256 对应各文件实际内容。

| 输入 | 相对路径 | SHA-256 |
| --- | --- | --- |
| 公开演示分组程序 | `.data/exports/opendrg-2026-10-20/raw/3258.b47bba5f.js` | `70c00d9ef9b02c1556b8a96ece350f6ce3d1fd2b6f9dd8ea80c2ec7d2ba0f0ff` |
| OpenDRG 参数表 | `.data/exports/opendrg-2026-10-20/groupers/chs_drg_30.json` | `75e10058ed0a30e2f679c68b34b8db8a580c5572b8667f2b9a1bf258de8db3b5` |
| CHS 3.0 组层级投影 | `.data/reference-prepared/r3/drg/groups.jsonl` | `4dba56d298c8a6d07266978498c8e429e6bb4fc456cbf14c1bb45ea016e855cb` |

当日从[原程序 URL](https://www.opendrg.cn/demo/drg/ce/3258.b47bba5f.js)重新取得 2,023,247 字节，SHA-256 与固定快照相同。r3 manifest 将 DRG 源版本记为 `DRG-3.0-updated-pdf-82b5d179`，源 PDF SHA-256 为 `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41`；其 `sourcePublicationVerified` 为 `true`，但上传 PDF 的二进制身份仍标记为 `unknown_export_contains_no_upload_hash`，不能把这个标记补写成已经核实。

独立 oracle 直接执行固定演示 bundle 的 `group_record_str`，不调用 ClinMesh 分组函数生成预期，也不将 ClinMesh 输出回填为 oracle 结果。执行仅在离线 Node.js `vm` 上下文中进行：未向上下文提供 `process`、文件系统或网络 API，不加载演示站界面，不在产品服务中执行；禁用动态字符串及 WebAssembly 代码生成，模块初始化上限 5 秒、单次分组上限 3 秒。输入全部合成，没有调用模型或开展压测。该 oracle 与提取实现共享上游规则来源，因此这种独立执行只能检验两个实现对固定输入是否一致，不能证明共同来源正确，也不等于正式医保分组金标准。

按上游[开发参考](https://www.opendrg.cn/blog/develop.html)，字符串顺序为 `Index,gender,age,ageDay,weight,dept,inHospitalDays,leavingType,zdList,ssList`，可选 `remark` 省略；诊断和操作列表内用 `|` 分隔，首项分别为主诊断和主操作。以下为实际传入 oracle 的完整字符串：男性 `1`、年龄 60 岁、日龄 21915、体重空、科室 `01`、住院 3 天、离院方式 `1`；这些是演示程序输入值，不与其他系统的离院方式编码自动等同。

```text
synthetic-coronary,1,60,21915,,01,3,1,I25.103,
synthetic-stent,1,60,21915,,01,3,1,I25.103,36.0700
synthetic-heart-failure,1,60,21915,,01,3,1,I50.900,
synthetic-pneumonia,1,60,21915,,01,3,1,J18.900,
synthetic-stent-hypertension,1,60,21915,,01,3,1,I25.103|I10.x09,36.0700
synthetic-ptca,1,60,21915,,01,3,1,I25.103,00.6600
synthetic-short-code,1,60,21915,,01,3,1,I50.9,
```

| 合成输入标识 | oracle 状态 | MDC / ADRG / DRG | 关键观察 |
| --- | --- | --- | --- |
| `synthetic-coronary` | 分组成功 | MDCF / FR5 / FR59 | 无有效操作，冠状动脉粥样硬化/血栓/闭塞 |
| `synthetic-stent` | 分组成功 | MDCF / FM3 / FM39 | `36.0700` 为有效主操作，经皮冠状动脉支架植入，不细分 |
| `synthetic-heart-failure` | 分组成功 | MDCF / FR2 / FR25 | 心力衰竭、休克，不伴合并症或并发症 |
| `synthetic-pneumonia` | 分组成功 | MDCE / ES4 / ES45 | 呼吸系统感染/炎症，不伴合并症或并发症 |
| `synthetic-stent-hypertension` | 分组成功 | MDCF / FM3 / FM39 | 增加 `I10.x09` 次诊断后仍为 FM39，CC/MCC 列表均空 |
| `synthetic-ptca` | 分组成功 | MDCF / FR5 / FR59 | `00.6600` 未进入 `ssValidList`，没有改走支架路径 |
| `synthetic-short-code` | 无法入组 | 0000 / 00 / 0000 | 短码 `I50.9` 未自动扩展为 `I50.900` |

结果表只覆盖上述输入与固定演示版本。源表 CCE 中 `I25.103` 为 `43`、`I50.900` 为 `45`、`J18.900` 为 `51`、`I10.x09` 为 `42`；`I10.x09` 在 CC/MCC 中均无条目。`I50.900` 虽在 MCC 中属于组 `45`，但在该例中为主诊断，没有把自身计作次诊断 MCC。增加高血压不改变该支架病例的结果，不能外推为所有次诊断或所有 PCI 路径都不改变分组。

临床诊断的精确字符串另与锁定 `nhc-icd10-clinical@2022.r4` 条目核对，定位如下。该对照证明本次三个代码的存在及文字身份，不构成整个临床版与医保版目录的等价映射。

| 临床码 | 名称 | sourceLocator |
| --- | --- | --- |
| `I25.103` | 冠状动脉粥样硬化性心脏病 | `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12670` |
| `I50.900` | 心力衰竭 | `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:13195` |
| `J18.900` | 肺炎 | `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:14680` |

这四类病例不等于全量核验，尚未覆盖全部主次诊断及操作顺序、联合操作条件、年龄和新生儿条件、CC/MCC 排除、歧义及无法入组边界，也未取得目标地区和年度的正式分组金标准。不得以四例一致解除整个源包的算法、编码兼容或适用性隔离。

## 公开使用说明与未决范围

2026-10-25 从上游直接核对以下使用说明，均返回 HTTP 200。它们补充了包内缺少 LICENSE 的事实，但不把公开可下载、免费医疗机构使用、源程序许可和重新物化分发混为同一范围。

| 上游原始来源 | 当日可见原文及身份 |
| --- | --- |
| [OpenDRG 项目版权说明](https://www.opendrg.cn/blog/copyright.html) | 明示“医疗机构可以免费使用（从官方渠道获取）”；分组器可由医疗机构通过 GitHub 上 OpenDRG 项目或 `opendrg.cn` 获取后免费使用；社区版列“保留版权声明可免费下载使用”。页面 SHA-256：`75afd2e180711ac4c6f3a6496320e69a5c901de16281ae18509d9fada61048fe` |
| [OpenDRG 下载说明](https://www.opendrg.cn/blog/download.html) | 明示医疗机构免费下载使用社区版，链接社区版下载和本地部署。页面 SHA-256：`60fe3b36e4f86b2772e5190d25623212b5a908cba6ae59475b2955b465b0b097` |
| [DRG_JavaScript 固定提交 LICENSE](https://github.com/OpenDRG/DRG_JavaScript/blob/c07e97302942e5f68bc27cdff96d2095873f655a/LICENSE) | 该仓库载有 Apache-2.0；同一提交未见 `chs_drg_30` 路径，未建立该仓库源码与固定 3.0 演示 bundle 的对应关系，不能据此把 Apache-2.0 自动赋予该 bundle |

上述 2026-10-25 核验本身没有生成启用批准。2026-10-27 的[本机 PCI 演示核验](2026-10-27-pci-drg-demo-enablement.md#来源用途)另取得官方社区版商业使用、厂商集成邀请及国家医保局公开研究说明，并重新下载与 r3 哈希相同的官方更新 PDF；据此对固定包的本机合成仿真形成有界受信审核。声明式转换按本地集成的技术方式解释，不宣称固定 bundle 采用 Apache-2.0；该结论不扩大到规则产物再分发、商业产品交付或地方正式结算。r3 与 OpenDRG 的依据分别保留，其他离线资料的隔离不自动解除。实际运行要求仍由[运行时 DRG 规则启用](../deployment.md#运行时-drg-规则启用)拥有。

## 使用前需要验证的事项

- 来源与使用条件、原始文件身份及版本，尤其分组程序与字典的数据使用范围。
- 住院端临床编码与本包所需编码的兼容性；不得通过名称、前缀或相似度默认为匹配。
- 在隔离环境中建立固定输入、固定版本及可解释预期的对照测试，覆盖主次顺序、排除关系、人口属性、无法入组、歧义与缺参；不能仅调用同一个程序两次便称独立验证。
- 本院启用映射、合成待遇、合成医院支付参数与原始参考权重／费用分别标识、固定版本，历史费用及评估可复现。
