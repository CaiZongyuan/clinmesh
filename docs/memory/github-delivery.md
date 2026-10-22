# GitHub 与交付排障

处理 GitHub 连接、权限、PR 操作、分支清理、媒体可达性或升级自动化时查阅。授权边界与交付流程由[Agent 工程开发](../agent-development.md#实施与交付)拥有，升级运行方式由[部署指南](../deployment.md#dsh-持续升级)拥有。

其他操作经验见[工程记忆入口](memory.md)。

## 连接、权限与 PR 操作

- 旧版 `gh pr edit` 可能因 GraphQL 请求已退役的 `projectCards` 字段而失败。已有 PR 正文更新授权时，使用 `gh api --method PATCH repos/<owner>/<repo>/pulls/<number> --input <json-file>` 的 REST 入口，JSON 保留实际换行；写入后核对正文、draft 和 head，不把工具兼容问题变成新的内容审批或安装流程。

- 排查 FlClash／TUN 环境的 GitHub 连接时，`198.18.0.0/15` 可能是正常的 Fake-IP；仅清除命令行代理环境变量不能证明绕过了 TUN。分别比较国内与境外 HTTPS、代理 CONNECT 和 TLS 握手阶段，再判断节点、分流或系统拦截，不把握手前失败归为 GitHub 账号权限问题。

- PR 从 draft 转为 ready 会触发仓库的异步 Codex 审查。合并前核对最新提交对应的 review summary、审查评论与完成反应；审查运行中先等待结果，处理 findings 后沿用已有合并授权。推送修复后若摘要仍指向旧提交，核对是否触发新一轮审查；已有 Ready 授权时可通过 draft → ready 状态事件重新触发，并确认审查绑定新提交。CI 与自动审查的状态分别核对。

- 关联 issue 用 `Ref`/`Refs #N` 只建立引用，GitHub 自动关闭只识别 `Closes`/`Fixes`/`Resolves` 关键词；本仓库 squash merge 的提交说明是"PR 标题 + 各条提交正文"，不含 PR 正文，所以正文里的关闭关键词在 squash 下也不生效。交付型 PR（issue 范围随本次交付完成）的正文统一写 `Closes #N`；合并后发现 issue 仍 OPEN 时核对提交说明后手动关闭并附原因，不重复推送只改关键词的空提交。

- 本仓库 `ci.yml` 的 `push` 触发仅限 `main`/`master`；feature 分支的 CI 由 PR 的 `pull_request` 事件触发。push 后 `gh run list` 为空时先核对分支是否在 push 触发列表、PR 是否已创建（PR 不存在时无 run 属预期），再怀疑 GitHub 偶发丢失 push 事件；确认事件丢失才推送空提交重新触发，不把"推送完成"当作"CI 已启动"。

- Actions 的 `pull-requests:write` 不等于仓库允许机器人创建 PR；出现明确的创建权限错误时先核对仓库设置，不反复重试。没有管理员权限时，可按[持续升级故障恢复](../deployment.md#dsh-持续升级)验证已有候选 PR 的更新与验收，并单独保留首次创建权限限制。

- `gh pr edit` 可能因 GitHub Classic Projects 的 GraphQL 字段废弃而失败。PR 正文更新可改用 REST：`gh api repos/<owner>/<repo>/pulls/<number> --method PATCH -f body=...`。

- `gh pr merge` 成功时可能没有标准输出。只用一次 `gh pr view --json state,mergeCommit` 确认结果，不因空输出重复合并或重跑检查。

- 已合并 PR 的正文仍可补充更清晰的演示链接，但不得改写 merge commit 或 force-push 源分支。更新后只核对 PR 状态、head SHA 和新链接，不重跑产品测试。

## 范围、合并与分支清理

- GitHub 的 PR ref 或 commit API 能访问某个支持 SHA，不代表从上游仓库普通 clone 后可检出；该对象可能只在贡献者 fork 的分支上。验收必须用声明的 source 新建 clone 并执行精确 checkout，不能复用含额外对象的本地仓库作为公开来源证据。

- PR 审查的 three-dot diff 以 merge-base 确定改动范围，合并冲突则以当前远端目标分支 tip 判断。PR 元数据中的 base SHA 与远端分支 tip 不一致时，用 `git ls-remote` 或远端 ref API 核对并 fetch 最新目标分支，再以 `git merge-tree --write-tree <target-tip> <head>` 验证；不能把旧 base 与 head 合并成功当作当前可合并的证据。

- 有合并冲突的 PR（`mergeable: CONFLICTING`、`mergeStateStatus: DIRTY`）不会运行任何 `pull_request` 工作流，表象是推送后 CI 完全静默。先核对 PR mergeable 状态再排查工作流配置、配额或 draft 属性；消除冲突（集成目标分支并推送）后工作流即恢复。查询提交的 check runs 必须传完整 commit SHA：`gh api repos/.../commits/HEAD/...` 的 HEAD 由服务端解析为默认分支而非 PR head，会产生误读；本地猜 SHA 也会得到无意义的空结果。

- 分支范围以当前 canonical issue 正文为准；不能仅凭分支名或提交主题判定串票。整理旧分支前先核对 issue 全文、关联 PR 状态和远端提交，避免拆散已经批准的一次集成交付。

- 本地 main 落后且子模块显示 `M` 时，先比较 main 记录、子模块实际 HEAD、远端 main 记录，并检查子模块内部是否干净。实际 HEAD 已与远端一致时，这是版本指针差异，不能称为用户源码改动；可快进 main 后在当前目录开分支，不应仅因此创建额外 worktree。

- PR 使用 squash merge 后，旧 feature branch 与 `main` 的 SHA 历史会显示分叉，即使交付内容已经进入 `main`。清理时先检查 PR 和 tree 内容，让本地 `main` 对齐 `origin/main`，只移植 squash 后新增的提交；不要再次 merge 整条旧 feature 历史。

- 删除非 main 分支前先枚举本地 branches、remote heads 和占用它们的 worktrees。Assets 分支是已发布 PR 媒体的 owner，删除会使历史链接失效；用户仍明确要求只保留 `main` 时按要求删除并报告影响，不把媒体二进制转存到 `main`。

## 媒体可达性与升级自动化

- GitHub Raw 可能把包含 VP8/VP9 视频流的 `.webm` 响应标为 `audio/webm`。不要只按该 header 判定文件损坏；同时核对 HTTP 状态、字节数、校验和以及媒体流的 codec、尺寸和时长。

- 上游自动更新中，无新版本与活动候选有效是两件事；撤销检查需覆盖旧候选，不能只检查 main 基线或 tarball 是否仍可下载。失效状态绑定精确 HEAD，并防止并发验收写回成功。

- 自动发布的目标基线从目标分支精确提交读取，不能沿用 workflow_dispatch 所选分支的本地锁。活动候选失效检查放在新版本发现前；回归需覆盖真实 CLI 的提前抛错路径，单独测试发布函数不足以证明旧状态能失效。

- npm 撤销需区分包仍存在但版本缺失与整包直接 404；候选失效检查覆盖两者。权威 404 的判断限定到固定官方 registry 且禁止重定向，不能把权限错误、服务故障或通用 HTTP 404 当作撤销。
