# Agent Note: 指南发行叠加校验、成人儿科人群隔离与本地 DRG 规则自动物化

Status: implemented

## Problem

固定指南包 `guidelines-2026-10-26-v1` 同时包含 16 份国家卫健委儿童血液病／恶性肿瘤诊疗规范、5 份全人群指南（含设有儿童青少年章节的肥胖症诊疗指南）和 37 份成人心血管／慢病／肿瘤指南，检索、固定页引用和可检索统计缺少患者人群边界时，成人就诊可能召回儿科血液肿瘤指南，儿科或缺失出生日期病例也可能读取成人专用的高血压、乳腺癌短引文与住院 PCI 支架专题；同时 `coronary-20-2021` 物理第 4 页包含图 1 矢量字体控制字符乱码而整页被质量过滤隔离。此外，本地开发准备入口只同步 DRG 精简资料库，未自动物化 `clinmesh.drg-rules.v2` 规则包并与 `deployment/drg/pci-demo-review.json` 校验绑定，且 `.env.example` 仍指向旧 v1 规则路径。需求见 [指南人群隔离与本地准备链路（Issue #466）](https://github.com/CaiZongyuan/clinmesh/issues/466)。

## Decision

保持 [`guideline-release.lock.json`](../../../../apps/server/reference-data/guideline-release.lock.json) 与 [`guideline-release-manifest.json`](../../../../apps/server/reference-data/guideline-release-manifest.json) 的归档字节及原始快照哈希校验不变，在准备阶段通过静态打包的 [`guideline-release-overlay.json`](../../../../apps/server/reference-data/guideline-release-overlay.json) 对 `guidelines-2026-10-26-v1` 施加经完整性验证的元数据与勘误叠加，部分修订补充[固定指南包安装决策](2026-10-26-guideline-release-installation.md)。叠加层强制 1:1 覆盖全部 58 个来源的 `population`（16 项 `pediatric`、4 项 `all`、38 项 `adult`）与 `specialty`，并在官方注册表和 30 项本地冠心病清单同步声明相同字段；对 `coronary-20-2021` 物理第 4 页先核对锁定原文 `beforeSha256`，剥离图 1 矢量字体乱码、保留正文首尾衔接与物理页定位前缀后再核对 `afterSha256` 及可用性规则，哈希不符立即失败关闭。

以医院当地（`Asia/Shanghai`）日历年龄与明确业务参考时间统一计算患者指南人群：满 18 周岁为 `adult`（仅匹配 `adult` 与 `all`），未满 18 周岁为 `pediatric`（仅匹配 `pediatric` 与 `all`），出生日期或业务参考时间缺失、非法或出生日期晚于参考日期时退回 `all-only`（仅匹配 `all`，不使用宿主机挂钟时间推断）；派生副本沿 `derivedFromSourceId` 继承整条来源链的人群边界。`GuidelineCorpus` 将 `population` 纳入 LRU 检索缓存键、检索与固定页读取的 `revision` 摘要及 `guidelineCorpusStatistics` 可检索统计；人群不匹配的来源在 `readReferences` 中以 `population-mismatch` 扣留，不混入表达撤回或损坏的 `inactiveSources`。门诊 `DoctorRecommendationsService`（含内置短引文）与住院 `InpatientGuidelineAdvice` 均按业务就诊或离院／在院参考时间传入患者 `population` 并纳入输入指纹，年龄跨界或缺失时旧建议自动失效；完整运行期合同见[临床业务流程](../../../architecture/clinical-workflows.md#81-门诊闭环)。

保持 `config.ts` 的生产默认严格门禁不变（默认策略可检索全文仍为 0，DRG 规则环境变量默认未启用）。`prepareDevelopmentEnvironment` 复用 `drg-rules-prepare` 的锁定来源检查：合成最小夹具缺失输入时跳过，完整精简资料存在时自动调用 `runDrgRulesPrepare` 物化 `.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2`，并在 `deployment/drg/pci-demo-review.json` 存在时调用 `loadReviewedDrgRules` 校验规则 Manifest 与临床 Reference Release 绑定且将同目录 `NOTICE.md` 复制到物化目录保留署名。当前操作说明见[部署指南](../../../deployment.md#运行时-drg-规则启用)与[本机 PCI 演示部署](../../../../deployment/drg/README.md)。

## Alternatives considered

- 重打并替换 `guidelines-2026-10-26-v1` 归档锁或直接改写固定清单快照：为元数据补充与单页勘误重发整包或改动锁定清单会破坏既有归档与清单 SHA-256 可复现性；使用绑定 `beforeSha256`／`afterSha256` 的静态叠加层可在保留原包字节校验的同时可验证地修正入库内容。
- 仅靠检索词或模型提示词区分成人与儿科：通用症状词（如发热、贫血、感染）仍会把 16 份儿科血液肿瘤规范送入成人上下文并占用八段检索预算；必须在存储检索、固定页回读和内置短引文入口强制隔离。
- 出生日期或业务参考时间缺失时默认按成人或宿主机当前时间放行：会把成人用药剂量、乳腺癌和冠脉介入专题误用于年龄未知病例，也会把宿主机挂钟时间混入持久指纹；退回 `all-only` 同时守住临床安全与确定性边界。
- 在开发环境默认自动启用 DRG 规则或内部测试指南策略：会改变未配置环境的生产默认行为；自动物化并校验规则包但保留显式 `.env` 开关，兼顾开箱准备与严格门禁。

## Consequences

单独启用 `internal-testing`（`allowNonCommercial=false`）时全库 58 份已核验指南均可检索，在成人患者上下文中 16 份儿科血液肿瘤指南召回与可检索计数恒为 0，42 份成人与全人群指南正常参与检索与统计（`default` 默认策略且未声明非商业用途时可检索计数仍为 0）；儿科与出生日期缺失患者不会读取成人短引文或成人 PCI 指南专题。`coronary-20-2021` 第 4 页在保留原始归档校验的前提下恢复全文 FTS 检索与物理页定位可读性，Vite SSR 单文件打包后的 `dist/guideline-prepare.js` 在隔离目录同样携带叠加规则。`pnpm --filter @clinmesh/server db:prepare` 自动就绪、校验并附带 `NOTICE.md` 署名地准备本地 v2 DRG 规则包，开发者只需按 `.env.example` 取消两行注释即可启用本机 PCI DRG 演示。
