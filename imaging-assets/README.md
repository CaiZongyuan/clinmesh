# 影像素材清单

本目录是 ClinMesh 胸片与胸部 CT 平扫阅片闭环使用的影像素材清单。清单公开提交到仓库；像素与来源原始文件不进入 Git，由 `pnpm imaging:sync` 按清单从公开数据源拉取到本地素材目录。各岗位的操作步骤和界面状态含义见 [影像检查使用指南](../docs/imaging.md)，安装、校验、修复与备份步骤见 [部署教程](../docs/deployment.md#影像素材)，设计边界见 [系统架构](../docs/architecture.md) 10.7 节。

## 目录内容

| 路径 | 内容 |
| --- | --- |
| `manifest.json` | 清单身份与数据合集：DOI、许可、署名文字、来源类型和来源读片标注包的地址与哈希 |
| `assets/<assetId>.json` | 一套素材：来源受试者与 Study/Series/Instance UID、每个来源文件的字节数与 SHA-256、转码版本与输出哈希、结构化标注、报告内容修订及其核对记录 |
| `matching.json` | 病例匹配规则：适配条目、未覆盖疾病、可作为来源检查证据的编码 |
| `prompts/chest-report-v1.md` | 报告草稿整理规则；素材条目的 `draft.promptVersion` 指向它 |

## 来源、许可与署名

首批素材全部来自 LIDC-IDRI 合集，经 The Cancer Imaging Archive（TCIA）公开发布，许可为 Creative Commons Attribution 3.0 Unported（CC BY 3.0）。来源数据已由发布方去标识。使用、演示或再发布这些影像（包括截图和录屏）时保留以下署名：

> Armato III, S. G., McLennan, G., Bidaut, L., et al. (2015). Data From LIDC-IDRI [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX
>
> Armato SG 3rd, McLennan G, Bidaut L, et al. The Lung Image Database Consortium (LIDC) and Image Database Resource Initiative (IDRI): A completed reference database of lung nodules on CT scans. Medical Physics, 38: 915–931, 2011. https://doi.org/10.1118/1.3528204
>
> Clark, K., Vendt, B., Smith, K., et al. The Cancer Imaging Archive (TCIA): Maintaining and Operating a Public Information Repository. Journal of Digital Imaging, 26(6): 1045–1057, 2013. https://doi.org/10.1007/s10278-013-9622-7

ClinMesh 对来源像素只做规范化：解码、CT 换算为 HU、胸片统一为 MONOCHROME2 灰度、按层面或图像序号排序并分块存储；不重采样、不裁剪、不做有损压缩。中文报告由 ClinMesh 依据来源读片标注整理，不属于来源数据集。

## 素材与核对记录

| 素材 | 检查 | 来源受试者 | 图像 | 报告印象 | 草稿 | 自动核对 | 复核 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lidc-idri-0094-chest-ct` | 胸部 CT 平扫 | LIDC-IDRI-0094 | CT 385 幅，层面间隔 1 mm | 右肺实性肿块，长径约 31 mm | `claude-opus-5-5` / `chest-report-v1` | 通过（规则版本 1） | JH，2026-10-01，通过；复核人不是放射科医师 |
| `lidc-idri-0094-chest-radiograph` | 胸片 | LIDC-IDRI-0094 | CR 正位 1 幅 | 右肺结节影 | 同上 | 通过 | 同上 |
| `lidc-idri-0028-chest-ct` | 胸部 CT 平扫 | LIDC-IDRI-0028 | CT 141 幅，层面间隔 2.5 mm | 左肺微小结节（直径小于 3 mm） | 同上 | 通过 | 同上 |
| `lidc-idri-0028-chest-radiograph` | 胸片 | LIDC-IDRI-0028 | DX 正位、侧位各 1 幅 | 胸片未见明确肺结节影 | 同上 | 通过 | 同上 |
| `lidc-idri-0668-chest-ct` | 胸部 CT 平扫 | LIDC-IDRI-0668 | CT 120 幅，层面间隔 2.5 mm | 未见明确肺结节 | 同上 | 通过 | 同上 |

每份报告的范围限于“肺结节相关所见”：来源读片标注只覆盖肺结节，报告不描述纵隔、心脏、胸膜、胸壁和骨骼。`lidc-idri-0094-chest-radiograph` 的来源文件没有患者方向标签，素材条目用 `orientation` 显式写明方向，依据是同一受试者 CT 与胸片读片标注的病灶侧别一致。完整的来源 UID、文件哈希、标注和逐项复核结论以各素材条目为准。

## 覆盖矩阵

| 适配条目 | 适用病例 | 胸片 | 胸部 CT 平扫 |
| --- | --- | --- | --- |
| `solitary-lung-mass-male` | 40–79 岁男性，来源有未缓解的疑似或确诊肺癌；来源有条目 `conflictProcedureCodes` 列出的手术史（例如肺移植）时判为冲突，不配片 | 异常：右肺结节影（0094） | 异常：右肺实性肿块（0094） |
| `no-visible-nodule-paired` | 18–89 岁，本次就诊为急性支气管炎，且没有任何阳性条目的疾病 | 阴性：未见结节（0028） | 异常：左肺微小结节（0028） |
| `no-nodule-ct-only` | 同上 | 无素材，申请以未取得结果结束 | 阴性：未见结节（0668） |

同一病例只使用一个适配条目，胸片与 CT 因此来自同一来源受试者。两个阴性条目适用同一类病例，按病例来源哈希稳定地二选一。来源有未缓解的肺炎、新型冠状病毒感染、急性呼吸衰竭或急性呼吸窘迫综合征、急性肺栓塞、慢性阻塞性支气管炎或肺气肿、囊性纤维化、慢性充血性心力衰竭、肋骨骨折的病例不配片；其余没有规则依据的病例同样不配片，不会被当作正常。0028 与 0668 的来源性别和年龄未公开，规则按成年、不限性别使用。

## 新增或修订素材

1. 在 `assets/` 写入素材条目的来源部分，运行 `pnpm imaging:record` 拉取来源文件、转码并写回哈希。
2. 运行 `pnpm imaging:annotate --annotation-directory <来源标注目录>` 从来源读片标注导出结构化标注。
3. 按 `prompts/` 中的规则整理报告草稿，写入 `reports`，并记录 `draft.model` 与 `draft.promptVersion`。
4. 运行 `pnpm imaging:check`，自动核对报告与标注在数量、侧别、图像序号和大小上的一致性。
5. 在管理员“影像覆盖清单 → 复核预览”中对照影像检查报告，再运行 `pnpm imaging:review --asset <id> --reviewer <姓名> --radiologist yes|no --conclusion approved|rejected` 签署。

只有通过自动核对并经人工复核通过的报告内容修订才会发布并进入病例匹配。报告、标注或输出变化后，原复核签署自动失效。
