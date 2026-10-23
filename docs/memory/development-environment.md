# 开发环境与跨平台运行

创建或复用 worktree、恢复依赖、处理 Windows/WSL 文件差异、启动进程或构建文档时查阅。本文记录环境排障经验；运行步骤由[部署指南](../deployment.md)拥有，验证范围由[测试策略](../testing.md)拥有。

其他操作经验见[工程记忆入口](memory.md)。

## Worktree、依赖与锁文件

- 清理历史 worktree 前，先保全被忽略的本地数据和验收文件，并反查保留副本的 `node_modules` junction/symlink 是否仍借用待删目录；仍被借用的依赖 owner 暂留。Windows 上 `git worktree remove` 报 `Directory not empty` 或 `Filename too long` 后，可能已注销 worktree 并只删除了部分目录，必须分别核对登记与实际目录，不能把报错当作完整保留。清理残留前核实绝对路径白名单和备份，对链接只删除链接本身；Windows 标为 `prunable` 的 Linux 路径还要在所属 WSL 文件系统核实，不能直接批量 prune。

- 独立 worktree 借用已有依赖进行检查时，pnpm 11 的依赖状态检查可能自动尝试安装。明确使用 `--config.verify-deps-before-run=false` 或现有锁定 runner，不能让它清理、安装或重写其他任务共用的 `node_modules`；构建与测试产物仍按任务隔离。

- pnpm 11 默认会在运行脚本前检查依赖；复用依赖的 worktree 可能触发自动重装并因无 TTY 失败。已核对依赖与锁一致时，可通过进程环境 `pnpm_config_verify_deps_before_run=false` 运行检查，不修改仓库配置。复用外部依赖时仍须让 `@clinmesh/*` 链接指向目标 worktree 的包，否则集成测试可能误用原工作区源码。

- pnpm 11 在执行脚本前可能自动安装并改写锁文件，包括重新解析间接依赖。纯文档检查遇到此行为时，先核对并撤回本次检查引入的无关锁文件变更；已安装工具可通过 Node 直接调用对应 CLI，避免重复触发安装。锁文件变化不属于文档交付。

- pnpm 11 默认的 `verifyDepsBeforeRun=install` 会在脚本前自动安装，可能重解析锁文件并给 file dependency 的 bin 源文件增加可执行权限。验证前先执行 `pnpm install --frozen-lockfile`，验证进程使用 `pnpm_config_verify_deps_before_run=error`，发现不一致时显式处理；安装后检查锁文件和子模块权限。全局 pnpm 与仓库指定版本不一致且启动器卡在联网解析时，可直接调用已缓存的精确版本，并让子进程 PATH 使用同一版本。缓存中的 `pnpm.cjs` 可能没有可执行位，仅把其目录或符号链接放进 PATH 不会生效；使用可执行的 shell wrapper 通过 `node` 调用该文件。

- 隔离验证副本复用已安装依赖时，VitePress 会在仓库根 `node_modules` 自动创建 `vue` 符号链接。验证副本应保留自己的 `node_modules` 真目录，将已有包分别链接到依赖缓存，让构建新增链接写入验证副本；整体链接共享依赖目录会把构建写入带到共享目录。

- `publint` 会再调用包管理器打包；pnpm script 注入的 Node 目录可能让子进程选择 Corepack shim，而不是父进程使用的 pnpm。若父构建成功、打包却卡在解析 pnpm 版本，核对实际 PATH 和 Corepack 缓存，预先缓存仓库 `packageManager` 指定的版本；需要代理时在缓存准备步骤启用 Node 的代理支持，不通过跳过 publint 或覆盖宿主环境规避。

- npm 11 的依赖安装脚本默认审批策略可能让 `npm ci` 成功却没有构建原生 helper。依赖原生组件的安装模板要维护明确的 `allowScripts`，并按依赖锁核对审批目标；不要依赖另一个 Profile 的 pnpm 构建结果，也不要通过允许全部脚本掩盖缺失的项目策略。

- 验证副本和隔离 worktree 放在仓库外。Git 忽略的 `.data/` 仍可能被根 Vitest 的脚本文件 glob 遍历，仓库内嵌套 checkout 会重复运行它的测试；不能靠 `.gitignore` 隔离测试发现。

- `pnpm install --lockfile-only` 自动解决锁文件冲突时可能重新解析间接依赖，顺带升级两侧均未改动的版本。常规主分支整合先按合并后的 manifest 合并两侧已有锁条目，核对 package 版本与 integrity 沿用原值，再用 `pnpm install --frozen-lockfile` 验证；不要把自动解冲突成功等同于依赖范围未变。

