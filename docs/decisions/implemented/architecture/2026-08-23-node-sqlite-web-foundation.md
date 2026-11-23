# Agent Note: Node.js、SQLite 与跨端单仓基础设施

Status: implemented

## Problem

ClinMesh 需要同时支撑多岗位仿真 HIS、跨平台客户端、可验证的临床 UI 合同与公开文档站。若首期同时维护 Cloudflare Worker/D1 与本地 SQLite 双适配器、照搬外部参考仓库的 Next.js/Go/PostgreSQL 或通用 React Native 树，或者在文档站与 Storybook 中复制第二套文档和静态组件示例，会让 Command 事务、迁移、UI 密度 token 与文档相对链接在多个权威源之间漂移。

## Decision

仓库采用 pnpm workspaces 与 Turborepo 单仓结构，包含 `apps/{web,dsh-web,server,cli,desktop,mobile,docs}` 与 `packages/{contracts,core,ui,views}`，模块边界见[系统边界](../../../architecture/system.md)与[前端架构](../../../frontend-architecture.md)：

1. **客户端共享分层与真实组件目录**：Web 与 Desktop 共享 `contracts -> core -> ui -> views`；Mobile 仅复用 `contracts`、标识符和无平台依赖的 `core` 纯函数，独立维护 React Native UI、导航、存储与 QueryClient。`packages/ui/src/styles.css` 与 `packages/ui/src/components` 分别拥有语义 token 和共享视觉 primitive，Web 提供无需登录、零应用 API 请求的 `/components` 公共路由直接挂载真实 `@clinmesh/ui` 组件，验证尺寸、状态、可访问性与明暗主题，设计约束见[临床 UI 设计](../../../ui/design.md)。
2. **单进程 Node.js Hono 与双 SQLite 边界**：`apps/server` 在单个 Node.js 进程内承载 HTTP API、FHIR R5 API、静态 Web 与同进程持久 outbox dispatcher。Operational SQLite 保存身份、FHIR 资源、领域事实、仿真状态、审计、Action Trace 与 outbox，连接启用外键、WAL 与 5 秒 `busy_timeout`；单服务端进程为唯一 writer，同步 Command 使用小于 1 秒的 `BEGIN IMMEDIATE` 短事务原子提交幂等回执、expected-version 保护事实、FHIR 历史／索引、审计与 outbox，外部网络调用与模型等待均留在事务外。所有业务表、唯一键与岗位索引携带 `workspace_id + epoch`；临床参考目录保存在独立只读 Reference SQLite。
3. **显式迁移、升级前备份与状态哈希**：Operational 与 Reference schema 分别只通过 `apps/server/drizzle/` 和 `apps/server/reference-drizzle/` 有序迁移演进，Server 进程启动只校验不改表。非空 operational 数据库迁移前自动创建并核验升级前备份；`backup` 与 `restore` 同时核验 schema、SQLite integrity 与覆盖 FHIR current/history 及持久领域表的规范化 `canonical state hash`（排除派生检索索引与运行时元数据）。根 `.env` 提供本地合成开发配置并由显式环境变量优先覆盖，持久化细则见[存储与事务](../../../architecture/storage.md)。
4. **单一源码文档投影**：仓库内 Markdown 为唯一事实源，`apps/docs/docs.ts` 显式选择公开页面并由 `scripts/project-doc-site.ts` 投影为一次性 VitePress 构建输入，规则见[文档规则](../../../AGENTS.md)。

## Alternatives considered

- **首期同时维护 Cloudflare Worker + D1 或立即引入 PostgreSQL**：会在单实例仿真闭环阶段叠加边缘批次限制、远端迁移和双适配器契约测试成本；保留无 SQLite 方言泄漏的 Repository 边界，待确有多实例需求时再建设第二适配器。
- **使用浏览器内 SQLite**：无法建立多账户共享状态、服务端受信 Actor 上下文、隐藏 Case Truth 隔离与权威审计。
- **全端共用一套通用 React Native 组件树**：迫使桌面高密度临床表格与移动端原生交互迁就最弱公共抽象，改为只共享语义契约与纯函数。
- **引入独立 Storybook、复制静态组件示例或在文档中抄写全量色值表**：产生脱离生产 primitive 的假视觉证据或第二套 token 权威；真实 `/components` 路由与包级无障碍测试已覆盖交付状态。
- **直接在 `apps/docs` 下手写另一套文档树**：导致仓库相对链接与公开站点内容分叉。

## Consequences

单文件 operational SQLite 与同进程 outbox 提供确定性的本地事务、备份恢复与重启续跑验证，但单 writer 要求查询严格分页建索引、写事务保持短小，且不提供多副本高可用或共享网络文件系统支持。`/components` 可在无后端时独立验收视觉与键盘合同；公开页面变更须同步维护 `apps/docs/docs.ts` 与 `pnpm doc-sync` 校验。
