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

当前工程具备可持久运行的单实例 Web 发布：同一个 Hono 服务提供 Web 静态资源、SPA fallback、健康检查、会话认证、岗位业务 API 和 FHIR R5 只读接口。挂号员、分诊护士、门诊医生、收费员和药师通过共享 Command 推进普通门诊 Encounter；SQLite 保存 FHIR current/history、业务事实、审计、Action Trace 和 outbox。管理员从中文化 Synthea 纵向病历生成患者，查看可见来源历史、生成 Patient Brief，再将不可变 Synthetic Case Instance 直接开始为普通 HIS 就诊；新 Epoch reset 重放同一病例 revision。

FHIR 公开面固定为 R5 `5.0.0`，当前只声明并实现资源 read、vread、instance history 和白名单 Search。业务写入只走 `/api/his/v1` 与 `/api/sim/v1` 的受控 Command；服务器不宣告通用 FHIR create/update/delete、自定义 FHIR Operation、项目 Profile 或 Implementation Guide 一致性。

## 仓库结构

```text
apps/
  web/          Vite + React Web 工作台
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
.agents/        Agent skills 与 Agent Notes
```

`packages/ui` 是 Web 与 Desktop 当前共同依赖的视觉层；`packages/views` 当前只承载 Desktop 工程壳。Web 工作台保留在 `apps/web`，只有出现第二个实际消费者后才提取共享业务视图。Mobile 只可复用 `contracts` 和 `core` 中的协议、类型、schema 与纯函数，独立管理 React Native UI、导航、安全存储、QueryClient 和发布周期。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.17.0`
- Docker Engine 与 `docker compose`（仅容器运行和 Synthea Provider 需要）
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

- Web：http://127.0.0.1:51888/
- Server：http://127.0.0.1:51868/
- 健康检查：http://127.0.0.1:51868/api/health
- FHIR metadata：http://127.0.0.1:51868/fhir/R5/metadata

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

默认地址为 http://127.0.0.1:51898/

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

## 运行方式

### 推荐：本地 Web 与 Server，加 Docker Synthea

这种方式把需要 Java 环境的 Synthea Provider 和 `cn-health-data` 本地化服务放进 Docker，ClinMesh Web 与 Server 继续使用本地 Node.js 工具链，便于开发和调试。`cn-health-data` 保持通用中国健康数据基础设施的定位；ClinMesh 只消费其固定版本的 Synthea profile、姓名、地理和人口 Candidate。Provider 默认运行 Synthea 全部模块，管理员只在需要复现聚焦人群时通过高级设置限制模块。

默认目录结构要求两个仓库同级：

```text
backend/
  clinmesh/
  cn-health-data/
