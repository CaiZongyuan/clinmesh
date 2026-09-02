# 部署指南

本指南从 clone 开始，按顺序完成本地部署：基础运行、参考目录同步、AI Provider 配置、Synthea 患者生成与可选运行方式。每一步都以前一步为前提；只想快速体验的读者完成步骤 1、2、5 即可登录演示账号。产品定位与工程形态见仓库根 [README](../README.md)，部署决策与单实例约束见 [Demo 部署架构](demo-architecture.md)。

不配置 Synthea Provider 不阻塞 ClinMesh 启动；Provider 缺失只影响新的患者生成任务。生成患者后，"生成患者梗概"和"开始门诊就诊"要求步骤 4 的 AI Provider 已配置。

## 0. 前置条件

| 目标 | 需要的工具 |
| --- | --- |
| 基础运行（步骤 1–2、5） | Node.js `^22.19.0` 或 `>=24.0.0`、pnpm `11.17.0`、Git |
| 完整参考目录（步骤 3） | 同上，加可访问 cn-health Registry 的网络 |
| 患者梗概与就诊闭环（步骤 4） | 同上，加一个 OpenAI-compatible Provider 及 API key |
| Synthea 患者生成（步骤 6） | Docker Engine 与 `docker compose`；当前还需要 Rust、`uv` 和 cn-health-data 贡献者工具链（见 6.2） |
| 全量检查与生产构建 | Bun `1.4.0`（DSH React Surface artifact 构建使用 `bun`） |
| DSH Web 原生入口 | DSH CLI `0.1.1-rc.2` |
| Mobile 原生目标 | Xcode 或 Android Studio |

pnpm 版本由根 `package.json` 的 `packageManager` 字段固定，可使用 corepack 自动切换。

## 1. 获取代码与安装依赖

```sh
git clone <repository-url> clinmesh
cd clinmesh
git submodule update --init --recursive
pnpm install
```

子模块初始化必须发生在 `pnpm install` 之前：`apps/dsh-web` 通过 `file:` 协议依赖 `vendor/dsh-react-surface/packages/{runtime,build}`，子模块不存在时安装会以 ENOENT 失败。依赖版本由 `pnpm-lock.yaml` 固定；pnpm build scripts 采用 allowlist，只允许仓库明确登记的安装步骤。

## 2. 创建环境文件

```sh
cp .env.example .env
```

已有 `.env` 时不要覆盖。Server 与数据库 CLI 自动读取仓库根 `.env`，显式 shell 环境变量优先级更高。`.env.example` 已包含全部必填项：`CLINMESH_AUTH_SECRET`、`CLINMESH_CURSOR_SECRET`、`CLINMESH_DATABASE_PATH` 和 `CLINMESH_DEMO_PASSWORD`；默认 Server 监听 `127.0.0.1:51868`，Web 开发入口为 `51888`。在 git worktree 中运行时，`.env` 必须位于该 worktree 根目录。

## 3. 同步参考目录（推荐）

诊断（ICD-10）、药品、完整 LOINC 和 `laboratory-cn` 检验数据只存在于独立 Reference SQLite，不在 HIS operational SQLite 中。仓库提交的 `reference-data.lock.json` 固定每个 Dataset Release 与 Manifest hash；同步只在开发、构建或运维阶段访问 Registry，Server 运行时不执行 `cn-health`，也不访问 GitHub 或 Registry。

先运行 check-only，它按 lock materialize 每个精确 Release 并交叉验证签名、身份、hash、SQLite 和表不变量，不写正式数据库。四个 Dataset 的 materialize 并行执行，stderr 逐阶段输出进度与耗时（stdout 的 JSON 结果不受影响）：

```sh
pnpm reference:sync -- --check
```

当前 `laboratory-cn@2026-09-01.r1` 应报告 `laboratory_test=84`、`laboratory_reference=96`、`laboratory_panel=15`、`laboratory_panel_member=88`。确认后执行正式同步：

```sh
pnpm reference:sync
```

正式同步写入 `.data/clinmesh-reference.sqlite`，相同 lock 重复执行返回幂等成功。同步不会修改 `.env`，也不会热切换已启动的 Server；随后在 `.env` 中启用：

