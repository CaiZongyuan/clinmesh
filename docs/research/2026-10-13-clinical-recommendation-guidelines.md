# 医生诊疗建议的权威指南来源、国内官方许可与冠心病资料核验

本文汇总临床指南的外部获取渠道、21 份国内官方 PDF 的法定使用依据与独立附表边界，以及 32 份冠心病指南资料包的门诊/住院适用性核验。本文只保存外部来源身份、许可边界与原文核验事实；现行指南库、专题注册表与推荐运行合同归 [`clinical-decision-support.md`](../architecture/clinical-decision-support.md) 与 [`deployment.md`](../deployment.md#免费指南全文同步)。

## 一、跨专科外部来源与获取边界（2026-10-16 核验）

| 来源 | 可核实的覆盖与取得方式 | 许可与机器接入边界 |
| --- | --- | --- |
| [中华医学知识库／精选指南库](https://seleguide.yiigle.com/webs/zhinan) 与 [基层集锦（subjectId=116/120/121）](https://www.medjournals.cn/clinic/list.do) | 覆盖内外妇儿、急诊、全科、病理、影像、检验等专科目录（可见 2026 年条目）；官方提供面向第三方的云资源 SDK 产品 | 匿名仅可读目录与首节试读，[用户协议](https://www.medjournals.cn/help/helpcenter.do?to=webagreement)与[版权声明](https://www.medjournals.cn/help/helpcenter.do?to=copyright)禁止非授权抓取、摘编与镜像；整体接入须商谈官方 SDK 授权 |
| [医脉通临床指南](https://guide.medlive.cn/) 与 [丁香园开放平台](https://open.dxy.cn/) | 医脉通提供国内外多学会指南目录；丁香园公开[中国药品说明书 API](https://open.dxy.cn/doc/1401.html) 与[批准适应症 API](https://open.dxy.cn/doc/1501.html) 结构 | 医脉通无公开全库机器 API；丁香园接口需商务询价，其疾病科普接口不能充当临床指南库 |
| [国家卫生健康委官方通知附件](https://www.gov.cn/zhengce/zhengceku/202507/content_7031426.htm) 与 [全国标准信息公共服务平台](https://std.samr.gov.cn/) | 可逐篇取得公开 PDF 附件与核对 `GB` / `GB/T` / `WS/T` 标准现行状态 | 公开下载不等同全库再分发或训练授权；国家标准、推荐性卫生行业标准（`WS/T`）、官方诊疗方案与学会共识四类身份严禁混标 |
| [WHO Guidelines](https://www.who.int/publications/who-guidelines) 与 [IRIS](https://iris.who.int/) | 单篇包含 `ORIGINAL`、`LICENSE` 与官方 `.pdf.txt` 全文文本层 | [WHO 版权政策](https://www.who.int/about/policies/publishing/copyright)多数采用 `CC BY-NC-SA 3.0 IGO`（允许署名非商业科研使用，商业用途与第三方内容另核）；首批已核验并导入成人高血压（2021）、糖尿病二三线用药（2018）、mhGAP（2023）、WHO PEN（2020）、体力活动（2020）共 5 份 `1,297,217` 字节文本 |
| [NICE Syndication API](https://www.nice.org.uk/reusing-our-content/nice-syndication-api) 与 [GIN 国际指南库](https://guidelines.ebmportal.com/) | NICE 提供已发布指南的正式 JSON/XML API；GIN 提供跨国指南索引 | NICE 国际商业与面向终端用户的 AI 调用须单独付费签约（禁训练/微调），[英国开放许可](https://www.nice.org.uk/reusing-our-content/nice-uk-open-content-licence)排除 AI 用途；GIN 不提供正文统一授权 |

首批核验的公开官方单篇原文及药品说明书基线身份：
- [流行性感冒诊疗方案（2025 年版）](https://www.gov.cn/zhengce/zhengceku/202501/content_7000939.htm)（国卫办医急函〔2025〕26 号，SHA-256 `d19f8cba72af08fd11fe17c0d6c3614c9aaac8d8c77fa803e7e9b999abea1125`）：明确抗原阴性不能排除流感、避免盲目使用抗菌药物、奥司他韦需按肾功能调量。
- [WS/T 872—2025 高血压患者健康管理服务规范](https://std.samr.gov.cn/hb/search/stdHBDetailed?id=3FDA4B0B7F8A90F4E06397BE0A0AC65C)（现行推荐性卫生行业标准，SHA-256 `4c099a4a656b72d6524c7acd05359da10b4dd861def402b80acd94a307d410d6`）：规范基层首次评估与随访，不单独规定具体药物固定疗程与盒装数量。
- [乳腺癌诊疗指南（2022 年版）](https://www.nhc.gov.cn/yzygj/c100068/202204/0c1f7d3aca0545abbeb02030ce255930/files/1732863054702_65919.pdf)（SHA-256 `9d3b51f20abe6b80fa2f6273d371c36e14554bfecceb84a274ffe60195c8ffae`）：确立组织病理学确诊地位。
- [苯磺酸氨氯地平片（络活喜）说明书](https://www.viatris.cn/-/media/project/viatris-sites/product-document/02norvasc.pdf)（国药准字 H10950224，SHA-256 `6421355efdba7552efc1d814295f8dcff186dfbb44805af6d78c6673199e5689`）：成人高血压起始 5 mg QD（身材小、虚弱、老年或肝功能不全起始 2.5 mg QD），不等于本院合成 30 片包装规格。

<a id="国内官方指南使用依据核验"></a>

## 二、21 份国内官方指南的使用依据与独立附表核验（2026-10-26 核验）

针对[指南注册表](../../apps/server/reference-data/guideline-sources.json)中 21 份国内官方 PDF（共 1,139 个物理页），逐份结合[《著作权法》（2020 修正）](https://www.gov.cn/guoqing/2021-10/29/content_5647633.htm)第 5/19/24/59 条、[《政府信息公开条例》](https://www.gov.cn/zhengce/content/2019-04/15/content_5382991.htm)、[中国政府网声明](https://www.gov.cn/home/2014-02/23/content_5046258.htm)及[《生成式人工智能服务管理暂行办法》](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)核验：

- **软件状态 `unverified` 的准确含义**：代表项目尚未将整份 PDF 放行至默认对外模型检索，**不代表法律已禁止模型推理引用**，也不能将“无 AI 专用许可证”等同于禁用；同时必须区分“行政印发通知主体”与“附件内引入的第三方受保护图表/评价量表”。
- **5 份综合与慢病/肿瘤国内官方资料（735 页）**：
  - **流感诊疗方案（2025，18 页）**与**[肥胖症诊疗指南（2024，79 页，国卫办医政函〔2024〕382 号）](https://www.gov.cn/zhengce/zhengceku/202410/content_6981734.htm)**：有明确行政印发通知（“请参照执行/组织实施”），提取文本未见外部连续转载附表（肥胖指南仅提及 PHQ-9/GAD-7/SF-36 名称而未转载量表全文）。
  - **[86 个罕见病病种诊疗指南（2025，517 页，国卫办医政函〔2025〕252 号）](https://www.gov.cn/zhengce/zhengceku/202507/content_7031426.htm)**：物理第 358–359 页（图 59-1 改编自 *Am J Perinatol*）与第 419–420 页（图 70-1 改编自 *JACC*）含外部期刊改编图，须与行政主体分开对待。
  - **乳腺癌诊疗指南（2022，113 页）**：物理第 69–79 页含 BI-RADS 分级（[ACR BI-RADS](https://www.acr.org/Clinical-Resources/Reporting-and-Data-Systems/Bi-Rads) 对软件集成设独立许可）、第 86–90 页含 AJCC 第 8 版 pTNM 分期表（[ACS/AJCC](https://www.facs.org/quality-programs/cancer-programs/american-joint-committee-on-cancer/) 明示第三方 AI/LLM 集成需书面授权），外部附表不能随封面统一放行。
  - **WS/T 872—2025（8 页）**：推荐性卫生行业标准，与行政公文通知分别判断。
- **[儿童血液病、恶性肿瘤相关 10 个病种诊疗规范（2019 年版，国卫办医函〔2019〕716 号）](https://www.gov.cn/zhengce/zhengceku/2019-11/15/content_5452452.htm)（16 份 PDF，404 页）**：
  - 10 个病种因淋巴瘤与肉瘤分型拆为 16 个附件（无独立儿童 ALL/AML 文件）。尾码 `01–04`（再障、ITP、血友病、噬血细胞综合征）未命中外部连续附表；尾码 `10`（骨肉瘤 p.30 起）、`11`（尤文肉瘤 p.20 起）、`13`（非横纹肌肉瘤软组织肉瘤 p.24 起）含连续 **RECIST 1.1** 中文附表（[EORTC/RECIST](https://recist.eortc.org/) 限定非商业署名忠实摘录）；尾码 `05–06`、`09–16` 引用 **CTCAE 5.0** 毒副反应表。

<a id="冠心病指南资料包与住院适用性核验"></a>

## 三、冠心病指南资料包与住院 PCI 适用性核验（2026-10-26 / 2026-11-02 核验）

本地冠心病指南资料包共 **32 份 PDF（870 个物理页，2015–2023 年，19 英 13 中）及 1 份 XLSX 题录表**，通过 `clinmesh-guidelines-2026-10-26-v1`（`coronary-*` 32 个来源，其中 `coronary-27-2016` 经离线 OCR 补齐并保留人工待校对边界；2021/2023 ESC 文件含个人教育及非商业限制，按部署用途策略隔离）接入受控评估。

| 核心来源 ID | 文献与核对物理页 | 可支撑的临床与质控边界 | 不能推导出的结论 |
| --- | --- | --- | --- |
| `coronary-32-2018` / `coronary-10-2021` | 2018 中国稳定性冠心病指南（p.1–4, 7–9）；[2021 ACC/AHA/SCAI 血运重建指南](https://doi.org/10.1161/CIR.0000000000001038)（p.11, 14, 35–36） | 择期 PCI 症状与缺血依据；稳定中度狭窄 `FFR > 0.80` 或 `iFR > 0.89` 不应行 PCI（反过度介入依据）；DES 优于 BMS 类别讨论；左主干/复杂病变 IVUS 指导与 OCT 左主干开口例外 | 不能直接映射为本院具体支架品牌型号或固定件数 |
| `coronary-15-2021` / `coronary-27-2016` | [2021 CVIT 血管内超声共识](https://doi.org/10.1007/s12928-021-00824-0)（p.2–6）；2016 中国 PCI 指南（p.4–6） | 近远端参考段、管腔与外弹力膜（EEM）区分；仅电动回撤或纵向成像可测病变长度（手动回撤不可测长）；支架偏小与覆盖不全风险 | 不能反推本院合成演示的 `3.0×18 mm` 为指南强制尺寸 |
| `coronary-20-2021` | [2021 含碘对比剂不良反应防治中国专家共识](https://doi.org/10.3760/cma.j.cn112148-20210315-00224)（p.2–6） | 术前 eGFR 评估、CKD 高危获益风险权衡与肾内科会诊、心衰容量限制，以及零/超低对比剂需术前影像+IVUS+经验术者的严格条件 | 物理第 4 页原提取含控制字符被质量隔离，不输出固定水化速度或剂量 |
| `coronary-24-2021` / 2023 ESC ACS | [2021 中国冠心病 DAPT 共识](https://doi.org/10.3760/cma.j.cn112148-20210125-00088)（p.3–5, 9–10）；2023 ESC ACS（p.19–23, 64–67） | 缺血与出血双风险评估（植入当日不套用满 12 个月无事件者的 DAPT 延长评分）；CCS 与 ACS 疗程及 LDL-C 目标值（`<1.8` vs `<1.4 mmol/L`）按人群与年份区分 | 严禁跨人群拼接成无版本全局常量；SCORE2 不适用于已确诊 CVD 患者 |
| `coronary-02-2021` / `coronary-12-2021` | 2021 ESC/EAPCI 围术期心肌损伤共识（p.2, 4, 10–11）；[2021 ACC PCI 当日出院路径](https://doi.org/10.1016/j.jacc.2020.11.013)（p.4, 8, 10–11） | 区分单纯术后 cTn 升高与伴缺血证据的 type 4a MI（防病案误编码 MI）；出院前双抗落实、穿刺点观察与随访交代 | 当日出院路径排除 STEMI/NSTEMI，不作为所有 PCI 患者的自动出院标准；临床指南不决定院内收费或 DRG 标准 |

实际只读检索探针（8 组固定临床查询）表明：底层 `GuidelineCorpus.search` 虽能稳定返回 ≤8 段、≤48 KiB 的带哈希原文，但纯全文泛搜易被目录页或同词高频文献挤占关键页（如漏召回血运重建 p.35 DES/BMS 条款与 CVIT p.6 测长限制），因此住院与专病场景需要叠加绑定原文哈希与物理页的专题导航层，详见 [LLM-Wiki 主题知识层评估](2026-11-02-llm-wiki-for-inpatient-guidelines.md)。
