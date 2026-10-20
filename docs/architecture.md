# 系统架构

ClinMesh 是面向 Agent 的中国公立医院仿真 HIS，当前交付 standalone Web、DSH React Surface 与 Agent CLI。人类岗位、页面 Tools 和受限任务 Agent 复用同一业务内核，以合成数据验证多岗位普通门诊及住院流程。当前范围与后续边界见[系统范围与拓扑](architecture/system.md#1-背景与目标)及[实现状态](architecture/system.md#15-首期实现状态)。

## 按任务查找合同

| 任务 | 详细 owner |
| --- | --- |
| 确认系统定位、模块职责、拓扑、当前范围和跨领域保证 | [系统范围与拓扑](architecture/system.md) |
| 修改 FHIR 能力、资源映射、术语、Search 或 HIS Command 接口 | [FHIR 与 Command 合同](architecture/fhir-and-commands.md) |
| 修改 DSH Surface、Page Context、Tool、人工审阅或 Agent CLI | [Agent 接入与能力边界](architecture/agent-integration.md) |
| 修改门诊、文书、医嘱、检查、处方、收费或其他临床状态流 | [临床业务流程](architecture/clinical-workflows.md) |
| 修改存储、事务、outbox、标识符或数据库迁移 | [存储与事务](architecture/storage.md) |
| 修改病例生成、隐藏事实、虚拟时钟、重放、素材准备或 Epoch reset | [仿真、病例与素材](architecture/simulation.md) |
| 修改身份、权限、字段隔离、审计、请求限制或失败恢复 | [安全与可靠性](architecture/security-and-reliability.md) |

## 相邻文档

- [领域词汇](../CONTEXT.md)定义业务语言；[跨端前端架构](frontend-architecture.md)定义包与平台职责；[临床 UI 设计合同](ui/design.md)定义界面规则。
- [部署指南](deployment.md)拥有从 clone 到运行的操作步骤；[Web Demo 运行与部署架构](demo-architecture.md)拥有首期运行时与部署选择；[Agent 操作与反馈](agent-capabilities.md)说明实际工具用法。
- [测试策略](testing.md)拥有验证层级与合同矩阵；[需求规格](spec/README.md)拥有任务范围和验收；[Agent Notes](decisions/README.md)拥有非平凡取舍及理由。
- [参考项目评估与采用边界](research/architecture-reference-decisions.md)保留外部证据；当前合同以本页导航的 owner 和实现为准。
