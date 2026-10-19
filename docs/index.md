---
layout: home

hero:
  name: ClinMesh
  text: Agent + 中国公立医院仿真 HIS
  tagline: 以 FHIR R5、显式业务命令和可重复场景构建 Agent 医疗环境。
  actions:
    - theme: brand
      text: 系统架构
      link: /architecture/system
    - theme: alt
      text: Agent 工程开发
      link: /engineering/agent-development

features:
  - title: 标准接口
    details: FHIR R5 负责标准资源与互操作，复杂医院流程由受控 Command 执行。
  - title: 可重复仿真
    details: Workspace、epoch、虚拟时钟和合成数据让人类与 Agent 面对一致场景。
  - title: 人类与 Agent 协作
    details: standalone Web、DSH React Surface 与 Agent CLI 共用医院业务内核；Desktop、Mobile 仍为工程壳，自建自治运行时与评分后置。
---

# 文档入口

## 运行与使用

- [部署指南](deployment.md)：从 clone 到完整运行，包含参考目录、Provider、Synthea、DSH 与升级验证。
- [Agent 操作与反馈](agent-capabilities.md)：产品内 Agent 的当前能力、岗位工具、人工审阅和恢复。
- [影像检查使用指南](imaging.md)：素材、病例准备、开单、阅片与已阅状态。
- [病理切片会诊使用指南](pathology.md)：切片安装与复核、病例准备、开单、阅片与已阅状态。

## 当前合同

- [系统架构](architecture.md)：按任务查找系统、FHIR/Command、Agent、临床、存储、仿真与安全 owner。
- [跨端前端架构](frontend-architecture.md)：Web、Desktop、Mobile 和共享包职责。
- [临床 UI 设计合同](ui/design.md)：高信息密度 token、组件组合、响应式与真实组件目录。
- [Demo 运行与部署架构](demo-architecture.md)：Node.js、SQLite、单实例与恢复边界。
- [领域词汇](../CONTEXT.md)：项目统一语言。

## 工程协作与验证

- [Agent 工程开发](agent-development.md)：需求、实施、授权、审查与交付。
- [测试策略](testing.md)：测试层级、合同和实际入口验证。
- [文档规则](AGENTS.md)：内容归属、写作、生命周期与发布检查。
- [开发模板](templates/README.md)：规格、PR、实施 Issue 与 Agent Note 模板。
- [正式需求与索引](spec/README.md)：需求状态、独有验收条件及规格生命周期。
- [Agent Notes](decisions/README.md)：决策理由、替代方案与后果。
- [工程记忆](memory/memory.md)：稳定协作偏好及按场景读取的操作经验。
- [研究索引](research/README.md)：外部证据和候选方案，不能代替当前合同。
