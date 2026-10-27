# PCI 演示环境的完整 DRG 包核验

核验日期：2026-10-27。需求为 [#319](https://github.com/CaiZongyuan/clinmesh/issues/319) 及[补充规格 T01](../spec/2026-10-27-pci-golden-demo-readiness.md#t01演示环境的-drg-启用)；业务实现基线为 `80c155e3ce9071a849b524f5ce939d66e966c348`。本记录保留固定来源和实际检查证据；正常操作说明归[本机演示部署](../../deployment/drg/README.md)，审核记录为[固定包审核](../../deployment/drg/pci-demo-review.json)。

## 来源用途

本次核验范围是固定完整 v2 包在本机合成医院中的非临床演示及研究。OpenDRG 公开说明支持社区版下载、私有部署及厂商集成；将 AST 提取后的声明式条件程序作为本地集成的实现方式，是本次部署的技术解释，不冒称上游逐字授予 AST 转换许可。独立 r3 层级则以国家医保局公开研究说明及重新下载的官方更新 PDF 核验。两组来源分别引用，不互相代替。

| 一手来源 | 本轮实际核对的文字及结论 |
| --- | --- |
| [OpenDRG 版权说明](https://www.opendrg.cn/blog/copyright.html) | “商业使用”表格的社区版为“保留版权声明可免费下载使用”；私有化部署“支持”。专业版的商业授权条件不移用到社区版。 |
| [OpenDRG 主项目固定 README](https://github.com/OpenDRG/OpenDRG/blob/945cd81e34cb049c02803005753f0cab998fe0e8/README.md) | “欢迎所有的信息化厂商进行集成”，可集成到医院内部业务系统；方案表含 CHS-DRG 3.0、2026年、825组。 |
| [社区发行固定 README](https://github.com/OpenDRG/OpenDRG.github.io/blob/69e8067efe6815ecf2d9ecbb042840a294c7ff58/README.md)、[本地部署](https://www.opendrg.cn/blog/deploy.html) | 支持 DRG 3.0，下载后不需要网络；提供单机、IIS、Nginx、Docker 部署说明。 |
| [国家医保局配置公开说明](https://www.nhsa.gov.cn/art/2026/9/9/art_14_22070.html) | 配置信息“面向社会公开”，包含“分组规则、具体匹配路径”，欢迎高校、科研院所等开展研究。这里的“开源”标题不等于某种 SPDX 软件许可。 |
| [国家医保局发布通知](https://www.nhsa.gov.cn/art/2026/9/2/art_104_21975.html)、[更正提示](https://www.nhsa.gov.cn/art/2026/9/12/art_14_22123.html) | 官方提供“按病组（DRG）付费3.0版分组方案（更新）.pdf”，更正页明确可重新下载更新件替换使用。 |

本轮重新取得[官方更新 PDF](https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=a7d842bb9ca046868a17a5611f026086.pdf)：HTTP 200、`application/pdf`、7,733,352 字节，SHA-256 为 `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41`，与 r3 `sources.drg.pdfSha256` 及本地保管原件完全一致。只下载规则文档字节并计算哈希，没有渲染或读取医学影像。r3 的 `unknown_export_contains_no_upload_hash` 仍只描述旧 MinerU 上传件没有保留哈希，不否认本轮已匹配的官方更新源。

实际 3.0 bundle 与旧 [DRG_JavaScript 的 Apache-2.0 LICENSE](https://github.com/OpenDRG/DRG_JavaScript/blob/c07e97302942e5f68bc27cdff96d2095873f655a/LICENSE)未建立对应：旧仓库完整树 8,608 项中无 3.0；当前社区发行 chunk 为 `3258.a3eedcb5.js`，不同于本次固定文件。因此审核依据是上述真实用途说明，不能宣称固定 bundle 已取得 Apache-2.0 身份。本次不核准规则产物再分发、商业产品交付或地方正式医保结算；离线大包中其他数据的隔离状态继续保留。[来源署名](../../deployment/drg/NOTICE.md)随本机物化包保留。

## 固定身份

| 项目 | 本次实际身份 / SHA-256 |
| --- | --- |
| 规则 | `clinmesh.drg-rules.v2`，`clinmesh-chs-drg-30-2026-10-25.conditions-v2` |
| 来源版本 | `opendrg-chs-drg-3.0@2026-10-20` |
| Manifest | `23dcd363076bbf1956d62788698819d1693b457c2b383818f209b963b7cc9d44` |
| 原程序 | `70c00d9ef9b02c1556b8a96ece350f6ce3d1fd2b6f9dd8ea80c2ec7d2ba0f0ff` |
| 独立参数表 | `75e10058ed0a30e2f679c68b34b8db8a580c5572b8667f2b9a1bf258de8db3b5` |
| r3 Manifest | `336e28c60bc6b77fc704a19d826c2bd89cad3301f8c46171c29aa9aadf044705` |
| `groups.jsonl` | `4dba56d298c8a6d07266978498c8e429e6bb4fc456cbf14c1bb45ea016e855cb`，1,343 行 |
| `program.json` | `db3ab5d32570f2b0d7bb4b265c3ee016d0a4484d6274238674927fde69d6d296` |
| 实际 published 临床 Release | `clinmesh-cn-health-2026-09-15.r1` |
| 临床 Release contentHash | `1f4693925350643d55914005b531cb4f9472100caa330c390795d3dcfc4ad2d7` |

以上来源及规则文件重新计算实际字节哈希，和[来源锁](../../apps/server/reference-data/drg-rules-source.lock.json)、[离线锁](../../apps/server/reference-data/drg-offline.lock.json)一致。层级实际为 26 MDC / 492 ADRG / 825 DRG；Manifest 的 `adrgCodes` 含 20 个 `*QY` 歧义分支，长度为 512，不能把它误报成 512 个层级 ADRG。

实际完整参考库使用只读连接核对：3 个来源、37,393 个概念、269,110 个药品、99 项检验定义、88 项组合成员。没有读取患者表。正常启动验收使用该完整库的一致副本；没有以少量测试 Reference Release 冒充实际目录。

## 编码与适用性

实际临床库 `I25.103` 为 active，来源 `nhc-icd10-clinical@2022.r4`，定位 `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12670`。两项操作来自[住院操作 owner](../../apps/server/src/application/scenario-data/inpatient-surgery-catalog.ts)：`clinmesh-surgery-subset-2026-10-20`，`hospital-surgery-7@1` 为 `88.5500`，`hospital-surgery-3@1` 为 `36.0700`，原始摘录定位分别为 `3.0!A12309:E12309` 和 `3.0!A3966:E3966`。三码均存在于固定完整程序的精确词表。

这是固定 PCI 全部诊断及实际操作的有界兼容核验，不是全临床版与医保版编码等价映射。其他未知主次编码继续返回不兼容。[PCI 资料摘录](../../apps/server/src/application/scenario-data/pci-data.ts)中的 `clinmesh-cn-health-2026-09-02.r1` 是摘录 provenance，不能替代实际部署 Sep15 Release 的审核绑定。

## 固定病例离线复核

本轮当前实现通过真实 `loadDrgRules` 装载上述完整包，输入为 61 岁男性、唯一主诊断 `I25.103`、无次诊断、住院 3 天，仅改变下表操作。预期沿用独立写明的来源案例，没有用 ClinMesh 输出生成预期。

| 实际操作与主操作 | 状态 | DRG |
| --- | --- | --- |
| 无操作 | grouped | FR59 |
| `88.5500` 为主 | grouped | FM59 |
| `36.0700` 为主，`88.5500` 为次 | grouped | FM39 |
| `88.5500` 为主，`36.0700` 为次 | grouped | FM59 |
| 两项均未选主操作 | invalid-input | 无 |

五组离线探测通过；受信装载器另对实际[审核文件](../../deployment/drg/pci-demo-review.json)与本任务物化目录装载通过。完整算法复用[既有完整来源对照](2026-10-25-drg-condition-verification.md)：同一完整包 13,784 例零差异、825/825 终端、23 项人工预期；本轮没有重跑全部 oracle。不可达 `WR2_2` 继续保留源码集合证明。这些是固定来源一致性证据，有限输入不穷举所有病例或证明地方正式标准。

FM39 继续使用[既有合成参数 owner](../../apps/server/src/application/scenario-data/pci-drg-payment-parameters.ts)：`clinmesh-synthetic-pci-payment@2026-10-25.r1`，500,000 分 × 24,000bp = 1,200,000 分（12,000 元）。FM59 支付参数、成本和完整盈亏继续缺失。

## 正常启动与历史保留

使用正常 `apps/server/src/index.ts` 子进程入口，明确提供独立合成业务库和配置；不继承真实 AI、DSH、Synthea 或支付渠道配置。Windows 仅将测试 stdin 关闭指令转为 SIGTERM 事件，随后执行原入口的 `server.close/runtime.close`；没有替换运行时产品模块。

无配置及未审核守卫首次运行 75.703 秒，5 个场景全部通过：无配置时健康检查、公开 HTTP 创建患者／入院／护士接收／回读均 200，DRG 预分组和推演均为 `409 DRG_RULES_NOT_CONFIGURED`；正常关闭并以原库重启后，既有住院及原幂等回执完整相等、列表仍 1 例。仅规则目录、仅审核路径均以 1 退出；完整包配四项 `pending` 审核也以 1 退出，均未监听。

完整包正向验收使用上述真实审核、正常入口及完整临床库的一致副本，通过公开 HTTP 重放既有 PCI 联合验收，3 项全部通过，86.11 秒。同一次住院实际取得 FR59 → FM59 → FM39；三阶段 `costMissing=true`，FM59 `paymentReference=null` 且 `paymentReferenceMissing=true`，FM39 参数身份及 1,200,000 分参考额均相符。管理员公开 Release 接口和诊断目录回读再次确认实际 Sep15 Release、contentHash 及来源；不是仅比较环境变量。

同例继续完成未知资金恢复、清床归档、医保核定、归档后财务更正与退款。正常关闭并以原业务库及同审核重新启动后，原归档、冻结 FM39、首次结算和原幂等回执完整保留；后续调整没有覆盖原临床和冻结事实。额外从真实审核复制出仅供拒绝测试的损坏配置，分别改动 Manifest 哈希、规则 releaseId、sourceVersion 和临床 referenceReleaseId；4 项全部退出 1 且未监听，93.822 秒，真实审核文件前后哈希相同。

普通医生页面使用 Playwright、1440×1000 视口从 `/inpatient` 打开同一 PCI 住院的三份一致阶段快照，进入“DRG 与费用推演”，三阶段均显示对应正式分组和来源版本，FM39 显示 `¥12,000.00`；FM59 缺参和成本缺失继续可见，页面运行错误为 0。浏览器复核 4.053 秒；Web 构建成功，21.96 秒。三阶段是在同一 HTTP 住院不同时间取得的业务快照，浏览器负责真实页面读取，不冒称本轮从零岗位完整演示或媒体验收。

本机原始进程／HTTP／浏览器 JSON 与账本断言保留在仓库外的 `clinmesh-issue319-startup-evidence`、`clinmesh-issue319-positive-evidence` 和 `clinmesh-issue319-acceptance` 任务目录，不提交业务 SQLite、合成登录文件或生成构建。主工作区另安装相同包、署名及审核并写入成对启用配置；既有 DSH 进程有活动模型任务，未在本任务触发其重启或真实模型调用。实际可用演示由独立正常 Web 环境提供，使用完整参考库和合成业务库；重启步骤见[部署说明](../../deployment/drg/README.md)。本票没有改写原工作区业务或冻结历史。

## 一手响应身份

以下页面及固定 README 均在本轮实际 HTTP 200。HTML 哈希包含完整响应结构，正文按 UTF-8 解码；PDF 为原始下载字节。

| 来源 | 字节数 | SHA-256 |
| --- | --- | --- |
| OpenDRG `copyright.html` | 78,079 | `544cdf973919b6b2f3f6f1c2fb69d204de0a84299d8eee94df0e5fcfaa98854d` |
| OpenDRG `deploy.html` | 80,722 | `df9d15bd705c6110993ca8c86b42a1ebbb4b62b4d4537950b90582c8b0eedb6a` |
| OpenDRG 主 README `945cd81e` | 9,796 | `6479d2b83102c0abc1ead159dc2fd672f7c538d3b213c859a08b079e90c86356` |
| 社区 README `69e8067e` | 3,005 | `b82e5190bb59daf6788984780033fab145fcab65a4114f9c626ef6d2a92ed5ab` |
| 国家医保局 9/9 公开页 | 11,397 | `ffaf30a565ddb399686e44120b5c2526568540d32e42489185163ea67155f295` |
| 国家医保局 9/2 通知页 | 12,358 | `3152de9ec1a8465f9918463c93e32da8464869bb968969efbfbc6bbc9ca97c63` |
| 国家医保局 9/12 更正页 | 11,391 | `3dbc72d0538cb37dd194f885b5ddcc7f46968e6e1d299f4c3daa7c1843ad94a8` |
| 官方更新 PDF | 7,733,352 | `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41` |
