# Agent Note: 共享指南专题注册表与住院手术单解耦

Status: implemented

## Problem

原有住院指南参考意见在数据表（`inpatient_guideline_advice.request_id TEXT NOT NULL` 并强外键关联 `inpatient_surgery_request`）与契约中都强绑定单一 `pci-stent` 手术申请单，导致无 PCI 手术申请的内科住院阶段——包括造影前对比剂肾损伤预防与围术期水化、冠脉造影提示临界狭窄但 `FFR > 0.80` 决定药物保守治疗而不开立 PCI 手术申请、出院双联抗血小板与二级预防以及合并糖肾用药调整——均无法生成或持久化指南参考意见。同时，门诊与住院缺少共享、确定性且零模型开销的专题原文核验读取入口，每次查看固定专题原文若耦合模型生成会增加不必要的延迟与请求消耗。

需求与范围见 [通用指南专题注册表与手术单解耦（Issue #472）](https://github.com/CaiZongyuan/clinmesh/issues/472) 及父需求 [专科指南与确定性临床评分体系（Issue #464）](https://github.com/CaiZongyuan/clinmesh/issues/464)。

## Decision

1. **表重建解耦手术单强绑**：通过 SQLite 表重建迁移 `0116_guideline-topic-advice.sql` 为 `inpatient_guideline_advice` 增加必填 `topic_id`（存量记录回填 `'pci-stent'`），将 `request_id` 改为可空并保留复合外键 `FOREIGN KEY(workspace_id, epoch, admission_id, request_id) REFERENCES inpatient_surgery_request(...) ON DELETE RESTRICT`（SQLite 在 `request_id IS NULL` 时放行无手术单记录，非空时继续约束真实手术申请），以两条部分唯一索引分别保证 `(workspace_id, epoch, admission_id, topic_id, request_id, version) WHERE request_id IS NOT NULL` 与 `(workspace_id, epoch, admission_id, topic_id, version) WHERE request_id IS NULL` 的单调版本链。
2. **建立共享 `Guideline Topic` 注册表与零模型同步读取**：将单一 `pci-stent` 扩展为门诊与住院同源复用的六个经核对专题（`acute-chest-pain-acs`、`coronary-revascularization-indication`、`pci-stent`、`contrast-kidney-hydration`、`cad-dapt-and-secondary-prevention`、`t2dm-renal-medication`），每个专题固定来源身份、版本、原件 SHA-256、物理页码、关键条款与限定语片段及 8 段／48 KiB 预算门禁。提供纯确定性的 `doctor.case.guideline-topics.read` 与 `inpatient.guideline-topics.read` 同步读取服务，模型请求增量为 0，同时关联当前患者确定性 `Clinical Score` 与已落库客观检查指标及缺项列表；来源缺失、撤回、人群不匹配隔离、页码片段残缺或超出预算时失败闭合降级为 `unavailable`，绝不截断限定语返回残缺依据。
3. **统一门诊检索与住院双路径兼容**：门诊诊疗建议在病例匹配注册专题时优先合并经该注册表核验的原文段落并去重；住院 `InpatientGuidelineAdvice` 同时保留绑定 PCI 计划的自动准备路径（`requestId` 非空）与无手术单的按专题显式评估路径（`requestId = null`），并在既有 `InpatientGuidelineAdvicePanel` 增加按需展开的轻量专题选择与同步原文核对卡片。

本决策扩展 [住院指南参考意见与具体耗材确认分开](2026-11-02-inpatient-pci-guideline-advice.md)，保留其只读定位、独立核验、Command 回执脱敏与来源撤回即时隐藏规则；人群隔离继续遵循 [指南固定包叠加层与人群隔离](2026-11-12-guideline-release-overlay-and-population-isolation.md)。

## Alternatives considered

- **为内科住院伪造占位手术申请单以复用原表**：无需迁移表结构，但污染正式手术登记、出院在途手术门禁与病案统计，违背临床事实边界。
- **新建第二张内科指南意见表与第二套模型执行器**：复制状态机、Command 回执恢复、用量控制与前端组件，维护成本翻倍。
- **在同步专题读取中调用轻量模型做动态摘要**：破坏零模型开销与确定性可复现保证，且存在吞掉原句限定语的风险。
- **放宽片段完整性或字节预算截断**：虽能提高弱数据下的可见率，但可能丢失肾功能界值、左心功能不全水化禁忌或左主干开口例外等关键安全限定语，不采用。

## Consequences

内科住院与保守治疗场景无需开立手术申请即可按专题核对原文依据并生成受独立核验保护的只读参考意见，既有 PCI 计划旅程保持向后兼容。新增专题仍须人工核对原件哈希、物理页码、限定语片段与三类结论枚举后入表注册。当前完整业务合同由[共享指南专题与住院只读指南参考意见](../../../architecture/clinical-workflows.md#pci-计划的只读指南参考意见)拥有。
