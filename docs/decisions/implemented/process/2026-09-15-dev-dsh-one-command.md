# Agent Note: 一键 DSH／局域网开发编排、数据源非阻塞门控与 Windows 进程树生命周期

Status: implemented

## Problem

DSH Web 原生开发涉及 dshvm 槽位、宿主锁恢复、AG-UI 检出构建、Surface 编译、Profile 链接、桥接密钥与双进程协同，散落二十余条手工命令且仓库目录迁移后 Profile `link:` 极易悬空；`pnpm dev:lan` 若不感知参考库与 Synthea Provider 状态会让开发者登录后才发现目录缺失，而强阻塞又会在未装 Docker 时卡死普通 HIS 开发。在 Windows 11 环境下还存在三类平台陷阱：`.cmd` 入口转义、无管理员权限下的目录链接与退出后残留孤儿 watcher 进程；父进程残留 `NODE_PATH` 会让 DSH 误加载旧 worktree 插件；经 Turborepo 包装常驻 `tsx watch`（`dev:server`）会因 IPC 管道中继随机死锁进程树并过滤 `CLINMESH_AI_*` 环境变量。

## Decision

通过 `scripts/dev-dsh.ts`、`scripts/dev-lan.ts`、`scripts/development-processes.ts` 与直连 `dev:server` 统一跨平台一键开发体验，操作说明见[部署指南](../../../deployment.md)：

1. **锁文件驱动的 `dsh:setup`／`dev:dsh` 幂等沙箱与同退编排**：脚本唯一从 `dsh-upstreams.lock.json` 读取 DSH、dshvm 与 AG-UI 精确版本，在 `.data/dsh-runtime/`（可由 `CLINMESH_DSH_SANDBOX` 覆盖）维护隔离沙箱：按模板与 `build-stamps.json` 跳过未变依赖，每次启动重验并自愈 Profile 三个插件链接、无条件执行幂等 `dshvm use`、重建全仓输入的 ClinMesh DSH 产物、自动补齐缺失的 32 字节 `CLINMESH_DSH_BRIDGE_SECRET` 并预探测 `3080` 端口防静默漂移；`development-processes.ts` 并行拉起 Server 与 DSH Host，捕获带启动 token 的 `dsh web: <url>` 打印就绪横幅，任一进程退出即全停报因（不自动重启掩盖崩溃，与全量回写的 CI `dsh-upstreams-verify.ts` 保持职责解耦）。
2. **数据源非阻塞就绪门控（`ensureDataSourcesReady`）**：`dev:lan` 与 `dev:dsh` 启动前统一探测数据源——`CLINMESH_REFERENCE_DATABASE_PATH` 缺失或落后于 `reference-data.lock.json` 时自动同步，未配置则提示内置合成夹具限制；`CLINMESH_SYNTHEA_PROVIDER_URL` 指向本机受管环回端口且未响应时静默预检 `docker --version` 后自动执行等价 `synthea:up`，Docker 缺失或远端不可达仅打印降级警告而不阻塞普通 HIS 启动。
3. **Windows 跨平台链接、环境隔离与 Job Object 原子清理**：命令调用经 `cross-spawn` 保持 argv 转义安全（禁开 `shell: true`）；Windows 插件目录采用免管理员权限的 `junction`（`lstat` 检测悬空链接）；拉起 DSH Host 子进程前显式清空 `NODE_PATH` 防止跨 worktree 旧包遮蔽 Profile 插件；Windows 进程组由 PowerShell 辅助器通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcess` 瞬间原子挂入带 `KILL_ON_JOB_CLOSE` 的内核 Job Object，确保异常中断或父命令提前退出时彻底清理整棵后代进程树。
4. **`dev:server` 绕过 Turborepo 直连 pnpm**：根 `pnpm dev:server` 与 `dev:dsh` 的 Server 分支统一采用 `pnpm --filter @clinmesh/server dev` 直启（直启前将 `.env` 中的相对数据库与静态资源路径按 `.env` 所在目录绝对化），彻底消除 Windows 下 Turbo 管道冻结及 strict env 对 `CLINMESH_AI_*` 变量的过滤。

## Alternatives considered

- **把 DSH 开关塞进 `dev:lan`、按文件 mtime 跳过 ClinMesh 产物重建，或运行期崩溃自动重启**：耦合局域网与宿主两套截然不同的前置面，漏检跨包改动导致静默旧包，或吞掉真实崩溃现场。
- **数据源未就绪时直接中止 `dev:lan`**：违背 Synthea Provider 可选架构边界，使无 Docker 环境无法调试常规门诊住院流程。
- **Windows 下开启 `shell: true` 或退出时仅调 `taskkill /T`**：破坏特殊字符路径安全性，且父进程已退出时无法凭失效 PID 回收孙代 watcher。

## Consequences

Windows PowerShell、macOS 与 Linux 开发者均可通过单条 `pnpm dev:dsh`、`pnpm dev:lan` 或 `pnpm dev:server` 获得一致的数据源准备、插件链接自愈、环境变量透传与无残留进程回收体验。