```dotenv
CLINMESH_REFERENCE_DATABASE_PATH=.data/clinmesh-reference.sqlite
CLINMESH_REFERENCE_RELEASE_ID=clinmesh-cn-health-2026-09-02.r1
```

数据库中存在多个 Release 时必须显式选择全系统当前 Release。跳过本步时 Server 使用内置合成 fixture（`clinmesh-hospital-reference-fixture-2026-08-28`）：诊断与检验目录为空，药品目录只有 3 条合成产品，医生无法下诊断或开检验。

## 4. 配置 AI Provider（患者梗概必需）

Synthea 病历压缩为 Patient Brief、Investigation 与 Catalog Enrichment 使用 OpenAI-compatible Provider。四个基础变量必须同时配置：

```dotenv
CLINMESH_AI_BASE_URL=https://provider.example/v1
CLINMESH_AI_API_KEY=replace-with-local-key
CLINMESH_AI_BRIEF_MODEL=provider/brief-model
CLINMESH_AI_INVESTIGATION_MODEL=provider/investigation-model
```

管理员发布新的本院检验服务时另需 `CLINMESH_AI_CATALOG_ENRICHMENT_MODEL`；未配置时已有服务仍可执行，但不能发布新服务。未配置基础变量时，"生成患者梗概"返回 `PROVIDER_NOT_AVAILABLE`，且没有 Brief 就无法把合成病例开始为门诊就诊（`BRIEF_NOT_READY`）。

可显式运行一次本地 live smoke 验证 schema 与泄漏检查；它不进入 `pnpm check`，不打印 Brief 内容或凭证：

```sh
pnpm smoke:patient-brief:live
```

## 5. 启动并验证

```sh
pnpm dev:server
```

`pnpm dev:server` 先构建 Web，迁移 operational SQLite 和 `.env` 中已配置的 Reference SQLite，seed 演示 workspace 与合成账号，再启动只验证 schema 的监听进程。默认地址：

- Server 与 Web 发布：http://127.0.0.1:51868/
- Web 开发入口（热更新）：`pnpm dev:web` → http://127.0.0.1:51888/
- 健康检查：http://127.0.0.1:51868/api/health
- FHIR metadata：http://127.0.0.1:51868/fhir/R5/metadata

合成演示账号（共用 `.env` 中 `CLINMESH_DEMO_PASSWORD`，从 `.env.example` 复制时默认为 `ClinMesh-demo-password-2026!`）：

| 岗位 | 账户邮箱 |
| --- | --- |
| 挂号员 | `registrar@demo.clinmesh.local` |
| 分诊护士 | `triage@demo.clinmesh.local` |
| 门诊医生 | `doctor@demo.clinmesh.local` |
| 收费员 | `cashier@demo.clinmesh.local` |
| 药师 | `pharmacist@demo.clinmesh.local` |
| 管理员 | `admin@demo.clinmesh.local` |

完成步骤 3 后，以门诊医生登录并打开诊断选择器应能搜索到 ICD-10 条目，即参考目录生效。

## 6. Synthea 患者生成

### 6.1 运行方式与数据来源

Synthea Provider 由 `compose.synthea-provider.yaml` 提供两个容器：`synthea-provider` 在 Docker 构建阶段下载固定 commit 的 Synthea 源码（校验 SHA-256 后用 gradle 构建），宿主机不需要 JDK；`cn-health-localizer` 在启动时验证 profile Manifest、文件哈希、SQLite integrity 与 Candidate 依赖，并为每个生成 Bundle 完成中文身份与临床显示投影。两者只读文件系统、以非 root 运行，Candidate 与翻译目录只读挂载，不复制进 ClinMesh 仓库或镜像。

### 6.2 当前对外部用户的限制

公共 Registry（`cn-health-data` 仓库 `distribution/registry.json`）目前不提供 Synthea Provider 所需的两类产物，纯 Registry 路径无法启动 Provider：

- `synthea-cn-profile` 不在 Registry 的 Dataset 清单中，只能用 `cn-health-build` 在本地构建；
- compose 挂载的 r1 身份 Candidate（`names-cn@40.37.0.r1`、`geography-cn@2026-08-29.r1`、`population-cn@WPP2024.r1`）已不在 Registry，`cn-health init` 只安装 r2；且本地已有的 profile `2026-08-29.r3` 是用 r1 输入构建的，与 r2 Candidate 的依赖校验不匹配。

