# 在线演示 Demo 架构选择

- 状态：已接受
- 日期：2026-08-19
- 适用范围：技术验证、产品演示、小规模在线试用

## 1. 目标

本项目用于快速验证产品交互、业务流程和技术集成，并以尽可能低的运维成本提供在线演示环境。

架构必须满足以下目标：

- 前后端均可在 Cloudflare Workers Free 上运行。
- 使用单一 TypeScript 技术栈，降低开发和联调成本。
- 前后端共享数据契约，并在运行时校验外部输入。
- 支持关系型数据、数据库迁移和可重复的演示数据初始化。
- 保持迁移路径，未来可替换数据库或拆分后端，而不重写前端业务层。

本阶段不追求大规模并发、复杂后台任务、强监管生产环境或真实敏感数据存储。

## 2. 架构决策

采用 React SPA 与 Hono API 组成的全栈 TypeScript 应用，通过一个 Cloudflare Worker 统一部署。

```text
Browser
  |
  +-- Static Assets -- React + TanStack Router + shadcn/ui
  |
  +-- /api/* -------- Hono Worker
                         |
                         +-- Zod validation
                         +-- Application services
                         +-- Drizzle ORM
                               |
                               +-- Cloudflare D1
                         |
                         +-- Cloudflare R2 (optional files)
```

静态资源由 Workers Static Assets 直接缓存和分发。只有 `/api/*` 请求进入 Hono Worker。前端路由使用 SPA fallback，不使用服务端渲染。

## 3. 技术选型

| 领域 | 选择 | 职责 |
| --- | --- | --- |
| 语言 | TypeScript | 前端、API 和共享契约统一语言 |
| 前端构建 | React + Vite | SPA 构建和本地开发 |
| 路由 | TanStack Router | 类型安全路由、搜索参数校验、懒加载 |
| UI | shadcn/ui + Tailwind CSS | 可维护的本地组件和样式系统 |
| 服务端状态 | TanStack Query | 请求、缓存、失效、重试和加载状态 |
| 客户端状态 | Zustand | 会话内 UI 状态和跨组件工作台状态 |
| 数据校验 | Zod | 表单、路由参数、环境变量和 API 契约校验 |
| API | Hono | Cloudflare Workers HTTP API |
| ORM | Drizzle ORM | 类型安全 SQL 和 D1 数据访问 |
| 数据库 | Cloudflare D1 | Demo 的关系型持久化存储 |
| 文件存储 | Cloudflare R2 | 可选的图片、附件和导出文件存储 |
| 部署 | Wrangler + Workers Static Assets | 构建、迁移、绑定和发布 |

依赖版本由 lockfile 固定。升级依赖应单独提交，并通过类型检查、测试和预览环境验证。

## 4. 状态管理边界

TanStack Query 是所有服务端数据的唯一客户端缓存，包括列表、详情、字典和当前用户信息。

Zustand 仅保存不属于服务端事实的状态，例如：

- 当前工作台布局和临时筛选条件。
- 尚未提交的多步骤操作上下文。
- 弹窗、侧栏和本地交互模式。

不得把同一份接口数据同时写入 TanStack Query 和 Zustand。组件内状态优先使用 React 本地状态，只有确实跨页面或跨组件共享时才进入 Zustand。

## 5. API 与数据契约

所有业务 API 使用 `/api` 前缀，按资源和用例组织路由。API 输入必须先经过 Zod 校验，禁止直接信任请求体、查询参数和路径参数。

建议的响应结构：

```ts
type ApiSuccess<T> = {
  data: T;
  requestId: string;
};

type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
};
```

共享 Schema 放在 `src/shared`。前端通过 Schema 推导输入输出类型，服务端使用同一 Schema 做运行时校验。数据库表类型不得直接作为公开 API 类型，API DTO 与持久化模型保持隔离。

## 6. 数据库策略

D1 作为 SQLite 数据库使用，Drizzle 负责表定义和查询。数据库变更必须通过迁移文件发布，禁止在 Worker 启动时自动修改表结构。

基本规则：

- 主键使用稳定的字符串 ID 或整数 ID，创建策略全项目统一。
- 所有列表查询必须分页。
- 常用筛选、关联和排序字段必须建立索引。
- 写操作尽量短小，并使用 D1 batch 或事务能力保持一致性。
- 大对象和文件不写入 D1，改存 R2，D1 只保存元数据和对象键。
- 提供可重复执行的演示数据 seed，并支持一键重置 Demo 数据。

Demo 与预览环境使用不同的 D1 数据库。生产演示数据库不得被本地开发命令直接访问。

## 7. 推荐目录结构

