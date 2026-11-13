# 开发环境与跨平台运行

创建或复用 worktree、恢复依赖、处理 Windows/WSL 文件差异、启动进程或构建文档时查阅。本文记录环境排障经验；运行步骤由[部署指南](../deployment.md)拥有，验证范围由[测试策略](../testing.md)拥有。

其他操作经验见[工程记忆入口](memory.md)。

## Worktree、依赖与锁文件

- 多 worktree 不隔离宿主或 WSL 的内存与浏览器进程。Vite／Playwright 重任务争用导致 WSL 服务请求超时时，先停止调度新重批并保留会话，减少并发后核对基本命令是否恢复；不要为测试重启 WSL 或终止用户进程。并行验证使用独立数据库、端口和输出目录。

- 工作区文档意外缺失时，先核对 `git status`、差异、stash 的已跟踪及未跟踪树、历史提交和既有备份，确认删除范围及是否早于当前任务；不要用整笔 stash pop 混入无关修改。已跟踪文件可按已核对版本定向恢复；未跟踪规格需从备份或本机会话中保留的原始创建补丁恢复，核对原文与链接后再继续实施，不能凭 Issue 摘要重写替代。

- 仓库外的 `tsx` 验收脚本不继承仓库 `package.json` 的 ESM 类型；需要顶层 `await` 时使用 `.mts`。pnpm workspace 依赖也不保证在根 `node_modules` 暴露，按声明该依赖的包解析模块，不能假定根目录拥有 Vite 等应用依赖。

- 跨 Agent 交接长验证时，统一执行工具的 `session_id` 属于发起线程，接收方可能得到 `Unknown process id`。启动时将精确提交、命令、工作目录、标准输出和退出码写入仓库外证据目录，再交接这些可读取文件；Playwright 另保留输出目录的 `.last-run.json` 与失败文字快照。截图数量只能证明生成了图片，不能替代测试终态。

- 手工测试或解释“当前实现”前，先核对工作目录的分支、HEAD、最新 `origin/main` 和实际服务的源码／构建来源；旧设计分支的行为不能代表最新主线。已合并任务的主目录仍停在旧分支时，先保全未提交内容再按用户目标切换；主线若被干净的历史验收 worktree 占用，可让该副本停在原提交的 detached HEAD 后释放分支。切换源码本身不证明已运行的 Server 或 DSH Surface 加载了新版本，运行核对见[DSH 集成排障](dsh-integration.md)。

- 隔离 worktree 需要子模块中的文档或源码时，使用该 worktree 自己的子模块检出，不要将整个子模块目录 junction 到另一个 worktree。子模块 `.git` 的相对路径会按当前入口解析，借用目录可能使 `git status` 报 `not a git repository`；可用 `git submodule update --init --reference <已核对相同固定提交的本地子模块> -- <子模块路径>` 复用本地对象，并核对子模块 HEAD 与父仓库 gitlink 一致。

- pnpm 11 临时切换 registry 使用 `pnpm_config_registry=https://registry.npmjs.org/`；旧式 `npm_config_registry` 在本机不能覆盖 registry，DSH 启动脚本即使设置它仍可能访问镜像。先用同一环境变量运行 `pnpm config get registry` 确认生效；遇到 `ERR_PNPM_NO_MATCHING_VERSION` 时，对比两源目标版本和版本列表。远端包含目标版本、安装仍报告旧列表时，检查本地元数据；确认陈旧后可用 `pnpm cache delete '<包名>'` 仅删除该包的缓存再重试，不降级依赖或清空整个缓存。`pnpm view` 能查到版本不代表 `pnpm dlx` 安装不再使用旧缓存，修复后须重跑原 CLI。

