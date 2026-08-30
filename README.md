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

当前工程具备可持久运行的单实例 Web 发布和 DSH 原生 React Surface adapter：同一个 Hono 服务提供 Web 静态资源、SPA fallback、健康检查、会话认证、岗位业务 API、Agent Page Context 和 FHIR R5 只读接口。挂号员、分诊护士、门诊医生、收费员和药师通过共享 Command 推进同一个普通门诊发热 Encounter；SQLite 保存 FHIR current/history、业务事实、审计、Action Trace、outbox 和 Agent Tool/proposal/review 关联，管理员通过新 Epoch 安装或重置合成 Scenario。

DSH 拥有原生模型 Session 与 transcript；ClinMesh Agent Tools 只能读取当前受信页面上下文、导航、编辑草稿和准备人工审阅。正式挂号、分诊、临床、支付、药房和 Scenario Command 的最终 Actor 始终是点击原生审阅框的登录人类。

FHIR 公开面固定为 R5 `5.0.0`，当前只声明并实现资源 read、vread、instance history 和白名单 Search。业务写入只走 `/api/his/v1` 与 `/api/sim/v1` 的受控 Command；服务器不宣告通用 FHIR create/update/delete、自定义 FHIR Operation、项目 Profile 或 Implementation Guide 一致性。

## 仓库结构

```text
apps/
  web/          Vite + React Web 工作台
  dsh-web/      DSH Host proxy、execution proof 与 React Surface adapter
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
vendor/         固定 commit 的外部源码 submodule
.agents/        Agent skills 与 Agent Notes
```

`packages/ui` 是 Web 与 Desktop 当前共同依赖的视觉层；`packages/views` 当前只承载 Desktop 工程壳。Web 工作台保留在 `apps/web`，只有出现第二个实际消费者后才提取共享业务视图。Mobile 只可复用 `contracts` 和 `core` 中的协议、类型、schema 与纯函数，独立管理 React Native UI、导航、安全存储、QueryClient 和发布周期。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.17.0`
- Bun `1.4.0`（仅构建 DSH React Surface artifact 时需要）
- DSH CLI `0.1.1-rc.2`（仅运行 DSH Web adapter 时需要）
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

`pnpm check` 同时构建 standalone Web、DSH Surface artifact 与 Server，并验证 Node.js Server 生产 bundle 可以读取 Web 静态资源。

## DSH Web 原生入口

DSH 入口保留 standalone Web，并复用同一 React application/runtime。首次准备固定依赖与 Web Profile：

```sh
git submodule update --init --recursive
pnpm install
pnpm --filter @clinmesh/dsh-web build
dsh plugin --profile web add github:CaiZongyuan/dsh-ag-ui#0c0b7e3608ac012dc2b053043fd0460d101b5db3
dsh plugin --profile web add "$PWD/vendor/dsh-react-surface/packages/runtime"
dsh plugin --profile web add "$PWD/apps/dsh-web"
```

`dsh-ag-ui` 的 always-on `browser-tools` row 无须配置 AG-UI Gateway。`dsh-react-surface` 固定为 submodule commit `e7b17dfd566f4a395027bc8ce1fd368b9fea1707`；CI 会递归 checkout 并固定 Bun `1.4.0`。

在 `.env` 中为 Hono 配置至少 32 bytes 的 `CLINMESH_DSH_BRIDGE_SECRET`，然后启动 Server：

```sh
pnpm dev:server
```

另一个终端把同一个 secret 提供给 DSH Host；默认 upstream 是 `http://127.0.0.1:51868`，Server 使用其他端口时同时设置 `CLINMESH_DSH_UPSTREAM_ORIGIN`：

```sh
set -a
. ./.env
set +a
dsh web
```

从 DSH Web 侧栏的 React applications launcher 打开 ClinMesh。默认使用 `workspace` 并保留原生会话；空间不足时自动退化到 `full-frame`。Surface 使用 Memory Router，页面导航不会修改 DSH document pathname。当前模式只信任安装到同一 Web Profile 的插件，并只允许合成数据。

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

