# Agent Note: dev:dsh 一键 DSH Web 原生入口

Status: implemented

## Problem

DSH Web 原生入口的搭建与启动散落在部署指南约二十条手工命令中：dshvm 沙箱、宿主锁文件恢复、AG-UI clone/build、Surface runtime 构建、Profile 组装、bridge secret 与双终端启动各自独立。版本事实存在于 `dsh-upstreams.lock.json` 却无程序化消费，目录迁移后 Profile `link:` 指向旧绝对路径只能人工排查。开发入口与 `pnpm dev:lan` 的体验差距使 DSH 模式进入成本远高于 standalone Web。

## Decision

`scripts/dev-dsh.ts` 提供两条命令：`pnpm dsh:setup` 幂等供给运行时，`pnpm dev:dsh` 复用同一 ensure 后由共享的 `scripts/development-processes.ts` 同时拉起 ClinMesh Server 与 DSH Web，任一退出全停并报因。核心规则：

- 版本单一来源：DSH、dshvm 版本与 AG-UI commit 只读 `dsh-upstreams.lock.json`（复用 `dsh-upstreams.ts` 的 `parseLock`），脚本零硬编码，升级上游只改 lock。
- 沙箱固定在仓库内 `.data/dsh-runtime/`（`CLINMESH_DSH_SANDBOX` 可覆盖到仓库外）：dshvm 槽位、隔离 DSH_HOME、AG-UI checkout 与 Web Profile 持久化，按探测结果跳过已完成步骤。
- 幂等探测而非时间戳：宿主与 Profile 依赖以"模板内容一致且依赖目录存在"判定；React Surface 与 AG-UI 以 `build-stamps.json` 记录已构建 commit，commit 变化才重建；ClinMesh DSH artifact 的输入是整个仓库，每次启动重建，不静默使用旧产物。
- Profile 三个 `link:` 插件每次启动 `readlink` 重验，指向漂移即重建且不触发 Profile 重装——目录迁移坑从人工修复变为自动治愈。
- `CLINMESH_DSH_BRIDGE_SECRET` 缺失时生成 32 bytes 随机值追加 `.env`，已有值不覆盖，此后脚本与手工直启同源；trusted origins 自动注入 `127.0.0.1:51868/51888/3080` 并跟随 `CLINMESH_PORT`。
- fail-fast：Bun `1.4.x`、submodule 与 `.env` 是前置检查，缺失时不启动任何进程；网络步骤（npm/dshvm/bun 安装、clone）失败自动重试一次，仍失败抛出带修复指引的 `DevDshEnsureError`；运行期进程不自动重启，避免掩盖真实崩溃。
- Server 以 `pnpm --filter @clinmesh/server dev` 直启绕过 Turborepo，`CLINMESH_AI_*` 直接生效；数据源就绪复用 `dev-lan.ts` 的 `ensureDataSourcesReady`，口径与 [dev:lan 数据源就绪门控](2026-09-15-dev-lan-data-source-gating.md) 一致。直启前由 `createDshDevelopmentPlan` 把 `CLINMESH_DATABASE_PATH`、`CLINMESH_REFERENCE_DATABASE_PATH` 与 `CLINMESH_WEB_ROOT` 按 `.env` 所在目录绝对化：Server 自身对 `.env` 相对路径执行同一规则，但进程环境里的原始相对值会覆盖该结果并按进程工作目录（apps/server）解析——Turborepo 的环境过滤恰好滤掉这些变量，因此该陷阱只暴露给直启路径。
- dshvm 的 `use` 每次启动无条件执行：`which <version>` 只回答槽位位置，不证明 active 选择，而 `exec web` 依赖 active 状态；`use` 幂等且廉价，执行后再用 `which` 断言槽位正确。
- 启动前探测 `3080` 端口，被占用即失败：DSH 遇端口占用会静默改用其他端口，而 trusted origins 与登录 CSRF 校验绑定 `3080`，静默漂移会产生难以定位的登录失败。

进程组管理从 `dev-lan.ts` 抽取为共享 `development-processes.ts`（`DevelopmentProcess.command` 可选，默认 pnpm），dev:lan 行为不变，其活体监督测试继续拥有同退语义。CI 候选验收（`dsh-upstreams-verify.ts`）保持独立的临时目录流程：两者序列事实同源于部署指南，但验收需要全量执行并回写锁与 manifests，开发需要幂等跳过且绝不写仓库文件，不共享组装代码。

## Alternatives considered

**扩展 dev:lan 加 DSH 开关。** 两种模式的进程面、origins 与前置完全不同，开关组合翻倍路径，且局域网场景不需要 DSH。

**每次全量重建全部构建。** 正确性最高，但 bun install 与 AG-UI 构建在秒到分钟级，热启动劣化；外部输入是锁定 commit，stamp 已保证重建等价。

**以 mtime 判断 ClinMesh artifact 新鲜度。** 输入是整个仓库，漏判任一文件即静默旧产物；每次重建的成本可接受。

**运行期进程自动重启。** 掩盖 Server panic 与 Host 崩溃，违背可观测性；ensure 幂等使人工重跑成本极低。

**沙箱放仓库外兄弟目录（原手工路径）。** 生命周期与仓库脱钩正是迁移 link 坑的根因；收进 `.data/` 并由脚本每次重验后问题类别消失。代价是删除仓库丢失 DSH 内手工配置，但 lock 纪律下沙箱可重建。

**与 `dsh-upstreams-verify.ts` 共享组装原语。** 两者控制流差异（全量线性回写 vs 探测跳过只读）大于序列相似性，强行抽象产生双向耦合。

## Consequences

Linux/macOS 上 DSH Web 原生入口的进入成本收敛为 `pnpm dsh:setup` + `pnpm dev:dsh`；Windows 保留部署指南手工路径。`scripts/dev-dsh.spec.ts` 以注入文件系统与命令执行覆盖冷/热运行、link 自愈、stamp 重建、secret 生成与重试边界，不真实联网、不启动 DSH；进程同退语义由 dev-lan 的活体监督测试继续覆盖。AG-UI 的 GitHub clone 仍是网络依赖，重试一次后失败即停止。仓库迁移目录后无需人工修复 Profile 链接。

Issue: https://github.com/CaiZongyuan/clinmesh/issues/102