```

启动前，`cn-health-data/dist/` 应存在以下已构建目录：

```text
synthea-cn-profile/releases/2026-08-29.r3
names-cn/releases/40.37.0.r1
geography-cn/releases/2026-08-29.r1
population-cn/releases/WPP2024.r1
```

如目录不在默认位置，通过 `CN_HEALTH_DATA_CONTEXT` 和 `CN_HEALTH_DATA_DIST` 指向仓库与 Candidate 根目录。Candidate 默认使用仅所有者可读权限；宿主账户不是 `1000:1000` 时，启动前设置 `export CN_HEALTH_DATA_RUN_AS="$(id -u):$(id -g)"`，容器仍以非 root 身份运行。

首次运行先创建环境文件；已有 `.env` 时不要覆盖，并确认端口与 Provider URL 使用以下值：

```sh
cp .env.example .env
```

```dotenv
CLINMESH_PORT=51868
CLINMESH_SYNTHEA_PROVIDER_URL=http://127.0.0.1:51878
```

如果 `.env` 显式设置了 `CLINMESH_PUBLIC_ORIGIN` 或 `CLINMESH_TRUSTED_ORIGINS`，对应 Server 和 Web 地址应分别使用 `51868` 与 `51888`。

启动独立 Synthea Provider：

```sh
docker compose -f compose.synthea-provider.yaml up -d --build
```

Compose 会启动两个内部服务：`cn-health-localizer` 在启动时验证 profile Manifest、文件哈希、SQLite integrity/application ID、三个 Candidate 依赖和固定中文 clinical-display catalog；`synthea-provider` 使用 profile classpath 与外部配置运行固定 Synthea commit，并在返回前把每个 Bundle 交给 localizer 完成身份与临床显示投影。两者都使用只读文件系统，Candidate 与翻译目录只读挂载，不复制进 ClinMesh 仓库或镜像。Provider 的 `/health` 同时暴露可用模块和 localizer provenance，Server 在接受生成请求前校验 Synthea commit、profile 身份、姓名/地理/人口 Release 以及 display projection ID/hash/记录数。catalog 未命中的显示名称保留来源英文并在患者详情中标记为待校对，不阻塞整批生成；结构、引用、hash 或 provenance 无效仍然失败。当前目录使用明确的 `experimental-preview` review mode，不声称术语内容已具备公开再分发资格。

另外打开两个终端启动 Server 和 Web：

```sh
pnpm dev:server
```

```sh
pnpm dev:web
```

#### 局域网访问 Web 开发入口

`pnpm dev:web` 默认只监听 `127.0.0.1:51888`。如需让同一局域网内的设备访问，使用一个命令同时启动 Server 和 Web：

```sh
pnpm dev:lan
```

该命令自动识别私有 IPv4 地址、让 Vite 监听 `0.0.0.0:51888`，并将本机及识别到的 Web origins 注入 Server 的 `CLINMESH_TRUSTED_ORIGINS`。终端会打印可供其他设备访问的 URL；按 `Ctrl+C` 会同时停止 Server 和 Web。未识别到正确地址时可显式指定，例如 `CLINMESH_LAN_IP=192.168.1.23 pnpm dev:lan`。

`0.0.0.0` 仅用于监听，不能作为浏览器访问地址。Vite 继续将 `/api` 和 `/fhir` 请求代理到本机 Server，因此只需允许防火墙的 TCP `51888` 入站，不需要向局域网开放 `51868`。开发入口不提供 HTTPS，只应暴露在可信局域网内。

检查三个入口：

```sh
curl --fail http://127.0.0.1:51878/health
curl --fail http://127.0.0.1:51868/api/health
docker compose -f compose.synthea-provider.yaml exec -T synthea-provider \
  java -cp /opt/provider:/opt/synthea/synthea.jar ProviderServer --smoke
```

`/health` 会返回固定 Synthea commit、全部可用模块、profile ID、内容哈希、身份算法、姓名/地理/人口 Release provenance，以及中文 display projection ID、catalog SHA-256、记录数和 review mode。`--smoke` 以 `moduleMode=all` 生成一名患者，并校验返回 Bundle、全模块 metadata 和完整 localization provenance。

使用 Web 开发入口访问管理员模拟数据页面：http://127.0.0.1:51888/scenario-data 。在“合成患者库”中点击“生成患者”；默认选择全部 Synthea 模块，每次打开都会产生新的双 seed，高级设置仍可手动修改以复现。生成完成后选择患者；标题中的“翻译待确认”表示患者可以继续使用，并可在“来源”页查看保留英文的名称、编码和 FHIR 位置。在“来源历史”中可打开任一条目的 R4 详情，再点击“生成患者梗概”。Brief 成功且已有当前 revision 后点击“开始门诊就诊”，选择科室、地点和门诊类型；系统会直接创建普通 HIS 的 Patient、Registration、Encounter 和 Queue Task，随后继续完成挂号、分诊、医生接诊、收费、检验、药房等现有岗位流程。

停止 Docker 中的 Provider，但保留容器：

```sh
docker compose -f compose.synthea-provider.yaml stop
```

### 导入 cn-health Candidate 到 Reference SQLite

ClinMesh 的作者参考库是独立 SQLite，不是 HIS operational SQLite。它可以直接读取 `cn-health-data` 的疾病、药品和检验 Candidate，无需先导出中间 CSV。外层 Reference Release manifest 选择一组固定来源；每个 Candidate source 指向自己的 `manifest.json`，`checksum` 是该 Manifest 文件的 SHA-256，`upstreamVersion` 必须等于 Candidate Release ID：

```json
{
  "createdAt": "2026-09-01T00:00:00.000+08:00",
  "releaseId": "clinmesh-cn-health-2026-09-01.r1",
  "schemaVersion": "1",
  "sources": [
    {
      "acquisitionMethod": "manual-download",
      "artifactFormat": "cn-health-candidate",
      "artifactPath": "/absolute/path/to/loinc-zh-cn/releases/2.83.r1/manifest.json",
      "checksum": "<candidate-manifest-sha256>",
      "licenseId": "LicenseRef-cn-health-source-terms",
      "retrievedAt": "2026-09-01T00:00:00.000+08:00",
      "sourceId": "cn-health-loinc-zh-cn",
      "sourceUrl": "https://loinc.org/download/loinc-complete/",
      "upstreamVersion": "loinc-zh-cn@2.83.r1"
    }
  ]
}
```

Reference SQLite 只需在准备或更新目录 Release 时导入，不参与患者生成。首次导入从仓库根目录执行 migration、import、verify 和 list：

```sh
REFERENCE_DATABASE="$PWD/.data/clinmesh-reference.sqlite"
REFERENCE_MANIFEST="$PWD/.data/cn-health-reference-release.json"

