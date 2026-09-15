# 部署指南

本指南从 clone 开始，按顺序完成本地部署：基础运行、参考目录同步、AI Provider 配置、Synthea 患者生成与可选运行方式。每一步都以前一步为前提；只想快速体验的读者完成步骤 1、2、5 即可登录演示账号。产品定位与工程形态见仓库根 [README](../README.md)，部署决策与单实例约束见 [Demo 部署架构](demo-architecture.md)。

不配置 Synthea Provider 不阻塞 ClinMesh 启动；Provider 缺失只影响新的患者生成任务。生成患者后，"生成患者梗概"和"开始门诊就诊"要求步骤 4 的 AI Provider 已配置。

## 0. 前置条件

| 目标 | 需要的工具 |
| --- | --- |
| 基础运行（步骤 1–2、5） | Node.js `^22.19.0` 或 `>=24.0.0`、pnpm `11.17.0`、Git |
| 完整参考目录（步骤 3） | 同上，加可访问 cn-health Registry 的网络 |
| 患者梗概与就诊闭环（步骤 4） | 同上，加一个 OpenAI-compatible Provider 及 API key |
| Synthea 患者生成（步骤 6） | x86-64 主机上的 Docker Engine 与 `docker compose` |
| 全量检查与生产构建 | Bun `1.4.0`（DSH React Surface artifact 构建使用 `bun`） |
| DSH Web 原生入口 | DSH CLI `0.1.5-rc.2`、`@dsh-so/dshvm@0.1.1` |
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

Synthea Provider 与中国化 localizer 由固定 digest 的预构建镜像提供。镜像内已经包含固定 Synthea JAR、`synthea-cn@2026-08-29.r4` profile、匹配的姓名/地理/人口 Release 与实验性中文显示目录；宿主机不需要 JDK、Python、Rust、`uv`、第二个源码仓库或数据挂载。

当前 Provider 镜像只发布 `linux/amd64`。arm64 主机不自动启用模拟运行，必须等待对应的原生镜像发行。

启动两个内部容器并等待健康检查：

```sh
pnpm synthea:up
```

命令幂等拉取镜像，只启动 `cn-health-localizer` 与 `synthea-provider`，并在 Provider 真正健康后返回。需要执行一次完整的全模块单患者生成诊断时运行：

```sh
pnpm synthea:doctor
```

`doctor` 只打印版本、profile、模块数和 smoke 结果，不打印生成的 FHIR Bundle、模型内容或凭证。临床显示目录明确属于 `experimental-preview`；结构与 provenance 错误失败关闭，缺失翻译保留来源英文并在患者来源页显示“翻译待确认”。

访问管理员模拟数据页面 `http://127.0.0.1:51868/scenario-data`，在“合成患者库”中点击“生成患者”；默认选择全部 Synthea 模块，每次打开都会产生新的双 seed，高级设置可手动修改以复现。生成完成后选择患者，可在“来源”页查看完整来源病史。

在“来源历史”中打开任一条目的 R4 详情，点击“生成患者梗概”（要求步骤 4 已配置）。Brief 成功且已有当前 revision 后点击“开始门诊就诊”，选择科室、地点和门诊类型；系统直接创建普通 HIS 的 Patient、Registration、Encounter 和 Queue Task，随后即可继续岗位流程。

停止并只移除两个 Synthea 容器：

```sh
pnpm synthea:down
```

该命令不删除 ClinMesh SQLite、业务数据、Docker volume 或其他服务。Provider 未启动、不可达或停止时，ClinMesh 普通 HIS 与已经生成的病例继续运行；只有新的患者生成任务不可用。运行与发行边界见 [一键 Synthea 运行时](../.agents/notes/implemented/architecture/2026-09-03-one-command-synthea-runtime.md)。

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

