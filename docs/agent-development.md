# Agent 工程开发

本文说明 ClinMesh 的 Agent 协作、授权和检查约定。用户提出自然语言需求，由主 Agent 选择执行方式并负责交付；产品内 Agent tools 的运行时安全见[系统架构](architecture.md)。

## 指令层级

- 根 `AGENTS.md` 保存每次工作都需要的 standing orders。
- 子目录 `AGENTS.md` 只增加该目录特有规则，不重复根规则。
- `CONTEXT.md` 只定义领域语言，不保存实现方案。
- `docs/` 保存当前架构、流程和测试参考。
- `docs/spec/` 保存需要追踪的正式需求，写法和状态见[需求规格](spec/README.md)。
- `docs/memory/` 从[工程记忆](memory/memory.md)进入：入口保存稳定协作偏好，按任务读取对应主题的低频操作经验；不保存产品事实或临时任务状态。
- `docs/decisions/` 保存有真实权衡且未来可能被重新讨论的提案和决策，沿用 Agent Note 格式。
- `.agents/skills/` 是本机开发 skills，不纳入 Git；其安装状态不决定共享规则。产品运行时 `clinmesh-*` skills 位于根 `skills/` 并继续同步，见[系统架构](architecture/agent-integration.md#711-agent-skills)。
- `.claude/` 是不纳入版本库的本机适配目录；需要 Claude Code 发现工程 skills 时，按需在 `.claude/skills/` 创建指向 `../../.agents/skills/<名称>` 的相对符号链接，复用本机已安装源。个人设置和这些别名均由仓库 `.gitignore` 忽略。

Agent 开始工作前读取目标文件路径上所有适用的 `AGENTS.md`，并从仓库代码和当前文档验证假设。`references/` 仅用于只读研究，不是实现来源。

## 仓库同步边界

| 内容 | 是否同步到 GitHub |
| --- | --- |
| `apps/`、`packages/`、`scripts/`、运行时 `skills/`、部署配置、依赖 manifest 与 lock、`.github/` | 同步；它们共同构成可复现的产品和工程入口 |
| `AGENTS.md`、`CONTEXT.md`、`docs/` | 同步；分别拥有项目规则、领域语言和共享文档，决策位于 `docs/decisions/` |
| `assets/`、影像及病理素材清单、vendor 子模块引用 | 同步可公开的源资产、许可与锁定引用；素材像素及本机来源文件遵循各自清单边界 |
| `.agent/`、`.agents/`、`.claude/`、`.env`、`.data/`、`references/`、依赖缓存、构建目录与测试输出 | 不同步；由仓库 `.gitignore` 管理，`.env.example` 保留为配置示例 |
| `previews/` | 不同步；本机保留预览版本与反馈，需要长期约束实现的结论写入规格、UI 合同或决策 |

项目自有的[开发模板](templates/README.md)位于 `docs/`；本机 skill 包内的脚本模板留在本机，不迁入共享目录。GitHub 需要固定路径的入口只负责发现或导航，正式需求仍由 `docs/spec/` 拥有。取消本机目录的 Git 跟踪时保留本地文件；忽略规则不会自动停止跟踪已有文件。取舍见[共享源与本机适配决策](decisions/implemented/process/2026-10-19-repository-sync-boundaries.md)。

## 开发入口

所有开发任务先按 `grilling` 澄清目标、范围、验收条件、设计取舍和验证方式；每次只问一个需要用户决定的问题，现成事实由 Agent 查证。小任务缩短澄清，已有批准结论直接继承，不重复访谈。检查相关实现、调用者和现有未提交修改，需求与方案确认且获准实施后连续推进，保留无关改动。

需要追踪的非平凡需求在 [docs/spec/](spec/README.md) 维护唯一正式版本；已批准的旧 Issue 在显式迁移前沿用原合同，普通机械任务可使用已确认的对话。仅在多个可独立验收的切片或跨会话追踪确有需要时拆票，不要求每个任务都创建 Issue。`to-spec` 的产物映射为仓库规格，通用 skill 的 Issue 发布步骤由[需求规格](spec/README.md)替代。GitHub 追踪遵循 [issue tracker](agents/issue-tracker.md) 和 [triage labels](agents/triage-labels.md)；领域与架构输入见 [工程上下文](agents/domain.md)。

`CONTEXT.md` 只接收医院仿真领域词汇。通用 skill 提出的 ADR 在 ClinMesh 中映射为 Agent Note；不创建平行的 `docs/adr/` 决策体系。

### 任务路由与调用

主 Agent 根据已确认的任务范围选择执行方式，用户无需挑选 skill 或手工分派子任务：

| 任务 | 默认执行方式 | 可用时的显式入口 |
| --- | --- | --- |
| 单个任务、紧密依赖的修改或无需拆票的工作 | 主 Agent 直接实施并完成必要验证、简化和审查 | `implement` |
| 已批准 spec 下的多个可独立验收切片 | 主 Agent 维护依赖图，安排独立 worktree，并集成到同一分支 | `implement-spec` |

表中名称是显式入口，不能由规则中的引用推导出自动调用授权。保留 Matt 的 `disable-model-invocation` 和 `allow_implicit_invocation` 设置；仅在宿主实际提供入口且满足调用条件时调用。普通自然语言请求直接由本规则驱动，主 Agent 使用实际可用的委派和 Git 工具完成相同职责，如实报告采用的项目流程，不声称调用了未提供或禁止隐式调用的 skill。

### 多 Agent 实施

主 Agent 负责拆分、跟进、集成、核验和交付。独立调研和 Standards/Spec 审查默认并行；实施任务只有在能独立验收、文件归属和共享接口明确时才并行，不按前后端等技术层硬拆。没有可独立推进的任务时直接实施。对行为变化使用现有 `tdd` 验证公共接口和失败边界；文档或机械调整使用相应检查。

1. 固定集成分支与共同基线，保真保存任务依赖的未提交修改。复用已有 spec、tickets 和任务记录维护依赖、归属、状态及证据入口，只启动前置依赖已满足的任务。
2. 并行写入各用独立分支和仓库外 worktree。创建前核对已有副本的任务归属；委派时给出目标、适用规则、文件范围、路径、基线、验收条件和授权。核实子 Agent 实际工作目录、分支和基线，不能把创建子线程当作文件隔离。按需隔离可写数据、服务端口和测试输出，worktree 不隔离运行权限。
3. 子 Agent 返回实际 diff 或提交、检查命令、结果、耗时和阻塞。主 Agent 核对证据与基线兼容性，再完成集成；集成可由主 Agent 执行，必要时委派。已有工作区基线不符时先保全修改和提交，再用合并或另建副本等可保真方式对齐，不因上游 reset 步骤丢弃已有工作。
4. 集成后重新核对依赖，启动新就绪任务；出现冲突先核对双方意图并验证受影响合同。持续完成整个已授权范围，在完整待交付结果上完成审查与必要验证，沿用仍然有效的检查证据。

清理遵守已有授权，只涉及本任务创建、已集成、干净、无其他任务占用且没有未集成或后续提交的副本。worktree 和分支删除分别核对；缺少授权或条件不满足时保留并说明，不批量清理其他任务副本。

### 完整变更审查

使用 `code-review` 进行 Standards 与 Spec 双轴并行审查。主 Agent 固定基线、任务范围和同一份完整待交付快照，向两个审查 Agent 提供同样的变更输入及各自的规范或需求来源。输入覆盖基线后的提交、暂存、未暂存修改和新增文件；三点 diff 只用于提交部分，不能据其为空跳过 WIP 审查。

未提交工作可用 `git diff <基线> -- <任务路径>` 取得 tracked 文件的最终变化，同时核对 `git diff --cached <基线> -- <任务路径>` 和新增文件的实际内容。任务起点已有无关修改时，用已保真的任务前快照限定此次差异，不能把所有未提交内容都视为本任务。审查后修复具体 findings，并补查、验证受影响部分。

## 交互预览

需要确认页面、导航或用户流程时，按当前任务提供可运行的交互预览。能独立表达体验时优先使用单个 HTML；需要真实应用上下文时使用临时隔离入口。复用当前组件、token、图标和贴近实际密度的合成内容，使关键操作及影响设计判断的空、加载、失败、权限或冲突状态可操作；明确模拟范围，模拟状态与业务写入隔离。

每次交付预览保留明确版本并给出可打开的文件或 URL；迭代创建新版本，保留已接受版本、反馈、修订要求和未决决定。沿用已有确认和最新补充，用户明确要求直接实施时从当前已接受方向继续。预览按任务隔离，不长期放入正式应用的路由和源码树；Matt `prototype` 用于回答特定布局或状态问题，采用通用 skill 的产物保留方式。

正式实现使用真实组件与合同，并在可比的内容、视口、语言和主题下对照已接受预览验证实际入口。预览提供设计依据，不作为认证、持久化、Command 或审计的验收证据；验证规则见[测试策略](testing.md#用户界面验证)。

## 实施与交付

`implement <已批准 issue URL>` 授权 Agent 创建 `issue-<number>-<slug>` branch、本地 commits、正常 push、draft PR，并向该 PR 发布验收证据，不要求逐个 artifact 再次批准。发布前仍须检查完整内容和敏感信息。它不授权 merge、force-push、release、删除分支或将 draft 标记为 ready。

多票集成流程沿用用户对整个 spec 或 Issue 已给出的实施与交付授权；存在相应授权时连续完成全部 tickets、普通 push 和一个集成 draft PR。调用入口本身不新增外部写入权限，上游 `implement-spec` 的 ready、关闭任务和清理步骤受本仓库授权规则约束。没有交付到远端的授权时先完成本地结果与验证；未合并的草稿 PR 不提前关闭执行票。

普通本地修改、提交、push、PR、发布和合并按用户当前授权执行；已有授权不重复确认。仓库公开，发布内容前检查患者信息、医保或支付凭证、密钥和未公开方案。没有该项外部写入授权时，先准备可复核的完整内容，再请求批准。

用户要求完整 issue 一次性交付时，连续完成全部 tickets，最终使用一个集成 PR，不因单票完成中断任务。

代码简化保留行为和合同，优先复用现有类型、工具及模式，删除未被需求使用的抽象，并运行受影响的最小检查；本机可用时使用 `reduce-complexity`。独立审查、commit 和 push 不自动触发重复整理或检查。

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

撰写 PR 正文时可使用当前宿主允许调用的 `pr`，以[仓库模板](pull_request_template.md)、简体中文和 `CONTEXT.md` 术语为准。摘要按需要用简图或 diff 解释关键变化，验证使用真实的前后证据、命令、结果和耗时；补充实际影响范围、回滚方式与限制。没有执行前证据时如实说明，不补造截图或结果。UI 证据沿用真实入口、WebM 和素材隐私合同，不为通用模板另建词汇文件或默认生成 GIF。

## Agent Notes

非平凡架构、流程、协议、持久化格式或测试策略变更必须新增或更新 Agent Note。Note 记录问题、决策、真实替代方案、后果和验证依据；不记录聊天过程、任务清单或代码逐步说明。

生命周期、格式、分类和替代关系统一见 [Agent Notes 规则](decisions/README.md)；当前行为与文档归属见 [文档规则](AGENTS.md)。

## Skills

开发 skills 属于本机工具配置，不提交其源码、个人安装清单或宿主别名；本仓库不保证某个 skill 已安装或可被当前宿主调用。共享开发合同由本文、根规则及相应 owner 文档负责；能力缺失时按同等合同使用原生工具执行，并如实说明实际入口。

根据用户请求和实际可用 skill 的 description 选择入口；下表是可选能力，不是安装清单：

| 触发 | Skill |
| --- | --- |
| 当前代码整理或较大范围简化调查 | `reduce-complexity` |
| Skills 和 Agent 指令编写 | `writing-for-agents` |
| 独立代码审查 | `code-review` |
| PR 正文写作 | `pr`；适配仓库模板和实际证据 |
| 用户明确要求会话复盘 | `retro`；实际调用遵守显式入口设置 |
| React Web 性能 | `vercel-react-best-practices` |
| 探索性浏览器交互或现有会话接管 | `agent-browser` |

普通文档编写、调整归属和发布投影直接遵循 [docs/AGENTS.md](AGENTS.md)。

本机自有或改造 skill 的使用条件：

- 至少会在多个任务中复用。
- 输入、适用范围和停止条件明确。
- 不执行外部项目的包规则、CI 作业或不存在的脚本。
- 指向仓库当前 source of truth，而不是复制完整规则。

本机 skills 保持其上游来源和调用限制；项目约定通过 `AGENTS.md` 和 owner 文档适配，不复制到 `docs/` 形成另一份 skill 分发。

复盘按用户明确请求进行，依据指定会话的证据提出改进候选，先核对现有检查和规则；不成为每项任务的固定步骤。实际不能调用 `retro` 时按用户请求直接分析，不声称使用该 skill。候选不自动授权安装 hooks、修改全局规则或扩大当前任务；已经要求记录的稳定经验仍及时写入其 owner，无需先启动复盘。编排方式的取舍见 [Agent Note](decisions/implemented/process/2026-10-16-primary-agent-worktree-development.md)。

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