- 新建隔离 worktree 后，安装依赖前先用 `git submodule update --init --recursive vendor/dsh-react-surface` 检出仓库锁定的子模块。未初始化的子模块目录会让 `pnpm install --frozen-lockfile` 在扫描 `file:` 依赖的 `packages/runtime` 时以 `ENOENT` 失败；初始化后重新按锁安装，不改写锁文件绕过缺失目录。

## Windows、WSL 与跨平台文件

- Windows PowerShell 向 Node 等原生进程通过 stdin 传入中文脚本前，显式将 `$OutputEncoding` 设为 UTF-8；默认管道编码可能替换中文，使字符串替换无匹配却仍以零退出码结束。中文文件编辑优先使用直接文件补丁，并检查实际 diff。Windows PowerShell 5 的 `Set-Content -Encoding utf8` 会写入 BOM；Git 消息文件使用 `UTF8Encoding(false)` 写入，并核对最终提交主题，避免不可见字符进入标题。

- Windows 上 `verify:agent-notes` 若大批报告空白行和 `Status` 行错误，先检查原始文件是否为 CRLF；当前校验器按 `\n` 分割并精确比较行内容，残留的 `\r` 会导致这些误报。若 `verify:docs` 报 `CLAUDE.md` 缺少末尾换行，再核对 Git 是否以 `120000` 跟踪它：Windows 可能把符号链接检出为仅含目标路径的普通文件。可在独立副本中统一换行并还原链接目标内容后验证，保留子模块以供相对链接检查；不为局部文档任务批量重写历史 Note 或修改共享 Git 配置。

- Windows 的 `core.symlinks=false` 会把 Git 符号链接检出为存放目标路径的普通文件。修改 `CLAUDE.md` 前先检查 Git mode；`120000` 的 blob 是链接目标，不能按 Markdown 添加末尾换行。文档或格式检查受 CRLF、符号链接、POSIX 权限影响时，在支持这些语义的 Linux checkout 验证，不改坏链接或放宽检查。

- 从 Windows 用 `git archive` 同步 Linux 验证副本时，显式使用 `git -c core.autocrlf=false archive`；否则归档可能带入 CRLF，导致按 LF 字节锁定的合成数据校验和失败。先比较归档、Git blob 和检查副本，不修改校验和或测试阈值。

- Windows worktree 的 `.git` 指针可能包含盘符绝对路径，WSL Git 不能直接解析。在 Windows Git 中导出 diff，再应用到 Linux 原生 checkout；不要改写原 worktree 的 Git 指针来迁就验证工具。

- WSL2 中 pnpm 为 Bun bin 生成的 shim 可能优先选择同目录 `bun.exe`，并把 Linux 路径转换成无法由该 Bun 解析的 UNC 路径。React Surface 构建脚本应由当前 Linux `bun` 直接执行 builder 的 TypeScript CLI，不能依赖该 shim；诊断时先比较实际 Bun 与 shim 目标，不要重复安装 Bun。

- pnpm 在 Windows 的 `node_modules/.bin` 只生成 `.cmd`/`.ps1` shim，且 Node 直接 `execFile` `.cmd` 会被拒绝。需要子进程调用 workspace 依赖的 CLI 时，用 `process.execPath` 加包内 JS launcher（如 `node_modules/cn-health/bin/cn-health.js`），不要拼 `.bin` 路径；Linux 测试传 `cliPath` 桩会掩盖该断裂，默认解析路径必须有独立测试。`cn-health dataset materialize` 支持多进程并行写同一 `--data-dir`（内部有锁），默认 Dataset 可并行 materialize；`cn-health@0.5.1` 起子进程在 stderr 自带分阶段进度，reference-sync 逐行转发到 `onProgress`。升级被 `reference-data.lock.json` 的 `cli.version` 锁定，与 receipt 的 `cliVersion` 严格相等，升级时 lock、根 devDependency、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 三处必须同步，且旧版本条目会因排除清单移除而被 `minimumReleaseAge` 政策拒绝——先临时双列排除完成重解析、`pnpm clean --lockfile` 清陈旧条目后再收窄清单。

