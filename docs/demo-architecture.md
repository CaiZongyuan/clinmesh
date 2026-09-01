# Web Demo 运行与部署架构

- 状态：已接受
- 日期：2026-08-23
- 适用范围：本地开发、局域网演示、单实例产品验证
- 系统设计：[中国公立医院仿真 HIS 详细架构](architecture.md)

## 1. 目标

首期用最少运行组件验证真实、多岗位、可重置的门诊业务闭环。运行环境只承载合成数据，不提供生产医疗服务、公开在线可用性承诺或多实例扩缩容。

当前运行时由一个 Hono 进程和一个 file-backed SQLite 文件组成。同一服务提供 Web 静态资源、SPA fallback、健康检查、认证、岗位业务 API 和 FHIR R5 只读接口；SQLite migration、备份、恢复、索引重建、Scenario 安装/reset、共享 Command 与持久 outbox 均有显式入口。

架构必须满足：

- React Web 与 Hono API 使用单一 TypeScript 技术栈和共享 wire contracts。
- 服务端在单个 Node.js 进程中运行，并使用持久化 SQLite 文件。
- 支持显式数据库迁移、确定性 Scenario 安装、Workspace/Epoch reset、备份和恢复。
- 业务模块通过 Repository 和领域端口访问持久化能力，不把数据库表类型暴露给 HTTP、FHIR 或 Web。
- 保留未来新增 D1 或 PostgreSQL adapter 的边界，但首期只实现和验证 SQLite。

## 2. 运行拓扑

```text
Browser
  |
  +-- static assets -- React + TanStack Router + shadcn/ui
  |
  +-- /api/* --------+
  +-- /fhir/R5/* ----+--> Hono on Node.js
                                |
                                +-- Application services
                                +-- Domain commands
                                +-- Repository adapters
                                           |
                                           v
                                  file-backed SQLite
```

开发时 Vite 可以独立提供 SPA 并代理 API。可部署构建由同一个 Node.js 服务提供静态资源、SPA fallback 和 API，从而保持同源 cookie、CSRF 和授权边界。

## 3. 技术选择

| 领域 | 选择 | 首期职责 |
| --- | --- | --- |
| 前端 | React + Vite | Web 工作台与静态构建 |
| 路由 | TanStack Router | 类型安全的 Web 路由和搜索参数 |
| 服务端状态 | TanStack Query | 查询、缓存、失效、轮询和 mutation 协调 |
| 客户端视图状态 | Zustand | 面板、筛选器、焦点和确认框 |
| API | Hono on Node.js | HTTP、FHIR 和静态资源 adapter |
| 数据校验 | Zod | 网络、配置、Scenario 和持久化边界验证 |
| SQL | Drizzle ORM | SQLite schema、迁移和参数化查询 |
| 数据库 | SQLite | FHIR store、领域事实、身份、仿真、审计和 outbox |
| 部署 | 单 Node.js 进程 | 本地、局域网或带持久卷的单实例容器 |

具体 SQLite driver 属于实现选择，不进入跨层 contract。Domain、Command 和应用服务不能依赖 driver API。

## 4. 单实例约束

首期只支持一个服务端进程写入一个本地文件系统上的 SQLite 数据库。数据库文件不能放在缺少 SQLite 锁语义保证的共享网络文件系统上，也不能由多个容器副本同时打开。

SQLite 连接必须启用外键、WAL 和五秒 `busy_timeout`。写入使用短 `BEGIN IMMEDIATE` 事务，单次同步 Command 的真实 SQLite 合约要求事务持续时间小于一秒；外部调用、长计算和浏览器等待不能占用数据库事务。

达到以下任一条件时必须重新选择部署或持久化方案：

- 需要公开在线服务或明确可用性承诺。
- 需要多个服务实例、滚动发布期间并行写入或跨节点故障转移。
- 持续写竞争使有界重试仍无法满足交互延迟。
- 需要数据库托管、在线扩容、复杂分析或独立运维团队。

## 5. SQLite 数据规则

- 所有 schema 变化通过有序迁移文件完成；可部署服务启动时不根据 TypeScript schema 隐式修改数据库。
- 开发和测试可以从空库应用全部迁移，正式实例必须先执行显式迁移和备份步骤。
- 金额和定点数量使用整数，时间使用可排序的 UTC 表示，JSON 只保存需要保留原结构的受验证对象。
- 每个业务表、唯一键、外键和索引显式包含适用的 `workspace_id + epoch`；审计保留域不随 reset 删除。
- 所有列表查询分页，常用授权、关联、过滤和排序路径建立组合索引。
- 签署临床文书保存为受验证的结构化 FHIR JSON；首期不保存图片、PDF 或其他附件。

## 6. 原子写入与恢复

CommandExecutor 在一个 SQLite 事务中提交幂等 receipt、FHIR current/history/search、领域事实、Audit Event、Action Trace 和适用的 outbox 记录。任何前置条件、expected version、授权或约束失败都必须使整个事务回滚。

最小 outbox 由同一 Node.js 进程中的 dispatcher 消费。claim、完成和失败状态持久化，进程重启后可以继续处理；重复投递由事件 ID、correlation ID 和消费者幂等约束吸收。LIS 与支付模拟器不得把请求内存状态当成恢复依据。

## 7. 迁移、备份与重置

Server 进程以 `migrationMode=verify` 打开数据库，发现未应用 migration 时拒绝启动。开发、裸机发布和容器入口在启动应用进程前单独执行 migration；应用运行期间不修改 schema。

数据库 CLI 处理以下动作：

