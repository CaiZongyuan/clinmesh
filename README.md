# ClinMesh

ClinMesh 是面向 Agent 评测、产品验证和医疗信息系统研究的中国公立医院仿真 HIS。系统以 FHIR R5 作为标准互操作接口，以显式业务命令承载挂号、医嘱、药房、收费、医保、库存和病案等医院流程。

项目只处理虚构、合成或不可逆脱敏的演示数据，不用于真实诊疗、真实医保结算或真实患者信息存储。

## 当前工程形态

ClinMesh 使用 pnpm workspace 和 Turborepo 组织 TypeScript monorepo：

```text
Browser
   |
   +-- Web static assets
   +-- /api/*
   +-- /fhir/R5/*
            |
            v
    apps/server (Hono on Node.js)
```

当前工程具备可持久运行的单实例 Web 发布：同一个 Hono 服务提供 Web 静态资源、SPA fallback、健康检查、会话认证、岗位业务 API 和 FHIR R5 只读接口。挂号员、分诊护士、门诊医生、收费员和药师通过共享 Command 推进同一个普通门诊发热 Encounter；SQLite 保存 FHIR current/history、业务事实、审计、Action Trace 和 outbox，管理员通过新 Epoch 安装或重置合成 Scenario。

FHIR 公开面固定为 R5 `5.0.0`，当前只声明并实现资源 read、vread、instance history 和白名单 Search。业务写入只走 `/api/his/v1` 与 `/api/sim/v1` 的受控 Command；服务器不宣告通用 FHIR create/update/delete、自定义 FHIR Operation、项目 Profile 或 Implementation Guide 一致性。

## 仓库结构

```text
apps/
  web/          Vite + React Web 工作台
  server/       Node.js Hono 后端、FHIR/HTTP adapter 和 Web 静态资源入口
  desktop/      Electron main、preload 和共享 React renderer
  mobile/       Expo / React Native 移动端
  docs/         VitePress 文档站配置和公开页面清单
packages/
  contracts/    Zod schema、DTO 和 FHIR 辅助类型
  core/         无平台依赖的领域纯函数和客户端规则
  ui/           Web/Desktop 视觉 primitives 和设计 token
  views/        当前 Desktop 工程壳与未来共享业务视图边界
docs/           架构、测试、Agent 工程规范和研究记录
scripts/        文档投影、依赖边界和质量检查
.agents/        Agent skills 与 Agent Notes
```

`packages/ui` 是 Web 与 Desktop 当前共同依赖的视觉层；`packages/views` 当前只承载 Desktop 工程壳。Web 工作台保留在 `apps/web`，只有出现第二个实际消费者后才提取共享业务视图。Mobile 只可复用 `contracts` 和 `core` 中的协议、类型、schema 与纯函数，独立管理 React Native UI、导航、安全存储、QueryClient 和发布周期。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.17.0`
- Xcode/Android Studio 仅在运行对应移动原生目标时需要

## 安装

```sh
pnpm install
```

依赖版本由 `pnpm-lock.yaml` 固定。pnpm build scripts 采用 allowlist，只允许仓库明确登记的安装步骤。

## 本地开发

Web 开发服务器：

```sh
pnpm dev:web
```

Server 开发服务器：

```sh
cp .env.example .env
pnpm dev:server
```

首次开发复制一次 `.env.example`；此后 Server 和数据库 CLI 自动读取仓库根 `.env`，显式 shell 环境变量拥有更高优先级。`pnpm dev:server` 会先构建 Web、迁移本地数据库，再启动监听进程。

默认地址：

- Web：http://127.0.0.1:5173/
- Server：http://127.0.0.1:8787/
- 健康检查：http://127.0.0.1:8787/api/health
- FHIR metadata：http://127.0.0.1:8787/fhir/R5/metadata

合成演示账号：

| 岗位 | 账户邮箱 |
| --- | --- |
| 挂号员 | `registrar@demo.clinmesh.local` |
| 分诊护士 | `triage@demo.clinmesh.local` |
| 门诊医生 | `doctor@demo.clinmesh.local` |
| 收费员 | `cashier@demo.clinmesh.local` |
| 药师 | `pharmacist@demo.clinmesh.local` |
| 管理员 | `admin@demo.clinmesh.local` |

所有演示账号共用 `.env` 中的 `CLINMESH_DEMO_PASSWORD`；从 `.env.example` 复制时，默认密码为 `ClinMesh-demo-password-2026!`。账号和密码仅用于本地合成演示。

桌面端与移动端：

```sh
pnpm dev:desktop
pnpm dev:mobile
```

文档站：

```sh
pnpm docs:dev
```

默认地址为 http://127.0.0.1:5174/。

## 质量检查

主检查集合覆盖共享包、Web、Server、Desktop、文档投影、测试和生产构建：

```sh
pnpm check
```

移动端使用独立检查，避免 Expo 和 React Native 工具链影响其他目标：

```sh
pnpm check:mobile
```

常用的窄检查：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm doc-sync
pnpm verify:boundaries
pnpm --filter @clinmesh/server test
```

