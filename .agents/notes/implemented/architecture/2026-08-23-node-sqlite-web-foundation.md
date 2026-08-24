# Agent Note: Node.js 与 SQLite Web 基础设施

Status: implemented

## Problem

ClinMesh 当前工程壳以 Cloudflare Worker 为运行时，但首个可验收发布只面向本地、局域网或单实例容器中的少量 Web 用户。此阶段同时维护 Worker/D1 与本地 SQLite 会迫使 Command 事务、迁移、测试和部署围绕两套能力的交集设计，却不能为门诊闭环提供额外验证价值。

系统仍需证明 Workspace/Epoch 隔离、幂等、乐观并发、FHIR current/history/search、审计、Action Trace、异步模拟器恢复和 Scenario reset。把 SQLite 当作无约束的开发数据库会掩盖这些正确性要求，也会让未来迁移到 D1、PostgreSQL 或 Supabase 时泄漏 driver 和表类型。

## Decision

`apps/server` 是单个 Node.js 进程中的 Hono 服务，以一个本地文件系统上的 SQLite 数据库保存身份、FHIR 资源、领域事实、仿真状态、审计、Action Trace 和 outbox。开发时 Vite 代理 API；可部署构建由同一个 Node.js 服务提供 Web 静态资源、SPA fallback、HTTP API 和 FHIR R5 API。Desktop、React Native Mobile 和 Agent runtime 不属于当前产品能力。

SQLite 连接启用 foreign keys、WAL 和有界 `busy_timeout`。一个服务端进程是唯一 writer，Command 使用短 `BEGIN IMMEDIATE` 事务；网络调用、模拟器等待和长计算不进入事务。每次业务提交原子写入幂等 receipt、expected-version 保护的当前事实、FHIR history/search、Audit Event、Action Trace 和适用的 outbox 事件。

所有适用的业务表、唯一键、外键和岗位查询索引包含 `workspace_id + epoch`。Scenario reset 构建并激活新 Epoch，不删除数据库文件；审计保留域跨 Epoch 保存。LIS 与药房就绪事件由同进程 outbox dispatcher 处理，claim、结果、失败和 correlation 状态持久化，使进程重启后可以恢复且重复投递不重复产生业务结果。支付 success/declined/ambiguous 由支付 Command 确定性提交，只有成功结果产生后续 outbox。

数据库 schema 只通过 `apps/server/drizzle/` 中的有序 migration 变更。Server 进程只验证 schema；数据库 CLI 显式执行 migration、verify、reindex、backup 和 restore。恢复先验证临时候选，再创建新目标路径。Compose 使用单副本与命名持久卷，数据库文件不得位于缺少 SQLite 锁语义保证的共享网络文件系统。

公开 contracts、FHIR capability registry 和 Web Query 层不依赖 SQLite 表类型、SQL 方言或 driver 错误。当前只实现 SQLite Repository；迁移到 D1、PostgreSQL 或 Supabase 时需要新增真实 adapter、数据迁移工具和双端 contract tests。仓库不预先维护未使用的兼容实现，也不承诺零成本切换。

## Alternatives considered

**继续使用 Cloudflare Worker + D1。** 它适合低运维的公开部署，但会在首期引入 D1 batch、远端迁移、预览环境和边缘运行时限制。当前目标是先证明单实例基础设施和门诊闭环，因此暂不承担这些成本。

**立即使用 PostgreSQL 或 Supabase。** 它们适合多实例、托管运维和更高并发，但在数据量与使用者都很少时增加远程依赖、连接和环境管理。Repository 边界保留后续迁移入口。

**使用浏览器内 SQLite。** 它减少服务端组件，却无法建立多账户共享状态、受信 Actor context、服务端 Hidden Fact 隔离和权威审计。

**同时维护 SQLite 与 D1 adapter。** 它能提早证明可移植性，但会让首期每个 schema、事务和测试都承担双实现成本。只有确定迁移目标后，真实的第二 adapter contract test 才能提供有效证据。

## Consequences

Node.js、HTTP/FHIR/Web 组合和业务持久化共享一个可备份文件与事务边界，空库 migration、进程重启、备份恢复、索引重建、Workspace/Epoch 隔离、幂等冲突和 outbox 恢复都使用真实临时 SQLite 文件验证。应用成功启动意味着 schema 已经由独立入口迁移并通过 verify；运行进程不会自行改变 schema。

SQLite 的单 writer 使岗位轮询、会话校验和业务写入竞争同一数据库。查询保持分页并使用组合索引，写事务保持短小；持续 busy 或无法满足交互延迟时必须重新选择持久化与部署方案。

单进程 dispatcher 不提供高可用，只承诺进程重启后的持久恢复，不承诺进程停止期间的实时处理或多副本故障转移。当前开发环境没有 Docker，因此 Dockerfile/Compose 的 build、healthcheck 和挂载同一卷的容器重建仍需在具备 Docker 的发布环境验证。

Repository 边界只能降低应用代码与 SQL 表的耦合，不能消除 SQL 方言、migration 和运维差异。任何第二数据库都需要显式迁移设计、canonical 数据校验和真实双端 contract tests。