- `migrate`：已有数据库落后于目标 schema 时，先在数据库同目录创建并验证带原版本和时间戳的升级前备份，再按文件名顺序应用 `apps/server/drizzle/` 中尚未执行的 migration，并验证 schema version 和完整性；空库不创建无意义备份。
- `verify`：只验证 migration、foreign keys、journal mode 与 integrity，不修改数据库。
- `reindex`：重建当前岗位队列索引并再次执行完整性检查。
- `backup`：先验证源数据库完整性，再通过 SQLite backup API 创建候选文件；候选的 schema version、integrity 和 canonical state hash 必须与源一致，否则删除候选并失败。
- `restore`：先验证备份源的 schema、migration、integrity 和 canonical state hash，再复制到临时候选路径并逐项比较；全部一致后才原子创建指定的新目标文件，目标已存在或候选验证失败时不覆盖。

本地开发从仓库根 `.env` 读取 Server 和数据库 CLI 配置，显式 shell 环境变量优先于文件值；`.env` 中的相对数据库路径相对该文件解析。首次复制 `.env.example` 后，`pnpm dev:server` 会先迁移 operational SQLite 和已配置的 Reference SQLite，再启动只验证 schema 的 Server。可单独执行同一开发准备入口，或对 operational SQLite 执行细分命令：

```sh
pnpm --filter @clinmesh/server db:prepare
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server db:verify
pnpm --filter @clinmesh/server db:reindex
pnpm --filter @clinmesh/server db:backup --output .data/clinmesh-backup.sqlite
pnpm --filter @clinmesh/server db:restore \
  --backup .data/clinmesh-backup.sqlite \
  --destination .data/clinmesh-restored.sqlite
```

`backup` 和 `restore` 拒绝覆盖已有目标。`migrate` 自动保留并验证升级前备份，操作者仍可在发布窗口前另做命名备份；恢复始终写入新路径，完成验证后由操作者切换 `CLINMESH_DATABASE_PATH`。

canonical state hash 覆盖 FHIR current/history 以及除派生 Search 索引、schema migration 和 runtime metadata 外的全部持久领域表。JSON 列按解析后的值规范化，FHIR `lastUpdated` 和存放 hash 自身的列不参与计算；该 hash 只证明同一 schema 下的快照内容等价，不是跨版本 replay 协议。

Scenario reset 是受控业务 Command：管理员构建并激活新 Epoch，不删除数据库文件或审计保留域。旧 Epoch 的 queued/claimed outbox 被标记为 abandoned，晚到结果不能写入新 Epoch。

容器部署通过 `compose.yaml` 把 `/var/lib/clinmesh` 挂载到命名卷 `clinmesh-data`，并限制为一个副本。容器 entrypoint 先对卷内数据库执行幂等 migration；旧 schema 会触发同卷内的升级前备份，随后启动仅验证 schema 的 Server。临时容器文件系统只允许用于测试数据库，不得承载需要保留的演示状态。

## 8. 数据库迁移边界

首期只有 SQLite Repository adapter。公开 contracts、Command、领域状态机、FHIR capability registry 和 Web Query 层不能依赖 SQLite 表类型、SQL 方言或 driver 错误。

未来选择 D1、PostgreSQL 或 Supabase 时，需要新增真实 adapter、迁移工具和双端 Repository contract tests。该边界不承诺迁移零成本，也不要求首期维护未使用的 SQL 方言。

## 9. 安全与数据

- 只允许虚构、合成和明确标记的医院数据。
- 浏览器与 API 同源；cookie session 写操作执行 CSRF 防护。
- 数据库路径、session secret 和其他凭据来自服务端配置，不进入前端 bundle 或日志。
- 日志不记录密码、token、完整临床草稿或未过滤的请求体。
- 备份与容器卷仍按敏感演示数据处理，不因数据是合成的而公开下载。

## 10. 首期不包含

- Cloudflare Worker、D1、R2、Queues、Cron Trigger 或 Durable Objects。
- PostgreSQL、Supabase、远程 SQLite 服务或多数据库 adapter。
- 多实例、高可用、公开注册、公开在线 SLA 和自动水平扩容。
- Desktop、React Native Mobile、附件对象存储和离线写入。
- AG-UI、Agent runtime、Evaluation Spec 和评分基础设施。

## 11. 可观察运行边界

- Node.js 服务从配置指定的 SQLite 文件读取状态；刷新浏览器或重启进程不丢失已提交事实。
- 空数据库可按顺序应用全部 migration，运行时在 schema 落后时拒绝启动。
- SQLite 自动化测试覆盖约束回滚、幂等与 expected-version 冲突、outbox 恢复、Epoch reset、索引重建以及备份恢复。
- Workspace/Epoch 进入授权查询、FHIR history/search/total/cursor、Command、审计和 outbox，跨上下文请求不共享事实。
- 备份与恢复分别验证源和候选的 schema version、integrity 与 canonical state hash；恢复只创建与备份源等价的新目标文件。
- `compose.yaml` 固定单副本和命名持久卷。当前开发环境没有 Docker，因此容器 build、healthcheck 和挂载同一卷的删除重建仍需在具备 Docker 的发布环境执行。

## 12. Alternatives considered

**Cloudflare Worker + D1。** 该方案适合低运维公开 Demo，但 D1 的 batch 模型会提前引入与首期本地单实例目标无关的事务限制。需要公开托管时再以真实 adapter 和迁移验证重新评估。

**立即使用 PostgreSQL 或 Supabase。** 它们更适合多实例与托管运维，但会在业务闭环尚未成立时增加远程服务、连接和环境管理。SQLite 足以验证首期负载与状态机。

**浏览器内 SQLite。** 它减少服务端组件，却无法建立多账户共享状态、受信 Actor context、服务端 Hidden Fact 隔离和权威审计，因此不符合仿真 HIS 边界。