```text
.
├── public/                 # 原样发布的静态资源
├── src/
│   ├── app/                # React SPA
│   │   ├── components/
│   │   ├── features/       # 按业务能力组织页面、查询和组件
│   │   ├── routes/         # TanStack Router 文件路由
│   │   ├── stores/         # 少量 Zustand store
│   │   └── main.tsx
│   ├── worker/             # Hono API
│   │   ├── routes/
│   │   ├── services/       # 用例编排，不依赖 Hono Request
│   │   ├── repositories/   # Drizzle 数据访问
│   │   ├── middleware/
│   │   └── index.ts
│   └── shared/             # Zod Schema、DTO 和纯函数
├── drizzle/                # SQL 迁移文件
├── scripts/                # seed、重置和发布辅助脚本
├── vite.config.ts
├── drizzle.config.ts
└── wrangler.jsonc
```

前端按业务能力组织，而不是建立全局 `api`、`components`、`utils` 大目录。Worker 的 service 层不得依赖具体 HTTP 对象，以便后续测试和迁移运行时。

## 8. 部署模型

一个 Worker 同时承载静态资源和 API：

- `/api/*`：优先进入 Hono。
- 真实静态文件：由 Workers Static Assets 直接返回。
- 其他浏览器路径：返回 `index.html`，交给 TanStack Router。

至少维护两个 Cloudflare 环境：

| 环境 | 用途 | 数据资源 |
| --- | --- | --- |
| preview | Pull Request 和验收 | 独立 D1，可随时重置 |
| demo | 稳定在线演示 | 独立 D1，受控执行迁移 |

发布顺序固定为：构建检查、生成并审查迁移、应用远端迁移、部署 Worker、执行冒烟测试。密钥只通过 Wrangler Secret 或 Cloudflare Dashboard 管理，不写入仓库和前端构建变量。

## 9. 免费版容量边界

设计按以下 Workers Free 关键限制约束：

- Worker 请求 100,000 次/天。
- 每次请求 CPU 时间 10 ms。
- 每个 isolate 内存 128 MB。
- Worker 压缩后代码 3 MB。
- 每次 Worker 调用最多 50 个 D1 查询。
- D1 单库 500 MB，读取 5,000,000 行/天，写入 100,000 行/天。

静态资源请求不应进入 Worker。接口不得在内存中处理大型文件、生成复杂报表或扫描无索引的大表。达到任一额度时，免费版可能直接拒绝后续请求，因此 Demo 必须展示友好的不可用状态，而不能假设服务始终可用。

## 10. 安全与数据规则

- 只允许使用虚构、合成或不可逆脱敏的演示数据。
- 不保存真实身份、诊疗、支付凭证或其他敏感个人信息。
- 前后端同源部署，默认不开放跨域访问。
- 所有写接口进行鉴权、输入校验和基础限流。
- 日志不得记录密码、令牌、完整请求体或敏感字段。
- 对外错误只返回稳定错误码和安全信息，详细异常保留在服务端日志。

## 11. 明确不选择的方案

### Rust Worker

当前不选择 Rust。Rust 可以通过 `workers-rs` 部署到 Workers，但会拆断 Hono、Zod、Drizzle 与前端之间的 TypeScript 类型链，并增加 Wasm 构建、D1 访问和调试成本。只有出现明确的计算密集任务或团队形成稳定 Rust 能力后，才评估将独立模块改为 Rust/Wasm。

### 服务端渲染

当前不使用 SSR。在线 Demo 不依赖搜索引擎收录，SPA 能让绝大多数页面请求直接命中静态资源，并减少 Worker CPU 和请求额度消耗。

### 微服务

当前不拆分多个服务。单 Worker 足以覆盖 Demo，分布式调用、独立部署和跨服务一致性只会增加验证成本。未来只有在出现独立扩缩容、权限隔离或不同运行时需求时才拆分。

### D1 之外的远程数据库

当前不引入远程 PostgreSQL/MySQL。外部数据库会增加连接、网络延迟和运维成本。数据规模、并发或 SQL 能力超出 D1 后，再通过 repository 边界迁移数据库。

## 12. 验收标准

架构验证完成需满足：

- 本地开发运行在 Cloudflare Workers 兼容运行时中。
- SPA 刷新任意前端路由不会返回 404。
- API 输入错误能返回统一的结构化错误。
- D1 迁移可在空数据库上完整执行。
- seed 可重复创建一致的演示数据。
- preview 和 demo 使用不同数据库绑定。
- 静态资源请求不触发 Worker API 逻辑。
- 类型检查、单元测试、构建和部署 dry-run 全部通过。
- 部署后完成登录、核心列表、核心写入和数据重载冒烟测试。

## 13. 重新评估触发条件

出现以下任一情况时重新评估本决策：

- 接近 Workers 或 D1 免费额度的 70%。
- D1 单库接近 350 MB。
- API 经常超过 10 ms CPU 时间。
- 需要长任务、复杂报表、实时协作或大量文件处理。
- 需要存储真实敏感数据或满足正式合规要求。
- Demo 转为具备可用性承诺的生产服务。

## 14. 参考资料

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Hono Guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
