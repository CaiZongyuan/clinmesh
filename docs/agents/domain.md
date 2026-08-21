# Engineering domain inputs

通用工程 skills 探索 ClinMesh 前读取与任务相关的以下 owner：

- 根 [领域词汇](../../CONTEXT.md)，用于 issue title、测试名和 interface 命名。
- [系统架构](../architecture.md) 与适用的 package `AGENTS.md`，用于所有权和依赖方向。
- [Agent Notes](../../.agents/notes/README.md)，用于真实权衡和既有决策。
- [测试策略](../testing.md)，用于测试 seam、层级和证据选择。

ClinMesh 不使用 `docs/adr/`。通用 skill 要求读取或创建 ADR 时，读取相关 Agent Notes，并按 Agent Note 生命周期记录符合条件的决策。缺少某类 owner 时继续检查代码，不预先创建空文档。