- Windows checkout 若把仓库中的 CLAUDE.md 符号链接物化为链接目标文本，文档换行检查会误报；CLI 的 POSIX 权限与文件符号链接测试也不能由该 checkout 证明。使用 Linux 文件系统上的独立 Git 检出验证，并把 Linux Node、pnpm 与 Bun 放在 PATH 前端，避免子进程拾取 Windows pnpm shim。跨命令复用的 WSL 验证副本和产物使用持久目录，避免重启清理 `/tmp`。

- Agent Note 格式检查当前按 LF 分行，Windows CRLF 检出会把空行和状态行误报为格式错误。隔离验证 Git 中的文本时使用 `git -c core.autocrlf=false archive`，再覆盖待提交的新 Note；默认 `git archive` 也可能按 `core.autocrlf` 转换换行，不能当作原始 Git blob。该验证只证明文本格式，不替代 POSIX 权限或符号链接验证。

- Windows 向 Linux 验证副本导出变更时，先暂存，再用默认 `git diff --cached <base> --binary --output=<path>`；不要给该 diff 强制 `core.autocrlf=false`，否则 CRLF 工作树可能产生整文件伪变化。应用前核对 patch 的文件数和行数；含 PATH 或复杂参数的 WSL 命令写入 LF shell 脚本文件执行，避免 PowerShell 到 WSL 的参数转义改变命令。

- PowerShell 将中文脚本通过 stdin 管道交给 Node 或浏览器前，显式设置 UTF-8 `$OutputEncoding`，避免默认 ASCII 把中文替换为问号。正式文件优先使用结构化 patch 或显式 UTF-8 写入。

- 新 worktree 的文档检查若把 `CLAUDE.md` 中的 `AGENTS.md` 路径当正文并报缺少末尾换行，先检查 Git 的 `120000` mode 与 `core.symlinks`：禁用 symlink 的 checkout 会生成普通文本占位文件。`core.symlinks=false` 时 `git status` 也可能仍显示干净。只在隔离 worktree 中恢复占位内容仍精确等于 index 目标的链接，不给目标文本补换行，也不修改共享 Git 配置。

- Windows 隔离文档校验的 checkout 和 `git archive` 均显式使用 `core.autocrlf=false`；archive 同样可能按当前配置转换换行，Agent Note 格式检查按 LF 解析，CRLF 会把有效头部误报为格式错误。没有创建符号链接的权限时，仅在隔离校验目录将已核对的文件链接物化为目标内容（可用 hard link），目录依赖用 junction；不改原工作区的链接占位或共享 Git 配置。

## 进程、容器与服务启动

- CI 中容器健康接口持续拒绝连接时，先核对启动进程是否已因依赖未就绪而退出；重试端口不能重新启动进程。容器依赖顺序与清理前保留日志见[Synthea 运行时决策](../decisions/implemented/architecture/2026-09-03-one-command-synthea-runtime.md)。

- Windows 进程树测试必须在启动器自身仍存活时检查后代退出；只在启动器退出后检查，可能被 Node 的进程清理掩盖。用 `.cmd` 中间层和 detached 后代覆盖实际包管理器链路，并保留无关进程存活断言。

- Docker 跨架构兼容性核验以当前 Compose 锁定 digest 的 manifest/index 与运行 config 的 `os`、`architecture` 为准，逐个确认依赖；index 中 `unknown/unknown` 的 attestation 是证明材料。分别报告原生发行、模拟运行和目标主机验收，本机 amd64 smoke 只提供其架构的生成证据。示例见[macOS 兼容性核验](../research/2026-10-13-synthea-macos-compatibility.md)。

- 生产 Docker build 不能假设 `better-sqlite3` 一定有预编译件。Build stage 保留 `python3`、`make` 和 `g++` 供 `node-gyp` 回退编译，runtime stage 不携带工具链；升级 Node.js 或 `better-sqlite3` 后必须用实际 Docker build 和健康启动验证。

- `scripts/dev-lan.ts` 的进程生命周期覆盖完整子树。POSIX 上 Server 和 Web 必须使用独立进程组；任一分支退出或收到终止信号时，向两个完整进程组转发原信号。只终止顶层 `pnpm` 会遗留 Turbo、Vite 或 `tsx watch` 子进程，并在下次启动时产生错误的端口占用。

- POSIX 上进程组 kill 已生效后，孤儿进程在被收养方收尸前仍处于僵尸/退出中状态，`kill(pid, 0)` 会把它探测为存活。判定幸存者必须在断言前轮询等待全部不可探测（如 50ms 间隔、数秒上限），超时仍存活才上报失败；Windows 无僵尸进程，本地全绿不能证明 Linux 无竞态。探测只把 `ESRCH` 视为已死、其余错误如实抛出，并拒绝非正整数 pid（`Number` 解析出的 NaN 会被强转为 pid 0，探测到探测方自身进程组）。