因此外部部署需要按 6.3 用 r2 Candidate 重建 profile 并调整 compose 挂载路径；维护者本地 `dist/` 已含 r1 与 profile r3 时可直接启动。Server 对 Provider provenance 的校验是结构性的（Synthea commit、profile 身份与各 Release 之间的一致性），不硬编码具体 Release ID，切换到 r2 与新 profile revision 不需要修改 Server。

### 6.3 本地构建 profile 并启动

默认目录结构要求两个仓库同级，`cn-health-data` 从 [公开仓库](https://github.com/CaiZongyuan/cn-health-data) clone：

```text
backend/
  clinmesh/
  cn-health-data/
```

安装 cn-health CLI 并初始化 Candidate（下载约 75MiB，解压约 785MiB，幂等）：

```sh
npm install --global cn-health@0.5.0
cd ../cn-health-data
cn-health init
```

构建 profile 需要 Rust 工具链与 `uv`（cn-health-data 贡献者环境）。用 r2 Candidate 路径构建新 revision（`--build-revision` 递增，命令在 cn-health-data 仓库根执行）：

```sh
uv run cn-health-build synthea profile \
  --geography-release dist/geography-cn/releases/2026-08-29.r2 \
  --names-release dist/names-cn/releases/40.37.0.r2 \
  --population-release dist/population-cn/releases/WPP2024.r2 \
  --output-root dist/synthea-cn-profile/releases \
  --profile-version 2026-08-29 \
  --build-revision 4 \
  --reference-year 2026 \
  --synthea-commit d9d07a6eef91ee5144293b42ab64224d84d124f8
```

随后把 `compose.synthea-provider.yaml` 中四处挂载路径从 r1 改为 r2、profile 路径改为新建的 revision（本地修改 compose，或以环境变量覆盖 `CN_HEALTH_DATA_DIST` 后使用调整过的 compose 文件）。宿主账户不是 `1000:1000` 时先设置：

```sh
export CN_HEALTH_DATA_RUN_AS="$(id -u):$(id -g)"
```

启动并验证：

```sh
cd ../clinmesh
docker compose -f compose.synthea-provider.yaml up -d --build
curl --fail http://127.0.0.1:51878/health
docker compose -f compose.synthea-provider.yaml exec -T synthea-provider \
  java -cp /opt/provider:/opt/synthea/synthea.jar ProviderServer --smoke
```

`/health` 返回固定 Synthea commit、全部可用模块、profile ID、内容哈希、身份算法、姓名/地理/人口 Release provenance，以及中文 display projection ID、catalog SHA-256、记录数和 review mode。`--smoke` 以 `moduleMode=all` 生成一名患者并校验完整 localization provenance。

### 6.4 生成患者并开始就诊

访问管理员模拟数据页面 `http://127.0.0.1:51888/scenario-data` ，在"合成患者库"中点击"生成患者"；默认选择全部 Synthea 模块，每次打开都会产生新的双 seed，高级设置可手动修改以复现。生成完成后选择患者，标题中的"翻译待确认"表示患者可以继续使用，并可在"来源"页查看保留英文的名称、编码和 FHIR 位置。

在"来源历史"中打开任一条目的 R4 详情，点击"生成患者梗概"（要求步骤 4 已配置）。Brief 成功且已有当前 revision 后点击"开始门诊就诊"，选择科室、地点和门诊类型；系统直接创建普通 HIS 的 Patient、Registration、Encounter 和 Queue Task，随后即可继续挂号、分诊、医生接诊、收费、检验、药房等岗位流程。停止 Provider 但保留容器使用 `docker compose -f compose.synthea-provider.yaml stop`。

## 7. 可选运行方式

### Docker 一键启动

需要完整容器化运行时（含 Synthea）时叠加两个 Compose 文件：

```sh
docker compose -f compose.yaml -f compose.synthea.yaml up -d --build
```

- Web：`http://localhost:51868/`
- 模拟数据：`http://localhost:51868/scenario-data`

容器入口使用命名卷 `clinmesh-data`，在启动应用进程前执行幂等 migration。除非明确要删除本地合成数据，不要使用 `docker compose down -v`。只需要容器化 ClinMesh、不需要 Synthea 时可单独运行 `docker compose up -d --build`。

### 生产构建与 Node.js 直跑

```sh
pnpm build
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server start
```

构建顺序由 workspace 依赖和 Turborepo 决定：先生成 Web assets，再生成 Server 的 Node.js bundle，同时构建 Desktop、DSH Surface artifact 和文档站。Server 启动时只验证 migration 状态，不隐式修改 schema；`CLINMESH_HOST`、`CLINMESH_PORT` 和 `CLINMESH_WEB_ROOT` 可覆盖运行配置。

### 局域网访问 Web 开发入口

```sh
pnpm dev:lan
```

该命令同时启动 Server 和 Web：自动识别私有 IPv4 地址、让 Vite 监听 `0.0.0.0:51888`，并把本机及识别到的 Web origins 注入 `CLINMESH_TRUSTED_ORIGINS`。`0.0.0.0` 仅用于监听，浏览器应访问打印出的具体地址；只需允许防火墙 TCP `51888` 入站。未识别到正确地址时可显式指定，例如 `CLINMESH_LAN_IP=192.168.1.23 pnpm dev:lan`。开发入口不提供 HTTPS，只应暴露在可信局域网内。

### DSH Web 原生入口

首次准备固定依赖与 Web Profile：

```sh
pnpm --filter @clinmesh/dsh-web build
dsh plugin --profile web add github:CaiZongyuan/dsh-ag-ui#0c0b7e3608ac012dc2b053043fd0460d101b5db3
dsh plugin --profile web add "$PWD/vendor/dsh-react-surface/packages/runtime"
dsh plugin --profile web add "$PWD/apps/dsh-web"
```

在 `.env` 中为 Hono 配置至少 32 bytes 的 `CLINMESH_DSH_BRIDGE_SECRET`，并把实际 DSH Web origin 加入 `CLINMESH_TRUSTED_ORIGINS`（DSH 默认开发端口 `3080`；使用 `--port` 时必须同步替换该 origin，否则登录和 mutation 的 CSRF 校验会拒绝）：

```sh
export CLINMESH_TRUSTED_ORIGINS=http://127.0.0.1:51868,http://127.0.0.1:51888,http://127.0.0.1:3080
pnpm dev:server
```

另一个终端把同一个 secret 提供给 DSH Host；Server 使用非默认端口时同时设置 `CLINMESH_DSH_UPSTREAM_ORIGIN`：

```sh
set -a
. ./.env
set +a
dsh web
```

从 DSH Web 侧栏的 React applications launcher 打开 ClinMesh。默认使用 `workspace` 模式并保留原生会话；Surface 宽度不足 `1024px` 时自动退化到 `full-frame`，页面导航使用 Memory Router，不修改 DSH document pathname。当前模式只信任安装到同一 Web Profile 的插件，并只允许合成数据。

经 Turborepo 的根 `pnpm dev:server` 不转发未声明的 `CLINMESH_AI_*` 变量；在 worktree 或需要显式加载 `.env` 的场景使用 `pnpm --filter @clinmesh/server dev` 直接启动，否则 Patient Brief 和 Investigation provider 会被视为未配置。

## 8. 升级与重置

当前病例架构包含破坏性的 operational database migration，不兼容旧的本地病例与安装数据。升级前停止 Server，重置 `CLINMESH_DATABASE_PATH` 指向的本地 operational SQLite：

```sh
rm -f .data/clinmesh.sqlite .data/clinmesh.sqlite-shm .data/clinmesh.sqlite-wal
pnpm --filter @clinmesh/server db:migrate
```

该操作删除本地 HIS 运行数据。独立的 `.data/clinmesh-reference.sqlite` 不在删除范围内，不需要重新导入；不要把 `CLINMESH_REFERENCE_DATABASE_PATH` 指向 operational database，也不要删除 Reference SQLite。备份与单实例约束的决策依据见 [Demo 部署架构](demo-architecture.md)。