pnpm --filter @clinmesh/server reference-db migrate \
  --database "$REFERENCE_DATABASE"
pnpm --filter @clinmesh/server reference-db import \
  --database "$REFERENCE_DATABASE" \
  --manifest "$REFERENCE_MANIFEST"
pnpm --filter @clinmesh/server reference-db verify \
  --database "$REFERENCE_DATABASE"
pnpm --filter @clinmesh/server reference-db list \
  --database "$REFERENCE_DATABASE"
```

Importer 会验证外层 checksum、Candidate manifest、`data.sqlite` SHA-256 与大小、SQLite integrity/application ID、表结构和 canonical record count，再在一个事务中发布 ClinMesh Reference Release。既有 Dataset Schema v1 Candidate 保持兼容；`loinc-zh-cn` Schema v2 同时导入完整 LOINC 主表、单位、SYSTEM 标本关系和 panel 成员边，并按 LOINC Class Type 将非实验室生命体征、问卷和量表分入 `other` domain。发布摘要分别记录四类检验关系数量和精确 Candidate provenance；任一来源失败时不留下部分 Release。

在 `.env` 中启用只读 Reference SQLite，并显式选择一个全系统共用的当前 Release；数据库含多个 Release 时 `CLINMESH_REFERENCE_RELEASE_ID` 必填：

```dotenv
CLINMESH_REFERENCE_DATABASE_PATH=.data/clinmesh-reference.sqlite
CLINMESH_REFERENCE_RELEASE_ID=clinmesh-cn-health-2026-08-30.r1
```

疾病、药品和完整 LOINC 行只存在于 Reference SQLite。医生诊断与药品选择器直接分页查询当前 Release；管理员从 orderable laboratory Reference candidates 中选择有界批次，通过 Catalog Enrichment 发布本院 Laboratory Service。医生检验选择器只查询当前 Workspace/Epoch 已发布服务，不接收 Reference Concept ID，也不显示模型或病例级生成 capability。诊断、处方和检验申请分别冻结选择时的 coding、产品或 Laboratory Service/report definition snapshot；切换 Reference Release 或重新发布服务不会改写既有医疗事实。Synthea 来源历史编码只用于展示外部合成病历和精确结果复用。挂载数据的来源条款不因 ClinMesh 软件许可证而改变。

### 可选：验证真实 Patient Brief Provider

配置 `.env` 中完整的 `CLINMESH_AI_BASE_URL`、`CLINMESH_AI_API_KEY`、`CLINMESH_AI_BRIEF_MODEL` 和 `CLINMESH_AI_INVESTIGATION_MODEL` 后，可以显式运行一次本地 live smoke。管理员使用 Catalog Enrichment 时另外配置 `CLINMESH_AI_CATALOG_ENRICHMENT_MODEL`；未配置时已有服务仍可执行，但不能发布新服务。

```sh
pnpm smoke:patient-brief:live
```

该命令只向配置的 OpenAI-compatible Provider 发送一份固定的合成 Brief 输入，验证响应 schema 与泄漏检查。它不进入 `pnpm check` 或 CI，不打印 Brief 内容、输入正文或凭证；成功输出只含状态、耗时、模型 ID 和输出哈希。不要在共享终端、日志或提交中暴露 `.env` 和 API key。

### Docker 一键启动 ClinMesh 与 Synthea

需要完整容器化运行时，叠加两个 Compose 文件：

```sh
docker compose -f compose.yaml -f compose.synthea.yaml up -d --build
```

启动成功后访问：

- Web：http://localhost:51868/
- 模拟数据：http://localhost:51868/scenario-data
- FHIR metadata：http://localhost:51868/fhir/R5/metadata

检查或停止完整部署：

```sh
docker compose -f compose.yaml -f compose.synthea.yaml ps
curl --fail http://localhost:51868/api/health
docker compose -f compose.yaml -f compose.synthea.yaml stop
```

只需要容器化 ClinMesh、但不需要 Synthea 时，可以单独运行 `docker compose up -d --build`。ClinMesh 不把 Synthea 作为启动门禁；Provider 未启动、不可达或生成失败时，只影响新的患者生成任务，不影响既有 Profile、Case 和 HIS 流程。除非明确要删除本地合成数据，不要使用 `docker compose down -v`。

ClinMesh 与 `cn-health-data` 自行创作的软件代码采用各仓库声明的 MIT License。Compose 挂载的第三方来源数据及其规范化产物不因软件许可证而改变权属或使用条件，具体 provenance 和条款记录由对应 Candidate Manifest、`cn-health-data/DATA-NOTICE.md` 与来源说明提供。

### 直接运行 Node.js

生产构建、显式迁移与启动：

```sh
pnpm build
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server start
```

Server 启动时只验证 migration 状态，不隐式修改 schema。数据库生命周期命令与单实例容器步骤见 [Web Demo 运行与部署架构](docs/demo-architecture.md#7-迁移备份与重置)。构建顺序由 workspace 依赖和 Turborepo 决定：先生成 Web assets，再生成 Server 的 Node.js bundle，同时构建 Desktop 和文档站。Server 默认监听 `127.0.0.1:51868`，并从 `apps/web/dist` 提供 Web；`CLINMESH_HOST`、`CLINMESH_PORT` 和 `CLINMESH_WEB_ROOT` 可覆盖这些运行配置。

当前病例架构包含破坏性的 operational database migration，不兼容旧的本地病例与安装数据。升级此分支前停止 Server，并重置 `.env` 中 `CLINMESH_DATABASE_PATH` 指向的本地 operational SQLite；默认路径的命令如下：

```sh
rm -f .data/clinmesh.sqlite .data/clinmesh.sqlite-shm .data/clinmesh.sqlite-wal
pnpm --filter @clinmesh/server db:migrate
```

该操作会删除本地 HIS 运行数据。独立的 `.data/clinmesh-reference.sqlite` 不在删除范围内，不需要重新导入；不要把 `CLINMESH_REFERENCE_DATABASE_PATH` 指向 operational database，也不要删除 Reference SQLite。

容器入口使用 `compose.yaml` 和命名卷 `clinmesh-data`，在启动应用进程前执行幂等 migration。当前只支持本地、局域网或单实例产品验证；不承诺多实例、高可用、公开在线 SLA 或共享网络文件系统上的 SQLite 正确性。

## 数据与安全约束

- 只提交合成医疗数据和公开、授权的最小术语子集。
- 禁止提交真实患者身份、诊疗、医保、支付和第三方平台凭证。
- Agent tools 采用窄 schema、受信 context binding、幂等键、预期版本、风险分级和审计。
- 不向 Agent 提供任意 SQL、URL、FHIR Bundle 或任意 method/path/body 写工具。
- `references/` 是本地只读研究输入，已被 Git 忽略，不参与构建和文档发布。