这种方式把需要 Java 环境的 Synthea Provider 和 `cn-health-data` 本地化服务放进 Docker，ClinMesh Web 与 Server 继续使用本地 Node.js 工具链，便于开发和调试。`cn-health-data` 保持通用中国健康数据基础设施的定位；ClinMesh 只消费其固定版本的 Synthea profile、姓名、地理和人口 Candidate。

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

Compose 会启动两个内部服务：`cn-health-localizer` 在启动时验证 profile Manifest、文件哈希、SQLite integrity/application ID 和三个 Candidate 依赖；`synthea-provider` 使用 profile classpath 与外部配置运行固定 Synthea commit，并在返回前把每个 Bundle 交给 localizer。两者都使用只读文件系统，Candidate 只读挂载，不复制进 ClinMesh 仓库或镜像。

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

`/health` 会返回 profile ID、内容哈希、身份算法、固定 Synthea commit 以及姓名、地理和人口 Release provenance。`--smoke` 对 fever、type-2-diabetes 和 hypertension 各生成 10 人，并验证临床关键编码仍存在。

使用 Web 开发入口访问管理员模拟数据页面：http://127.0.0.1:51888/scenario-data

停止 Docker 中的 Provider，但保留容器：

```sh
docker compose -f compose.synthea-provider.yaml stop
```

### 备选：本机 JDK 17 启动 Synthea

不使用 Docker 时，需要本机安装 Git、JDK 17，并在同级 `cn-health-data` 仓库运行本地化服务。以下命令从 ClinMesh 仓库根目录执行，将固定版本的 Synthea 和编译产物保存到已忽略的 `.data/`：

```sh
SYNTHEA_DIR="$PWD/.data/synthea"
git clone https://github.com/synthetichealth/synthea.git "$SYNTHEA_DIR"
git -C "$SYNTHEA_DIR" checkout d9d07a6eef91ee5144293b42ab64224d84d124f8
test "$(git -C "$SYNTHEA_DIR" rev-parse HEAD)" = \
  d9d07a6eef91ee5144293b42ab64224d84d124f8

(
  cd "$SYNTHEA_DIR"
  ./gradlew --no-daemon shadowJar
)

SYNTHEA_JAR="$(find "$SYNTHEA_DIR/build/libs" -name '*with-dependencies.jar' -print -quit)"
PROVIDER_CLASSES="$PWD/.data/synthea-provider/classes"
mkdir -p "$PROVIDER_CLASSES"
javac -cp "$SYNTHEA_JAR" -d "$PROVIDER_CLASSES" \
  apps/synthea-provider/ProviderServer.java
```

先在另一个终端从 `cn-health-data` 仓库启动 localizer；该进程会在监听前完成 profile 与 Candidate 验证：

```sh
CN_HEALTH_DATA_ROOT="$(cd ../cn-health-data && pwd)"
cd "$CN_HEALTH_DATA_ROOT"
CN_HEALTH_SYNTHEA_PROFILE_PATH="$PWD/dist/synthea-cn-profile/releases/2026-08-29.r3" \
CN_HEALTH_NAMES_RELEASE_PATH="$PWD/dist/names-cn/releases/40.37.0.r1" \
CN_HEALTH_GEOGRAPHY_RELEASE_PATH="$PWD/dist/geography-cn/releases/2026-08-29.r1" \
CN_HEALTH_POPULATION_RELEASE_PATH="$PWD/dist/population-cn/releases/WPP2024.r1" \
uv run cn-health-synthea-service --host 127.0.0.1
```

再启动 Provider；该进程在前台运行，停止时按 `Ctrl+C`：

```sh
SYNTHEA_DIR="$PWD/.data/synthea"
SYNTHEA_JAR="$(find "$SYNTHEA_DIR/build/libs" -name '*with-dependencies.jar' -print -quit)"
PROVIDER_CLASSES="$PWD/.data/synthea-provider/classes"
CN_HEALTH_DATA_ROOT="$(cd ../cn-health-data && pwd)"
CN_HEALTH_LOCALIZER_URL=http://127.0.0.1:51879/v1/localize \
SYNTHEA_JAR_PATH="$SYNTHEA_JAR" \
SYNTHEA_CLASSPATH_PATH="$CN_HEALTH_DATA_ROOT/dist/synthea-cn-profile/releases/2026-08-29.r3/classpath" \
SYNTHEA_CONFIG_PATH="$CN_HEALTH_DATA_ROOT/dist/synthea-cn-profile/releases/2026-08-29.r3/synthea.properties" \
SYNTHEA_PROVIDER_PORT=51878 \
java -cp "$PROVIDER_CLASSES:$SYNTHEA_JAR" ProviderServer
```

