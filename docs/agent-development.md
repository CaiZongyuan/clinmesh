# Agent 工程开发

本文说明 Agent 如何在 ClinMesh 中安全、可复核地参与工程开发。产品内 Agent tools 的运行时安全见[系统架构](architecture.md)。

## 指令层级

- 根 `AGENTS.md` 保存每次工作都需要的 standing orders。
- 子目录 `AGENTS.md` 只增加该目录特有规则，不重复根规则。
- `CONTEXT.md` 只定义领域语言，不保存实现方案。
- `docs/` 保存当前架构、流程和测试参考。
- `.agents/notes/` 保存有真实权衡且未来可能被重新讨论的提案和决策。
- `.agents/skills/` 保存可复用工作流；skill 不能成为产品行为或架构事实的唯一来源。

Agent 开始工作前读取目标文件路径上所有适用的 `AGENTS.md`，并从仓库代码和当前文档验证假设。`references/` 仅用于只读研究，不是实现来源。

## 工作流程

1. 确认直接目标、受影响模块和现有未提交修改。
2. 阅读 owning interface、调用者、测试和文档，不从目录名推断行为。
3. 对跨模块或长期任务建立 todo；并行的独立研究可以交给 background agent。
4. 在编辑前说明将修改哪些事实和文件。
5. 通过最小 interface 实现，保持业务状态机只有一个 owner。
6. 先运行覆盖改动的最小检查，再根据影响范围扩大。
7. 检查文档、Agent Note、生成投影和公开能力声明是否同步。
8. 最终报告实际修改、实际运行的检查和未完成风险。

## Agent Notes

非平凡架构、流程、协议、持久化格式或测试策略变更必须新增或更新 Agent Note。Note 记录问题、决策、真实替代方案、后果和验证依据；不记录聊天过程、任务清单或代码逐步说明。

生命周期：

- `proposed`：尚未实施的方案。
- `implemented`：当前已交付决策。
- `rejected`：经过考虑但未采用，且仍能防止合理误判的方案。

文件格式和分类见 [Agent Notes 规则](../.agents/notes/README.md)。

## Skills

保留 skill 的条件：

- 至少会在多个任务中复用。
- 输入、适用范围和停止条件明确。
- 不硬编码外部项目名、包名、CI 作业或不存在的脚本。
- 指向仓库当前 source of truth，而不是复制完整规则。

项目自有 skills 使用通用名称，例如 `doc-site-sync`、`doc-standards`、`prose-standard` 和 `pre-push-checks`。第三方 skill 由 `skills-lock.json` 记录来源；本地项目 skill 不伪装成上游内容。

## 文档发布

仓库 Markdown 是唯一可编辑来源。`apps/docs/docs.ts` 是公开页面 allowlist，`scripts/project-doc-site.ts` 将页面和图片投影到 disposable 的 `apps/docs/.generated`。

- 修改已发布页面只编辑 canonical Markdown。
- 发布新页面时在 owning docs 位置创建文件，再加一条 manifest entry。
- 移动/删除页面时同时更新 manifest 和入站链接。
- 未发布的仓库文档链接投影为 GitHub source link。
- 绝不编辑或提交 `.generated`、`.cache` 和 `.dist`。

本地预览和检查：

```sh
pnpm docs:dev
pnpm doc-sync
```

`.github/workflows/docs.yml` 在默认分支更新后构建并发布 GitHub Pages。部署权限和 Pages source 仍需在仓库设置中启用一次。

## 验证范围

- 纯函数和 schema：包级 `typecheck` 与 unit test。
- Server route/FHIR response：adapter test 与 schema parse。
- Web/Desktop 共享视图：`packages/views` 测试；平台 wiring 留在 app。
- Mobile：独立 typecheck 和移动端测试，不用 DOM 测试代替。
- 用户可见 Web/Desktop 改动：真实应用入口的浏览器测试与截图/GIF。
- 文档和 manifest：`pnpm doc-sync`。

Agent 不得声称未运行的检查通过，也不得用自身输出文本作为业务操作成功的唯一证据。