- 本机开发 skills 若只有 `.agents/skills/` 副本而没有 CLI 来源锁记录，更新命令无法据目录存在确定上游来源。先备份，再按原上游重新安装以建立 `skills-lock.json`，只选择该来源的 skills；后续使用 `skills update --project` 限定项目范围。安装记录通过本机 Git exclude 保持不入库，调用限制与项目适配边界见 [Agent 工程开发](../agent-development.md#skills)。

- 参考资料测试在导入已锁定合成 CSV 时出现 checksum mismatch，先核对 Git checkout 是否将原 LF 改成 CRLF；比较工作区原字节、规范化 LF 与清单 SHA-256，不能改清单哈希掩盖差异。`apps/server/tests/fixtures/reference-data/*.csv` 已用 `.gitattributes` 固定 LF；旧工作区需按 Git 原字节恢复这些 fixture。真实资料的 BOM、JSON 数字词法及换行同样属于内容身份，转换规则见[DRG 储存合同](../drg-reference-storage.md)。

- Node.js 24 盘点缓冲 JSONL 时出现 `ERR_USE_AFTER_CLOSE: readline was closed`，用超过千行的单个合成 Buffer 复核；readline 异步迭代器可能在输入结束后恢复已关闭接口。已经完整读取并校验的文本可惰性逐行解释，避免额外流生命周期；保留全部换行形式、末行、行数与内容哈希边界，见[DRG 储存决策](../decisions/implemented/architecture/2026-10-25-drg-compact-storage.md)及[公开清单核验回归](../../apps/server/tests/drg-reference-compact.test.ts)。

- 清理历史 worktree 前，先保全被忽略的本地数据和验收文件，并反查保留副本的 `node_modules` junction/symlink 是否仍借用待删目录；仍被借用的依赖 owner 暂留。Windows 上 `git worktree remove` 报 `Directory not empty` 或 `Filename too long` 后，可能已注销 worktree 并只删除了部分目录，必须分别核对登记与实际目录，不能把报错当作完整保留。清理残留前核实绝对路径白名单和备份，对链接只删除链接本身；Windows 标为 `prunable` 的 Linux 路径还要在所属 WSL 文件系统核实，不能直接批量 prune。待删 worktree 若用 junction 借用主 checkout 的 `node_modules` 条目，或 `@clinmesh/*` junction 仍指向主 checkout 的包目录，Windows 上的 `git worktree remove --force` 和递归删除可能沿链接删除主 checkout 的依赖与 `apps/web`、`packages/*`；删除前先列出所有重解析点，用 `cmd /c rmdir <链接>` 只解除链接，再删除目录。删除后用 `git status` 核对主 checkout，并重新安装依赖。

- Windows worktree 以 junction 复用依赖时，`git status --ignored` 可能追随依赖环并遍历超长路径。检查源码使用 tracked diff，本地数据按明确路径检查；中断扫描后若遗留 `index.lock`，先确认对应 Git 进程已退出、锁路径属于该 worktree，再清理该锁，避免并发切分支被阻塞。

- pnpm 11 默认的 `verifyDepsBeforeRun=install` 会在脚本运行前自动安装，可能因无 TTY 失败、重解析 `pnpm-lock.yaml` 或给 `file:` 依赖的 bin 源文件增加可执行权限。常规安装在验证前先跑 `pnpm install --frozen-lockfile` 并设 `pnpm_config_verify_deps_before_run=error`；独立 worktree 借用已有依赖或跑纯文档检查时设 `pnpm_config_verify_deps_before_run=false`（或直接用 `node` 调用已安装 CLI），撤回任何无关锁文件或子模块权限变动，且不得清理或重写其他任务共用的 `node_modules`。全局 pnpm 与 `packageManager` 版本不一致且联网解析卡住时，用可执行 shell wrapper 通过 `node` 调用已缓存的 `pnpm.cjs` 并同步子进程 `PATH`。重建 `@clinmesh/*` 链接须按各 `package.json` 名称同时覆盖 `apps/` 和 `packages/`（漏掉 `apps/` 会使 `apps/dsh-web/node_modules/@clinmesh/web` 仍指旧 worktree），验证前回读链接目标确认均指向当前副本。

- 隔离验证副本复用已安装依赖时，VitePress 会在仓库根 `node_modules` 自动创建 `vue` 符号链接。验证副本应保留自己的 `node_modules` 真目录，将已有包分别链接到依赖缓存，让构建新增链接写入验证副本；逐项链接时也排除 `.vite`、`.vite-temp`、`.cache`、`.turbo` 等可写缓存，改在验证副本创建真目录。整体链接共享依赖目录或复用这些缓存链接会把构建和测试写入带到共享目录。

- `publint` 会再调用包管理器打包；pnpm script 注入的 Node 目录可能让子进程选择 Corepack shim，而不是父进程使用的 pnpm。若父构建成功、打包却卡在解析 pnpm 版本，核对实际 PATH 和 Corepack 缓存，预先缓存仓库 `packageManager` 指定的版本；需要代理时在缓存准备步骤启用 Node 的代理支持，不通过跳过 publint 或覆盖宿主环境规避。

- npm 11 的依赖安装脚本默认审批策略可能让 `npm ci` 成功却没有构建原生 helper。依赖原生组件的安装模板要维护明确的 `allowScripts`，并按依赖锁核对审批目标；不要依赖另一个 Profile 的 pnpm 构建结果，也不要通过允许全部脚本掩盖缺失的项目策略。

- 验证副本和隔离 worktree 放在仓库外。Git 忽略的 `.data/` 仍可能被根 Vitest 的脚本文件 glob 遍历，仓库内嵌套 checkout 会重复运行它的测试；不能靠 `.gitignore` 隔离测试发现。

- `pnpm install --lockfile-only` 自动解决锁文件冲突时可能重新解析间接依赖，顺带升级两侧均未改动的版本。常规主分支整合先按合并后的 manifest 合并两侧已有锁条目，核对 package 版本与 integrity 沿用原值，再用 `pnpm install --frozen-lockfile` 验证；不要把自动解冲突成功等同于依赖范围未变。

- 原型和交互预览只保存在主 checkout 被忽略的 `.prototypes/`，新建的 worktree 检出不到。需要对照原型时，在 worktree 根目录执行 `ln -s <主 checkout>/.prototypes .prototypes`，所有 worktree 共用同一份原型。`.gitignore` 用不带斜杠的 `.prototypes` 同时忽略目录和软链接；带斜杠的写法只匹配目录，软链接会出现在未跟踪文件中。原型结构要点仍写进规格的验收条件，链接缺失时不能作为跳过对照的理由。

- 新建隔离 worktree 后，安装依赖前先用 `git submodule update --init --recursive vendor/dsh-react-surface` 检出仓库锁定的子模块。未初始化的子模块目录会让 `pnpm install --frozen-lockfile` 在扫描 `file:` 依赖的 `packages/runtime` 时以 `ENOENT` 失败；初始化后重新按锁安装，不改写锁文件绕过缺失目录。

## Windows、WSL 与跨平台文件

- WSL 无中文字体时，截图出现方框不能作为中文视觉证据。先用 `fc-match sans-serif:lang=zh-cn` 核对字体；软件源不可用时可复用本机已授权的 Windows CJK 字体到用户字体缓存，再刷新缓存并重拍。字体只用于本地验证，不提交字体文件或改变产品系统字体栈。

- Windows Agent 反复启动 `wsl.exe` 时若出现 `Wsl/Service/0x8007274c`，但 UNC 文件读取仍正常，先保留用户进程，不重启 WSL。已验证的恢复方式是在 Windows 本地目录启动带 TTY 的 `wsl.exe -d Ubuntu-24.04 --exec /bin/bash --noprofile --norc`，等 shell 提示符后复用同一会话执行命令，并将已安装的 Linux Node、pnpm 放在 PATH 前端；单独更换 cwd 或去掉 `--cd` 不能保证恢复。复用 shell 时设置 `GIT_PAGER=cat` 与 `PAGER=cat`，避免分页器读取队列里的后续命令；以实际退出码、Git 状态和提交记录核对执行结果。启动错误不是有效的测试失败，需在 shell 内重新取得目标行为的 red／green 结果。

- Linux worktree 的 Git 检查和提交使用同一 Linux shell。Windows Git 即使通过 UNC `safe.directory` 检查，仍可能按 Windows 换行规则扫描全仓，产生大量 LF／CRLF 提示、符号链接读取错误及后续索引 stat 刷新；这些现象不代表源码已被修改。先在原生 Linux Git 核对实际 diff，不为消除提示重写文件或更改全局换行配置。需要 Windows Git 排查推送时按[对象级推送经验](github-delivery.md#连接权限与-pr-操作)只操作已核对的 Git 对象。

- WSL 调用 Windows 可执行文件时报 `UtilAcceptVsock ... accept4 failed 110` 时，先检查继承的 `WSL_INTEROP`，不要当作目标应用的 HTTP 故障。用本机现存且可用的 `/run/WSL/*_interop` 套接字做最小探针，仅对子进程覆盖；Windows 原生命令输出可能不是 UTF-8，先以字节接收并按实际编码解码。

- Windows 运行指南同步时，若 WHO 文本成功而全部 PDF 报 `Invalid factory url ... must include trailing slash`，先检查 PDF.js 的 `cMapUrl` 和 `standardFontDataUrl`。`path.join` 会把末尾 `/` 转成反斜杠，不能满足 PDF.js 的字面斜杠校验；将本机路径分隔符统一为 `/` 并显式保留末尾 `/`，继续使用 Node 可读取的文件路径。用现有合成 PDF 原文及物理页定位测试复现和回归，再运行同步与只读 `--check`，不要改来源哈希或关闭原文校验。实现见[指南导入器](../../apps/server/src/infrastructure/guidelines/import-guideline-source.ts)。

- Windows 读取中文 PDF 时显式使用 `pdftotext -enc UTF-8`，并以 UTF-8 解码；默认输出编码可能产生非 UTF-8 字节。若显式编码后中文仍被映射为拉丁字母、数字或标点，应渲染相关页核对原文，不能以文件长度或提取命令成功判断正文可用。指南的阈值、单位、否定词和图表条件需逐页核验；实例见[冠心病指南资料核对](../research/2026-10-26-coronary-guidelines-project-reference.md#文件核对与阅读范围)。

- Windows PowerShell 向 Node 或浏览器等原生进程通过 stdin 管道传入中文脚本或 here-string 前，显式将 `$OutputEncoding` 设为无 BOM 的 UTF-8；默认管道编码可能把中文变成问号，使字符串替换静默无匹配却仍以零退出码结束。正式文件编辑优先使用结构化补丁并核对实际 diff；Windows PowerShell 5 的 `Set-Content -Encoding utf8` 会写入 BOM，Git 消息文件使用 `UTF8Encoding(false)` 写入并核对最终提交标题。

- Windows PowerShell 将原生命令 stderr 经 `2>&1` 重定向时，可能产生 `NativeCommandError`，使宿主报告非零退出，即使测试摘要全绿。调用后立即保存 `$LASTEXITCODE` 并显式返回，或用 Node `spawnSync` 将 stdout/stderr 写入日志并记录 `result.status`；分别核对原生退出码、宿主退出码和测试摘要，不仅凭摘要宣称命令成功。

- Node 测试用 `execFile('pnpm', ...)` 构建 CLI 时，Windows 只有 PowerShell／CMD shim 会报 `spawn pnpm ENOENT`。跨平台测试通过 `process.execPath` 启动已安装构建工具的 JS 入口，并显式设置目标包目录；CLI 进程验收见 `apps/server/tests/cli-process-http.test.ts`。

- Windows 的 `core.symlinks=false` 会将 Git mode `120000` 的符号链接（如 `CLAUDE.md`）检出为仅含目标路径的无换行普通文件：修改或校验前先检查 Git index mode，切勿向 `120000` 占位文件追加换行或改写共享 Git 配置；CLI 的 POSIX 权限与符号链接测试在原生 Linux 文件系统检出上验证（将 Linux Node、pnpm、Bun 置于 `PATH` 前端，持久目录存放跨命令产物）。从 Windows 归档 Git 原始字节时显式加 `git -c core.autocrlf=false archive`（防止 `core.autocrlf` 带入 CRLF 破坏合成数据 SHA-256 或 LF 行格式检查）；而从 Windows worktree 向 Linux 副本导出变更补丁时先暂存再用默认 `git diff --cached <base> --binary --output=<path>`（不强制 `core.autocrlf=false` 以免产生整文件换行伪 diff，也不改写原 worktree 的盘符 `.git` 指针）。 原生 Windows checkout 的文本 fixture 若受 manifest SHA-256 约束，先比较工作区字节与 `git show HEAD:<path>`；确认仅为 CRLF 转换时，在隔离副本恢复 Git blob 原字节后重跑，核对 `git diff` 为空，不改 manifest 哈希迁就本机换行。

- WSL2 中 pnpm 为 Bun bin 生成的 shim 可能优先选择同目录 `bun.exe`，并把 Linux 路径转换成无法由该 Bun 解析的 UNC 路径。React Surface 构建脚本应由当前 Linux `bun` 直接执行 builder 的 TypeScript CLI，不能依赖该 shim；诊断时先比较实际 Bun 与 shim 目标，不要重复安装 Bun。候选验收会净化 PATH，构建前分别验证 `bun --version` 与 `bunx --version`；只有单文件 Bun 时，在隔离工具目录提供指向同一二进制的 `bunx` 入口，不修改业务脚本补偿本机工具缺失。

- pnpm 在 Windows 的 `node_modules/.bin` 只生成 `.cmd`/`.ps1` shim，且 Node 直接 `execFile` `.cmd` 会被拒绝。需要子进程调用 workspace 依赖的 CLI 时，用 `process.execPath` 加包内 JS launcher（如 `node_modules/cn-health/bin/cn-health.js`），不要拼 `.bin` 路径；Linux 测试传 `cliPath` 桩会掩盖该断裂，默认解析路径必须有独立测试。`cn-health dataset materialize` 支持多进程并行写同一 `--data-dir`（内部有锁），默认 Dataset 可并行 materialize；`cn-health@0.5.1` 起子进程在 stderr 自带分阶段进度，reference-sync 逐行转发到 `onProgress`。升级被 `reference-data.lock.json` 的 `cli.version` 锁定，与 receipt 的 `cliVersion` 严格相等，升级时 lock、根 devDependency、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 三处必须同步，且旧版本条目会因排除清单移除而被 `minimumReleaseAge` 政策拒绝——先临时双列排除完成重解析、`pnpm clean --lockfile` 清陈旧条目后再收窄清单。

## 进程、容器与服务启动

- 启动器在仓库根准备数据库、再通过 `pnpm --filter` 启动 Server 时，子进程的工作目录会切到 `apps/server`。向子进程传递 `.env` 路径前，以仓库根解析为绝对路径；否则父子进程可能访问不同的数据库。DRG 规则目录与审核文件同样必须由 `resolveServerEnvironmentPaths` 转换；继承的相对环境变量会覆盖 Server 从 `.env` 解析的绝对值，导致根目录文件存在却报 `apps/server/.data/drg-rules/` 下文件缺失。取消子进程重复准备或新增路径配置时，用默认相对路径回归此边界，不能只测绝对路径。

- CI 中容器健康接口持续拒绝连接时，先核对启动进程是否已因依赖未就绪而退出；重试端口不能重新启动进程。容器依赖顺序与清理前保留日志见[Synthea 运行时决策](../decisions/implemented/architecture/2026-09-03-one-command-synthea-runtime.md)。

- Windows 进程树测试必须在启动器自身仍存活时检查后代退出；只在启动器退出后检查，可能被 Node 的进程清理掩盖。用 `.cmd` 中间层和 detached 后代覆盖实际包管理器链路，并保留无关进程存活断言。

- Docker 跨架构兼容性核验以当前 Compose 锁定 digest 的 manifest/index 与运行 config 的 `os`、`architecture` 为准，逐个确认依赖；index 中 `unknown/unknown` 的 attestation 是证明材料。分别报告原生发行、模拟运行和目标主机验收，本机 amd64 smoke 只提供其架构的生成证据。示例见[macOS 兼容性核验](../research/2026-10-13-synthea-macos-compatibility.md)。

- 生产 Docker build 不能假设 `better-sqlite3` 一定有预编译件。Build stage 保留 `python3`、`make` 和 `g++` 供 `node-gyp` 回退编译，runtime stage 不携带工具链；升级 Node.js 或 `better-sqlite3` 后必须用实际 Docker build 和健康启动验证。

- pnpm 11 的 `deploy --prod --legacy` 会重新解析 workspace 的 peer，即使只 filter Server，也可能请求未发布的 DSH 本地 peer。部署命令局部关闭 `auto-install-peers`，不修改整个 workspace 的 peer 合同；legacy 不保留 frozen-lockfile 语义，部署后仍需核对实际生产依赖与容器启动。deploy 后在源码 workspace 继续运行 pnpm script 可能触发依赖修复并要求非交互安装；已完成 frozen install 的构建步骤直接使用固定包内 JS launcher 运行资料同步。

- 把已写入的 SQLite 固化到只读镜像前，先 checkpoint 并切换 `journal_mode=DELETE`。仅关闭 WAL 库的连接通常不会改变文件头模式；只读查询仍可能尝试创建 `-shm`，在只读根文件系统上失败。验收时关闭容器网络并使用只读根文件系统，从健康接口和管理员查询确认预检与实际 runtime 均可读取。

- `scripts/dev-lan.ts` 的进程生命周期覆盖完整子树。POSIX 上 Server 和 Web 必须使用独立进程组；任一分支退出或收到终止信号时，向两个完整进程组转发原信号。只终止顶层 `pnpm` 会遗留 Turbo、Vite 或 `tsx watch` 子进程，并在下次启动时产生错误的端口占用。

- POSIX 上进程组 kill 已生效后，孤儿进程在被收养方收尸前仍处于僵尸/退出中状态，`kill(pid, 0)` 会把它探测为存活。判定幸存者必须在断言前轮询等待全部不可探测（如 50ms 间隔、数秒上限），超时仍存活才上报失败；Windows 无僵尸进程，本地全绿不能证明 Linux 无竞态。探测只把 `ESRCH` 视为已死、其余错误如实抛出，并拒绝非正整数 pid（`Number` 解析出的 NaN 会被强转为 pid 0，探测到探测方自身进程组）。

- Windows 上 Turborepo 包装 `tsx watch` 的持久任务（旧根 `pnpm dev:server`）会以约三成概率把整棵进程树冻结在启动阶段：父进程 IPC 管道已建、子进程已派生，但双方 CPU 归零、服务永不监听，且 forensics 期 inspector 无响应。常驻开发服务器一律直连 pnpm（`pnpm --filter @clinmesh/server dev`），不进 turbo；诊断该类挂起先用“绕开包装层”隔离，再比较冻结与正常实例的 CPU 增量。

- Turborepo strict env 只转发任务声明的 `passThroughEnv` 变量，turbo 包装的任务拿不到未声明的 `CLINMESH_AI_*` 等变量。核对环境变量是否生效要从实际业务进程取证，只看父 shell 会把 provider 未配置误判为产品错误；这也是根 `dev:server` 改为直连 pnpm 的原因之一。

- WSL mirrored 模式下 `ss` 显示 `127.0.0.1` 端口 LISTEN 且无属主、Windows 侧 `netstat.exe` 与 `Get-NetTCPConnection`（非 admin）和 Linux `/proc/net/tcp`（含全部进程的 per-pid tcp 表，VM 只有单一 netns）都查不到该端口，但 curl 可连通、WSL 内 bind 报 `Address already in use` 时，优先怀疑 Docker Desktop 容器的发布端口：`docker ps` 的 PORTS 列直接给出属主（如 `127.0.0.1:51878->51878/tcp`），`docker stop` 对应容器即释放。Docker 把发布端口持有在非默认网络隔离区，用户态枚举不可见，不要沿防火墙保留区或幻影镜像方向继续排查。

- 隔离验证实例须覆盖仓库 `.env` 中的 `CLINMESH_PUBLIC_ORIGIN` 与 `CLINMESH_TRUSTED_ORIGINS`，否则登录返回 `INVALID_ORIGIN`；数据库迁移从 `apps/server` 目录运行。没有配置 `CLINMESH_AI_*` 时 Persona 任务无法完成，合成病例不能开始就诊。

- worktree 首次跑 `pnpm dev:dsh` 前先补齐两类 gitignored 环境：从主工作区复制 `.env`，再运行 `pnpm reference:sync` 物化参考数据；缺后者时 Server 在 runtime 初始化抛 `REFERENCE_RELEASE_NOT_FOUND`。`.env` 的 `CLINMESH_REFERENCE_RELEASE_ID` 落后于 lock release 也会同样报错——主工作区可能因 `.data` 库里残留旧 release 而侥幸可用，新 worktree 的全新库只会暴露它；发现配置漂移时两侧一起更新，不要只修 worktree 掩盖主工作区的雷。端口语义：DSH Web 3080 被残留进程占用时脚本拒绝启动（防 trusted origin 与登录校验错位，不要绕过）；Server 51868 的残留须手动 kill（只停 `pnpm` 包装层不杀子进程）；Synthea 51878 由 Docker 容器幂等复用，跨启动存活是正常现象。

## 文档构建

- `verify:docs` 与 `verify:agent-notes` 兼容 CRLF/LF 行尾并按 Git index 识别 `120000` 符号链接别名，但新编写或编辑的仓库文件仍统一保存 LF 与末尾单换行（Windows 符号链接与归档注意事项见上节）。

- Vite SSR 将带 CLI 守卫的模块内联到另一个入口后，`import.meta.filename` 会变成构建入口文件，单独比较 argv 路径可能误执行被导入模块的 CLI。库逻辑优先直接依赖 typed service；保留 CLI 的模块还要核对入口 basename，并用真正构建出的 JS 执行合成资料准备验证退出码和 JSON 输出。见[DRG 自动分发决策](../decisions/implemented/architecture/2026-10-22-drg-reference-distribution.md)。

- VitePress 文档站与 `verify:docs` 共用 GFM 兼容的 `slugifyHeading` 生成标题锚点；在标题旁保留显式 `<a id="...">` 兼容历史锚点时，避免与标题自身生成的 slug 产生同页重复 `id`，搬迁章节后同时运行 `pnpm verify:docs` 与 `pnpm docs:check` 核对构建产物。归属与校验规则见[文档整理决策](../decisions/implemented/process/2026-10-19-documentation-ownership.md)。

- VitePress 构建把公开页面里裸写的 `http://localhost:*` URL 当作内部死链并使 `pnpm docs:check` 失败（`127.0.0.1` 不受影响）。进入文档站投影的页面中所有本机地址一律写成代码 span，不起链接。

- 文档站构建与全仓 lint 顺序执行：VitePress 会短暂创建并删除 `.vitepress/config.ts.timestamp-*.mjs`，并行 oxlint 可能在扫描后读取到已删除文件而报 `Failed to open file`。先确认构建结束，再原样重跑 lint，不扩大忽略范围掩盖源码错误。

- 从已导出 `CLINMESH_DATABASE_PATH` 等变量的终端或 Agent 运行环境切换 worktree 时，调用环境会覆盖新副本的 `.env`。启动命令显式传入该 worktree 的业务、Reference 和指南数据库路径；启动后核对 Server 子进程的实际环境与迁移备份路径，再以健康响应确认就绪，不能仅核对 `.env`。

- Windows PowerShell 的 `Set-Location` 不会改变 .NET 进程当前目录；在其后用相对路径调用 `[System.IO.File]::ReadAllText` 或 `WriteAllText` 会解析到启动目录，静默读写错文件或报找不到标记。脚本内的 .NET 文件 API 一律使用绝对路径；需要多行替换或插入时，把逻辑写成仓库外的 Node 脚本文件运行，避免 `node -e` 在 PowerShell 中的引号拆分。