ClinMesh 只要求 DSH、React Surface 和 AG-UI。精确来源、版本、commit、依赖关系及维护归属由 [`dsh-upstreams.lock.json`](../dsh-upstreams.lock.json) 记录；React Surface 与 AG-UI 均直接声明当前 RC 依赖。其他插件与旧 HIS Demo 不属于此组合，不需要升级或逐项验收，也不应覆盖它们的配置和数据。跟进公开正式版和 RC 时更新经过验证的精确输入，不把 `latest` 当作可复现版本。

以下 Bash 示例建立独立工具、连接器和数据目录，不接管日常 DSH。`CLINMESH_DSH_SANDBOX` 应使用仓库外尚未使用的绝对目录：

```sh
export CLINMESH_DSH_SANDBOX="$(cd .. && pwd)/clinmesh-dsh-runtime"
export DSHVM_HOME="$CLINMESH_DSH_SANDBOX/versions"
export DSHVM_BIN_DIR="$CLINMESH_DSH_SANDBOX/bin"
npm install --prefix "$CLINMESH_DSH_SANDBOX/tooling" @dsh-so/dshvm@0.1.1
DSHVM_CLI="$CLINMESH_DSH_SANDBOX/tooling/node_modules/@dsh-so/dshvm/bin/dshvm.js"
node "$DSHVM_CLI" install 0.1.5-rc.2
cp deployment/dsh/host/package*.json "$DSHVM_HOME/dsh-0.1.5-rc.2/"
npm ci --prefix "$DSHVM_HOME/dsh-0.1.5-rc.2"
node "$DSHVM_CLI" isolate 0.1.5-rc.2
node "$DSHVM_CLI" use 0.1.5-rc.2
node "$DSHVM_CLI" which 0.1.5-rc.2
node "$DSHVM_CLI" exec --version
export DSH_HOME="$DSHVM_HOME/isolate/0.1.5-rc.2"
DSH_CLI="$DSHVM_HOME/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

`which` 应指向该隔离槽位，`exec --version` 应返回锁定版本。宿主安装必须在停止状态下使用 [`deployment/dsh/host/package-lock.json`](../deployment/dsh/host/package-lock.json) 执行 `npm ci`；dshvm 的初始安装用于建立槽位登记，不能代替锁文件恢复，因为 DSH 顶层版本的内部依赖仍使用版本范围。不要对已有共享槽位使用 `setup` 或 `isolate --copy` 来建立干净验收环境。Windows PowerShell 使用 `$env:DSHVM_HOME`、`$env:DSHVM_BIN_DIR` 和 `$env:DSH_HOME` 设置相同目录，普通路径变量使用 `$变量名`；Node CLI 的参数相同。新终端需要重新提供这些变量。DSH Provider 在隔离宿主设置页单独配置，密钥不写入 Profile 仓库或公开记录。

先按上游锁文件构建 React Surface 与 ClinMesh，再构建并安装 AG-UI。AG-UI 安装使用公开支持分支的精确 commit，合并后仍可按同一 commit 重建：

```sh
bun install --cwd vendor/dsh-react-surface --frozen-lockfile
bun run --cwd vendor/dsh-react-surface build:runtime
pnpm --filter @clinmesh/dsh-web build
git clone https://github.com/keaideppk/dsh-ag-ui.git "$CLINMESH_DSH_SANDBOX/ag-ui"
git -C "$CLINMESH_DSH_SANDBOX/ag-ui" checkout 521740953be41cc37bd770ecf41b36bd7b0824d9
pnpm --dir "$CLINMESH_DSH_SANDBOX/ag-ui" install --frozen-lockfile
pnpm --dir "$CLINMESH_DSH_SANDBOX/ag-ui" build
DSH_PROFILE="$DSH_HOME/profiles/web"
mkdir -p "$DSH_PROFILE/plugins"
cp deployment/dsh/profile/* "$DSH_PROFILE/"
ln -s "$CLINMESH_DSH_SANDBOX/ag-ui" "$DSH_PROFILE/plugins/ag-ui"
ln -s "$PWD/vendor/dsh-react-surface/packages/runtime" "$DSH_PROFILE/plugins/react-surface"
ln -s "$PWD/apps/dsh-web" "$DSH_PROFILE/plugins/clinmesh"
pnpm --dir "$DSH_PROFILE" install --frozen-lockfile
```

[`deployment/dsh/profile`](../deployment/dsh/profile/package.json) 只加载 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与上述三个插件；其 pnpm lock 固定 Profile 的独立依赖闭包，本地插件使用相对 `link:`。Windows 可用 `New-Item -ItemType Junction -Path <Profile/plugins/名称> -Target <对应源码绝对目录>` 代替三个 `ln -s`。模板只用于新建的专用 Profile，不覆盖已有 Profile；再次安装使用已有链接和 `--frozen-lockfile`。链接安装不替插件安装源码依赖，因此不能省略各 workspace 的安装与构建。

需要查看或修改插件时直接调用 `node "$DSH_CLI" plugin --profile web ...`：dshvm `0.1.1` 会把 `plugin --profile web` 误判为 Web 启动，并在默认端口被占用时附加插件命令不接受的 `--port`。dshvm 连接器也会按 active-data 覆盖显式 `DSH_HOME`；测试自行管理数据目录时应使用对应槽位的实际 bin。插件变更后重新验证并更新 Profile lock，日常运行不要用无锁安装替换已验证组合。

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
node "$DSHVM_CLI" exec web --port 3080 --no-open
```

无桌面交互的浏览器验收可在隔离 Profile 的 `cordis.patch.yml` 使用官方目录选择器替换点，避免工作区选择触发不可操作的 Windows 原生对话框：

```yaml
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

该替换同时加载 host 与 client 两半，不能与自动选择器同时启用；保存后重启隔离 DSH。可交互桌面的普通运行无需此覆盖。

重新启动 DSH Web 后，左侧栏顶端显示 ClinMesh Logo 和名称；应用尚未打开或已经关闭时仍保留该 Profile 品牌。新会话中央同样显示 ClinMesh Logo，中文标题为“医疗智能体平台”，英文为“Medical AI Agent Platform”。禁用或卸载 ClinMesh 插件后恢复宿主的品牌显示。从侧栏底部“医院工作台”菜单打开 ClinMesh；登录后岗位导航直接显示在宿主侧栏的新会话与工作区之间，底部菜单保留设置与主题入口，其他已注册 Surface 位于“其他应用”分组。ClinMesh 在 DSH 内不显示自己的左侧栏，默认使用 `workspace` 左右分屏并保留原生会话；现有页头的“全屏 ClinMesh”与“返回 DSH 分屏”按钮可往返切换，无需刷新。全屏时先返回分屏再使用宿主导航。窗口缩小或侧栏开关不自动全屏，应用内部按容器宽度适配。页面导航使用 Memory Router，不修改 DSH document pathname。独立 Web 保留原侧栏。当前模式只信任安装到同一 Web Profile 的插件，并只允许合成数据。

经 Turborepo 的根 `pnpm dev:server` 不转发未声明的 `CLINMESH_AI_*` 变量；在 worktree 或需要显式加载 `.env` 的场景使用 `pnpm --filter @clinmesh/server dev` 直接启动，否则 Patient Brief 和 Investigation provider 会被视为未配置。

### DSH 持续升级

[`DSH upstream updates`](../.github/workflows/dsh-upstreams.yml) 每日 UTC 02:23（北京时间 10:23）发现更新，也支持 Actions 页面手动运行。发现范围由 [`dsh-upstreams.lock.json`](../dsh-upstreams.lock.json) 拥有：npm 组件比较全部公开正式版和 `rc.N`，不以 `latest` 或 `next` 标签决定候选；源码组件跟踪公开来源的默认分支完整 commit。源码默认分支落后于已验证支持提交时保留支持提交，历史分叉时明确失败并等待维护者协调。

本地只读发现命令为 `pnpm upstream:discover`，结果写入已忽略的 `dsh-upstreams.discovery.json`。所有来源解析成功后才产生新候选；已验证 npm 版本被撤销、发行身份或完整性变化、非法响应和网络错误均失败，不产生部分更新。没有差异不创建 PR。发布模式先从目标分支的精确 HEAD 读取基线锁，不采用运行分支或本地 checkout 的锁；读取失败停止，不回退到本地。手动和定时运行以仓库默认分支为目标，专用验证分支的 push 以该验证分支为目标。随后在新版本发现前检查当前基线对应的活动候选；目标 npm 版本已撤销或内容变化时，保留候选和人工提交，确认 HEAD 未变化后将该提交的兼容状态置为失败，并在 PR 自动管理区和发现报告的 `result` 中记录待适配原因，不调度安装。即使后续发现因基线版本撤销或其他来源错误而失败，候选失效证据仍保存：报告的 `result` 保留待适配结果，报告和 CLI 输出另以 `discoveryError` 记录发现错误，不产生新候选或验收 HEAD。没有候选失效时，发现错误仍以非零退出码结束。正常候选不写入；网络或非法响应报错，不判定为撤销。`pnpm upstream:discover --publish` 还要求 `GH_TOKEN`，使用 GitHub Git API 在当前升级分支 HEAD 上原子追加候选文件与 `deployment/dsh/discovery.json`，后者保存上一次自动发现的完整候选。再次更新前比较 PR 当前候选与该记录；人工支持 commit、版本或其他目标字段有变化时停止，保留人工目标，不先合并基线。没有人工修改时，新的上游目标同步更新两份文件。基于目标分支和基线摘要的分支名保证重复发现复用活动 draft PR；PR 中的自动管理区更新完整组件差异，区外人工说明保留。

main 上的上游锁是已验证基线；升级分支的 `deployment/dsh/candidate.json` 是待适配目标。发现只更新候选。同一目标分支的发现与 PR 验收由工作流串行执行，防止先前验收覆盖撤销后的失败状态。工作流随后显式调用[候选验收](../.github/workflows/dsh-upstreams-verify.yml)，不依赖 `GITHUB_TOKEN` 创建 PR 后触发 `pull_request`。安装与构建进程不获得写入 token；最终追加提交和写入 commit status 的步骤单独使用 token。需要仓库允许 Actions 创建 PR，并授予发现 job `contents:write`、`pull-requests:write`、`statuses:write`，验收收尾 job `contents:write`、`statuses:write`；权限不足保留明确的 HTTP 错误。

维护者可在全新独立 clone 中检出升级 PR 的精确 HEAD、递归恢复子模块并执行 `pnpm install --frozen-lockfile`，随后运行 `pnpm upstream:verify`。该命令拒绝主分支和已有未提交修改，保护不同于锁定版本的人工依赖或子模块适配；pnpm 给构建 CLI 添加的可执行位仅在文件内容与 Git 相同时恢复。它在安装前和全部检查结束后核对 npm registry 中的目标版本及发行摘要；版本撤销或内容变化时停止，不因旧 tarball 仍可下载而通过验收。它从候选的精确 URL 下载 DSH/dshvm tarball，逐字节计算 SHA-512，摘要一致后才准备依赖或执行候选；下载错误、重定向及摘要不符均停止，失败下载不保留为可安装文件。随后按精确源码构建 Surface 与 AG-UI，在新的系统临时目录安装已校验的 dshvm 文件，并由它安装已校验的宿主文件。宿主 `npm ci` 前还核对依赖锁中的版本、来源与完整性是否匹配候选，npm 安装时继续验证锁定摘要。宿主与 Web Profile 重建后，通过 dshvm 隔离、选择和 `exec` 检查实际版本并启动 HTTP smoke，最后运行 `pnpm check`。子进程只继承运行工具所需环境，npm 使用临时空用户配置，模型密钥、GitHub token、日常 Profile 与数据库配置不传入；smoke 临时凭证在日志中脱敏。临时 Profile 只加载必要组合，不切换日常 Profile，也不调用付费模型。POSIX 命令与宿主在独立进程组中运行，退出或取消后有界清理；Windows 取消时回收 launcher 的现存子树。进程结束后保留临时安装供诊断；它不作为日常运行目录。

只有自动检查全部通过才写入升级 checkout 的目标上游锁与 `deployment/dsh/automation.json` 摘要回执。回执允许同一 PR 在已自动准备的组合上继续接收新候选；人工改动锁后摘要不匹配时拒绝覆盖。Actions 在确认远端 HEAD 未被人工提交改变后追加精确依赖锁与子模块引用；普通 push 的快进约束处理检查后的并发竞争。结果、日志和准备补丁在 `.upstream-evidence/` 中，并作为当前 Actions 运行的 artifact 保存；`DSH candidate compatibility` status 绑定被检查的精确 commit。失败状态是待适配，已验证基线不推进，draft 不自动变为 ready，也不自动合并。自动通过只证明记录中的安装、构建、smoke 和测试；原生会话、browser Tool → review → Effect、Windows 实际使用和业务闭环仍按[测试策略](testing.md)补充人工证据，由维护者决定合并。

故障恢复按原因处理：网络或权限故障修复后重跑发现；依赖或编译失败由维护者在同一升级分支追加适配；人工 HEAD 已变化时重新运行验收；基线发生变化或候选与人工支持 commit 冲突时先协调目标再运行。不要 force-push 自动分支、降低宿主到 alpha 或覆盖人工改动来消除失败。合并后新的基线摘要拥有下一轮升级分支。`automation/dsh-upstreams-validation` 是受控集成验证入口：推送该分支会针对它自身创建候选 PR 并执行相同权限与验收路径，不向 main 提交或合并更新。

旧候选缺少 `deployment/dsh/discovery.json` 时，发现停止而不猜测归属。维护者可从 Git 历史恢复最后一次机器人写入的候选到该文件；有人工目标差异时继续保留，由 PR 验收验证支持提交。只有决定将当前候选重新交给自动发现管理时，才把经确认的 `candidate.json` 同步为 `discovery.json` 并提交；下一次发现即可采用更新的上游目标。不要为了消除报错而把未经核对的人工修复标为机器人目标。

如果 Actions 报 `GitHub Actions is not permitted to create or approve pull requests`，需要仓库管理员在 Settings → Actions → General → Workflow permissions 开启 `Allow GitHub Actions to create and approve pull requests`。暂时无法开启时，有创建 PR 权限的维护者可把已生成的候选分支手动建为 draft PR，目标分支必须与该次发现一致，再重跑发现工作流；机器人可复用已有 PR 并显式执行验收。这只能证明更新与验收路径，不能替代首次自动创建 PR 的权限验收，也不会自动修复下一轮新基线的创建权限。

## 8. 升级与重置

当前病例架构包含破坏性的 operational database migration，不兼容旧的本地病例与安装数据。升级前停止 Server，重置 `CLINMESH_DATABASE_PATH` 指向的本地 operational SQLite：

```sh
rm -f .data/clinmesh.sqlite .data/clinmesh.sqlite-shm .data/clinmesh.sqlite-wal
pnpm --filter @clinmesh/server db:migrate
```

该操作删除本地 HIS 运行数据。独立的 `.data/clinmesh-reference.sqlite` 不在删除范围内，不需要重新导入；不要把 `CLINMESH_REFERENCE_DATABASE_PATH` 指向 operational database，也不要删除 Reference SQLite。备份与单实例约束的决策依据见 [Demo 部署架构](demo-architecture.md)。
