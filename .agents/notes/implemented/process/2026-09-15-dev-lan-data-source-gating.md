# Agent Note: dev:lan 数据源就绪门控

Status: implemented

## Problem

`pnpm dev:lan` 只负责启动 Server 与 Web，不感知数据源状态：Synthea Provider 是否运行、参考目录数据库是否存在都只能在登录后逐个发现。局域网演示或开发启动因此依赖部署指南的多步前置命令，无法一条命令直达可用状态。同时，就绪探测的目标地址必须与 Server 实际消费的 Provider 地址同口径，否则会出现"脚本报告已就绪、Server 实际不可用"的矛盾。

## Decision

`scripts/dev-lan.ts` 在启动双进程前执行 `ensureDataSourcesReady`，逐项打印数据源状态，任何数据源失败都只降级为警告，不阻塞启动：

- 参考目录数据库三分支：`CLINMESH_REFERENCE_DATABASE_PATH` 已配置且包含当前 Release 则报告就绪；文件缺失或版本不匹配时自动同步到配置路径；未配置则提示使用内置合成 fixture（医生无法下诊断或开检验）并指向 `pnpm reference:sync`。
- Synthea Provider 只探测 `CLINMESH_SYNTHEA_PROVIDER_URL`，与 Server 的消费口径一致；URL 未配置即等价于生成能力不可用，不探测端口默认地址。探测失败时，仅当 URL 主机名为环回地址且端口等于 `CLINMESH_SYNTHEA_PROVIDER_PORT`（默认 51878）时，视为本地受管地址并执行与 `pnpm synthea:up` 等价的自动拉起；否则视为远程自定义地址，只警告。Docker 不可用或拉起失败时警告"HIS 可正常使用，仅新的患者生成任务不可用"后继续。
- `CLINMESH_SYNTHEA_PROVIDER_PORT` 无效时打印其校验错误并跳过自动拉起，不静默吞掉。

参考目录的当前 Release 以 `reference-data.lock.json` 为单一事实来源：Server 配置在 `CLINMESH_REFERENCE_RELEASE_ID` 未配置时默认读取 workspace 根 lock 的 `compositeRelease.releaseId`（lock 升级自动跟随；lock 缺失或无效时回退原有语义），开发脚本不为本地数据库引入第二套 Release 解析。dev:lan 的 Release 就绪检查与自动同步由[默认检验服务与统一模拟数据管理](../architecture/2026-09-15-default-laboratory-and-data-reset.md)定义；Server 继续对配置库中当前 Release 缺失执行失败关闭。

健康探测、`.env` 加载和运行时依赖工厂复用 [一键 Synthea 运行时](../architecture/2026-09-03-one-command-synthea-runtime.md) 的 `scripts/synthea-runtime.ts` 导出，不复制健康合同。`up` 与 `doctor` 在首次调用 docker 前静默预检 `docker --version`（`stdio: ignore`）：CLI 不可用时抛出单条含修复指引的中文错误，不执行任何 compose 命令，避免 Docker Desktop WSL stub 的重复提示噪音；`down` 保持幂等清理不做预检。开发输出按"数据源 / 访问地址"分节，状态行带 ✓/⚠ 前缀，颜色仅在交互终端且未设置 `NO_COLOR` 时启用。"Provider 缺失不阻塞普通 HIS"的边界不变：门控发生在开发启动脚本，Server 进程本身仍不等待 Provider。

## Alternatives considered

**数据源未就绪时中止 dev:lan。** 这保证启动即完全可用，但 Docker 未运行时连普通 HIS 开发也无法进入，违反 Provider 可选的既有边界。

**只检查不拉起。** 提示操作者手动运行 `pnpm synthea:up` 保留两条命令，一条命令直达可用状态的目标落空；自动拉起复用幂等的 `up`，成本与手动执行相同。

**探测端口默认地址（不依赖 URL 配置）。** Server 在 URL 未配置时进入显式不可用状态，不构建默认地址；脚本若探测默认端口会把未配置误报为就绪。

**由 Server 在启动时自拉 Provider。** 已被一键 Synthea 运行时决策拒绝：需要 Docker socket 或扩大主进程供应链，并让可选生成能力阻塞普通 HIS。

## Consequences

全新 checkout 配好 `.env` 后 `pnpm dev:lan` 一条命令即可进入具备完整数据源的局域网开发；Docker 缺失时自动拉起快速失败并降级，HIS 开发不受影响。`scripts/dev-lan.spec.ts` 的进程监督测试通过注入假 Provider HTTP 服务与参考库文件隔离真实 Docker。就绪输出属于开发脚本日志，不进入 Server 审计。
