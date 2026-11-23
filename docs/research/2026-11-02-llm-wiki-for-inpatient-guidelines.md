# LLM-Wiki 主题知识层与住院指南取证评估

核验日期：2026-11-02。本文评估《LLM-Wiki》提出的持久主题知识层在 ClinMesh 指南检索中的适用边界，并保存两个离线实验专题与纯全文泛搜的可复现取证对照。现行产品已基于该验证结论上线共享指南专题注册表（合同见 [`clinical-decision-support.md`](../architecture/clinical-decision-support.md)）；底层指南来源与泛搜探针基线见 [权威指南与冠心病资料核验](2026-10-13-clinical-recommendation-guidelines.md#冠心病指南资料包与住院适用性核验)。

## 方法核心与 ClinMesh 采用边界

参考资料为[飞书《LLM-Wiki》](https://scnwctaxwdzt.feishu.cn/wiki/AqKHwQpSJiBSWJkaEsycSrrnnRe)离线导出稿（SHA-256 `622c313487d9992b56811ced34e34a8312583b8b4485b25dd41fb7d86c40be2e`，保存在本地 `.data/research/LLM-Wiki/`）：围绕单一临床决策问题跨多份原始文献构建可回溯专题页，严格区分结论依据（`sources`）与扩展阅读链接（`links`）。

对 ClinMesh 指南体系的四条硬性约束：
1. **原文库唯一权威**：SQLite 指南原文库继续作为唯一事实源；专题页仅做问题定位与限定语导航，查询时必须同时回读绑定 `sourceHash`、版本与物理页的完整原文段落，内部 `links` 不构成医学依据。
2. **权限与完整性连带失效**：原来源撤回、部署用途策略不允许或目标页因控制字符被质量隔离时，派生专题或对应缺口页同步停用，严禁借人工摘要绕过原文隔离。
3. **保留条件与未知缺口**：不同年份、人群与推荐等级的条款显式并列而不强行合并；具体器械品牌、型号、尺寸、件数与计价规则不由专题页补造（通过 `unsupportedCapabilities` 机器声明）。
4. **无需重型外部设施**：确定性专题注册表配合现有 FTS5 原文回读即可解决泛搜前八段漏召回问题，无需引入图数据库、向量库或独立 Wiki 服务。

## 两专题离线取证对照实验

针对 [PCI 支架类别与尺寸核对](topics/pci-stent.md) 与 [对比剂与肾功能风险](topics/contrast-kidney.md) 两个实验专题，使用可复现脚本 [`apps/server/research/guideline-topic-evaluation.ts`](../../apps/server/research/guideline-topic-evaluation.ts) 在相同只读语料策略（`default + allowLocalEvaluation=true`、上限 8 段 / 48 KiB）下对比纯 `GuidelineCorpus.search` 泛搜与“专题 + 原文页回读”：

| 问题 | 纯泛搜关键证据命中 | 专题辅助关键证据命中 | 泛搜／专题段数 | 泛搜／专题字节 |
| --- | :---: | :---: | :---: | ---: |
| Q1：`PCI stent type drug-eluting DES BMS` | 0/1 | **1/1** | 8 / 4 | 46,018 / 21,396 |
| Q2：`IVUS reference segment lesion length lumen diameter stent sizing` | 0/2 | **2/2** | 7 / 4 | 46,900 / 21,396 |
| Q3：`PCI 含碘对比剂 肾功能 eGFR 水化` | 1/2 | **2/2** | 8 / 4 | 47,166 / 21,226 |
| Q4：`PCI 零对比剂 超低剂量 肾功能不全 IVUS` | 1/1 | **1/1** | 8 / 4 | 47,028 / 21,226 |

- **召回与体积对比**：4 个问题的 6 处关键原文页（含 IVUS/OCT 左主干开口例外、电动回撤测长限制、零对比剂四重前置条件），纯泛搜仅命中 **2/6**，专题辅助命中 **6/6**，且未截断任何原文页即将序列化上下文从约 46 KB 降至约 21 KB。
- **四项负向边界校验（Q5–Q8）**：全部通过——请求具体品牌/四类各一件时显式返回 `unsupportedCapabilities`（Q5）；超出两专题范围的双抗问题返回 `out-of-scope`（Q6）；对比剂共识物理第 4 页因控制字符被质量隔离时保留 `incomplete` 缺口而不输出固定水化速度（Q7）；关闭 `allowLocalEvaluation` 时核心来源与派生专题同步停用（Q8）。

复现命令（结果写入本地 `.data/research/inpatient-guideline-topic-evaluation.json`；加 `--baseline-only` 可单独复现 2/6 漏召回基线）：

```sh
node node_modules/tsx/dist/cli.mjs apps/server/research/guideline-topic-evaluation.ts
```
