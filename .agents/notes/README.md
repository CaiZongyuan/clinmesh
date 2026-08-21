# Agent Notes

Agent Note 记录影响代码库的提案或决策，保存代码和当前文档难以表达的动机、真实替代方案、后果和验证要求。

## 路径

```text
.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

生命周期：

- `proposed`：尚未完成的提案。
- `implemented`：当前已经交付的决策；路径、符号和机制随实现更新，但不改写原决策。
- `rejected`：未采用且仍能防止合理误判的方案；失去价值时删除。

分类是 `feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。新增分类必须同步修改 `scripts/agent-note-tree.ts`。

## 何时写

非平凡变更必须新增或更新 Agent Note，包括：

- 跨文件或跨包架构与依赖方向。
- 公开 interface、协议、配置、持久化或 wire format。
- Agent 工作流、文档发布或测试策略。
- 有真实替代方案且未来维护者可能重新讨论的取舍。

局部重命名、格式化、依赖锁更新或不改变行为的机械修改不需要 Note。一个决策只有一份 owner；新 Note 创建前搜索现有 active tree，完整取代时在新旧记录中交叉链接。

## 文件格式

前三行：

```markdown
# Agent Note: <title>

Status: <status>
```

所有 Note 以 `## Problem` 开始并包含 `## Alternatives considered`。

`proposed` 必须包含：

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

`implemented` 必须包含：

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

`rejected` 的状态行是 `Status: rejected — <reason>`，并保留 `## Problem`、`## Proposal` 和替代方案。

Implemented Note 描述当前已交付现实，不保留 migration plan、验收任务清单或评审过程。改变原决策时创建新 Note；不要把旧 Note 改写成相反结论。

运行 `pnpm verify:agent-notes` 检查路径、状态和章节。
