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

## 开发入口

新功能、可观察行为变化、跨包工作和非平凡 bug 必须有已批准的 GitHub issue。纯机械小修可以把当前对话作为任务合同。需要 issue 的任务在 GitHub 不可用时停在已批准草稿，不建立第二套本地 spec。

仓库公开。任何 issue、评论、PR 或 GIF 在发布前都必须检查患者信息、医保或支付凭证、密钥和未公开方案；没有 owning workflow 已经授予该外部写入时，先展示完整待发布内容并取得用户明确批准。

## Design gate

Agent 编辑前确认直接目标、受影响模块、现有未提交修改和所有未决设计分支。事实从 owning interface、调用者、测试和当前文档验证，不要求用户提供可从仓库或工具查到的信息。

- 新功能或行为变化存在未决分支时使用 `grilling`。
- 公共 interface、跨包状态流、持久化、外部协议、多 ticket 或测试策略存在真实权衡时使用 `grill-with-docs`。
- 已批准 issue 已经回答全部 frontier 问题时，design gate 直接通过。
- 共享理解确认前不编辑正式文件。确认后再更新 `CONTEXT.md`、Agent Note、spec 或实现。

`CONTEXT.md` 只接收医院仿真领域词汇。通用 skill 提出的 ADR 在 ClinMesh 中映射为 Agent Note；不创建平行的 `docs/adr/` 决策体系。

## Spec 与 tickets

使用 `to-spec` 把已确认对话形成 GitHub issue。发布前向用户展示完整 title、body、labels 和测试 seam；用户批准后才能执行 `gh` 写操作。Issue body 是任务活动期间的 canonical implementation contract，包含目的、范围、验收条件和测试决策。Agent Brief 或后续讨论只能提供上下文，不能成为第二份 spec owner。

一个可评审纵向切片直接使用 spec issue 实施。只有存在多个独立纵向切片或需要跨 session 时才使用 `to-tickets`；拆分结构和依赖必须先由用户批准。拆票后父 issue 保留 `spec`，移除 `ready-for-agent`，只有依赖已经满足的叶子 ticket 才能进入实施队列。不得按 types、backend、frontend 等技术层制造不能独立验收的水平 tickets。

GitHub 原生状态拥有执行队列：

- `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和 `wontfix` 表示 Matt skills 使用的 triage 角色。
- `spec` 标记 canonical spec；assignee 表示已领取，native issue dependency 表示阻塞，draft PR 表示评审中。
- 需求变化必须再次取得用户批准，并用 revision comment 记录差异；不得静默改写实施合同。

仓库映射见 [issue tracker](agents/issue-tracker.md)、[triage labels](agents/triage-labels.md) 和 [工程上下文](agents/domain.md)。

## 实施与交付

`implement <已批准 issue URL>` 授权 Agent 创建 `issue-<number>-<slug>` branch、本地 commits、正常 push、draft PR，并向该 PR 发布验收证据，不要求逐个 artifact 再次批准。发布前仍须检查完整内容和敏感信息。它不授权 merge、force-push、release、删除分支或将 draft 标记为 ready。

每个 ticket 使用独立上下文，先读取 issue、相关 Agent Note、owner 文档和代码。复杂状态变化仍通过共享 Command owner 实现，不在 transport、UI 或 Agent tool 中复制状态机。

### TDD 与测试证据

使用 `tdd` 按批准 seam 完成 red-green-refactor。写测试前向用户说明目标行为、测试文件和层级、关键断言，以及为什么这是能够捕获目标回归的最窄测试。运行命令时报告开始和长任务进度；完成后报告实际命令、结果、耗时、修改的测试和未运行项。详细规则由[测试策略](testing.md)拥有。

### Simplify、review 与 push

1. 目标行为变绿后使用 `code-simplifier`，只整理当前 diff 并保持所有外部行为不变。
2. 重跑被 simplification 影响的最小测试和检查；不要仅因即将 commit 或 push 重复仍有效的成功证据。
3. 创建含 `Refs #<issue>` 的 checkpoint commit，再使用 `code-review` 对固定 base 到 `HEAD` 做 Standards/Spec 双轴审查。
4. 修复 findings、追加 commit，并重新检查被修复影响的证据，直到没有未解决 blocker。
5. 使用 `dsh-pre-push-checks` 覆盖完整 outgoing diff，正常 push 后核对 remote head，创建或更新 draft PR，再检查 CI。
6. 用户可见 Web/Desktop 变化使用 `agent-browser` 走真实入口，并用 `record-browser-gif` 发布绑定精确 commit 的 GIF。Mobile 使用独立检查并报告真实设备或模拟器证据；浏览器 GIF 不能证明原生行为。

