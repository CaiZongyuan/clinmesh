# Agent 工程开发

本文说明 ClinMesh 的 Agent 协作、授权和检查约定。Skills 按任务选择，产品内 Agent tools 的运行时安全见[系统架构](architecture.md)。

## 指令层级

- 根 `AGENTS.md` 保存每次工作都需要的 standing orders。
- 子目录 `AGENTS.md` 只增加该目录特有规则，不重复根规则。
- `CONTEXT.md` 只定义领域语言，不保存实现方案。
- `docs/` 保存当前架构、流程和测试参考。
- `docs/spec/` 保存需要追踪的正式需求，写法和状态见[需求规格](spec/README.md)。
- `docs/memory/` 保存稳定协作偏好和低频操作坑，不保存产品事实或临时任务状态。
- `.agents/notes/` 保存有真实权衡且未来可能被重新讨论的提案和决策。
- `.agents/skills/` 保存开发 Agent 的可复用工程工作流；运行时 `clinmesh-*` skills 位于根 `skills/`，见[系统架构](architecture.md#711-agent-skills)。Skill 不能成为产品行为或架构事实的唯一来源。
- `.claude/skills/` 为每个开发 skill 提供指向 `../../.agents/skills/<名称>` 的相对符号链接，供 Claude Code 复用同一份源文件；增删开发 skill 时同步对应链接，个人设置仍由 Git 忽略。

Agent 开始工作前读取目标文件路径上所有适用的 `AGENTS.md`，并从仓库代码和当前文档验证假设。`references/` 仅用于只读研究，不是实现来源。

## 开发入口

以用户请求或已选用的 spec 为目标，先检查相关实现、调用者和现有未提交修改，再处理影响实施的未决问题。新增且需要跨会话追踪的需求先在 [docs/spec/](spec/README.md) 维护唯一正式版本；已批准的旧 Issue 在显式迁移前沿用原合同，普通机械任务可直接使用已确认的对话。目标明确后直接实施，保留无关改动，不要求先创建 GitHub issue 或拆票。

需要访谈、跨 session 需求记录、测试驱动或独立审查时，可以选择相应 Matt skill。`to-spec` 在本仓库生成 `docs/spec/` 文件，通用 skill 的 Issue 发布步骤由[需求规格](spec/README.md)替代；不修改上游 skill。任务使用 GitHub Issues 追踪执行时遵循 [issue tracker](agents/issue-tracker.md) 和 [triage labels](agents/triage-labels.md)；领域与架构输入见 [工程上下文](agents/domain.md)。

`CONTEXT.md` 只接收医院仿真领域词汇。通用 skill 提出的 ADR 在 ClinMesh 中映射为 Agent Note；不创建平行的 `docs/adr/` 决策体系。

## 交互预览

需要确认页面、导航或用户流程时，按当前任务提供可运行的交互预览。能独立表达体验时优先使用单个 HTML；需要真实应用上下文时使用临时隔离入口。复用当前组件、token、图标和贴近实际密度的合成内容，使关键操作及影响设计判断的空、加载、失败、权限或冲突状态可操作；明确模拟范围，模拟状态与业务写入隔离。

每次交付预览保留明确版本并给出可打开的文件或 URL；迭代创建新版本，保留已接受版本、反馈、修订要求和未决决定。沿用已有确认和最新补充，用户明确要求直接实施时从当前已接受方向继续。预览按任务隔离，不长期放入正式应用的路由和源码树；Matt `prototype` 用于回答特定布局或状态问题，采用通用 skill 的产物保留方式。

正式实现使用真实组件与合同，并在可比的内容、视口、语言和主题下对照已接受预览验证实际入口。预览提供设计依据，不作为认证、持久化、Command 或审计的验收证据；验证规则见[测试策略](testing.md#用户界面验证)。

## 实施与交付

`implement <已批准 issue URL>` 授权 Agent 创建 `issue-<number>-<slug>` branch、本地 commits、正常 push、draft PR，并向该 PR 发布验收证据，不要求逐个 artifact 再次批准。发布前仍须检查完整内容和敏感信息。它不授权 merge、force-push、release、删除分支或将 draft 标记为 ready。

普通本地修改、提交、push、PR、发布和合并按用户当前授权执行；已有授权不重复确认。仓库公开，发布内容前检查患者信息、医保或支付凭证、密钥和未公开方案。没有该项外部写入授权时，先准备可复核的完整内容，再请求批准。

用户要求完整 issue 一次性交付时，连续完成全部 tickets，最终使用一个集成 PR，不因单票完成中断任务。

代码简化使用 [reduce-complexity](../.agents/skills/reduce-complexity/SKILL.md)，保留行为和合同，运行受影响的最小检查。独立审查、commit 和 push 不自动触发重复整理或检查。

UI 变更需要验证时，默认用 Playwright 从真实产品入口观察结果，入口与范围见[测试策略](testing.md#用户界面验证)。用户要求演示媒体时使用绑定精确 commit 的原生 WebM，成片默认 3–4 倍速，标明步骤并显示真实点击位置，压缩到文字仍可读的最小体积；用户明确要求时才生成 GIF。浏览器证据不代表原生 Mobile 行为。

## 消息与提交规范

Commit 的主题与正文，以及 GitHub issue、PR、评论和 review reply 等公开工程消息使用简体中文。命令、路径、代码标识、协议名、label 和 Conventional Commit 的 `type`、`scope` 保留原始技术写法。

Commit 主题使用 `<type>(<scope>): <简体中文交付摘要>`；没有有效 scope 时省略括号。摘要陈述已经交付的结果，不写“更新内容”“修复问题”等无法独立判断范围的笼统文字。

Commit 正文按变更复杂度记录背景、交付内容和实际验证。需要详细说明时可使用：

```text
背景：
- 为什么需要这次变更

变更：
- 交付了哪些可观察行为或工程约束

验证：
- 实际命令、结果与耗时

关联：
- Refs #<issue>
```

只引用真实关联的 issue，没有关联时省略关联节。没有运行检查时说明未运行项及原因。Issue 和 PR 使用仓库模板，说明目的、范围、结果和实际验证。

## Agent Notes

非平凡架构、流程、协议、持久化格式或测试策略变更必须新增或更新 Agent Note。Note 记录问题、决策、真实替代方案、后果和验证依据；不记录聊天过程、任务清单或代码逐步说明。

生命周期：

- `proposed`：尚未实施的方案。
- `implemented`：当前已交付决策。
- `rejected`：经过考虑但未采用，且仍能防止合理误判的方案。

文件格式和分类见 [Agent Notes 规则](../.agents/notes/README.md)。

## Skills

根据用户请求和各 skill 的 description 选择入口；常用能力如下：

| 触发 | Skill |
| --- | --- |
| 当前代码整理或较大范围简化调查 | `reduce-complexity` |
| Skills 和 Agent 指令编写 | `writing-for-agents` |
| 独立代码审查 | `code-review` |
| React Web 性能 | `vercel-react-best-practices` |
| 探索性浏览器交互或现有会话接管 | `agent-browser` |

普通文档编写、调整归属和发布投影直接遵循 [docs/AGENTS.md](AGENTS.md)。

ClinMesh 自有或改造 skill 的保留条件：

- 至少会在多个任务中复用。
- 输入、适用范围和停止条件明确。
- 不执行外部项目的包规则、CI 作业或不存在的脚本。
- 指向仓库当前 source of truth，而不是复制完整规则。

Matt skills 保持上游内容；项目约定通过 `AGENTS.md` 和 owner 文档适配。ClinMesh 自有 skills 使用本仓库的路径、术语和规则，同一职责只保留一个活动入口。

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
- 用户可见 Web/Desktop 改动：按风险选择真实入口验证；用户要求演示时提供绑定 commit 的 WebM。
- 文档和 manifest：`pnpm doc-sync`。

Agent 不得声称未运行的检查通过，也不得用自身输出文本作为业务操作成功的唯一证据。
