# 开发环境与跨平台运行

处理 worktree、依赖锁、Windows/WSL 差异、进程容器或文档构建时查阅；常规部署见[`docs/deployment.md`](../deployment.md)，其他主题见[工程记忆入口](memory.md)。

## Worktree、依赖与锁文件

- **pnpm 11 自动安装守卫**：pnpm 11 默认 `verifyDepsBeforeRun=install` 会在跑脚本前自动安装，易在无 TTY 下失败或改写 `pnpm-lock.yaml` 与子模块可执行位。常规验证前先跑 `pnpm install --frozen-lockfile` 并设 `pnpm_config_verify_deps_before_run=error`；独立 worktree 借用依赖或跑纯文档检查时设 `pnpm_config_verify_deps_before_run=false`（或直接调 `node_modules/.bin/tsx`），及时撤回无关锁文件变动。合并分支锁冲突时按两侧已有条目整合后再跑 `--frozen-lockfile`，不用 `--lockfile-only` 顺带升级间接依赖。
- **新建隔离 worktree 准备**：worktree 必须建在仓库外（防根 Vitest 遍历嵌套目录）；首次安装前先 `git submodule update --init --recursive vendor/dsh-react-surface`（复用本地对象可用 `--reference`），复制 `.env` 并运行 `pnpm reference:sync`（确保 `.env` 的 `CLINMESH_REFERENCE_RELEASE_ID` 与锁一致）；需要对照原型时软链 `<主 checkout>/.prototypes` 到 `.prototypes`。借用依赖时在验证副本建真实 `node_modules` 目录并排除 `.vite`、`.cache`、`.turbo` 等可写目录，重建 `@clinmesh/*` 链接须同时覆盖 `apps/` 与 `packages/`。
- **Windows 安全删除与归档 worktree**：删除前先保全未跟踪本地数据，检查其他副本是否仍借用其 `node_modules` 或子模块 `objects/info/alternates`（父仓 `.git/worktrees/*/modules/` 与子模块 `.git/` 均须检查；同批清理时先注销依赖方，再注销对象库 owner 并用 `git fsck --connectivity-only --no-reflogs` 复核）。若含指向主 checkout 的 junction，严禁直接递归强删或 `git worktree remove --force`——先列出重解析点并用 `cmd /c rmdir <链接>` 仅解除链接再删目录。需移出同级目录归档时，先备份 Git 管理目录与分支 bundle，同卷重命名工作目录后再按原路径 `git worktree remove` 注销。Windows worktree 含依赖 junction 时避免 `git status --ignored` 引发环路深扫。
- **Registry、Corepack 与原生脚本**：pnpm 11 切源使用 `pnpm_config_registry=https://registry.npmjs.org/`（旧 `npm_config_registry` 不生效），缓存陈旧时用 `pnpm cache delete '<包名>'` 定向清理；`publint` 子进程若落入未缓存的 Corepack shim，先预热 `packageManager` 指定版本；`npm 11` 模板显式维护原生组件 `allowScripts`。仓库外 `tsx` 脚本需顶层 `await` 时使用 `.mts`。

## Windows、WSL 与跨平台文件

