# Agent Note: 免费指南全文库、固定包叠加层、共享正文与人群隔离

Status: implemented

## Problem

固定短引文无法支撑多病种与冠脉介入扩展，但“网络免费可下载”并不等同于允许输入任意模型服务；若仅在开发者本机保留原件与 SQLite，克隆环境无法复现同一套经 OCR 校对的指南语料；若固定包与本地验证双入口各自存储全文，会重复占用索引与检索八段预算；同时 `guidelines-2026-10-26-v1` 内含 16 份儿科血液肿瘤规范、5 份全人群指南与 37 份成人指南，缺少患者年龄人群隔离会导致成人胸痛召回儿科规范或儿科／年龄未知病例误读成人心血管短引文与 PCI 支架专题。

## Decision

在独立指南 SQLite（FTS5 trigram）上建立分层用途治理、锁定包叠加安装、共享正文去重与上海日历年龄人群隔离机制，当前运行与运维合同分别见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)、[存储与事务](../../../architecture/storage.md)及[部署指南](../../../deployment.md)，版权与取证核验见[临床推荐指南研究](../../../research/2026-10-13-clinical-recommendation-guidelines.md)：

1. **来源许可与部署用途四层隔离及维护者停用优先**：严格区分文献原始许可与部署启用策略——默认策略仅放行已核实开放用途；非商业来源（如 WHO）须显式声明适用非商业部署才启用；显式 `internal-testing` 策略启用锁定固定包中正文核验通过的 `active` 资料（未确认控制字符异常段落在限额前隔离）；`local-evaluation-` 独立命名空间支持受控本地流程验证而不扩大官方 HTTPS 下载白名单。副本通过 `derivedFromSourceId` 继承原来源撤回／替代限制；维护者发布的停用限制独立持久化且优先级高于固定包重导，任一引用依据失活时读取与幂等重放立即携带 `hidePreviousResults: true` 隐藏旧派生建议。
2. **锁定资料包事务导入、静态叠加校验与共享正文去重**：原件、派生正文与校对定位由 [`guideline-release.lock.json`](../../../../apps/server/reference-data/guideline-release.lock.json) 与清单锁定，安装时在保持已打开只读连接可用的单事务内整包导入并执行 FTS 完整性核验（准备器在临时目录复制稳定主库与 WAL 校验，不污染运行连接）。在不改动锁定归档字节的前提下，准备阶段应用 [`guideline-release-overlay.json`](../../../../apps/server/reference-data/guideline-release-overlay.json) 强制 1:1 补齐全部 58 项来源的 `population`／`specialty`，并以 `beforeSha256`／`afterSha256` 校验修复 `coronary-20-2021` 第 4 页矢量字体乱码。数据库将来源记录与按“格式 + 原件哈希 + 版本 + 有序定位与精确正文”确定的物理正文分离，多入口同文只存一份正文与索引，检索在同一相关性层按独立正文分轮覆盖多病种来源。
3. **上海日历年龄人群隔离与开发环境 DRG v2 自动物化**：统一按 `Asia/Shanghai` 业务参考时间计算患者日历年龄，分为 `adult`（满 18 周岁，匹配 `adult + all`）、`pediatric`（未满 18 周岁，匹配 `pediatric + all`）与出生日期／参考时间缺失或非法时的保守兜底 `all-only`（仅匹配 `all`，绝不读取宿主机挂钟或默认按成人放行）。`population` 纳入检索缓存键、全库 `revision` 与门诊／住院建议输入指纹，不匹配来源以 `population-mismatch` 独立扣留。同时 `prepareDevelopmentEnvironment` 在完整 DRG 精简资料存在时自动物化并校验本地 `clinmesh.drg-rules.v2` 规则包与 `NOTICE.md` 署名，保持运行时启用开关显式受控。

## Alternatives considered

- **在临床请求内实时抓取网页、将大体积 PDF／SQLite 提交 Git，或把所有资料一律标为开放许可**：分别引入网络漂移、仓库膨胀与真实权利事实失真。
- **为补齐人群元数据与单页勘误重打替换 `guidelines-2026-10-26-v1` 归档，或仅在返回结果层去重共享来源**：重打整包破坏既有归档哈希可复现性，仅结果去重仍留下双倍 FTS 存储与统计失真。
- **仅靠提示词区分成人与儿科，或在缺失出生日期时默认按成人处理**：通用症状词仍会让儿科指南挤占八段预算，未知年龄放行成人剂量与介入专题则违背医疗安全边界。

## Consequences

克隆仓库后可通过固定资料包与静态叠加层确定性复现全部 58 份已核验指南及单页勘误，成人就诊中 16 份儿科规范召回恒为 0，儿科或年龄未知患者亦不会误触成人专用短引文与 PCI 专题（跨门诊／住院六个固定专题的零模型同步读取见[共享指南专题注册表](2026-11-17-shared-guideline-topic-registry.md)）。PDF 物理页提取只保证字符与页码可核对，不替代复杂表格与临床个体化审校。
