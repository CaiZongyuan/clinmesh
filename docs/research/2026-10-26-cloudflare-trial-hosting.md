# ClinMesh 的 Cloudflare 试用部署可行性

核验日期：2026-10-26。本记录保存 Cloudflare 官方文档与当前仓库之间的适配证据，不定义产品支持合同，也不代表已经部署或获准实施。当前部署 owner 是[部署指南](../deployment.md)，单实例、事务和持久化合同由 [Demo 部署架构](../demo-architecture.md)拥有。

## 结论与适用范围

Cloudflare 可以承担试用入口，也有运行 Linux 镜像的 Containers 产品。当前 ClinMesh 不能仅上传前端或切换数据库连接后完整迁入 Workers。Containers 的运行环境更接近当前服务，但默认临时磁盘、快照与镜像绑定，以及请求编排要求，使其仍需要单独的持久化和部署适配。

面向少量受邀用户，优先评估独立运行副本配合 Tunnel 与 Access：Cloudflare 提供公网域名入口和受邀者准入，ClinMesh、DSH 与 SQLite 继续在已有电脑或云主机运行。这是建议，不是已经验证的部署结果；日常开发数据库不能直接充作对外试用实例。

## 当前项目的约束

- [Server 数据库实现](../../apps/server/src/infrastructure/sqlite/database.ts)使用 `better-sqlite3`；Workspace、FHIR 与 outbox 仓储依赖同步事务及 `BEGIN IMMEDIATE`。[认证服务](../../apps/server/src/application/identity-service.ts)使用 `drizzle-orm/better-sqlite3`。
- [现有 Dockerfile](../../Dockerfile)运行 Node.js、构建 standalone Web 与 Server，并把 operational SQLite 放在 `/var/lib/clinmesh`；[Compose](../../compose.yaml)提供命名持久卷和单副本。
- [单实例合同](../demo-architecture.md#4-单实例约束)要求一个服务端进程写入本地文件系统上的数据库，启用 WAL；缺少 SQLite 锁语义保证的共享文件系统不在当前支持范围内。
- 完整 DSH 体验还包括宿主进程、会话、Profile 与文件，其搭建方式见[DSH 原生入口](../deployment.md#dsh-web-原生入口)。当前 standalone Dockerfile 不包含完整 DSH 组合。

## Workers 与 D1

事实：Workers 的 [Node.js 兼容表](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)包含大量 Node API，但 `node:sqlite`、`node:child_process` 标为 non-functional stub；`nodejs_compat` 不等于完整 Node.js 主机。[文件系统文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)说明其 VFS 在内存中，`/bundle` 只读，`/tmp` 不提供跨请求持久化。

事实：[D1 的 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)接收 prepared statements，通过异步 API 在整批事务中执行，失败回滚。它不是当前 `better-sqlite3` 文件连接的同形替代。

推断：选择 Workers + D1，需要真实数据库 adapter、事务语义、迁移、备份恢复与后台任务适配及相应合同测试；DSH 进程还需要其他运行方式。D1 可作为迁移候选，不能以修改连接地址估算工作量。

具体代码影响、候选分工、费用情景和继续条件见 [Workers 与 D1 迁移评估](2026-10-26-workers-d1-migration-assessment.md)。

## Containers 的运行能力

事实：[Containers 首页](https://developers.cloudflare.com/containers/)明确可在 Workers Paid plan 使用，运行自定义语言、Linux-like 环境和现有容器镜像；实例由 Worker 与 Durable Object 控制。[生命周期文档](https://developers.cloudflare.com/containers/concepts/architecture/)说明实例运行在拥有独立内核和网络的 Firecracker microVM 中，镜像应构建为 `linux/amd64`。[执行命令文档](https://developers.cloudflare.com/containers/guides/execute-commands/)支持在运行实例中启动额外进程。

推断：Containers 的运行时具备承载 Linux Node.js、原生 SQLite 依赖与多个进程的基础条件。但官方平台能力不能代替当前 ClinMesh 镜像、Bun/DSH、原生扩展与完整业务路径的实测。

事实：标准部署入口配置 Worker、Durable Object、镜像和实例大小，再使用 Wrangler 部署。[FAQ](https://developers.cloudflare.com/containers/faq/)另有 Docker-in-Docker 示例，要求 root 并关闭若干网络功能。当前 Compose 配置不会自动成为等价的 Cloudflare 路由、生命周期或存储编排；本轮未验证 Docker-in-Docker 作为 ClinMesh 部署方案。

当前首页的可用性陈述是 Workers Paid plan 可用。本轮未核实单独的 GA 宣布，不将历史 beta 标签当作当前状态，也不据首页推断免费计划或具体账号已经获准运行。

## Containers 的数据保存与生命周期

事实：[FAQ 的磁盘说明](https://developers.cloudflare.com/containers/faq/#is-disk-persistent-what-happens-to-my-disk-when-my-container-sleeps)明确默认磁盘为 ephemeral；实例休眠后再次启动时从容器镜像获得新磁盘。更改休眠策略不能排除平台停止、主机重启、进程退出或镜像更新。平台不保证实例持续运行固定时长；停止时向主进程发送 `SIGTERM`，最多等待 15 分钟后使用 `SIGKILL`。

事实：当前已提供[文件系统 snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)，仅适用于 `durable_object` scheduling policy。快照是显式创建的不可变时间点，包含文件系统，不包含进程和内存；后续文件变更需要重新创建快照。快照绑定创建时的镜像版本，不能直接迁移到另一镜像。快照默认保留 30 天，恢复会刷新 TTL，暂不能自定义 TTL。

事实：[R2 FUSE 示例](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)允许将对象存储映射为文件系统，但明确不提供本地磁盘性能或完整 POSIX 语义，适合数据集、模型和共享资产访问。示例也提供写入方式；这不能证明它满足 SQLite WAL 和锁语义。

推断：不能把默认容器磁盘、不可变快照或 R2 FUSE 直接视为当前 Docker 命名持久卷的等价替代。使用本地 SQLite 的可靠持久化还需设计已确认写入的保存边界、单一写入权威、崩溃恢复、镜像升级的数据迁移，以及 DSH 会话和文件保存。关闭自动休眠不能解决这些边界；仅在正常退出时保存快照也不能证明崩溃后的数据不丢失。

## Containers 的价格与资源边界

事实：[官方价格](https://developers.cloudflare.com/containers/platform/pricing/)按每 10ms 运行时间计费，休眠后停止容器资源计费；内存和磁盘按预配资源计算，CPU 按实际活跃用量计算。Workers Paid 基础费用为每月 5 美元，并包含下列容器用量；包含量按账户计划核算，不应为每个实例重复扣除。

| 项目 | 每月包含量 | 超额单价 |
| --- | --- | --- |
| 内存 | 25 GiB-hours | 0.0000025 美元 / GiB-second |
| CPU | 375 vCPU-minutes | 0.000020 美元 / vCPU-second |
| 磁盘 | 200 GB-hours | 0.00000007 美元 / GB-second |

公开实例规格包括 `standard-1` 的 0.5 vCPU、4 GiB 内存、8 GB 磁盘，及 `standard-3` 的 2 vCPU、8 GiB 内存、16 GB 磁盘。[资源限制](https://developers.cloudflare.com/containers/platform/limits/)还允许自定义规格，默认最大 4 vCPU、12 GiB 内存和 20 GB 磁盘；快照最大 20 GB。

下表按一个实例持续运行 30 天、包含量未被其他实例消耗计算。4 GiB 与 8 GiB 仅是容器计费示例，不代表已确认 ClinMesh 的足够资源或承载人数。它仅展示基础计划、内存和磁盘三项，不含实际 CPU、Workers/Durable Objects 超额、日志、出站流量、额外存储、AI 或税费，不是完整账单或已测负载估算。

| 规格 | 计算 | 三项合计 |
| --- | --- | --- |
| 4 GiB 内存、8 GB 磁盘 | `5 + (4 × 720 - 25) × 3600 × 0.0000025 + (8 × 720 - 200) × 3600 × 0.00000007` | 约 32.10 美元 / 月 |
| 8 GiB 内存、16 GB 磁盘 | `5 + (8 × 720 - 25) × 3600 × 0.0000025 + (16 × 720 - 200) × 3600 × 0.00000007` | 约 59.47 美元 / 月 |

官方还分别计费 Worker 与 Durable Object 用量。容器出站流量在北美/欧洲每月包含 1 TB、超额每 GB 0.025 美元；大洋洲/韩国/台湾包含 500 GB、超额 0.05 美元；其余地区包含 500 GB、超额 0.04 美元。低使用量且能安全休眠的任务可能受益于按需计费；持续运行的完整产品不能按每月 5 美元估算。

## Tunnel 与 Access

事实：[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)可在所有计划使用；`cloudflared` 运行在 origin 所在机器，通过出站连接把公开域名映射到应用。网站实际计算与 SQLite 仍在该电脑或云主机，Tunnel 不代替应用托管。

事实：[自定义域名的入门流程](https://developers.cloudflare.com/tunnel/get-started/)需要 Cloudflare 账号、已接入 Cloudflare 的域名，以及运行 origin 和 `cloudflared` 的机器。临时 Quick Tunnel 是另一种入口；本轮未验证其与流式 Agent 的兼容性，不以临时隧道可访问证明完整产品验收。

事实：[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)支持以明确的 Emails 列表配置 Allow，并默认拒绝未获准访问者。[邮箱一次性验证码](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)需要显式启用，不会默认自动添加。Access 的入口准入不能替代 ClinMesh 岗位权限，也不证明 DSH 会话、文件及工具权限已按试用者隔离。

建议：短期受邀试用先保留现有运行架构，使用独立数据库及运行目录，评估 Tunnel 与 Access 作为入口。长期迁入 Cloudflare 计算平台，应在完整数据持久化、DSH 多用户隔离、恢复路径与真实成本验证后，再决定 Workers + D1 或 Containers。

## 核验限制

本轮只读取官方文档和仓库实现，未创建 Cloudflare 资源、构建或启动镜像、调用真实模型、执行压测或购买计划。未验证当前镜像的运行正确性、SQLite 一致快照、断电/崩溃恢复、DSH 多用户隔离、数据迁移、目标地区网络表现或承载人数；文档能力与价格不构成这些行为的验收证据。