随后仍按推荐方式运行 `pnpm dev:server` 和 `pnpm dev:web`。本机 Java 路径与 Docker 路径使用同一 Provider HTTP 协议、固定 Synthea commit、profile 和 localizer 合同。

### 更新 Synthea 依赖清单

`apps/server/reference-data/synthea-dependency-inventory.json` 保存递归 static inventory 和固定 generated corpus 的频次与 hash，不保存原始患者 Bundle。先从固定 Synthea checkout 准备 module 目录，并用 Provider 分别生成三个病种各 10 人的 `fever.json`、`type-2-diabetes.json` 和 `hypertension.json`，再从仓库根目录运行：

```sh
SYNTHEA_DIR="$PWD/.data/synthea"
CORPUS_DIRECTORY="$PWD/.data/synthea-provider/dependency-corpora"
pnpm --filter @clinmesh/server synthea-inventory \
  --module-directory "$SYNTHEA_DIR/src/main/resources/modules" \
  --corpus-directory "$CORPUS_DIRECTORY" \
  --output "$PWD/apps/server/reference-data/synthea-dependency-inventory.json"
```

CLI 分别固定校验三份 corpus 的 Synthea commit、`populationSeed=4242`、`clinicalSeed=7331`、单病种、10 人、`1986-08-01` 至 `2026-08-01` 和 `Asia/Shanghai`；参数不符时不覆盖清单。

### 导入 cn-health Candidate 到作者参考库

ClinMesh 的作者参考库是独立 SQLite，不是 HIS operational SQLite。它可以直接读取 `cn-health-data` 的疾病、药品和检验 Candidate，无需先导出中间 CSV。外层 Reference Release manifest 选择一组固定来源；每个 Candidate source 指向自己的 `manifest.json`，`checksum` 是该 Manifest 文件的 SHA-256，`upstreamVersion` 必须等于 Candidate Release ID：

```json
{
  "createdAt": "2026-08-30T00:00:00.000+08:00",
  "releaseId": "clinmesh-cn-health-2026-08-30.r1",
  "schemaVersion": "1",
  "sources": [
    {
      "acquisitionMethod": "manual-download",
      "artifactFormat": "cn-health-candidate",
      "artifactPath": "/absolute/path/to/nhc-icd10-clinical/release/manifest.json",
      "checksum": "<candidate-manifest-sha256>",
      "licenseId": "LicenseRef-cn-health-source-terms",
      "retrievedAt": "2026-08-30T00:00:00.000+08:00",
      "sourceId": "cn-health-nhc-icd10-clinical",
      "sourceUrl": "https://github.com/CaiZongyuan/cn-health-data",
      "upstreamVersion": "nhc-icd10-clinical@2022.r3"
    }
  ]
}
```

从仓库根目录执行 migration、import、verify 和 list：

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

Importer 会验证外层 checksum、Candidate schema/Dataset/Release、`data.sqlite` SHA-256 与大小、SQLite integrity/application ID、主表列和 canonical record count，再在一个事务中发布 ClinMesh Reference Release。发布摘要保存 Candidate Release ID、source version、canonical hash、SQLite hash/size 和记录数；任一来源失败时不留下部分 Release。当前疾病、药品和项目自有 `laboratory-cn` Candidate 均可直接使用。`laboratory-cn` 是当前病例所需概念的精选中文目录，不是官方完整 LOINC 中文语言包；调用方提供 `loinc-zh-cn` Candidate 时仍通过同一 reference concept 边界导入。

Reference Release 不会按中文名自动选择本院产品或概念。运行时使用单独的 Hospital Reference Selection，以 `system + version + code` 绑定本院目录 ID；药品至少需要 `medication-acetaminophen`、`medication-metformin` 和 `medication-amlodipine` 三项，疾病和检验 binding 用于选择 Package 中实际物化的本院目标。配置文件可以省略 `contentHash`，Server 会从其余字段确定性派生；显式提供时必须匹配：

