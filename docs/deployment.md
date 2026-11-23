# 部署指南

本指南从 clone 开始，按顺序完成本地部署：基础运行、参考目录与指南同步、AI Provider 配置、启动验证，以及 Synthea、影像／病理素材、Docker、生产直跑、局域网与 DSH 原生入口。只想快速体验演示工作台的读者完成步骤 1、2、5 即可登录合成账号。产品定位见仓库根 [README](../README.md)，单实例运行边界见[系统架构](architecture/system.md#部署拓扑与单实例约束)。

## 0. 前置条件

| 目标 | 需要的工具 |
| --- | --- |
| 基础运行（步骤 1–3、5） | Node.js `>=24.9.0`、pnpm `11.17.0`（可由 corepack 按 `packageManager` 自动切换）、Git，首次启动可访问 cn-health Registry 与 GitHub Release |
| 动态患者档案与自由问诊（步骤 4） | 同上，加 OpenAI-compatible Provider 及 API key，或 DSH 已配置的 Provider（固定 PCI 与专病病例包无需外部模型即可运行） |
| Synthea 动态患者生成（步骤 6） | x86-64（`linux/amd64`）主机上的 Docker Engine 与 `docker compose` |
| 全量检查与生产构建 | Bun `1.4.2`（构建 DSH React Surface artifact） |
| DSH Web 原生入口 | Bun `1.4.2` 与网络，其余由 `pnpm dsh:setup` 按 lock 自动安装；Windows 另需系统自带 Windows PowerShell 5.1 |
| Mobile 原生目标 | Xcode 或 Android Studio |

## 1. 获取代码与安装依赖

```sh
git clone <repository-url> clinmesh
cd clinmesh
git submodule update --init --recursive
pnpm install
```

子模块初始化必须在 `pnpm install` 之前：`apps/dsh-web` 通过 `file:` 依赖 `vendor/dsh-react-surface/packages/{runtime,build}`，缺失时安装会以 `ENOENT` 失败。依赖版本与允许执行的构建脚本均由 `pnpm-lock.yaml` 和根配置固定。

## 2. 创建环境文件

```sh
cp .env.example .env
```

已有 `.env` 时不要覆盖。Server 与数据库 CLI 自动读取当前仓库或 git worktree 根目录的 `.env`，显式 shell 环境变量优先级更高。`.env.example` 已包含 `CLINMESH_AUTH_SECRET`、`CLINMESH_CURSOR_SECRET`、`CLINMESH_DATABASE_PATH`、`CLINMESH_REFERENCE_DATABASE_PATH` 和 `CLINMESH_DEMO_PASSWORD`；默认 Server 监听 `127.0.0.1:51868`，Web 热更新入口监听 `127.0.0.1:51888`。

## 3. 参考目录、DRG 与指南同步

`pnpm dev:server`、`pnpm dev:dsh` 和 `pnpm dev:lan` 首次启动会自动按 `reference-data.lock.json` 同步 ICD-10 诊断、药品和 `laboratory-cn` 数据集到独立的 `.data/clinmesh-reference.sqlite`，并自动启用本院检验服务快照；Server 运行期只读该库，不联网调用 `cn-health`。维护者可显式执行只读核对（如当前 `laboratory-cn@2026-09-01.r1` 应报告 `laboratory_test=84`、`laboratory_reference=96`、`laboratory_panel=15`、`laboratory_panel_member=88`）或正式同步：

```sh
pnpm reference:sync -- --check
pnpm reference:sync
```

绕过准备入口直接启动 Server 且参考库缺少当前 Release 时，进程以 `REFERENCE_RELEASE_NOT_FOUND` 失败关闭；仅显式移除 `CLINMESH_REFERENCE_DATABASE_PATH` 时才回退内置最小合成 fixture（诊断与检验为空，仅含 3 条合成药品）。

### 离线 DRG 资料核对

启动准备与 `pnpm reference:sync` 会按[离线清单](../apps/server/reference-data/drg-offline.lock.json)和[分发锁](../apps/server/reference-data/drg-distribution.lock.json)自动下载并核验五目录 r3 与 OpenDRG 固定精简包，默认安装于 `.data/drg-reference/`（物理表示、无损读取与维护制包命令见[DRG 离线资料储存合同](drg-reference-storage.md)）。已安装完整版本离线复用，准备前跨分页校验全部现存登记格式与内容哈希，缺失或损坏时在临时目录重验通过后才原子替换；用途固定为离线核对（`runtimeEnabled=false`），管理员会话可通过 `GET /api/sim/v1/reference-data/offline-inventories` 分页回读摘要（审计边界见[参考数据策略](architecture/fhir-and-commands.md#54-中国术语与参考数据策略)）。维护者核对与单独修复命令如下：

```sh
pnpm --filter @clinmesh/server drg:prepare --check
pnpm --filter @clinmesh/server drg:prepare
pnpm --filter @clinmesh/server reference-db list-inventories --database ../../.data/clinmesh-reference.sqlite --page 1 --page-size 20
pnpm --filter @clinmesh/server reference-db inventory-audit --database ../../.data/clinmesh-reference.sqlite
pnpm --filter @clinmesh/server reference-db verify --database ../../.data/clinmesh-reference.sqlite
```

### 运行时 DRG 规则启用

离线资料就绪默认不启用住院分组。`db:prepare` 在精简资料齐备时会自动按 `drg-rules-source.lock.json` 将 `clinmesh-chs-drg-30-2026-10-25.conditions-v2` 物化到 `.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2`（也可使用绝对路径执行 `pnpm --filter @clinmesh/server drg:rules:prepare --input-root <精简资料根绝对路径> --output-directory <输出绝对路径>` 单独物化，条件编译边界见[DRG 条件分组](architecture/drg-grouping.md#规则产物与交接)）。部署审核 JSON（`clinmesh.drg-rules-review.v1`）须绑定实际 `releaseId/sourceVersion/manifestSha256/referenceReleaseId` 且 `usageTerms`、`codingCompatibility`、`sourceApplicability`、`algorithmValidation` 四项均为 `verified`（本机合成演示可直接复用已核验的 [`deployment/drg/pci-demo-review.json`](../deployment/drg/README.md)，证据见[DRG 条件核验记录](research/2026-10-25-drg-condition-verification.md)）。在根 `.env` 同时配置以下两项并重启 Server 即可开启 CHS-DRG 3.0 预分组、归档冻结与医保办核定（缺一、哈希不符或临床 Release 不匹配均启动失败）：

```dotenv
CLINMESH_DRG_RULES_DIRECTORY=.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2
CLINMESH_DRG_RULES_REVIEW_PATH=deployment/drg/pci-demo-review.json
```

### 旧格式 DRG 登记的局部恢复

若历史参考库残留缺少 `storage` 字段的旧格式登记，启动会因不可变登记校验失败而报错退出，且单纯重下新资料不会自动清除旧记录。确认该旧登记已被当前精简快照逐逻辑文件等哈希完整替代后，先停止所有访问参考库的进程并对参考库执行 SQLite 在线一致备份，运行 `pnpm --filter @clinmesh/server drg:prepare --database <参考库绝对路径> --check` 验证当前物理包与全部原逻辑文件哈希无误，再在短 SQLite 写事务内仅删除已核实的被替代旧登记行（保留既有审计、其他登记、临床参考目录与业务数据库），最后运行 `reference-db verify` 复核无误后重启；未确认替代关系前严禁删除记录或改写旧 JSON（格式边界见[当前格式决策](decisions/implemented/simplification/2026-10-25-drg-current-format-only.md)）。

### 免费指南全文同步

<a id="冠心病资料的本地流程验证"></a>

正常启动准备会自动按[`guideline-release.lock.json`](../apps/server/reference-data/guideline-release.lock.json)、[`guideline-release-manifest.json`](../apps/server/reference-data/guideline-release-manifest.json)与[`guideline-release-overlay.json`](../apps/server/reference-data/guideline-release-overlay.json)离线核验或下载安装 58 份锁定指南快照到 `.data/clinmesh-guidelines.sqlite`（`CLINMESH_GUIDELINE_DATABASE_PATH` 可覆盖；异常中断遗留 `.prepare.lock` 时确认无准备进程后再删除；人群隔离、共享正文与检索规则见[临床决策支持与质控](architecture/clinical-decision-support.md)，schema 升级与回滚备份边界见[数据库迁移边界](architecture/storage.md#99-数据库迁移边界)，来源考证见[临床指南研究](research/2026-10-13-clinical-recommendation-guidelines.md)）。常用准备、官方注册表同步与已复核单来源恢复命令如下：

```sh
pnpm guidelines:prepare
pnpm guidelines:prepare -- --check
pnpm guidelines:prepare -- --restore-source coronary-01-2021
pnpm guidelines:sync
pnpm guidelines:sync -- --check
```

默认用途策略下固定包可检索全文为 `0`。内部测试环境可在 `.env` 显式设置 `CLINMESH_GUIDELINE_DEPLOYMENT_POLICY=internal-testing` 并重启 Server 启用锁定包中正文核验通过的可靠段落；`default` 策略下核实非商业科研用途后设置 `CLINMESH_GUIDELINE_NON_COMMERCIAL_USE=true` 仅启用 WHO 非商业许可段落。维护者对本地原始冠心病 PDF（按 `<sha256>.pdf` 放入目录并匹配 `local-guideline-sources.json`）做内部验证时，运行 `pnpm guidelines:local-sync -- --source-dir <原件目录> --database <指南库路径>` 并设置独立的 `CLINMESH_GUIDELINE_LOCAL_EVALUATION=true`。

## 4. 配置 AI Provider（患者档案必需）

`pnpm dev:dsh` 自动设置 `CLINMESH_AI_SOURCE=dsh` 复用宿主 Provider 与凭据，在 DSH“设置 → 通用 → ClinMesh 模型”即可选择路由（若报 `AI_AUTH_FAILED`，在宿主检查凭据或改选可用模型后对问诊点击重试、对失败检验点击重新生成、对患者档案发起新任务；已在途任务保持原绑定模型）。standalone Web 默认 `CLINMESH_AI_SOURCE=openai`，动态 Synthea 病例的档案生成、检验模型兜底与自由问诊在 `.env` 配置（OpenAI 兼容网关 `baseURL` 须填包含 `/v1` 的实际 API 根路径；仅显式通过 CLI 发布 LOINC 候选服务时才需额外配置 `CLINMESH_AI_CATALOG_ENRICHMENT_MODEL`）：

```dotenv
CLINMESH_AI_BASE_URL=https://provider.example/v1
CLINMESH_AI_API_KEY=replace-with-local-key
CLINMESH_AI_BRIEF_MODEL=provider/brief-model
CLINMESH_AI_INVESTIGATION_MODEL=provider/investigation-model
CLINMESH_AI_CONSULTATION_MODEL=provider/consultation-model
```

固定 PCI 病例与五例心肾专病 `Authored Case Pack`（Web“模拟数据 → PCI 演示准备”或 `clinmesh admin authored-case-pack prepare`）内置版本化模板 `clinmesh-authored-template` 与分阶段 `Case Truth`，无需配置外部 AI Provider 即可跑通完整门诊与住院流程。缺少 consultation 模型时服务仍正常启动，仅自由问诊返回 `CONSULTATION_REPLY_UNAVAILABLE` 并保留医生提问供恢复后重试；配置外部 Provider 后可显式运行 `pnpm smoke:patient-brief:live` 做单次连通性自检。

## 5. 启动并验证

```sh
pnpm dev:server
```

`pnpm dev:server` 构建 Web、迁移 operational SQLite、准备参考与指南资料、seed 演示工作区与账号并监听 `http://127.0.0.1:51868/`（前端热更新另开终端运行 `pnpm dev:web` 访问 `http://127.0.0.1:51888/`；健康检查 `/api/health`，FHIR 元数据 `/fhir/R5/metadata`）。全部合成岗位账号共用 `.env` 中的 `CLINMESH_DEMO_PASSWORD`（默认 `ClinMesh-demo-password-2026!`）：

| 岗位 | 账户邮箱 |
| --- | --- |
| 挂号员 | `registrar@demo.clinmesh.local` |
| 分诊护士 | `triage@demo.clinmesh.local` |
| 门诊医生 | `doctor@demo.clinmesh.local` |
| 收费员 | `cashier@demo.clinmesh.local` |
| 药师 | `pharmacist@demo.clinmesh.local` |
| 住院医生 | `inpatient-doctor@demo.clinmesh.local` |
| 病区护士 | `ward-nurse@demo.clinmesh.local` |
| 病案人员 | `medical-records@demo.clinmesh.local` |
| 医保办 | `medical-insurance@demo.clinmesh.local` |
| 管理员 | `admin@demo.clinmesh.local` |

以门诊医生登录可搜索 ICD-10 目录即表示参考库生效；住院跨科室交接与药耗目录准备分别见[住院与手术流程](architecture/inpatient-workflows.md)、[处方、医嘱与药事](architecture/orders-and-pharmacy.md)及[住院 CLI Skill](../skills/clinmesh-inpatient/SKILL.md)。

## 6. Synthea 患者生成

Synthea Provider 与中文化 localizer 由固定 digest 的 `linux/amd64` 预构建容器提供，无需宿主机安装 JDK 或 Python（运行与重放边界见[Synthea 病例来源与重放决策](decisions/implemented/architecture/2026-08-30-synthea-case-source-and-replay.md)）：

```sh
pnpm synthea:up
pnpm synthea:doctor
pnpm synthea:down
```

启动后在管理员 `http://127.0.0.1:51868/scenario-data` 点击“生成患者”（可选放射或病理定向条目），生成 Patient Persona 后即可开始就诊。`synthea:down` 仅移除两个生成容器，不影响已有病例与 HIS 运行。

## 7. 可选运行方式

### 影像素材

胸片与胸部 CT 阅片按[影像素材清单](../imaging-assets/README.md)从公开数据源拉取 DICOM 到 `.data/imaging-assets`（可用 `CLINMESH_IMAGING_ASSET_DIRECTORY` 覆盖，支持重复 `--asset <assetId>` 限定范围，经代理访问公网时加 `NODE_USE_ENV_PROXY=1`；不安装时放射服务仅显示未开展）：

```sh
pnpm imaging:sync
pnpm imaging:verify
pnpm imaging:repair
```

`imaging:repair` 从本地保留的 `sources/` 离线重建 `installed/`，修复后无需重启 Server；备份数据库时须同步备份 `sources/` 原件目录，病例影像准备与阅片操作见[影像检查使用指南](imaging.md)。

### PathJX 外部阅片服务

PathJX 独立部署，ClinMesh 未配置它也能启动。结直肠与甲状腺会诊依赖外部原片、相容模型和经复核报告，乳腺仍使用下方的本地素材包。支持的协议固定为 `clinmesh.pathology-reading.v1`；原生 REST `/api/v1` 的版本不能代替该握手。双方端点及恢复规则见[协议合同](architecture/pathology-reading.md)；PathJX 侧由[接入 Issue](https://github.com/JinhaoFang/PathJX-01/issues/327)关联的 `contracts/clinmesh-reading.md` 拥有。

1. 部署支持该协议的 PathJX 平台、瓦片服务与 Web 专用入口 `/clinmesh/reading`。Web 与 ClinMesh 必须使用不同 origin；反向代理保留 `private, no-store`，只对部署白名单中的确切父 origin 允许嵌入。生产使用 HTTPS。
2. 在 PathJX 的部署环境设置 `PATHJX_CLINMESH_KEY`、稳定的 `PATHJX_CLINMESH_INSTANCE_ID`、`PATHJX_CLINMESH_PARENT_ORIGINS`，以及固定的 `CLINMESH_AUTHORIZATION_URL=<ClinMesh origin>/api/his/v1/pathology-reading/authorize`。使用 `PATHJX_CLINMESH_ACTORS` 将 ClinMesh 稳定 Actor ID 映射到已有的启用人类医生账号；不要映射管理员、Agent 或共享服务账号。`PATHJX_CLINMESH_ASSETS` 将稳定资产键映射到预登记的原片。凭据只留各自服务环境。
3. 核验原片许可、署名、去标识和完整 SHA-256，在本机准备外部清单 JSON。格式由 `apps/server/src/application/pathology-external-catalog.ts` 的 `externalPathologyCatalogSchema` 拥有；报告人工批准的 `contentHash` 使用同模块 `externalPathologyReportHash` 计算。外部 `output` 包含 `kind: "pathjx"`、实例、资产键、内容哈希、器官、标本类型与 `stain: "HE"`，不包含文件路径或下载 URL。只有来源诊断与既往标本相容、报告复核有效且远端资产可读才就绪。
4. 在 ClinMesh 的 `.env` 设置 `CLINMESH_PATHOLOGY_READING_ENDPOINT`、`CLINMESH_PATHOLOGY_READING_VIEWER_ORIGIN`、`CLINMESH_PATHOLOGY_READING_INSTANCE_ID` 和 `CLINMESH_PATHOLOGY_READING_TOKEN`，四项一起提供。令牌与 PathJX 集成密钥一致；前两项仅为确切 origin。设置 `CLINMESH_PATHOLOGY_EXTERNAL_CATALOG_PATH` 为上一步 JSON 的绝对路径。重启 Server 加载部署授权，浏览器不能修改白名单或令牌。
5. 管理员打开“模拟数据 → 病理阅片服务”，填写同一实例和地址，明确“保存并启用”，再“检查连接”。核对实际模型版本、适用器官和限制；这一步不运行推理。通过公开管理员 `GET /api/sim/v1/admin/pathology-case-pack` 查看版本化病例包，`POST /api/sim/v1/admin/pathology-case-pack/prepare` 携带当前 Epoch 和幂等键准备固定两例，再按[病理指南](pathology.md#管理员与医生pathjx-外部会诊)准备并开始病例。
6. 由医生按原开单、缴费和出报告流程打开切片，核对实际显示、当前医生、原报告和单片范围。模型提示与人工复核不自动写回正式报告。真实模型现场计算仍须本次明确授权；合成执行器测试不算真实医学效果证据。

| 部署组合 | 行为 |
| --- | --- |
| 两侧均声明并通过 `clinmesh.pathology-reading.v1` 合同 | 允许按当前授权建立单片会话 |
| 任一侧缺少接入端点、实例不符或协议不兼容 | 嵌入阅片不可用，保留 ClinMesh 文字报告与历史引用 |
| 缺凭据、未启用、离线或原片不可读 | 拒绝新的阅读资格与写入，不影响其他 HIS 业务 |
| 原对象、内容或确认修订不一致 | 待修复；不得自动补建、换片或重跑 |

本次验证的来源组合为 ClinMesh 本次 `clinmesh.pathology-reading.v1` 适配器与 PathJX 提交 `53d7f0ffcfee1026ce98af26f69916dd770e4f71`（包含专用 Web 页、受限平台 API 与瓦片代理），使用 PostgreSQL 18、Go 1.27.3、合成切片与合成模型声明；真实两侧 HTTP 旅程覆盖两器官、当前人类身份复核、原回执、单片报告更正及停用撤权。ClinMesh 外壳另通过 Chromium 1243 的 standalone 与 React 18/19 ShadowRoot 合同。PathJX 原主线 `789f96eae83b4deb893e375e22f4dff290ab1b8b` 缺少接入端点，不能作为兼容部署组合。该来源组合仍需按各仓库流程交付后部署；这些合成证据不代表真实原片、GPU、模型质量或全部外部版本组合已验证。

升级前停用 ClinMesh 阅片服务，保留数据库一致备份和固定版本引用，在隔离环境运行共享正反样例、原回执恢复及单片旅程后再启用。回退同时使用已验证的两侧版本与匹配数据；不以回退单侧代码抹掉已确认动作。当前本地实现与合成验证不构成对任意已发布版本组合的兼容承诺。

备份需包含 ClinMesh SQLite 的绑定、会话与检查点，以及 PathJX PostgreSQL 的受控病例、切片、冻结模型、分析、复核、测量、回执和加密材料；原片文件、模型、实例与密钥配置分别保留。分别恢复任何一侧后先保持停用，核对原实例、内容和双方已确认修订；缺失或回退时保留诊断并恢复匹配备份，不清空回执或重新准备同一个已开始会诊。短效会话可重新签发，历史临床事实不得据此重建。

### 病理切片素材

乳腺切片病理会诊按[病理切片素材清单](../pathology-assets/README.md)独立拉取 TCGA-BRCA 公开切片到 `.data/pathology-assets`（`CLINMESH_PATHOLOGY_ASSET_DIRECTORY`，与放射素材互不依赖，支持 `--asset <assetId>` 按需安装，最大单张摄取进程内存峰值约 1.2 GB）：

```sh
pnpm pathology:sync
pnpm pathology:verify
pnpm pathology:repair
```

备份与离线修复同样以保留 `sources/` 为准（升级底层 JPEG/JPEG 2000 编解码库会改变转码哈希，须维护者重新登记），切片复核签署与病例匹配操作见[病理切片会诊使用指南](pathology.md)。

### Docker 一键启动

```sh
docker compose -f compose.yaml -f compose.synthea.yaml up -d --build
```

容器使用命名卷 `clinmesh-data` 持久化 `/var/lib/clinmesh/clinmesh.sqlite` 与 `/var/lib/clinmesh/guidelines.sqlite`（镜像内置锁定参考库与指南包，冷启动离线可用，不包含影像与病理像素；无需 Synthea 时只传 `compose.yaml`，避免使用 `down -v` 误删卷数据；从指南库位于 `/opt/clinmesh/guidelines.sqlite` 的旧容器升级时须先导出一致备份再迁入新持久卷）。

### 生产构建与 Node.js 直跑

```sh
pnpm build
pnpm --filter @clinmesh/server db:migrate
pnpm --filter @clinmesh/server start
```

Server `start` 只校验 schema 版本而不隐式执行迁移，可用 `CLINMESH_HOST`、`CLINMESH_PORT`、`CLINMESH_WEB_ROOT` 覆盖监听与静态资源目录。升级前须使用在线备份 API 保存快照，恢复旧备份时必须停止旧库进程并传入最新权威库合并按日门诊号高水位（细则见[数据库运维](architecture/storage.md#database-operations)）：

```sh
pnpm --filter @clinmesh/server db:verify
pnpm --filter @clinmesh/server db:reindex
pnpm --filter @clinmesh/server db:backup --output ./.data/clinmesh-backup.sqlite
pnpm --filter @clinmesh/server db:restore --authority-database ./.data/clinmesh.sqlite --backup ./.data/clinmesh-backup.sqlite --destination ./.data/clinmesh-restored.sqlite
```

### 局域网访问 Web 开发入口

运行 `pnpm dev:lan` 会自动探测私有 IPv4（或由 `CLINMESH_LAN_IP=192.168.x.x` 显式指定）、将 Vite 绑定到 `0.0.0.0:51888` 并注入 `CLINMESH_TRUSTED_ORIGINS`，同时检查参考库与本地 Synthea 容器状态。该入口无 HTTPS，仅限可信局域网开放防火墙 TCP `51888` 访问打印出的具体地址。

### DSH Web 原生入口

ClinMesh 所需 DSH Host、React Surface 与 AG-UI 的精确版本和 commit 统一锁定在 [`dsh-upstreams.lock.json`](../dsh-upstreams.lock.json)，跨平台使用两条命令完成隔离沙箱供给与双进程启动：

```sh
pnpm dsh:setup
pnpm dev:dsh
```

`dsh:setup` 幂等构建 `.data/dsh-runtime/`（`CLINMESH_DSH_SANDBOX` 可改到仓库外）：按 lock 安装 `dshvm` 与宿主槽位、用 [`deployment/dsh/host/package-lock.json`](../deployment/dsh/host/package-lock.json) 恢复依赖、克隆构建锁定 AG-UI、构建 React Surface runtime 与 `@clinmesh/dsh-web` artifact，并在专用 Web Profile 建立三个插件链接（Windows 使用无需管理员权限的目录 junction）。`dev:dsh` 自动生成缺失的 `CLINMESH_DSH_BRIDGE_SECRET`、对齐 `127.0.0.1:51868/51888/3080` 可信 Origin（端口 `3080` 被占用时直接报错退出），并以进程组／Windows Job Object 同时拉起直连 `@clinmesh/server`（绕过 Turborepo，保留 `CLINMESH_AI_*` 环境变量）与 DSH Web。

浏览器必须打开控制台打印的带本次启动 token 的 DSH URL，首次使用在宿主设置配置模型 Provider，并从左侧栏“医院工作台”打开左右分屏（顶栏支持全屏与收起右侧会话无刷新切换）。非开发模式 DSH 在插件激活时将 client 脚本读入内存，手工重编 `@clinmesh/dsh-web` 后须重载插件或重启 DSH 宿主；手动直启 Server 时若进程环境已含 `.env` 相对路径变量，须先按 `.env` 目录转为绝对路径。单次结构化生成默认限时 120 秒（`CLINMESH_AI_TIMEOUT_MS` 可在 `100`–`600000` 间覆盖，初次生成、一次格式修复与一次限流重试共享同一截止时间）。

#### 问诊自动记录原生验收

完成锁定 DSH 沙箱安装与 `pnpm --filter @clinmesh/dsh-web build` 后，开发者可显式运行 `pnpm smoke:consultation:native` 或 `pnpm smoke:recommendations:native` 在临时隔离 Profile、临时 SQLite 与合成模型下端到端验证原生 Session browser Tool 草稿保存、`.propose` 人工批准签署及 request/audit/trace 串联；仅在取得明确许可并配置隔离 `CLINMESH_DSH_SMOKE_HOME` 与 `CLINMESH_DSH_SMOKE_LIVE_MODEL` 时才运行对应的 `:live` 实模自检（无桌面环境可在隔离 Profile `cordis.patch.yml` 切换 `directory-picker-browse`），验证分层见[测试策略](testing.md#end-to-end)。

### DSH 持续升级

[`.github/workflows/dsh-upstreams.yml`](../.github/workflows/dsh-upstreams.yml) 每日自动发现上游正式版／RC 与 commit 更新并串行触发[候选验收](../.github/workflows/dsh-upstreams-verify.yml)；需跳过某次候选时在升级 PR 添加 `跳过此版本` 标签并关闭 PR。本地只读发现与全新克隆隔离验收分别运行 `pnpm upstream:discover` 和 `pnpm upstream:verify`。

## 8. 升级与重置

<a id="共享收款的一次性开发切换"></a>

常规升级先停止 Server，运行 `db:backup` 保留一致备份，再依次执行 `db:migrate` 与 `db:verify`；日常重跑合成病例使用管理员页面的“重置数据”（Epoch reset），禁止通过删除整库替代数据库迁移（见[数据库运维](architecture/storage.md#database-operations)）。

## 模型用量

ClinMesh“设置 → 模型用量”提供跨 Epoch 用量总览、Workspace 级开关／请求数／Token／人民币上限与默认 90 天明细保留期管理，以及只读计价说明。部署维护者可通过相对 `.env` 目录的 JSON 文件配置部署级总上限（`CLINMESH_MODEL_CONTROL_PATH=.data/model-control.json`）与统一合成价表／汇率（`CLINMESH_MODEL_PRICING_PATH=.data/model-pricing.json`，单价为原币／百万 Token、最多六位小数，`model` 精确匹配请求路由），修改后重启生效：

```json
{ "enabled": true, "requests": 1000, "tokens": null, "cny": null, "automaticRetries": true }
```

```json
{
  "prices": [{ "provider": "synthetic.invalid", "model": "synthetic-model", "version": "v1", "currency": "USD", "rates": { "input": 2, "output": 4, "cacheRead": 0.5, "cacheWrite": 2, "reasoning": 4 } }],
  "exchangeRates": [{ "currency": "USD", "version": "fx-v1", "cnyPerUnit": 7 }]
}
```

当前三类模型入口均可精确限制请求次数；因直接 OpenAI 请求无硬输出 Token 上限且 DSH SDK 未公开底层 wire 计量保证，配置有限 Token 或非零人民币上限后新派发会以 `MODEL_METERING_UNAVAILABLE` 失败关闭。授权与持久账本合同分别见[模型用量查询](architecture/security-and-reliability.md#模型用量查询)和[模型调用账本](architecture/storage.md#模型调用账本)。

## 实时病历整理模型与负载验证

`CLINMESH_AI_RECORDING_MODEL` 可为门诊实时自动病历整理固定独立路由（如在 DSH 路由 JSON 中显式指定 `"reasoningEffort":"off"` 关闭思考延迟，不设置时沿用问诊模型），超时统一遵循 `CLINMESH_AI_TIMEOUT_MS`（DSH 默认 120 秒、OpenAI 默认 60 秒），批次与来源约束见[门诊业务流程](architecture/outpatient-workflows.md)与[模型调用账本](architecture/storage.md#模型调用账本)。日常开发与验收默认使用合成 Provider 与临时数据库；任何真实模型验证或负载测试均须事先取得用户针对当次运行的明确许可，严格遵循[工程规则](../AGENTS.md)。
