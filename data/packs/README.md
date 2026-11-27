# 合成教学包来源

各 `pack.json` 完整内置于服务端，安装过程离线可用。病例身份、教学阈值、院内价格、医保属性与支付参数均为固定模拟数据。`guidelineTopics` 中的 `physicalPage` 按 PDF 文件第一页从 1 计。引文核验使用原件，跨行断词按连续文字转写。

## 影像病理教学门诊

`diagnostic-teaching` 内含一例合成术后随访病例。胸部 CT 的两帧和脂肪组织的一帧均为数学图形绘制的教学示意。胸片与病理更正版本使用纯文本。Vite 开发服务启动和前端构建时，`scripts/prepare-teaching-frames.ts` 通过 Node 标准库离线生成三张 PNG 到 `assets/clinical-public/clinical-frames/`，再按数据包中已签发报告的引用供浏览器加载。

## 综合门诊

四例双语教学病例依照 [#588 的门诊黄金矩阵](https://github.com/CaiZongyuan/clinmesh/issues/588) 编写。病史和检查数值为合成教学内容。胸痛指南引文取自 2021 AHA/ACC 等学会指南物理第 3 页（刊页 e370），Top 10 Take-Home Messages 第 2 项。核验原件 SHA-256 为 `3d889cee60fa1eb173ccf63cac9ab8359c8ceccfa02dc48d162cc44f1ce3a4d0`。[指南原文](https://doi.org/10.1161/CIR.0000000000001029)

`global-general` 1.4.0 中 `g01` 版本 2 的血常规白细胞 15.4 × 10⁹/L 为本项目编写的固定合成教学结果。分析物使用 LOINC 6690-2。医院快照保留其原始安装版本与病例依据。

## 心血管与 PCI

历史底稿固定于 `main` 提交 `6dadcd7139fe5f35403756c7d315b75a963e0b5c` 的 `apps/server/src/application/scenario-data/`。可用 `git show <sha>:<path>` 查阅。以下院内子集保留原病例的判断依据与约束。

- `cardiorenal-authored-case-pack.ts` 的第④、③、①例分别对应 `c01`、`c02`、`c03`。沿用作者指定的病史、心电、超声、多支造影与阶段性检验。`c01` 的 FFR 为 0.74，肌酐从 175 到术后 168、随访 170 µmol/L。`c02` 前降支狭窄 60%，FFR 为 0.86。`c03` 的高敏肌钙蛋白 I 从 0.68 复查至 1.45 ng/mL。
- `standard-medications.ts`、`medication-package-inserts.ts` 与 `pci-data.ts` 提供 19 种扩展常备药和 3 种基础药，以及给药途径、剂型、限量与用药注意事项。包内双语说明为选编摘要。院内药码、价格、基础药医保属性与病人分诊值用于教学。
- 三例病例的公开肾功能基线来自 `cardiorenal-authored-case-pack.ts` 各自的 `visibleHistory`，按原就诊时间转换为 UTC。各例另从 `laboratories` 和 `ecgs` 摘取初诊肌酐与心电结果，为教学检查清单提供当期依据。手术完成后的长期医嘱处理策略为本教学机构的声明式设置。
- `inpatient-surgery-catalog.ts`、`pci-selection-evidence.ts` 提供术式及合成选择组合。0.014 英寸导丝、6F 导管、2.5 × 15 mm 球囊与 3.0 × 18 mm 支架适用于该底稿的测量条件。
- `pci-drg-payment-parameters.ts`、`angiography-drg-payment-parameters.ts` 与 `apps/server/reference-data/drg-rules-source.lock.json` 固定精简 CHS-DRG 3.0 教学组合。FM39 与 FM59 的合成权重分别为 24000、8000 个万分点，基础费率为 500000 分。其余组合留给地区模块显式报告规则缺口。
- WS/T 872—2025 的引文位于物理第 5 页（印刷页 3）第 8.1 条。核验原件 SHA-256 为 `4c099a4a656b72d6524c7acd05359da10b4dd861def402b80acd94a307d410d6`。[国家卫生健康委员会原件](https://www.nhc.gov.cn/fzs/c100048/202509/2f3f7cce449145f8b361e70b3ed4ae9a/files/WS%20T%20872%E2%80%942025-20250930105429913.pdf)