Review 同时追踪 changed interface 的两侧、授权路径、状态 owner、真实产品入口、测试对目标回归的敏感性，以及文档和 Agent Note 是否匹配实现。Finding 必须包含位置、影响和证据。

## 追溯

| Artifact | 约定 |
| --- | --- |
| Branch | `issue-<number>-<slug>` |
| Commit | `Refs #<number>` |
| Leaf PR | `Closes #<number>`；拆票时同时写 `Part of #<parent>` |
| Agent Note | 使用完整 issue URL 引用任务背景 |
| Test evidence | PR 表格记录命令、证明的行为、结果和耗时 |
| GUI evidence | PR body 记录 commit SHA、运行入口和 GIF |

合并叶子 PR 时由 `Closes` 关闭 ticket。父 spec 只有在所有叶子 tickets 关闭且整体验收完成后才关闭；merge 和关闭父 issue 都由人类授权。

## Agent Notes

非平凡架构、流程、协议、持久化格式或测试策略变更必须新增或更新 Agent Note。Note 记录问题、决策、真实替代方案、后果和验证依据；不记录聊天过程、任务清单或代码逐步说明。

生命周期：

- `proposed`：尚未实施的方案。
- `implemented`：当前已交付决策。
- `rejected`：经过考虑但未采用，且仍能防止合理误判的方案。

文件格式和分类见 [Agent Notes 规则](../.agents/notes/README.md)。

## Skills

根 `AGENTS.md` 在不可漏的开发节点直接路由 skills；普通意图匹配由各 skill 的 description 负责。常用路由如下：

| 触发 | Skill |
| --- | --- |
| 未决设计分支 | `grilling` |
| 大型设计及决策落盘 | `grill-with-docs` |
| 已确认对话形成 spec | `to-spec` |
| 多个纵向切片 | `to-tickets` |
| Ticket 实施与 TDD | `implement`、`tdd` |
| 当前 diff 行为保持型整理 | `code-simplifier` |
| Standards/Spec 双轴审查 | `code-review` |
| Outgoing diff 检查 | `dsh-pre-push-checks` |
| React Web 性能 | `vercel-react-best-practices` |
| Web/Desktop 真实入口与 GIF | `agent-browser`、`record-browser-gif` |
| 文档结构、文句和投影 | `dsh-doc-standards`、`dsh-prose-standard`、`dsh-doc-site-sync` |
| 周期性架构简化审计 | `dsh-find-simplifications` |

ClinMesh 自有或改造 skill 的保留条件：

- 至少会在多个任务中复用。
- 输入、适用范围和停止条件明确。
- 不执行外部项目的包规则、CI 作业或不存在的脚本。
- 指向仓库当前 source of truth，而不是复制完整规则。

Matt skills 由 `skills-lock.json` 记录并保持上游原样；上述项目 skill 条件不授权修改其内容。只有被根或子树规则路由的 Matt workflow 才成为 ClinMesh 开发流程的一部分，ClinMesh 规则在更高优先级的 `AGENTS.md` 和 owner 文档中适配其输入、审批和产物。`dsh-` 前缀保留 DeepSeek Harness 来源谱系，但这些 skills 由 ClinMesh 维护，description 必须写明 ClinMesh 触发条件，正文不得保留 DSH 包、命令、双语、stack 或 CI 假设。同一职责只保留一个活动入口。

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
- 用户可见 Web/Desktop 改动：真实应用入口的浏览器测试与绑定 commit 的 GIF。
- 文档和 manifest：`pnpm doc-sync`。

Agent 不得声称未运行的检查通过，也不得用自身输出文本作为业务操作成功的唯一证据。
