# 系统架构

ClinMesh 是面向 Agent 的中国公立医院仿真 HIS，当前交付 standalone Web、DSH React Surface 与 Agent CLI。人类岗位、页面 Tools 和受限任务 Agent 复用同一业务内核，以合成数据验证多岗位普通门诊及住院流程。当前范围与后续边界见[系统范围与拓扑](architecture/system.md#背景与目标)及[实现状态](architecture/system.md#首期实现状态)。

## 按任务查找合同

| 任务 | 详细 owner |
| --- | --- |
| 确认系统定位、模块职责、拓扑、当前范围和跨领域保证 | [系统范围与拓扑](architecture/system.md) |
| 修改 FHIR 能力、资源映射、术语、Search 或 HIS Command 接口 | [FHIR 与 Command 合同](architecture/fhir-and-commands.md) |
| 修改 DSH Surface、Page Context、Tool、人工审阅或 Agent CLI | [Agent 接入与能力边界](architecture/agent-integration.md) |
| 查看临床闭环总览、跨岗位交接路由或集中办理私稿与逐项原回执恢复 | [临床业务流程](architecture/clinical-workflows.md) |
| 修改门诊挂号、自由问诊、实时自动病历整理、12 字段结构化病历、门诊诊断或完诊门禁 | [门诊业务流程](architecture/outpatient-workflows.md) |
| 修改住院登记入科、转科、PCI 与手术耗材核实、术后核查、出院清床、病案归档或院内 DRG 核定 | [住院与手术流程](architecture/inpatient-workflows.md) |
| 修改门诊内外延处方、住院长期与临时医嘱、药事安全规则、药房发药或护士校对与给药执行 | [处方、医嘱与药事](architecture/orders-and-pharmacy.md) |
| 修改检验申请与送检、门诊独立检查门禁、心电/超声功能检查、放射阅片、病理会诊或报告已阅与修订 | [检验、检查与报告](architecture/examinations-and-reports.md) |
| 修改收费账单、共享收款、多费用合并收退、住院预交金与首次冻结结算、患者医保待遇或结算后财务更正 | [收费、结算与医保](architecture/billing-and-insurance.md) |
| 修改专病风险评估与确定性算子、心血管医嘱组套、免费指南全文与专题、诊疗建议或双层事中临床质控 | [临床决策支持与质控](architecture/clinical-decision-support.md) |
| 修改 CHS-DRG 条件提取、规则包、分组计算或独立对照 | [DRG 条件分组](architecture/drg-grouping.md) |
| 修改 DRG 离线精简物理储存、无损读取或维护命令 | [DRG 离线资料储存合同](drg-reference-storage.md) |
| 修改存储、事务、outbox、标识符、数据库运维、模型账本或迁移 | [存储与事务](architecture/storage.md) |
| 修改病例生成、隐藏事实、虚拟时钟、重放、素材准备或 Epoch reset | [仿真、病例与素材](architecture/simulation.md) |
| 修改身份、权限、字段隔离、审计、请求限制或失败恢复 | [安全与可靠性](architecture/security-and-reliability.md) |

## 相邻文档

- [领域词汇](../CONTEXT.md)定义业务语言；[跨端前端架构](frontend-architecture.md)定义包与平台职责；[临床 UI 设计合同](ui/design.md)定义界面规则。
- [部署指南](deployment.md)拥有从 clone 到运行与升级的操作步骤；[Agent 操作与反馈](agent-capabilities.md)说明实际工具用法。
- [测试策略](testing.md)拥有验证层级与合同矩阵；[Issue 规则](agents/issue-tracker.md)定义正式需求规格与拆票；[Agent Notes](decisions/README.md)拥有非平凡取舍及理由。
- [参考项目评估与采用边界](research/architecture-reference-decisions.md)保留外部证据；当前合同以本页导航的 owner 和实现为准。