- Windows 上 Turborepo 包装 `tsx watch` 的持久任务（旧根 `pnpm dev:server`）会以约三成概率把整棵进程树冻结在启动阶段：父进程 IPC 管道已建、子进程已派生，但双方 CPU 归零、服务永不监听，且 forensics 期 inspector 无响应。常驻开发服务器一律直连 pnpm（`pnpm --filter @clinmesh/server dev`），不进 turbo；诊断该类挂起先用“绕开包装层”隔离，再比较冻结与正常实例的 CPU 增量。

- Turborepo strict env 只转发任务声明的 `passThroughEnv` 变量，turbo 包装的任务拿不到未声明的 `CLINMESH_AI_*` 等变量。核对环境变量是否生效要从实际业务进程取证，只看父 shell 会把 provider 未配置误判为产品错误；这也是根 `dev:server` 改为直连 pnpm 的原因之一。

- WSL mirrored 模式下 `ss` 显示 `127.0.0.1` 端口 LISTEN 且无属主、Windows 侧 `netstat.exe` 与 `Get-NetTCPConnection`（非 admin）和 Linux `/proc/net/tcp`（含全部进程的 per-pid tcp 表，VM 只有单一 netns）都查不到该端口，但 curl 可连通、WSL 内 bind 报 `Address already in use` 时，优先怀疑 Docker Desktop 容器的发布端口：`docker ps` 的 PORTS 列直接给出属主（如 `127.0.0.1:51878->51878/tcp`），`docker stop` 对应容器即释放。Docker 把发布端口持有在非默认网络隔离区，用户态枚举不可见，不要沿防火墙保留区或幻影镜像方向继续排查。

- 隔离验证实例须覆盖仓库 `.env` 中的 `CLINMESH_PUBLIC_ORIGIN` 与 `CLINMESH_TRUSTED_ORIGINS`，否则登录返回 `INVALID_ORIGIN`；数据库迁移从 `apps/server` 目录运行。没有配置 `CLINMESH_AI_*` 时 Persona 任务无法完成，合成病例不能开始就诊。

- worktree 首次跑 `pnpm dev:dsh` 前先补齐两类 gitignored 环境：从主工作区复制 `.env`，再运行 `pnpm reference:sync` 物化参考数据；缺后者时 Server 在 runtime 初始化抛 `REFERENCE_RELEASE_NOT_FOUND`。`.env` 的 `CLINMESH_REFERENCE_RELEASE_ID` 落后于 lock release 也会同样报错——主工作区可能因 `.data` 库里残留旧 release 而侥幸可用，新 worktree 的全新库只会暴露它；发现配置漂移时两侧一起更新，不要只修 worktree 掩盖主工作区的雷。端口语义：DSH Web 3080 被残留进程占用时脚本拒绝启动（防 trusted origin 与登录校验错位，不要绕过）；Server 51868 的残留须手动 kill（只停 `pnpm` 包装层不杀子进程）；Synthea 51878 由 Docker 容器幂等复用，跨启动存活是正常现象。

## 文档构建

- GitHub 与 VitePress 对数字章节生成的锚点不同，例如 `8.1 门诊闭环` 分别为 `81-门诊闭环` 与 `_8-1-门诊闭环`。搬迁章节时同时核对仓库链接和构建后的 HTML；实际被引用的 GitHub 锚点可用显式 HTML `id` 保持两端可达。`verify:docs` 只证明文件目标存在，不能证明章节存在；用 Playwright 核对真实页面中的目标元素。归属与迁移要求见[文档整理决策](../decisions/implemented/process/2026-10-19-documentation-ownership.md)。

- VitePress 构建把公开页面里裸写的 `http://localhost:*` URL 当作内部死链并使 `pnpm docs:check` 失败（`127.0.0.1` 不受影响）。进入文档站投影的页面中所有本机地址一律写成代码 span，不起链接。

- 文档站构建与全仓 lint 顺序执行：VitePress 会短暂创建并删除 `.vitepress/config.ts.timestamp-*.mjs`，并行 oxlint 可能在扫描后读取到已删除文件而报 `Failed to open file`。先确认构建结束，再原样重跑 lint，不扩大忽略范围掩盖源码错误。
