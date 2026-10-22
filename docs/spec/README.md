# 需求规格

`docs/spec/` 保存新增的、需要跨会话追踪的功能、行为变化和非平凡修复的唯一正式需求。简单机械改动可以使用已确认的对话作为依据；研究材料、Agent Note、Issue 和 PR 引用规格，不复制另一份完整需求。已有的已批准 Issue 在显式迁移前继续按原合同执行；迁移时在 Issue 中链接新规格，并只保留一份详细 owner。

## 位置与状态

- 每项需求建立一份 `YYYY-MM-DD-<topic>.md`，日期取首次成稿日，`topic` 使用简短的 ASCII kebab-case；需求修订继续编辑同一文件。
- 从 [模板](../templates/spec.md) 创建，标题使用简体中文。`Status` 取 `draft`、`approved`、`implemented` 或 `superseded`；被取代时链接接替的规格。
- `draft` 允许明确列出未决问题和真实依赖；只有设计取舍、验收条件和实施依赖均已确定后才能标为 `approved`。完成验收后改为 `implemented`。

## 写法

1. 从用户问题写目标、范围和范围外事项，保留已确认的交互与业务决定；演示原型仅作为设计依据。
2. 用可观察的结果写验收条件，覆盖空、加载、失败、权限及恢复等与需求有关的状态。
3. 记录测试入口、关键断言、真实依赖和风险；技术实现未确定时写约束，不把推测写成决定。
4. 对新增的实质性取舍重新确认，再更新同一规格及状态。规格描述当前有效要求，Git 历史保存修订过程。

非平凡架构、流程、协议或测试策略取舍另由 [Agent Note](../decisions/README.md) 记录理由；规格只保留实施所需的决定和链接。文档遵循 [文档规则](../AGENTS.md)，不包含凭证或真实患者信息。

## 完成后的维护

规格拥有正式需求及其独有验收条件；当前行为归实现与当前合同，决策理由归 Agent Note。`implemented` 表示该规格已经验收，不意味着它可以立即删除，也不代表相关 Note 的所有后续调整已自动纳入验收。

1. 验收完成后，将长期有效的行为、失败边界和操作说明维护到对应当前 owner；规格引用该 owner，不继续复制实现细节。
2. 保留仍拥有独有验收信息、活跃任务依赖或尚无替代合同的规格。`draft`、`approved` 的状态和未完成断言不能因目录整理被升级。
3. 只有独有要求已有明确去向、没有活跃任务依赖且所有入站引用已处理时，才删除冗余规格。删除前搜索仓库、Issue 与 PR 的依赖；外部引用仍需保留时继续保留简短规格入口。
4. `superseded` 规格链接接替者，保留仍需解释的要求差异；确认不再有独有信息与引用后按同一条件删除。修订历史交给 Git，不新建 completed/archive 目录。

规格索引只提供入口与状态，详细要求只保留在对应规格中；新增、状态变化或删除规格时同步索引。

## 规格索引

### 待设计与待验收

| 规格 | 状态 |
| --- | --- |
| [新安装自动准备完整 DRG 参考资料](2026-10-22-drg-reference-installation.md) | `approved` |
| [AI 原生医生工作台改版](2026-10-19-ai-native-doctor-workspace.md) | `implemented` |
| [模型调用停用、预算与用量监控](2026-10-19-model-usage-control.md) | `draft` |
| [低延迟病历自动记录](2026-10-15-low-latency-document-recording.md) | `approved` |

### 已验收与已取代

以下规格仍保留正式要求或验收引用；当前运行行为从 [系统架构](../architecture.md) 进入。

| 规格 | 状态 |
| --- | --- |
| [住院闭环](2026-10-20-inpatient-closed-loop.md) | `implemented` |
| [门诊号按日期持久发号与一致展示](2026-10-20-registration-numbering.md) | `implemented` |
| [医生主诉展示同步与分诊差异质控优化](2026-10-20-current-chief-complaint.md) | `implemented` |
| [同输入建议复用、患者回答去重与模型任务阶段恢复](2026-10-19-model-request-reuse-recovery.md) | `implemented` |
| [自动记录语义检查统一归病历质控](2026-10-19-recording-quality-consolidation.md) | `implemented` |
| [DSH 默认窄栏与工作区会话历史](2026-10-06-dsh-compact-sidebar-workspace-history.md) | `implemented` |
| [在 DSH 设置中选择 ClinMesh 使用的模型](2026-10-07-clinmesh-dsh-model-settings.md) | `implemented` |
| [门诊诊疗页头部紧凑化](2026-10-07-consultation-header-compact-density.md) | `implemented` |
| [门诊队列侧栏紧凑化](2026-10-07-consultation-queue-sidebar-compact.md) | `implemented` |
| [DSH 医院业务 Agent Harness](2026-10-07-dsh-business-agent-harness.md) | `implemented` |
| [问诊病史自动记录](2026-10-08-consultation-auto-record.md) | `implemented` |
| [医生 Agent 当前病例读取与执行恢复](2026-10-08-doctor-agent-context-execution.md) | `implemented` |
| [检验检查两阶段工作台与统一分类](2026-10-08-investigation-workspace.md) | `implemented` |
| [诊断与处方两阶段工作台](2026-10-10-diagnosis-prescription-workspace.md) | `implemented` |
| [问诊病史的 Agent 总结与患者自述溯源](2026-10-12-consultation-agent-summary-sources.md) | `implemented` |
| [病史整理中自述与疑问混合句的来源校验](2026-10-12-consultation-mixed-question-citations.md) | `implemented` |
| [字段内问诊建议与显式应用](2026-10-13-consultation-field-suggestions.md) | `superseded` |
| [基于权威指南与当前病例的诊疗建议](2026-10-13-doctor-guideline-recommendations.md) | `implemented` |
| [病历字段补齐与问诊自动记录](2026-10-14-clinical-document-fields.md) | `implemented` |
| [医生补充来源与全病历自动整理](2026-10-14-doctor-full-document-recording.md) | `implemented` |
| [病历修订区优先与签署历史折叠回顾](2026-10-15-clinical-document-history-layout.md) | `implemented` |
| [四项病历质控与签署前汇总](2026-10-15-doctor-document-quality-control.md) | `implemented` |
| [DSH 绑定失配诊断与只读恢复](2026-10-15-dsh-binding-recovery.md) | `implemented` |
| [免费跨专科指南全文与诊疗建议检索](2026-10-16-free-guideline-corpus.md) | `implemented` |
| [检验真值单位换算与失败恢复](2026-10-16-laboratory-unit-conversion.md) | `implemented` |
| [主 Agent 统筹的开发方式](2026-10-16-primary-agent-development-workflow.md) | `implemented` |
| [文档归属与结构整理](2026-10-19-documentation-ownership.md) | `implemented` |
| [共享工程资料与本机 Agent 目录分离](2026-10-19-repository-materials.md) | `implemented` |
| [诊疗建议信封预算与分批瘦身](2026-10-20-recommendation-envelope-budget.md) | `implemented` |
| [医生 Agent 临床助手](2026-10-08-doctor-agent-assistant.md) | `implemented` |

## Issue 与交付

GitHub Issue 可以追踪实施、拆票和 PR，但正文应链接本目录的规格，不另写相互竞争的全文。公开创建或修改 Issue 遵循 [Issue 规则](../agents/issue-tracker.md) 的审阅与授权；本地编写规格不等于授权公开发布。实施与验收按 [Agent 工程开发](../agent-development.md) 执行。
