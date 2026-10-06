# GitHub issue tracker

新增正式需求写入 [docs/spec/](../spec/README.md)。已有的已批准 Issue 在显式迁移前沿用原合同。选择 GitHub Issues 追踪实施或拆票时，使用公开仓库 `CaiZongyuan/clinmesh` 并通过 `gh` CLI 读写；普通本地任务不要求创建 Issue。

## Ownership

对采用仓库规格的任务，`docs/spec/` 文件拥有目的、范围、验收条件和测试决策；新建 Issue body 链接唯一的正式规格，记录执行范围与追踪关系，不复制完整需求。Agent Note 拥有真实权衡和决策理由；合并后的代码和当前状态文档拥有最终行为。Agent Brief comment、讨论摘要或 PR body 不能取代规格成为 implementation contract。

需要引用实施任务时使用完整 Issue URL。Branch、commit 和同仓库 PR 可以使用 `#<number>`，但必须能回到对应 Issue；Issue 再链接仓库规格。

## Publication

Issue 的 title、body 和 comments 遵循[消息与提交规范](../agent-development.md#消息与提交规范)。仓库公开；创建或修改 issue 前展示完整 title、body、labels 和拆票结构，检查患者信息、医保或支付凭证、平台密钥和未公开方案，并取得用户明确批准。显式调用 skill 不自动授权外部写入。

批准后使用 `gh issue create`、`gh issue view`、`gh issue edit`、`gh issue comment` 和 `gh issue close`。需求变化再次取得批准，并用 revision comment 记录差异。

## Tickets

一个可评审纵向切片可由一个 Issue 追踪；多个独立切片使用 GitHub sub-issues 和 native dependencies，不支持时才在 body 中使用 `Part of #<parent>` 和 `Blocked by: #<number>`。只有规格已批准且无 open blocker 的执行 Issue 使用 `ready-for-agent`。

PR 不是需求入口。Leaf PR 使用 `Closes #<ticket>`；多票任务的父 Issue 在全部叶子关闭且整体验收完成后由人类关闭。规格状态按 [需求规格](../spec/README.md)维护。
