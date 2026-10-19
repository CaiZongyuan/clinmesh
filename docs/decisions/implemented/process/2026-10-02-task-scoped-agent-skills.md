# Agent Note: Task-scoped Agent skills

Status: implemented

## Problem

固定的访谈、spec、拆票、TDD、checkpoint、审查和录屏链使普通任务承担额外流程成本。多个 DSH skills 分担文档规则和代码整理，也增加入口选择与路径维护成本。

## Decision

本 Note 的按需选择与直接实施入口由[主 Agent 统筹的 worktree 开发](2026-10-16-primary-agent-worktree-development.md)部分取代：默认协调、需求澄清、行为测试和最终审查遵循新入口；本文关于不强制建 Issue、不捆绑演示媒体、简化职责和文档归属的决定继续有效。

开发 skills 按用户请求和任务范围选择，明确目标后直接实施。GitHub issue、拆票、独立审查和演示媒体按需要使用；已有授权持续有效。

代码简化使用 `reduce-complexity`，分别处理当前任务的行为保持型整理和明确请求的集成范围调查。Skill 使用 ClinMesh 的测试、架构与 Agent Note 路径，保留共享 Command、平台边界、FHIR R5、授权、审计、幂等和持久化兼容合同。

文档归属、写作和检查由 `docs/AGENTS.md` 拥有，发布投影由 `docs/agent-development.md` 的文档发布章节拥有。编写 skills 和 Agent 指令时使用 `writing-for-agents`。Matt skills 保持上游内容，项目事实与授权由仓库规则适配。

本文取代 [Traceable Agent development workflow](2026-08-21-traceable-agent-development-workflow.md) 中的固定生命周期和 DSH skill 编排决策；该 Note 继续保留事实归属、工程证据和公开内容授权的理由。

## Alternatives considered

**保留固定生命周期，只删除 DSH skills。** 现有指令仍会要求调用不存在的入口，并保留普通本地任务的 issue 与交付前置条件。

**把所有能力合并成一个总流程 skill。** 入口数量减少，但代码整理、文档编写和 GitHub 交付仍被耦合，独立使用时会加载无关规则。

## Consequences

任务可以直接以用户请求作为目标和验收依据，跨 session 或需要公开追踪时再使用 spec 与 tickets。简化调查不自动授权行为或架构变化。

检查覆盖实际变更；记录真实结果，复用仍有效的证据。开发 skills 留本机且不进入共享校验范围；当前同步与文档归属由[共享资料边界决策](2026-10-19-repository-sync-boundaries.md)拥有，共享规则不依赖本机 skill 文件。
