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
  - title: Web 首发
    details: 首期以 Web 工作台验证多岗位门诊闭环，Desktop、Mobile 与 Agent 运行时保持后置。
---

# 文档入口

- [系统架构](architecture.md)：FHIR、HIS 领域、受控 Command 与仿真设计。
- [跨端前端架构](frontend-architecture.md)：Web、Desktop、Mobile 和共享包职责。
- [临床 UI 设计合同](ui/design.md)：高信息密度 token、组件组合、响应式与真实组件目录。
- [Demo 部署](demo-architecture.md)：Node.js、SQLite 与 Web-only 首期部署决策。
- [Agent 工程开发](agent-development.md)：Agent 约束、决策记录和检查流程。
- [测试策略](testing.md)：测试层级和验收入口。
- [领域词汇](../CONTEXT.md)：项目统一语言。