```json
{
  "bindings": [
    {
      "catalogItemId": "diagnosis-fever",
      "coding": {
        "code": "<exact-diagnosis-code>",
        "system": "urn:clinmesh:reference:nhsa-diagnosis",
        "version": "<source-version>"
      },
      "kind": "diagnosis"
    },
    {
      "catalogItemId": "medication-acetaminophen",
      "coding": {
        "code": "<exact-product-code>",
        "system": "urn:clinmesh:reference:nhsa-medication-product",
        "version": "<source-version>"
      },
      "kind": "medication-product"
    },
    {
      "catalogItemId": "lab-cbc",
      "coding": {
        "code": "58410-2",
        "system": "http://loinc.org",
        "version": "2.83"
      },
      "kind": "laboratory"
    }
  ],
  "referenceReleaseId": "clinmesh-cn-health-2026-08-30.r1",
  "schemaVersion": "1",
  "selectionId": "cn-health-hospital-baseline",
  "version": "2026-08-30.r1"
}
```

在 `.env` 中同时启用只读作者库和选择文件：

```dotenv
CLINMESH_REFERENCE_DATABASE_PATH=.data/clinmesh-reference.sqlite
CLINMESH_REFERENCE_SELECTION_PATH=.data/reference-hospital-selection.json
```

Server 只查询 selection 声明的精确概念与产品。若外部 Release 没有本院服务和值域，组合投影会显式使用内置合成服务支撑，并把外部 Release hash、selection hash 和支撑 Release hash 合成新的 provenance；不会把不同 Release 静默表示为同一个来源。Candidate 产品在新 Package 中标记为 `cn-health-candidate / source-record`，内置合成产品继续保留原有 `nmpa-manual-check / synthetic-match` 兼容记录。

完整全国参考行只存在于作者数据库。Scenario Compiler 选择当前病种所需的诊断、检验和药品闭包写入不可变 Package，普通运行与 reset 不读取 Candidate。挂载数据的来源条款不因 ClinMesh 软件许可证而改变。

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

只需要容器化 ClinMesh、但不需要 Synthea 时，可以单独运行 `docker compose up -d --build`。ClinMesh 不把 Synthea 作为启动门禁；Provider 未启动、不可达或生成失败时，只影响对应生成任务，不影响内置生成器和既有 HIS 流程。除非明确要删除本地合成数据，不要使用 `docker compose down -v`。

ClinMesh 与 `cn-health-data` 自行创作的软件代码采用各仓库声明的 MIT License。Compose 挂载的第三方来源数据及其规范化产物不因软件许可证而改变权属或使用条件，具体 provenance 和条款记录由对应 Candidate Manifest、`cn-health-data/DATA-NOTICE.md` 与来源说明提供。

### 直接运行 Node.js

生产构建、显式迁移与启动：

```sh
pnpm build
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server start
```

Server 启动时只验证 migration 状态，不隐式修改 schema。数据库生命周期命令与单实例容器步骤见 [Web Demo 运行与部署架构](docs/demo-architecture.md#7-迁移备份与重置)。构建顺序由 workspace 依赖和 Turborepo 决定：先生成 Web assets，再生成 Server 的 Node.js bundle，同时构建 Desktop 和文档站。Server 默认监听 `127.0.0.1:51868`，并从 `apps/web/dist` 提供 Web；`CLINMESH_HOST`、`CLINMESH_PORT` 和 `CLINMESH_WEB_ROOT` 可覆盖这些运行配置。

容器入口使用 `compose.yaml` 和命名卷 `clinmesh-data`，在启动应用进程前执行幂等 migration。当前只支持本地、局域网或单实例产品验证；不承诺多实例、高可用、公开在线 SLA 或共享网络文件系统上的 SQLite 正确性。

## 数据与安全约束

- 只提交合成医疗数据和公开、授权的最小术语子集。
- 禁止提交真实患者身份、诊疗、医保、支付和第三方平台凭证。
- Agent tools 采用窄 schema、受信 context binding、幂等键、预期版本、风险分级和审计。
- 不向 Agent 提供任意 SQL、URL、FHIR Bundle 或任意 method/path/body 写工具。
- `references/` 是本地只读研究输入，已被 Git 忽略，不参与构建和文档发布。
