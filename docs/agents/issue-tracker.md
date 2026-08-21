# GitHub issue tracker

ClinMesh 的 spec 和 tickets 使用公开仓库 `CaiZongyuan/clinmesh` 的 GitHub Issues，并通过 `gh` CLI 读写。

## Ownership

Issue body 在任务活动期间拥有目的、范围、验收条件和测试决策。Agent Note 拥有真实权衡和决策理由；合并后的代码和当前状态文档拥有最终行为。Agent Brief comment、讨论摘要或 PR body 不能取代 issue body 成为 implementation contract。

使用完整 issue URL 跨文档引用。Branch、commit 和同仓库 PR 可以使用 `#<number>`，但必须能回到 canonical issue。

## Publication

Issue 的 title、body 和 comments 遵循[消息与提交规范](../agent-development.md#消息与提交规范)。仓库公开；创建或修改 issue 前展示完整 title、body、labels 和拆票结构，检查患者信息、医保或支付凭证、平台密钥和未公开方案，并取得用户明确批准。显式调用 skill 不自动授权外部写入。

批准后使用 `gh issue create`、`gh issue view`、`gh issue edit`、`gh issue comment` 和 `gh issue close`。需求变化再次取得批准，并用 revision comment 记录差异。

## Tickets

一个可评审纵向切片直接使用 spec issue。多个独立切片使用 GitHub sub-issues 和 native dependencies；不支持时才在 body 中使用 `Part of #<parent>` 和 `Blocked by: #<number>`。父 spec 拆票后移除 `ready-for-agent`，只有无 open blocker 的叶子 ticket 使用该 label。

PR 不是需求入口。Leaf PR 使用 `Closes #<ticket>`，拆票时同时写 `Part of #<spec>`；父 spec 在全部叶子关闭且整体验收完成后由人类关闭。
