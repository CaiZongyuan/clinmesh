# Agent Note: 共享工程资料与本机 Agent 配置分离

Status: implemented

## Problem

共享决策和个人开发 skills 同处 `.agents/`，而 `.claude/` 的技能别名与本机预览也被跟踪。只添加忽略规则不能停止上传已有跟踪文件，直接忽略整个目录又会使共享文档依赖的决策失去正式归属。

## Decision

`.agent/`、`.agents/`、`.claude/` 与 `previews/` 不纳入 Git。开发 skills 和宿主别名保留在本机，停止跟踪，不复制进共享文档。产品运行时 `skills/` 继续作为产品组成部分同步。

共享 Agent Notes 迁入 `docs/decisions/`，保留原格式、生命周期、决策关系及理由；项目模板放在 `docs/` 并从 [模板索引](../../../templates/README.md)导航。GitHub PR 使用官方支持的 `docs/pull_request_template.md`，实施 Issue 的正文与平台发现入口分开维护。共享规则、校验与入站引用使用新路径，不依赖本机目录。

本决定部分取代 [Task-scoped Agent skills](2026-10-02-task-scoped-agent-skills.md) 的仓库内技能源码与校验机制；其按任务选择、简化边界和文档归属理由仍有效。同步范围由 [仓库同步边界](../../../agent-development.md#仓库同步边界)拥有，正式需求及验收见 [规格](../../../spec/2026-10-19-repository-materials.md)。

## Alternatives considered

- 保留开发 skills 在 Git：能够共享安装副本，但不符合个人 skills 不同步的要求，也让共享规则依赖某套本机工具。
- 把 skills 复制到 `docs/`：改变了目录名称，仍在分发用户明确不希望共享的技能源码。
- 只忽略 `.agents/` 而不迁移决策：会留下失效的共享引用，并把项目理由和工程知识留在本机。
- 删除被忽略文件：停止跟踪不要求删除本机配置、技能或预览，删除会破坏用户已有工作。

## Consequences

新 checkout 从共享规则、规格、模板、决策和实际代码理解项目，不要求与某台机器安装相同的开发 skills。宿主只使用实际可用的技能入口；能力缺失时沿用同等项目合同和原生工具，不假定技能已安装。

预览保留在本机，需要长期约束实现的结论写入正式规格、UI 合同或决策。迁移验证同时检查 Git 跟踪/忽略、本地文件保留、决策正文、链接与公开文档构建；不将本机 skills 源码作为共享文档校验输入。
