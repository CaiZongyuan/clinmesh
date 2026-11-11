# 开发模板

项目自有模板统一从本页进入；模板只提供写作结构，正式要求、授权与验收仍由对应 owner 负责。本机开发 skills 及其附带脚本模板不属于共享文档。

| 用途 | 模板 | 规则 owner |
| --- | --- | --- |
| 功能、行为变化或非平凡修复的正式规格 Issue | [功能规格模板](../../.github/ISSUE_TEMPLATE/feature-spec.md) | [Issue 规则](../agents/issue-tracker.md) |
| PR 交付与验证说明 | [PR 模板](../pull_request_template.md) | [消息与提交规范](../agent-development.md#消息与提交规范) |
| 提案、已交付或拒绝的决策理由 | [Agent Note 模板](agent-note.md) | [决策规则](../decisions/README.md) |

PR 模板位于 `docs/pull_request_template.md`，这是 [GitHub 官方支持的自动发现路径](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository)；不在 `.github/` 保存第二份。功能规格 Issue 模板位于 `.github/ISSUE_TEMPLATE/feature-spec.md`，拆票子任务结构遵循 [Issue 规则](../agents/issue-tracker.md#tickets)。
