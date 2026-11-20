# GitHub 与交付排障

处理 GitHub 连接、Actions 日志、PR 操作、分支合并清理或媒体与升级自动化时查阅；授权与提交规范见 [`docs/agent-development.md`](../agent-development.md#实施与交付)。其他主题见[工程记忆入口](memory.md)。

<a id="连接权限与-pr-操作"></a>

## 连接、权限与 PR 操作

- **TLS / HTTP2 断连与推送核实**：Windows/WSL 在代理或 TUN（`198.18.0.0/15` Fake-IP）下遇 `gh` EOF 或 Git `curl 16/52`、`SSL_ERROR_SYSCALL` 时，POST/push 报错后先回读远端正文或 `git ls-remote` 核对完整 SHA（防止请求已生效却重复创建或误信末尾 `Everything up-to-date`）。确认远端未推进后，单次命令可局部使用 `GODEBUG=http2client=0`（`gh`）或 `git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push`（WSL 推送卡死而 Windows `gh` 正常时，可用 Windows Git 指向同一 `.git` 配合局部 `credential.helper=!gh auth git-credential` 只推送已核对提交对象），不改全局代理或关闭 TLS 校验。
- **PowerShell 构造 GitHub REST 请求**：旧版 `gh pr edit` 若报 `projectCards` GraphQL 错误，改用 `gh api --method PATCH repos/<owner>/<repo>/pulls/<n> --input <file>`；JSON 请求体在 PowerShell 中必须用 `[System.IO.File]::ReadAllText` 读取并以无 BOM UTF-8 序列化（避免 `Get-Content -Raw` 附带扩展属性把 `body` 序列化为对象），写入后回读远端正文核实。
- **Actions 状态查询与日志脱敏**：`ci.yml` 的 `push` 仅触发 `main`/`master`，工作分支须创建 PR 且无合并冲突（`CONFLICTING` 时工作流完全静默）才会触发 `pull_request` CI。查询 check runs 或按 `head_sha` 过滤必须传完整 40 位 SHA（禁传 `HEAD` 或短 SHA），以 `Complete job` 步骤完成态判定终态，重跑单 job 须等整轮 run 结束。下载 Actions 日志报错时**严禁输出含 Azure Blob 临时签名 URL 的原始 stderr**（PowerShell 换行会截断单行正则脱敏），仅在内存校验重定向主机并将日志存入 `.data/`（单 job 下载失败可在整轮结束后试 `gh run view <id> --log-failed` 或下载 run logs ZIP）。
- **关闭关键词与自动审查**：本仓 squash merge 提交说明不含 PR 正文，交付型 PR 正文写 `Closes #<ticket>`，合并后仍核对 Issue 是否已自动关闭（未关则手动附原因关闭，不补空提交）；`gh pr merge` 无输出属正常，用一次 `gh pr view --json state,mergeCommit` 确认。PR 转 ready 会触发异步 Codex 审查，合并前核对最新 SHA 的审查结果与 CI 全绿（含 `perf:ci`）；若 Codex 配额耗尽仅回上限提示，在已有 findings 清零且 CI 全绿时可按已有授权完成合并。

## 范围、合并与分支清理

- **定向 Fetch 与基线预检**：共享 `remote.origin.fetch` 含已删远端分支时裸 `git fetch origin` 会报错，统一显式 `git fetch origin main` 或目标分支；继续集成分支或评估合并冲突前先 fetch 最新目标分支 tip 并用 `git merge-tree --write-tree <target-tip> <head>` 预检，squash 合并多票时每合入一票都重新对齐最新 `origin/main` 并检查自动合并是否产生重复 helper。
- **误提交保护与特殊分支**：提交前始终用 `git branch --show-current` 确认不在 `main`（误提交本地 `main` 时用 `git reset --mixed HEAD~1` 保全工作区改动后切工作分支）；子模块显示 `M` 时先比对远端 `main` 记录与子模块实际干净状态，仅指针落后时快进即可；`assets` 分支承载历史 PR 媒体，非用户明确要求不得删除。
- **Catalog 升版联动**：扩展 Agent-facing DTO 时同步排查读取操作的 Catalog 版本与摘要（共享响应 schema 会自动带出新字段），推送前先在本机跑 `contracts` 与 `cli` 的计数及示例漂移测试，避免单 job 顺序校验多轮往返。

## 媒体可达性与升级自动化

- **媒体树写入与响应头**：Windows 下向 `git mktree` 写文件名禁用 PowerShell 文本管道（末尾 CRLF 会拼入文件名致 404），改用 Node 字节流配 `git mktree -z` 并在发布后核对 HTTP 200；GitHub Raw 将 `.webm` 标为 `audio/webm` 属预期，以字节数、SHA-256 与 ffprobe 流信息为准。
- **上游升级跳过与撤销核验**：跳过某个上游版本须在升级 PR 打上 `跳过此版本` 标签后关闭（仅关闭或评论无效），跳过最高版本后仍须核对完整 `changes` 中是否还有高于基线的较早候选，仅 `no-update` 且 `changes` 为空才算无候选；自动升级从目标分支精确提交读取锁并优先检查活动候选是否已被上游撤销（区分版本缺失与官方源权威 404），外部来源 PR 过滤先跳过 `head.repo: null`。
