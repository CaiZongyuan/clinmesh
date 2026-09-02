# 工程记忆

本文保存用户的稳定协作偏好和从实际操作中提炼的低频坑。产品行为、架构和测试合同仍由各自 owner 文档负责；高频且每次都必须看到的防错规则提升到根或子目录 `AGENTS.md`。

## 协作与交付偏好

- 已批准的 spec、测试 seam 和拆票结构没有未决分支时，直接实施，不重复展示最终待发布全文，也不逐项请求内容批准。
- 用户要求“完整整个 issue”时，一口气完成全部 tickets，最终只提一个集成 PR。Tickets 用于执行和追踪，不自动等于一个 ticket 一个 PR。
- Merge、发布或合并现有工作区变更仍以用户明确授权为边界；授权已经给出后直接执行，不再增加一次确认。
- 用户明确要求把当前工作区 changes 一并提交时，先辨认并保真保存这些修改，再纳入目标 PR；不丢弃、不改写为自己的内容，也不额外推送原工作分支。
- 用户询问进度时，先报告已经完成、正在处理和剩余阻塞，然后继续执行，除非用户要求暂停。
- 用户询问合成演示账号或密码时，从当前 Scenario 或 seed owner 直接给出可试用信息；真实凭证、平台密钥和患者信息永不写入本文或公开 artifact。
- 快速 UI 探索默认只在隔离的 `/ui-dev` 原型入口生成界面，使用 mock 数据承载必要状态和交互，不接生产业务、不补测试，也不启动完整交付流程；根据用户的视觉反馈直接迭代，只有用户明确选定方案并要求落地后才进入正式实现。

## 产品参考优先级

- 中国公立医院 HIS 的业务语义、岗位交接、正向流程和逆向状态以 OpenHIS 为首要参考；FHIR Repository、history、Search、授权和审计基础设施以 Medplum 为首要参考。两者是长期业务与技术参照，但不授权复制其物理架构或未实际闭环的菜单和占位实现。
- Tairex 虚拟诊室研究只参考虚拟诊疗产品模式和体验；`references/DSH-AGUI-demo` 与其他 Agent 案例只参考 UI 和交互布局，不作为 HIS 业务事实来源。发生冲突时以 OpenHIS、Medplum、当前 ClinMesh owner 文档和可执行流程为准。

## 运行与验证边界

- 当前 Web 交付使用 Node.js 真实入口即可证明运行时和数据库生命周期；没有明确容器验收条件时，不安装、不启动也不要求 Docker。
- 验证必须对应 outgoing diff。纯 Markdown、设计资产或 PR 媒体变更不触发代码单元测试、全量 `pnpm test` 或 `pnpm check`；只运行 owning 文档检查、媒体解码或发布可达性检查。
- 已经通过且没有被后续变更失效的证据不因 commit、push、review、Ready 或 merge 再次运行。
- 生产 Docker build 不能假设 `better-sqlite3` 一定有预编译件。Build stage 保留 `python3`、`make` 和 `g++` 供 `node-gyp` 回退编译，runtime stage 不携带工具链；升级 Node.js 或 `better-sqlite3` 后必须用实际 Docker build 和健康启动验证。
- Command receipt 是跨版本持久数据。响应 DTO 新增必填字段时提供向后兼容默认值或迁移旧回执，并用原幂等键重放升级前响应形状；只验证新命令成功不能发现这类回归。
- Better Auth 在 `NODE_ENV=test` 下默认跳过 origin 校验；ClinMesh Auth 必须显式保持 origin check 开启，相关 HTTP 测试同时携带会话 Cookie 和 `Origin`，否则无法捕获开发 Web origin 的 CSRF 配置回归。
- `scripts/dev-lan.ts` 的进程生命周期覆盖完整子树。POSIX 上 Server 和 Web 必须使用独立进程组；任一分支退出或收到终止信号时，向两个完整进程组转发原信号。只终止顶层 `pnpm` 会遗留 Turbo、Vite 或 `tsx watch` 子进程，并在下次启动时产生错误的端口占用。
- DSH React Surface Client 以 classic lazy-CJS 加载；任何构建后仍存在的 `import.meta` 都会在模块执行前触发语法错误，即使该分支在运行时不可达。开发标记使用可被构建器静态消除的 `process.env.NODE_ENV`，artifact verifier 必须拒绝残留 `import.meta`。
- `vendor/dsh-react-surface` 的 `lib/` 是未跟踪的生成目录。ClinMesh 的 Vitest 若直接导入由 DSH 注入的 `dsh-react-surface/client` external，必须通过显式测试 alias 解析到本地 stub；测试不能依赖开发机曾构建 submodule 后遗留的 `lib/client.js`。
- WSL2 中 pnpm 为 Bun bin 生成的 shim 可能优先选择同目录 `bun.exe`，并把 Linux 路径转换成无法由该 Bun 解析的 UNC 路径。React Surface 构建脚本应由当前 Linux `bun` 直接执行 builder 的 TypeScript CLI，不能依赖该 shim；诊断时先比较实际 Bun 与 shim 目标，不要重复安装 Bun。
- worktree 外部的 `.env` 通过 shell 加载时，根 `pnpm dev:server` 的 Turborepo 子进程不会自动获得未声明转发的 `CLINMESH_AI_*` 变量。需要复用外部配置时直接运行 `pnpm --filter @clinmesh/server dev`，并从实际 Server 进程核对变量名；只核对父 shell 会把 Brief provider 的未配置误判为产品错误。
- SQLite perf gate 统计数据库、WAL 和 SHM 总增长；同一 Command completion 更新的多个 nullable 关联列若各建独立索引，会放大短事务 WAL pages。优先按真实验证查询建立一个复合索引，并用 `pnpm perf:ci` 证明增长，而不是放宽预算。
- VitePress 构建把公开页面里裸写的 `http://localhost:*` URL 当作内部死链并使 `pnpm docs:check` 失败（`127.0.0.1` 不受影响）。进入文档站投影的页面中所有本机地址一律写成代码 span，不起链接。
- pnpm 在 Windows 的 `node_modules/.bin` 只生成 `.cmd`/`.ps1` shim，且 Node 直接 `execFile` `.cmd` 会被拒绝。需要子进程调用 workspace 依赖的 CLI 时，用 `process.execPath` 加包内 JS launcher（如 `node_modules/cn-health/bin/cn-health.js`），不要拼 `.bin` 路径；Linux 测试传 `cliPath` 桩会掩盖该断裂，默认解析路径必须有独立测试。`cn-health dataset materialize` 支持多进程并行写同一 `--data-dir`（内部有锁），四个 Dataset 并行冷下载实测约 59s；`cn-health@0.5.1` 起子进程在 stderr 自带分阶段进度，reference-sync 逐行转发到 `onProgress`。升级被 `reference-data.lock.json` 的 `cli.version` 锁定，与 receipt 的 `cliVersion` 严格相等，升级时 lock、根 devDependency、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 三处必须同步，且旧版本条目会因排除清单移除而被 `minimumReleaseAge` 政策拒绝——先临时双列排除完成重解析、`pnpm clean --lockfile` 清陈旧条目后再收窄清单。