- **符号链接与换行原字节**：Windows `core.symlinks=false` 会把 Git `120000` 符号链接（如 `CLAUDE.md`）检出为无换行的目标路径文本——严禁向其补换行；`git archive` 导出原始字节时显式加 `-c core.autocrlf=false`，而向 Linux 副本导出补丁时用默认 `git diff --cached <base> --binary --output=<path>` 避免整文件换行伪 diff。受 SHA-256 约束的 CSV/提示词已由 `.gitattributes` 锁 LF，校验不符时对比 `git show HEAD:<path>` 恢复原字节，不改清单哈希。
- **PowerShell 编码、退出码与 .NET 路径**：PowerShell 管道传中文前设 `$OutputEncoding` 为无 BOM UTF-8，写文件用 `UTF8Encoding(false)`；`2>&1` 可能把原生 stderr 包装成 `NativeCommandError`，以紧随其后的 `$LASTEXITCODE` 或 Node `spawnSync().status` 判定成败；`Set-Location` 不改变 `.NET` 进程目录，`[System.IO.File]` 一律传绝对路径，多行脚本写成临时 `.mjs` 文件执行而非在 PowerShell 内拼 `node -e`。
- **Windows 子进程与 PDF 工具**：Node 子进程禁止直接 `execFile` `.bin/*.cmd`，统一用 `process.execPath` 调用包内 JS 入口（升级 `cn-health` 时同步 `reference-data.lock.json`、根 `devDependencies` 与 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）。PDF.js 的 `cMapUrl`/`standardFontDataUrl` 在 Windows 须转为正斜杠并保留末尾 `/`；`pdftotext` 显式加 `-enc UTF-8`，若字体映射仍乱码则渲染原页人工核对。
- **WSL 会话、字体与端口排障**：Linux worktree 固定在原生 Linux Git 操作（仅对象级推送见[GitHub 排障](github-delivery.md#连接权限与-pr-操作)）；WSL 报 `0x8007274c` 时不重启 WSL，起单个带 TTY 的 `/bin/bash --noprofile --norc` 会话（设 `GIT_PAGER=cat`）复用；WSL2 下直接调 Linux `bun` 运行 Surface 构建脚本以防命中 `bun.exe` UNC 转换；缺中文字体时先向用户字体缓存载入本机授权 CJK 字体并 `fc-cache`；WSL mirrored 模式 `127.0.0.1` 无属主端口占用优先用 `docker ps` 排查容器发布端口。

## 进程、容器与服务启动

- **局域网 HTTP 与随机标识**：后台健康和登录 HTTP 成功不代表工作台可渲染；非 localhost 的普通 HTTP 页面没有 `crypto.randomUUID`。启动局域网入口后用真实浏览器走到登录后的工作台；客户端标识统一使用 Web 的 `createRandomUuid`（加密随机字节后备），不通过关闭浏览器安全策略解决。
- **环境变量继承与工作目录**：根启动器通过 `pnpm --filter` 进入 `apps/server` 前须用 `resolveServerEnvironmentPaths` 将 `.env`、数据库与 DRG 规则等相对路径解析为绝对路径；切换 worktree 时调用方已导出的 `CLINMESH_*_PATH` 会覆盖 `.env`，启动时须显式覆盖并核对子进程实际环境，隔离实例同时覆盖 `CLINMESH_PUBLIC_ORIGIN` 与 `CLINMESH_TRUSTED_ORIGINS`。常驻 `dev:server` 直连 `pnpm --filter` 绕开 Turbo（防 Windows 进程树冻结及 strict env 过滤 `CLINMESH_AI_*`）；POSIX 多服务启动使用独立进程组转发信号，进程存活断言轮询等待僵尸进程彻底 `ESRCH`。
- **Docker 构建与只读 SQLite**：生产镜像构建阶段保留 `python3`/`make`/`g++` 供 `better-sqlite3` 回退编译；将已写入 SQLite 封入只读镜像前必须 `PRAGMA wal_checkpoint(TRUNCATE)` 并切回 `journal_mode=DELETE`（否则只读文件系统因无法建 `-shm` 报错）；`pnpm deploy --prod --legacy` 局部关闭 `auto-install-peers`。跨架构兼容性以锁定 digest 的 manifest/config `os`/`architecture` 为准。

## 文档构建

- **飞书文档读取**：飞书链接匿名跳登录页时，先 `lark-cli whoami` 确认身份，再用 `lark-cli docs +fetch --doc '<链接>'`（`bot` 身份开放时加 `--as bot`；`--as user` 报 `token_missing` 仅代表用户态未授权，先试已有应用身份）。
- **VitePress 与校验陷阱**：公开文档页面中的本机 `http://localhost:*` 一律写成反引号代码 span（裸链接会被 VitePress 判为死链）；保留 `<a id="...">` 兼容锚点时避免与同页标题 `slugifyHeading` 重复；`pnpm docs:build` 与 `oxlint` 顺序执行，防止扫描到构建瞬态创建又删除的 `.vitepress/config.ts.timestamp-*.mjs`；若主工作区因被忽略的 `.github/skills/` 触发 `verify:docs` 报错，先用 `git check-ignore` 确认归属并在干净 worktree 复验。
