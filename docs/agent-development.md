# Agent 工程开发

本文规定 ClinMesh 的工程协作、分派隔离、审查与交付规则；根级常驻约束见 [`AGENTS.md`](../AGENTS.md)，产品内 Agent 运行时安全见[系统架构](architecture.md)。

## 仓库同步边界

| 内容 | 是否同步到 GitHub |
| --- | --- |
| `apps/`、`packages/`、`scripts/`、运行时 `skills/`、部署配置、依赖 manifest/lock、`.github/` | 同步；构成可复现的产品与工程入口 |
| `AGENTS.md`（根与子目录）、`CONTEXT.md`、`docs/` | 同步；分别拥有工程规则、领域语言、当前合同、决策与经验 |
| `assets/`、影像与病理素材清单、`vendor/` 子模块引用 | 同步公开源资产、许可与锁定提交；像素与原始来源文件遵循各自清单边界 |
| `.agent/`、`.agents/`、`.claude/`、`.prototypes/`、`previews/`、`.env`、`.data/`、`references/`、构建与测试产物 | 不同步；由 `.gitignore` 管理（`.claude/skills/` 按需建指向 `../../.agents/skills/<名称>` 的本地软链），取消跟踪时使用 `git rm --cached` 保留本地文件 |

取舍见[共享工程资料与本机配置分离](decisions/implemented/process/2026-10-19-repository-sync-boundaries.md)。

## 开发入口

开发任务先按 `grilling` 澄清目标、范围、验收条件与关键设计取舍：每次只问一个需要用户决定的问题，现成事实由 Agent 自行查证；小任务缩短澄清，已批准结论直接继承。检查相关实现与工作区既有未提交修改（全程保真保留无关改动），范围与方案获准后连续推进。

非平凡需求以 [GitHub Issue](agents/issue-tracker.md) 正文为唯一正式规格（标签遵循 [triage labels](agents/triage-labels.md)，领域与 ADR 映射见 [工程上下文](agents/domain.md)）：单纵向切片使用 1 张 `spec` Issue；多个可独立验收切片按“1 张父规格 Issue + N 张自包含子票”通过原生 `sub-issues` 与 `blocked_by` 关联。

### 任务路由与多 Agent 实施

主 Agent 根据任务结构自动选择直接实施或隔离分派，保留本机 Matt skills 的显式调用限制（仅在宿主提供入口且满足条件时调用，不声称隐式调用未授权 skill）：

- **单任务或强耦合修改**：主 Agent 直接在工作分支实施，行为变更按 `tdd` 验证公共接口与失败边界。
- **独立调研与审查**：默认并行委派只读子 Agent。
- **多个可独立验收的写入切片**：固定集成分支与基线，按依赖图分批启动；每个并行写入任务必须使用**独立分支与仓库外 worktree**（核实子 Agent 实际 `pwd`、分支与基线，按需隔离数据库、端口与测试输出），子 Agent 返回实际 diff/commit、验证命令、结果与耗时后由主 Agent 核验合入。任务收尾只清理本次创建、已集成且无未合并提交的干净副本（编排取舍见[主 Agent Worktree 编排决策](decisions/implemented/process/2026-10-16-primary-agent-worktree-development.md)）。

主工作区只保留待提交或当前推进的修改；仅供本地排障的临时改动在任务结束前还原。

### 完整变更审查

交付前按 `code-review` 执行 Standards 与 Spec 双轴并行审查：向两个审查 Agent 提供相对于共同基线的同一份完整变更快照（含已提交、暂存、未暂存与新增文件，不能因三点提交 diff 为空而跳过工作区变更，且预先剔除任务前已有的无关改动），修复具体 findings 后补跑受影响检查。

## 交互预览

需要确认界面布局或交互流程时，在被忽略的 `.prototypes/` 或隔离入口提供可运行预览（优先单文件 HTML），复用当前 token、图标与贴近真实密度的合成数据，使空、加载、失败、权限或冲突状态可操作且与业务写入隔离。每次迭代保留明确版本与反馈记录；正式实现落回真实组件与合同，并在同视口、字号、语言和主题下对照已接受预览核验真实入口（见[交互预览决策](decisions/implemented/process/2026-10-02-task-scoped-interactive-preview.md)）。

## 实施与交付

- `implement <已批准 issue URL>` 或对整个 Issue/Spec 的实施交付授权允许创建 `issue-<number>-<slug>` 分支、本地提交、普通 push、创建或更新 draft PR 并附上验收证据；**不授权** merge、force-push、release、删分支或将 draft 转为 ready。无远端写入授权时在本地分支完成实现与验证后请求批准。
- 用户要求“完整整个 issue”时连续完成全部子票并汇总为 1 个集成 PR；用户明确要求逐票系列交付时按票绑定精确 commit 短视频并提草稿 PR，不逐票停等。
- UI 演示媒体默认使用绑定精确 commit 的原生 WebM（3–4 倍速、底部岗位/动作字幕、真实点击波纹、文字可读的最小体积；仅用户明确要求时生成 GIF，人眼 `1x` 导览视频按[慢速操作导览录屏](memory/video-walkthrough.md)执行）。浏览器证据不替代原生 Mobile 验证。

## 消息与提交规范

Commit、GitHub Issue、PR、评论与 review reply 统一使用简体中文；命令、路径、代码标识符、协议名、label 与 Conventional Commit 的 `<type>(<scope>): <简体中文交付摘要>` 保留原始技术写法（无有效 scope 时省去括号，摘要写明具体交付结果）。复杂提交正文按“背景 / 变更 / 验证 / 关联（`Refs #<issue>`）”组织，无真实关联 Issue 时省略关联节。

PR 正文使用 [`docs/pull_request_template.md`](pull_request_template.md)，如实填写验证命令、结果、耗时、影响与回滚方式及未运行项原因，严禁补造截图或未执行证据。

## Skills

本机开发 skills 属于个人工具配置，不假设在所有环境可用；能力缺失时由主 Agent 使用原生工具按同等项目合同完成并如实说明。常见可选入口：`reduce-complexity`（代码简化）、`writing-for-agents`（技能与指令编写）、`code-review`（双轴审查）、`pr`（PR 正文）、`retro`（仅按用户明确请求复盘指定会话）、`vercel-react-best-practices`（React 性能）、`agent-browser`（探索性浏览器交互或接管）。

## 文档发布

仓库 Markdown 是唯一可编辑源，`apps/docs/docs.ts` 是公开页面 allowlist，`scripts/project-doc-site.ts` 将公开页面与引用图片投影到临时的 `apps/docs/.generated`（未公开的仓内链接自动重写为 GitHub 源码链接）。新增、移动或删除公开页面时同步更新 manifest 与入站引用，运行 `pnpm doc-sync` 验证（预览用 `pnpm docs:dev`），绝不手工编辑或提交 `.generated`、`.cache`、`.dist`。