## 浏览器演示经验

- `agent-browser` 原生 WebM 会忠实记录自动化输入和等待，未经编排的完整闭环可能远慢于人类观看速度。优先按业务阶段分段录制，成片统一到 3–4 倍速并添加开场、岗位/动作字幕和结束状态。
- Headless 录制默认看不到鼠标指针。点击高亮必须在录制开始前注入已审查的同源脚本，由真实 `pointerdown` 或 `click` 事件在实际坐标显示短暂圆环；不能根据成片猜测并伪造历史点击位置。
- 字幕应持续显示当前岗位和动作，不用字幕复述页面上已经清楚可见的全部文字。压缩优先降低等待时长和分辨率，其次调整码率；临床字段、状态和错误信息必须仍可读。
- 发布媒体使用 append-only assets 分支和新文件名，不覆盖或改写已经发布的对象。PR body 记录 commit、入口、Scenario、时长、尺寸、大小和 SHA-256，并链接新版文件。
- 每次 `record start` 都配对 `record stop` 和进程清理。停止命令超时后检查 encoder 子进程，只对确认属于该录制会话的进程发送终止信号，避免后台 FFmpeg 无限驻留。
- `agent-browser` 会话守护进程存活时，单独终止 Chrome 可能触发自动重启。正常 `record stop`/`close` 超时后先终止该命名会话的守护进程，再清理其 Chrome 和 encoder 子进程；随后用 `ps`/`ss` 验证，不重新连接已关闭会话。
- `agent-browser record start` 会在现有命名会话中新增录制 tab，原 tab 仍可保有 DSH Surface leader lease。录制 DSH browser Tools 时必须关闭旧 tab，等待录制 tab 取得 `active` lease，再让 Agent 读取新的 Page Context；否则 Tool 可能正确更新旧 leader，而录制 tab 只显示未变化的 contender Surface。
- 使用 FFmpeg 前先检查依赖；缺失时报告而不是自行安装。后期只改变播放速度、字幕和编码，不拼接来自不同 Scenario、workspace、epoch 或 commit 的业务证据。
- 一次 FFmpeg 命令抽取多个时间点时必须为每个输出显式指定 input/map，或为每个时间点单独执行；依赖默认 stream mapping 可能让多个输出都取自第一个输入，形成看似正常的重复截图。

## GitHub 操作经验

- PR 使用 squash merge 后，旧 feature branch 与 `main` 的 SHA 历史会显示分叉，即使交付内容已经进入 `main`。清理时先检查 PR 和 tree 内容，让本地 `main` 对齐 `origin/main`，只移植 squash 后新增的提交；不要再次 merge 整条旧 feature 历史。
- 删除非 main 分支前先枚举本地 branches、remote heads 和占用它们的 worktrees。Assets 分支是已发布 PR 媒体的 owner，删除会使历史链接失效；用户仍明确要求只保留 `main` 时按要求删除并报告影响，不把媒体二进制转存到 `main`。
- `gh pr edit` 可能因 GitHub Classic Projects 的 GraphQL 字段废弃而失败。PR 正文更新可改用 REST：`gh api repos/<owner>/<repo>/pulls/<number> --method PATCH -f body=...`。
- `gh pr merge` 成功时可能没有标准输出。只用一次 `gh pr view --json state,mergeCommit` 确认结果，不因空输出重复合并或重跑检查。
- GitHub Raw 可能把包含 VP8/VP9 视频流的 `.webm` 响应标为 `audio/webm`。不要只按该 header 判定文件损坏；同时核对 HTTP 状态、字节数、校验和以及媒体流的 codec、尺寸和时长。
- 已合并 PR 的正文仍可补充更清晰的演示链接，但不得改写 merge commit 或 force-push 源分支。更新后只核对 PR 状态、head SHA 和新链接，不重跑产品测试。
