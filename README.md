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

DSH Web -- React Surface --> apps/web application/runtime
        -- browser Tools --> /api/agent/v1/*
        -- /clinmesh-api --> fixed loopback Hono
```

当前工程具备可持久运行的单实例 Web 发布和 DSH 原生 React Surface adapter：同一个 Hono 服务提供 Web 静态资源、SPA fallback、健康检查、会话认证、岗位业务 API、Agent Page Context 和 FHIR R5 只读接口。挂号员、分诊护士、门诊医生、收费员和药师通过共享 Command 推进普通门诊 Encounter；SQLite 保存 FHIR current/history、业务事实、审计、Action Trace、outbox 和 Agent Tool/proposal/review 关联。管理员从中文化 Synthea 纵向病历生成患者，查看可见来源历史，生成 Patient Brief，再将不可变 Synthetic Case Instance 直接开始为普通 HIS 就诊；新 Epoch reset 重放同一病例 revision。

DSH 拥有原生模型 Session 与 transcript；ClinMesh Agent Tools 只能读取当前受信页面上下文、导航、编辑草稿和准备人工审阅。正式挂号、分诊、临床、支付和药房 Command 的最终 Actor 始终是点击原生审阅框的登录人类。

FHIR 公开面固定为 R5 `5.0.0`，当前只声明并实现资源 read、vread、instance history 和白名单 Search。业务写入只走 `/api/his/v1` 与 `/api/sim/v1` 的受控 Command；服务器不宣告通用 FHIR create/update/delete、自定义 FHIR Operation、项目 Profile 或 Implementation Guide 一致性。

## 仓库结构

```text
apps/
  web/          Vite + React Web 工作台
  dsh-web/      DSH Host proxy、execution proof 与 React Surface adapter
  server/       Node.js Hono 后端、FHIR/HTTP adapter 和 Web 静态资源入口
  cli/          Agent 原生 HIS CLI、human profile 与 Agent task runtime
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
vendor/         固定 commit 的外部源码 submodule
.agents/        Agent skills 与 Agent Notes
```

`packages/ui` 是 Web 与 Desktop 当前共同依赖的视觉层；`packages/views` 当前只承载 Desktop 工程壳。Web 工作台保留在 `apps/web`，只有出现第二个实际消费者后才提取共享业务视图。Mobile 只可复用 `contracts` 和 `core` 中的协议、类型、schema 与纯函数，独立管理 React Native UI、导航、安全存储、QueryClient 和发布周期。

## 快速开始

需要 Node.js `^22.19.0` 或 `>=24.0.0` 与 pnpm `11.17.0`（由 `packageManager` 固定，可经 corepack 切换）。

```sh
git submodule update --init --recursive
pnpm install
cp .env.example .env
pnpm dev:server
```

子模块初始化必须在 `pnpm install` 之前：`apps/dsh-web` 以 `file:` 依赖 `vendor/dsh-react-surface`，缺失时安装失败。`pnpm dev:server` 会自动构建 Web、迁移 SQLite、seed 演示账号并监听 http://127.0.0.1:51868/ ；需要热更新开发入口时另开终端运行 `pnpm dev:web`（http://127.0.0.1:51888/ ）。

打开 http://127.0.0.1:51868/ ，以 `doctor@demo.clinmesh.local` 和 `.env` 中的 `CLINMESH_DEMO_PASSWORD`（从 `.env.example` 复制时默认为 `ClinMesh-demo-password-2026!`）登录。全部六个合成岗位账号与密码约定见 [部署指南](docs/deployment.md)。

此最小路径使用内置合成 fixture 参考目录（诊断与检验为空、药品仅 3 条）。完整的参考目录同步、AI Provider、Synthea 患者生成、Docker、局域网与 DSH Web 入口按顺序见 [部署指南](docs/deployment.md)。

## Agent CLI

`clinmesh` 从同一 Operation Catalog 生成全部 canonical HIS 命令和只读 FHIR R5 命令。先离线发现 operation，再读取单项 schema；这两个命令不需要 Server 或凭据：

```sh
pnpm clinmesh operations list
pnpm clinmesh operations schema encounter.diagnosis.draft.set
```

Human mode 使用 Better Auth profile，密码只从 stdin 读取。下面的环境变量只存在于当前 shell，不进入 argv 或 profile：

```sh
printf '%s\n' "$CLINMESH_DEMO_PASSWORD" | pnpm clinmesh auth login \
  --profile doctor \
  --server-url http://127.0.0.1:51868 \
  --email doctor@demo.clinmesh.local \
  --password-stdin
pnpm clinmesh context show --profile doctor
pnpm clinmesh doctor queue list --profile doctor
```

Agent runner 为每个任务注入 `CLINMESH_SERVER_URL`、`CLINMESH_TOKEN` 和 `CLINMESH_AGENT_TASK_ID`。Agent mode 只使用这个短期 Capability Grant，不读取 human profile；一个 token 只承担一个 Practitioner Role 和显式 operation allowlist。所有 write 都要求 `--idempotency-key`，修改既有事实还从 operation schema 取得 expected version 字段。write 返回 `ambiguous_outcome` 时，使用原 operation ID 和原 key 查询 receipt，不直接重发：

```sh
pnpm clinmesh context show
pnpm clinmesh command receipt get \
  --operation-id encounter.diagnosis.draft.set \
  --idempotency-key <original-key>
```

成功默认输出 JSON；human mode 可显式使用 `--output table`。复杂诊断、处方、检验结果和结构化病历通过 `--input @<workspace-file>` 或 `--input -` 提交。CLI 不提供任意 URL、method/body、SQL、FHIR write、Bundle 或通用 operation invoke。

七个 Agent Skills 位于 [`.agents/skills`](.agents/skills)，按 registration、triage、doctor、billing、pharmacy 和 FHIR 分域；`clinmesh-shared` 统一说明 context、schema、幂等和错误恢复。命令路径与 Skill 示例由同一测试约束。

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
pnpm --filter @clinmesh/dsh-web test
pnpm --filter @clinmesh/dsh-web build
```

`pnpm check` 同时构建 standalone Web、DSH Surface artifact 与 Server，并验证 Node.js Server 生产 bundle 可以读取 Web 静态资源；构建 DSH Surface artifact 需要 Bun `1.4.0`。

## 文档与决策

- [部署指南](docs/deployment.md)：从 clone 到完整运行的顺序步骤。
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

## 数据与安全约束

- 只提交合成医疗数据和公开、授权的最小术语子集。
- 禁止提交真实患者身份、诊疗、医保、支付和第三方平台凭证。
- Agent tools 采用窄 schema、受信 context binding、幂等键、预期版本、风险分级和审计。
- 不向 Agent 提供任意 SQL、URL、FHIR Bundle 或任意 method/path/body 写工具。
- `references/` 是本地只读研究输入，已被 Git 忽略，不参与构建和文档发布。
