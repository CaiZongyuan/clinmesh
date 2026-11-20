# Agent Note: 共享指南专题注册表、住院手术单解耦与只读指南参考意见边界

Status: implemented

## Problem

住院冠脉介入准备阶段若将指南参考意见与具体耗材确认绑死在同一完整性门槛下，患者尚未完成血管测量或目录缺具体规格时连指南支持的器械类别与缺项提示也无法产出；更进一步，若数据库表将住院指南意见强绑定非空 `request_id`（外键指向手术申请单），则造影前对比剂肾损伤水化评估、临界病变 `FFR > 0.80` 不行 PCI 的保守治疗、双抗二级预防及合并糖肾调药等无手术申请单的内科住院场景完全无法生成意见。同时，门诊与住院缺少零模型开销的固定专题原文同步核对入口，且若把成功生成的指南原文直接塞进通用 Command 持久回执 `result`，在指南来源撤回后重放回执就会绕过来源治理检查。

## Decision

建立门诊与住院同源复用的确定性 `Guideline Topic` 注册表、可空手术单关联与受治理的只读参考意见机制，详细合同见[临床决策支持与质控](../../../architecture/clinical-decision-support.md)，专题取证对照见[住院指南专题研究](../../../research/2026-11-02-llm-wiki-for-inpatient-guidelines.md)：

1. **共享六专题注册表与零模型同步原文核对**：注册 `acute-chest-pain-acs`、`coronary-revascularization-indication`、`pci-stent`、`contrast-kidney-hydration`、`cad-dapt-and-secondary-prevention` 与 `t2dm-renal-medication` 六个经人工核对的专题，每个专题锁定来源 ID、版本、原件 SHA-256、物理页码、关键限定语片段与 `8 段／48 KiB` 硬预算。`doctor.case.guideline-topics.read` 与 `inpatient.guideline-topics.read` 以零模型请求同步返回专题原文、当前患者[确定性临床算子](2026-11-17-deterministic-clinical-risk-scores.md)与客观指标对照及缺项清单；来源缺失、撤回、[人群隔离不匹配](2026-10-16-free-guideline-corpus.md)、片段残缺或超预算时一律失败闭合返回 `unavailable`，绝不截断安全限定语。门诊建议检索优先合并匹配专题的核验段落并去重。
2. **表重建解耦手术单强绑，兼容 PCI 计划与内科双路径**：迁移 `0116_guideline-topic-advice.sql` 为 `inpatient_guideline_advice` 增加必填 `topic_id`（存量回填 `'pci-stent'`），将 `request_id` 改为可空并保留非空时的手术申请复合外键与两条部分唯一版本索引，同时支持绑定 PCI 计划的自动准备（`requestId` 非空，取消计划准备时先行终止在途指南步骤以停止额外计费）与无手术单的内科按专题显式评估（`requestId = null`）。
3. **只读参考意见与具体耗材确认严格分离及回执脱敏**：缺少患者测量或院内目录规格不阻断有合法原文支持的类别与缺项说明，但参考意见绝不伪造目录产品 ID、默认一件数量或把“意见就绪”标为“耗材预留可确认”（具体选型与整批预留继续由[单次耗材预计决策](2026-10-28-single-material-estimate.md)独立把关）。指南评估 Command 的持久幂等回执仅保存任务、版本与状态，`result` 恒置空；正文与原文统一经实时核验来源可用性的读取接口返回，防止来源撤回后借历史回执重放泄露受限文本。

## Alternatives considered

- **为内科住院伪造占位手术申请单，或新建第二张内科指南表与执行器**：伪造申请污染正式手术登记与出院未收口门禁，双表双执行器则成倍复制恢复与用量控制逻辑。
- **在同步专题读取中调用轻量模型生成摘要，或超预算时截断限定语片段**：破坏零模型确定性保证，并可能裁掉肾功能阈值、心衰水化禁忌或左主干例外等关键安全限定。
- **取消具体耗材候选与数量校验，或把指南原文存入通用 Command 回执 `result`**：前者把不确定医学说明变成可计费器械预留，后者在文献撤回后击穿[免费指南用途治理](2026-10-16-free-guideline-corpus.md)。

## Consequences

心肾内科保守治疗与 PCI 介入路径共享同一套可审计专题依据、独立模型核验与用量账本；新增指南专题须经原件哈希、物理页码与限定语片段人工核对后静态注册，不从未审校 Markdown 自动编译上线。