`pnpm check` 同时构建 Web 与 Server，验证 Node.js Server 生产 bundle 可以读取 Web 静态资源。

## 文档与决策

- [系统架构](docs/architecture.md)
- [跨端前端架构](docs/frontend-architecture.md)
- [Web Demo 运行与部署架构](docs/demo-architecture.md)
- [Agent 工程开发](docs/agent-development.md)
- [测试策略](docs/testing.md)
- [领域词汇](CONTEXT.md)
- [项目初始化参考分析](docs/research/project-bootstrap-reference-analysis.md)

仓库 Markdown 是唯一可编辑文档来源。`apps/docs/docs.ts` 是公开页面 allowlist，`scripts/project-doc-site.ts` 将文档投影到不会提交的 `apps/docs/.generated`，VitePress 从该目录构建站点。

`.github/workflows/docs.yml` 在默认分支更新后构建并发布 GitHub Pages。仓库需要在 Settings → Pages 中将发布来源设置为 GitHub Actions。

影响架构、协议、持久化、工程流程或测试策略的非平凡决策使用 `.agents/notes/` 记录，格式见 [Agent Notes](.agents/notes/README.md)。

## 部署

生产构建、显式迁移与启动：

```sh
pnpm build
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server start
```

Server 启动时只验证 migration 状态，不隐式修改 schema。数据库生命周期命令与单实例容器步骤见 [Web Demo 运行与部署架构](docs/demo-architecture.md#7-迁移备份与重置)。构建顺序由 workspace 依赖和 Turborepo 决定：先生成 Web assets，再生成 Server 的 Node.js bundle，同时构建 Desktop 和文档站。Server 默认监听 `127.0.0.1:8787`，并从 `apps/web/dist` 提供 Web；`CLINMESH_HOST`、`CLINMESH_PORT` 和 `CLINMESH_WEB_ROOT` 可覆盖这些运行配置。

容器入口使用 `compose.yaml` 和命名卷 `clinmesh-data`，在启动应用进程前执行幂等 migration。当前只支持本地、局域网或单实例产品验证；不承诺多实例、高可用、公开在线 SLA 或共享网络文件系统上的 SQLite 正确性。

## 数据与安全约束

- 只提交合成医疗数据和公开、授权的最小术语子集。
- 禁止提交真实患者身份、诊疗、医保、支付和第三方平台凭证。
- Agent tools 采用窄 schema、受信 context binding、幂等键、预期版本、风险分级和审计。
- 不向 Agent 提供任意 SQL、URL、FHIR Bundle 或任意 method/path/body 写工具。
- `references/` 是本地只读研究输入，已被 Git 忽略，不参与构建和文档发布。
