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

当前工程具备 Node.js Web 运行时基线。同一个 Hono 服务提供 Web 静态资源、SPA fallback、健康检查和只声明 metadata 能力的 FHIR R5 CapabilityStatement。file-backed SQLite、认证和门诊业务闭环按[系统架构阶段](docs/architecture.md#15-分期实施)继续交付，不属于当前能力。

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
pnpm dev:server
```

默认地址：

- Web：http://127.0.0.1:5173/
- Server：http://127.0.0.1:8787/
- 健康检查：http://127.0.0.1:8787/api/health
- FHIR metadata：http://127.0.0.1:8787/fhir/R5/metadata

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

生产构建与启动：

```sh
pnpm build
pnpm --filter @clinmesh/server start
```

构建顺序由 workspace 依赖和 Turborepo 决定：先生成 Web assets，再生成 Server 的 Node.js bundle，同时构建 Desktop 和文档站。Server 默认监听 `127.0.0.1:8787`，并从 `apps/web/dist` 提供 Web；`CLINMESH_HOST`、`CLINMESH_PORT` 和 `CLINMESH_WEB_ROOT` 可覆盖这些运行配置。

当前只支持本地、局域网或单实例产品验证，不承诺多实例、高可用或持久化业务状态。SQLite migration、Scenario 安装和持久卷入口在后续阶段交付，且不得在服务启动时隐式执行。

## 数据与安全约束

- 只提交合成医疗数据和公开、授权的最小术语子集。
- 禁止提交真实患者身份、诊疗、医保、支付和第三方平台凭证。
- Agent tools 采用窄 schema、受信 context binding、幂等键、预期版本、风险分级和审计。
- 不向 Agent 提供任意 SQL、URL、FHIR Bundle 或任意 method/path/body 写工具。
- `references/` 是本地只读研究输入，已被 Git 忽略，不参与构建和文档发布。
