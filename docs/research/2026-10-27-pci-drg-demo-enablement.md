# PCI 演示环境完整 DRG 包与耗材证据边界核验

本文保存固定 CHS-DRG 3.0 v2 规则包在本机 PCI 演示环境中的来源用途核验、固定编码兼容复核，以及 PCI 耗材推荐的临床输入与证据边界（2026-10-27 核验）。部署步骤与署名文件归 [`deployment/drg/README.md`](../../deployment/drg/README.md)、[`pci-demo-review.json`](../../deployment/drg/pci-demo-review.json) 与 [`NOTICE.md`](../../deployment/drg/NOTICE.md)。

<a id="来源用途"></a>

## 一、DRG 包来源用途与官方原件核验

本次核验限定于本机合成医院的非临床演示与研究，两组上游依据分别保留且不宣称规则产物可商业再分发或用于地方正式结算：
- **OpenDRG 社区版集成说明**：[版权说明](https://www.opendrg.cn/blog/copyright.html)（`544cdf97...`）、[主仓库固定 README](https://github.com/OpenDRG/OpenDRG/blob/945cd81e34cb049c02803005753f0cab998fe0e8/README.md)（`6479d2b8...`，“欢迎信息化厂商集成到医院内部系统”）与[本地部署说明](https://www.opendrg.cn/blog/deploy.html)（`df9d15bd...`）支持社区版保留声明免费下载与单机私有部署；不将旧 `DRG_JavaScript` 的 Apache-2.0 移花接木到 3.0 bundle。
- **国家医保局 3.0 官方更新 PDF 一致性**：重新下载[官方更新 PDF](https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=a7d842bb9ca046868a17a5611f026086.pdf)（`7,733,352` 字节），实测 SHA-256 为 `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41`，与 r3 `sources.drg.pdfSha256` 完全一致。

## 二、固定身份与 PCI 三阶段分组复核

锁定规则包 `clinmesh-chs-drg-30-2026-10-25.conditions-v2`（Manifest `23dcd36363076bbf1956d62788698819d1693b457c2b383818f209b963b7cc9d44`，哈希与 [`drg-rules-source.lock.json`](../../apps/server/reference-data/drg-rules-source.lock.json) 及 [`drg-offline.lock.json`](../../apps/server/reference-data/drg-offline.lock.json) 一致）与实际发布的临床参考库 `clinmesh-cn-health-2026-09-15.r1`（contentHash `1f4693925350643d55914005b531cb4f9472100caa330c390795d3dcfc4ad2d7`）联调：

- **有界编码兼容**：主诊断 `I25.103`（`nhc-icd10-clinical@2022.r4:diagnosis:12670`）及两项本院手术目录操作 `88.5500`（单导管冠脉造影，`3.0!A12309:E12309`）、`36.0700`（药物洗脱冠脉支架置入，`3.0!A3966:E3966`，见 [`inpatient-surgery-catalog.ts`](../../apps/server/src/application/scenario-data/inpatient-surgery-catalog.ts)）均精确命中 `program.json` 词表（Manifest 的 `adrgCodes` 含 20 个 `*QY` 歧义分支共 512 项，层级 ADRG 仍为 492 个）。
- **PCI 黄金病例阶段转换**：61 岁男性主诊断 `I25.103` 无操作入 `FR59` → 造影 `88.5500` 为主操作入 `FM59`（支付参数缺失保持 `null`） → 支架 `36.0700` 为主、`88.5500` 为次入 `FM39`（匹配合成支付参数 [`pci-drg-payment-parameters.ts`](../../apps/server/src/application/scenario-data/pci-drg-payment-parameters.ts) `500,000 分 × 24,000bp = ¥12,000.00`；若反以 `88.5500` 为主则仍落 `FM59`，两项均未标主操作返回 `invalid-input`）。无配置或未审核 `pending` 时服务启动或接口按守卫拒绝，归档后重启完整保留冻结 `FM39` 与原回执。

## 三、PCI 耗材推荐的临床输入与证据边界

结合 [CVIT 2021 血管内超声专家共识](https://link.springer.com/article/10.1007/s12928-021-00824-0) 与项目耗材模型（[`pci-data.ts`](../../apps/server/src/application/scenario-data/pci-data.ts)、[`cardiovascular-materials.ts`](../../apps/server/src/application/scenario-data/cardiovascular-materials.ts)、[`inpatient-surgery.ts`](../../packages/contracts/src/inpatient-surgery.ts)）核验：
- **测量语义不可混用**：病变直径、近远端参考血管管腔/外弹力膜（EEM）直径与病变长度具有严格方法学边界（如无电动回撤系统的手动回撤不可测长），不能把单一“直径”数字直接等同于器械规格，未知测量必须保持未知。
- **合成方案不等于临床 IFU**：本院四项心血管耗材（`0.014` 导丝、`6F` 导引导管、`2.5×15 mm` 预扩球囊、`3.0×18 mm` 药物洗脱支架）及单枚支架底稿属于显式标记的**有界合成适配方案**，未接入真实器械注册说明书（IFU）与跨品牌组合兼容认证；因此耗材预计只比较医生已确认方向与有限合成兼容候选并展示价格口径，严禁从 DRG 支付参考额倒推耗材规格或数量。
