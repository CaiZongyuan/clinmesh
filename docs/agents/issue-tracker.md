# GitHub issue tracker

开始代码修改前，先创建或关联公开仓库 `CaiZongyuan/clinmesh` 的 GitHub Issue，通过 `gh` CLI 读写；沿用已有 Issue 和授权。只读检查与需求讨论不要求创建 Issue。

## Ownership

GitHub Issue body 在任务活动期间拥有目的、范围、验收条件和测试决策。Agent Note 拥有真实权衡和决策理由；合并后的代码和当前状态文档拥有最终行为。Agent Brief comment、讨论摘要或 PR body 不能取代 Issue body 成为 implementation contract。

不在仓库内维护平行的 Markdown 需求规格目录；任务合入后，长期有效的产品事实与行为合同写入对应架构或 UI 文档，历史需求与变更记录通过对应 GitHub Issue 和 PR 追溯。

使用完整 Issue URL 跨文档引用。Branch、commit 和同仓库 PR 可以使用 `#<number>`，但必须能回到 canonical issue。

## Publication

Issue 的 title、body 和 comments 遵循[消息与提交规范](../agent-development.md#消息与提交规范)。仓库公开；发布前检查患者信息、医保或支付凭证、平台密钥和未公开方案。已有对应内容与写入授权时直接执行；没有授权时展示完整 title、body、labels 和拆票结构并取得明确批准。显式调用 skill 不自动授权外部写入。

批准后使用 `gh issue create`、`gh issue view`、`gh issue edit`、`gh issue comment`、`gh issue close` 及 `gh api`（`sub_issues` 与 `dependencies/blocked_by`）。需求变化再次取得批准，并用 revision comment 记录差异。

## Tickets

一个可评审纵向切片直接使用单个 spec Issue（从 [功能规格模板](../../.github/ISSUE_TEMPLATE/feature-spec.md) 准备）。多个独立纵向切片由 1 张父 spec Issue 统领完整背景、范围、设计决策、总验收与切片表，拆出的执行子票使用 GitHub 原生 `sub-issues` 与 `blocked_by` 依赖关联，并在子票正文自包含写明 `## Parent`、`## 范围`、`## 验收标准`、`## 测试决策` 与 `## Blocked by`。

按 [Triage labels](triage-labels.md)，仅单票 spec Issue 或多票父 spec Issue 使用 `spec` 标签；父 spec 拆票后移除 `ready-for-agent`，只有已审定范围且无 open blocker 的叶子子票添加 `ready-for-agent`，存在前置依赖的子票保持空标签而不误标 `needs-triage`。

PR 不是需求入口。Leaf PR 使用 `Closes #<ticket>`（拆票时可同时写 `Part of #<parent>`）；集成 PR 列出实际完成的执行票 `Closes #<ticket>` 并引用父 Issue。草稿交付不提前关闭执行票，关闭关系在实际合并时生效；多票任务的父 spec Issue 在全部叶子关闭且整体验收完成后由人类关闭。
