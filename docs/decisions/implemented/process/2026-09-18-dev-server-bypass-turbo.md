# Agent Note: 根 dev:server 绕过 Turborepo 直连 pnpm

Status: implemented

## Problem

Windows 11 开发机上，根 `pnpm dev:server`（`turbo run dev --filter=@clinmesh/server`）包装的 `tsx watch` 持久任务会随机把整棵进程树冻结在启动阶段：`db:prepare` 完成后日志再无输出，服务永不打印 `ClinMesh listening`。取证显示 tsx watch 父进程的 IPC 管道已创建、子进程已派生，但双方 CPU 时间完全停止增长，Node inspector 的 CDP 握手也无法完成（主线程不再泵事件）；同一命令绕开 turbo（裸 `tsx watch`、`pnpm run dev` 全链）则 100% 正常，经 turbo 复现则 100% 冻结。该冻结与 ClinMesh 代码、SQLite 和参考库校验耗时无关。此外 Turborepo strict env 只转发 `passThroughEnv` 声明的变量，turbo 包装的 dev:server 历史上也不转发未声明的 `CLINMESH_AI_*` 变量。

## Decision

根 `dev:server` 改为 `pnpm --filter @clinmesh/server dev`，与 `pnpm dev:dsh` 的 Server 进程同一启动路径。dev 任务在 turbo.json 中本就是 `cache: false` 的持久任务，Turborepo 在此只提供输出前缀，无缓存价值；经 turbo 的持久 dev 任务不再使用。

## Alternatives considered

- 升级 turbo 2.10.11 到 2.10.13：无证据表明修复该 Windows 管道中继冻结，且引入依赖变更，风险大于收益；后续若上游确认修复可再评估恢复包装。
- 用 `scripts/development-processes.ts` 承载 dev:server：该 runner 面向多进程并行编排（dev:dsh），单包顺序链用一行 pnpm 直连即可，不引入新入口。
- 保留 turbo 包装并在文档标注“偶尔卡死就重启”：冻结不可自愈且无法从终端输出区分“慢启动”与“已冻结”，把诊断成本留给每个开发者不可接受。

## Consequences

- `pnpm dev:server` 语义不变（构建 Web → db:prepare → `tsx watch src/index.ts`），环境变量不再被 strict env 过滤，`CLINMESH_AI_*` 等未声明变量随 pnpm 自然传递。
- dev:server 输出不再带 `@clinmesh/server:dev:` 前缀；单包顺序链下无并行输出混淆。
- 其他 turbo 任务（build、typecheck、test 等）不受影响；若未来把其他常驻 `tsx watch` 任务放入 turbo，需重新评估该冻结风险。
