# PathJX 接入面核验：用作 ClinMesh 病理科阅片系统的可行边界

本文记录把 PathJX 作为本院病理科阅片系统、ClinMesh 作为 HIS 时，两个系统之间实际存在的接口、权限、数据和约束。它是研究记录，不是需求，也不授权实施；已确认的方向（方案 A、不改 PathJX、ClinMesh 不再保存切片、新增病理医生岗位、病理会诊改为结直肠）只作为聚焦范围，不在此重新论证。

## 核验范围

| 项目 | 内容 |
| --- | --- |
| 对象 | PathJX：面向医院病理科的 H&E 切片辅助阅片平台（Go 平台 API、PostgreSQL、Python 执行器与瓦片服务、React 阅片器、Go CLI），仓库归 JinhaoFang 所有 |
| PathJX 核验版本 | `origin/main` = `789f96eae83b4deb893e375e22f4dff290ab1b8b`（2026-11-17 合并 PR #299）。本机 `/home/claude/PathJX-01` 工作区落后远端 39 个提交（`d2a41e9`），不作依据 |
| ClinMesh 核验版本 | `origin/main` = `3beba4d829f4d69c8d3076cb1640529f915e0db6` |
| 核验日期 | 2026-11-19 |
| 方法 | 只读源码、OpenAPI、契约文档、迁移 SQL、README、方案与报告、CLI 命令元数据和技能；没有启动任何服务，没有读取切片像素、瓦片、缩略图或含切片的截图，没有下载数据集，没有访问 GitHub |
| 引用写法 | `PJ:` 表示 PathJX 仓库内路径，`CM:` 表示 ClinMesh 仓库内路径，后接行号；OpenAPI 用 operationId，行号指 `PJ:contracts/openapi/pathjx.yaml` |
| 标注 | 【事实】来自上述一手来源；【推断】由事实推出但没有实际运行验证；【建议】对 ClinMesh 的处理建议；【未决】需要决定或需要 PathJX 回答 |

不在本次范围：PathJX 的模型训练细节、GPU 作业性能、真实运行时的网络与浏览器行为（只读代码，没有在浏览器里验证）。

## 一页结论

1. 接得上，且不必改 PathJX 就能做出第一版。【事实】PathJX 的 REST API（OpenAPI v1，`info.version` 1.0.0）已覆盖登记切片、改病例关联、读分析结果、读复核记录、导出 JSON；病理医生用 PathJX 的网页阅片器看片，ClinMesh 只需要「登记切片、深链打开、轮询取回复核记录、在 ClinMesh 内写报告」。
2. PathJX 没有报告、没有「复核完成」信号、没有回调。【事实】`PJ:docs/clinical-wording.md:13` 明确「本系统不签发报告」；契约里没有 webhook 或事件推送，只能轮询（`PJ:docs/guides/reading-system/03-upload-and-jobs.md:200` 把 SSE 列为潜在优化）。因此「病理医生是否看完」必须由 ClinMesh 自己的流程决定。
3. 一个服务账号做不完所有事，至少要两个 PathJX 身份。【事实】导入服务器目录的切片只有管理员令牌且开启 `administer` 能做；读复核记录、导出、改切片的是 Agent 或医生角色，管理员反而读不了复核（`PJ:apps/platform/internal/authz/policy.go:101,104,112,125`）。Agent 令牌无论如何都不能写复核决定，只能提交待医生采纳的建议。
4. 病理医生必须在 PathJX 里有自己的医生账号，并且单独登录。【事实】没有 OIDC 或单点登录，只有本地账号加会话 Cookie 或 API 令牌（`PJ:contracts/README.md:236-241`）；复核决定要人的浏览器会话或本人亲自开启 `decide` 的令牌。登录后一律跳到 `/worklist`，不会回到深链目标（`PJ:apps/web/src/app.tsx:160-172`）。
5. 深链可行，iframe 条件苛刻。【事实】阅片页是 `/viewer/<slide_id>`；平台本身不设置 `X-Frame-Options` 或 CSP，但会话 Cookie 是 `SameSite=Lax`，跨站 iframe 里发不出去。【推断】只有 ClinMesh 与 PathJX 同站（同一可注册域名，或本机不同端口）iframe 才可能工作，且阅片页里的「返回」会把 iframe 导航到 PathJX 工作列表。【建议】第一版用新标签页打开。
6. 最大的结构性冲突是 Epoch 重置与数据隔离。【事实】PathJX 的复核记录、标注、测量只追加、永不改写，切片删除和永久清除只能管理员在浏览器里做，令牌一律拒绝；同一路径的目录导入只会返回已有记录（`PJ:contracts/README.md:111,124`，`PJ:apps/platform/README.md:32`）。ClinMesh 每个 Epoch 要求互不影响（`CM:docs/architecture/simulation.md:98-106`）。不处理的话，上一个 Epoch 病理医生画的框会出现在下一个 Epoch 里。
7. PathJX 的切片是真实去标识人体切片，不是合成数据，且几乎所有结直肠开发池素材需要先下载 TB 级数据。【事实】HunCRC 全集约 431 GB，PathJX 本机 `data/` 目录里只有一个说明文件；16 张对比切片共 28.8 GB（`PJ:datasets/huncrc/README.md`，`PJ:datasets/huncrc/dataset.toml`）。HunCRC 的 WSI 许可是 CC BY 4.0，要求数据引用与署名。
8. 锁定测试集切片对 ClinMesh 没有用。【事实】锁定切片只能登记，对非管理员完全隐藏，不会分析、不能阅片、不能复核、不能导出（`PJ:apps/platform/internal/authz/policy.go:135`）。ClinMesh 只能使用开发池切片，而 AI 提示模型正是在开发池上训练和交叉验证的，对这些切片的 AI 提示不能当作性能证据。
9. AI 用语有硬性限制。【事实】PathJX 的 AI 结果只能叫「提示」「候选区」「可疑度」，不能叫诊断，凡是可能被读成阴性的地方都要写明「不代表阴性」；结直肠模型只验证过肠镜活检和息肉切除，手术切除标本不能说已验证（`PJ:docs/clinical-wording.md:9-14`，`PJ:docs/reports/first-version-summary.md:119,133-139`）。ClinMesh 的报告模板和界面必须沿用。
10. 取图能力与 ClinMesh「像素不进模型输入」规则冲突，但可以靠不发放能力组避免。【事实】CLI 的取图命令只在令牌开启 `view_images` 时可用，新令牌默认只有 `read` 与 `analyze`（`PJ:apps/platform/README.md:123`，`PJ:contracts/README.md:162`）。ClinMesh 为 PathJX 签发的令牌不开 `view_images`，也不安装图像技能。
11. 需要向 PathJX 提的 Issue 里没有一项是绝对阻塞第一版的，但有两项会决定方案是否体面：Epoch 之间如何清理或隔离切片记录，以及息肉切除的标本类型词项（后者 PathJX 已在待议）。详见「需向 PathJX 提 Issue 的清单」。

## 已知事实核对

| 已知事实 | 核对结果 | 来源 |
| --- | --- | --- |
| Synthea `d9d07a6` 的 colorectal_cancer 模块产生 Biopsy of colon 76164006、Rectal polypectomy 274031008、Partial resection of colon 43075005、Colonoscopy、Polyp of colon、Malignant neoplasm of colon | 全部属实，并有补充：活检只出现在「恶性腺瘤」分支（约 10% 的腺瘤），良性腺瘤只做息肉切除，模块注释说明「所有大腺瘤都按癌处理」；Colonoscopy 为 73761001，Polyp of colon 为 68496003；`Malignant neoplasm of colon` 363406005 是 III 期，I 期是 `Primary malignant neoplasm of colon` 93761005，II 期 109838007，IV 期 94260004；结肠部分切除只出现在确诊癌之后。模块不产生病理报告、也没有组织学分级，所以「肿瘤性程度」必须由 ClinMesh 另行规定 | 取自 Synthea 本机克隆 `/mnt/c/Users/26341/synthea_CNPPK` 中的提交对象 `d9d07a6eef91ee5144293b42ab64224d84d124f8`，文件 `src/main/resources/modules/colorectal_cancer.json`（该克隆当前 HEAD 为 `6824345`，不是 d9d07a6，读取使用 `git show` 指定提交）；转移概率见状态 `Detect_Adenoma`、`Adenoma_Removal`、`Adenoma_Biopsy` |
| PathJX 结直肠模型适用于肠镜活检和息肉切除，三档（非肿瘤性、低级别上皮内瘤变、高级别及以上） | 属实，并有补充：机器可读的标本类型清单写的是 `biopsy` 和 `resection`，因为词表里没有「息肉切除」，息肉切除只能归入 `resection`；真正验证过的范围只写在文字说明里，手术切除标本只作过外部参考 | `PJ:tools/model-packaging/first-models-v1-1/colorectal/manifest.json`（`intended_use`）、`PJ:tools/model-packaging/first-models-v1/README.md:39`、`PJ:docs/reports/first-version-summary.md:119` |
| 锁定测试集切片只能登记不能分析 | 属实。`protection=locked_test` 只能在导入时设置，之后没有接口修改；管理员以外的角色对其读写一律 404 | `PJ:contracts/openapi/pathjx.yaml:2844-2847`、`PJ:apps/platform/internal/authz/policy.go:135`、`PJ:contracts/README.md:232` |
| PathJX 无新建病例接口，切片可 PATCH case_id | 属实。病例只在上传（未给 `case_id`）或导入（每片新建一个）时由平台创建，病例号是 `C` 加六位序号；没有创建、重命名、合并病例的接口，病例显示名没有写入口；`PATCH /api/v1/slides/{slide_id}` 的 `case_id` 可把切片改属已有病例 | `PJ:apps/platform/internal/database/migrations/00002_slides_and_audit.sql:30-35`、`PJ:apps/platform/internal/slides/imports.go:285`、`PJ:apps/platform/README.md:26`、updateSlide（行 732） |
| 同一切片文件可对应多条切片记录，目录导入按路径去重，网页上传不收 MRXS | 属实。内容摘要相同的文件在识别后共用一条切片文件记录，各切片记录的病例和复核历史独立；同一实际路径（解析软链接后）再次导入返回 `already_imported`；上传扩展名只有 `.svs .tif .tiff .ndpi .scn .bif .svslide`，`.mrxs` 只能由管理员目录导入 | `PJ:apps/platform/README.md:24,30-32`、`PJ:apps/platform/internal/slides/imports.go:28`、`PJ:contracts/README.md:245,248` |

## 1. 架构与部署

【事实】运行 PathJX 需要这些进程（`PJ:docs/guides/reading-system/09-runtime-and-observability.md:5-20`）：

| 组成 | 作用 | 依赖 |
| --- | --- | --- |
| PostgreSQL 18.x | 业务数据、作业队列和通知；迁移使用 `uuidv7()`，平台与执行器用两个不同的数据库角色 | 需要自行准备数据库与两个角色（`PJ:apps/platform/README.md:7`） |
| Go 平台 | HTTP API、上传、审计、作业结算、可选托管前端和瓦片代理 | 数据库、`PATHJX_STORAGE_ROOT`、`PATHJX_TILE_KEY`、`PATHJX_TILE_BASE_URL`、可选 `PATHJX_IMPORT_ROOTS` |
| CPU 执行器 | 切片识别、组织检测 | 与平台共享的存储目录和导入根 |
| GPU 队列执行器 | 模型验证与整片、区域分析 | 假编码器可在 CPU 上运行；真实结果需要 CUDA、已固定的 H-optimus-0 权重和单卡锁 |
| 瓦片服务 | 验证短期令牌后按视野读取原片，不连数据库 | 与平台相同的 `PATHJX_TILE_KEY` |
| 前端 | 开发时 Vite，生产由平台用 `PATHJX_WEB_DIST` 托管 | Node、pnpm |

【事实】`make dev` 启动开发栈：临时或开发用 PostgreSQL、平台 8080、瓦片 8081、CPU 与假 GPU 执行器、Vite 5173，默认合成数据与假编码器，管理员账号 `admin`（`PJ:README.md:29`，`PJ:docs/engineering/development.md:30-48`）。`make demo-start` 启动持久化演示：平台托管构建好的前端，同源入口 18180、瓦片 18181，默认加载真实 H-optimus-0 与两个 v1.1 模型包，需要本机模型资产和 GPU，无 GPU 时传 `DEMO_ARGS="--encoder fake"`（`PJ:README.md:32`，`PJ:docs/demo/first-version.md:59-72`）。两者的区别只是：开发栈用 Vite 开发服务器、临时数据、假编码器；演示栈用构建产物、持久数据库与存储、真实编码器。

【事实】假编码器只用于工程验证，登记的真实模型不会被自动换成假模型，缺依赖时明确失败（`PJ:docs/guides/reading-system/09-runtime-and-observability.md:24-28`）。【推断】开发机没有 GPU 时，ClinMesh 联调能看到流程，但看到的 AI 提示没有任何病理含义，界面上必须标明。

【事实】同源要求：前端以 `window.location.origin` 作为 API 地址（`PJ:apps/web/src/app.tsx:41`）；托管模式下 `/api` 和 `/tiles` 与页面同源，瓦片模板使用请求的协议和主机，不信任 `X-Forwarded-*`（`PJ:apps/platform/README.md:16`）。登录和 Cookie 写请求要求请求头 `Origin` 精确命中 `PATHJX_ALLOWED_ORIGINS`，默认空列表即全部拒绝；`PATHJX_SESSION_COOKIE_SECURE` 默认 `true`，纯 HTTP 只在本机开发时关闭（`PJ:apps/platform/README.md:14,178`）。Bearer 令牌请求不检查 Origin（`PJ:contracts/README.md:239`）。

【事实】能否与 ClinMesh 同机运行：默认端口 8080、8081、5173、18180、18181 与 ClinMesh 的 51868、51888、3080（`CM:docs/deployment.md:239-240,463`）没有冲突；PathJX 的基准环境是 Linux 或 WSL，与 ClinMesh 相同（`PJ:docs/engineering/development.md:3`）。【推断】技术上可以同机运行，但要额外装一个 PostgreSQL 18（ClinMesh 用 SQLite），真实模型还要 GPU：PathJX 报告里单卡 RTX 3090 的显存峰值约 10.1 GiB（`PJ:docs/adr/0001-foundation-model.md:43`）。数据保护方面，PathJX 自己写明目前没有备份脚本和恢复演练（`PJ:docs/guides/reading-system/09-runtime-and-observability.md:94-96`）。

【事实】`deploy/` 现状：只有一份预留说明，写明目标是 Linux 单机 Docker Compose 与离线镜像包，当前没有部署包，Docker 不是基础检查依赖（`PJ:deploy/README.md`）。路线图把「部署」列为第二阶段第 4 项（`PJ:docs/roadmap.md`）。主仓暂未指定开源许可证（`PJ:README.md:66`），任何分发、内嵌或复制其代码与 CLI 技能到 ClinMesh 之前需要先确认授权。

## 2. 认证与账号

【事实】角色四种：`doctor`、`department_lead`、`admin`、`agent`（`PJ:contracts/openapi/pathjx.yaml:2016`）。账号只有本地账号：用户名 1–100 个 ASCII 字符，密码 12–1024 字符（Agent 可无密码）；管理员用 `POST /api/v1/users` 建账号，首个管理员用平台命令 `create-admin` 创建，密码从标准输入读入（`PJ:contracts/README.md:236-241`，`PJ:apps/platform/README.md:176`）。

【事实】凭据两种：浏览器会话 Cookie `pathjx_session`（HttpOnly、`SameSite=Lax`、固定 12 小时、不续期），或管理员签发的 Bearer 令牌 `pathjx_` 加随机值（只存 SHA-256、没有到期时间、显式吊销，原文只显示一次）。认证先看 Bearer，无效 Bearer 直接 401，不回落到 Cookie（`PJ:contracts/README.md:238-239`，`PJ:apps/platform/internal/httpapi/server.go:207`）。

【事实】令牌能力组（`Capability` 枚举，`PJ:contracts/openapi/pathjx.yaml:2008`；各角色允许范围见 `PJ:apps/platform/internal/authz/capabilities.go:36-47`）：

| 能力组 | 含义 | 管理员 | 医生/科室负责人 | Agent |
| --- | --- | --- | --- | --- |
| `read` | 读取列表、详情、分析、复核、测量；始终保留 | 是 | 是 | 是 |
| `analyze` | 发起或取消区域分析 | 否 | 是 | 是 |
| `view_images` | 取图：浏览信息、瓦片续期、缩略图 | 否 | 是 | 是（仅令牌） |
| `suggest` | 提交 Agent 复核建议、写意见 | 否 | 否 | 是 |
| `decide` | 确认、否定、修改、补画、已看，采纳或驳回建议 | 否 | 是（只能本人在浏览器开启） | 否 |
| `comment` | 人写复核意见 | 否 | 是 | 否 |
| `measure` | 长度、面积测量 | 否 | 是 | 是 |
| `export` | 导出 JSON 与 GeoJSON | 否 | 是 | 是 |
| `manage_slides` | 上传、编辑切片（含改属病例） | 否 | 是 | 是 |
| `administer` | 账号、令牌、导入根、分析任务、模型登记 | 是 | 否 | 否 |
| `data`、`train` | 第二阶段预留，不能开启 | 否 | 否 | 否 |

新令牌默认只有角色允许范围与 `read`、`analyze` 的交集，管理员令牌默认只有 `read`；开启其他能力要由管理员在浏览器里完成，`decide` 只能由令牌所属本人亲自在浏览器里开启，管理员也不能替别人开启（`PJ:apps/platform/README.md:123-125`，`PJ:contracts/README.md:161-162`）。

【事实】谁能建账号和令牌：只有管理员（`user.create`、`api_token.create` 要 `administer`）；本人浏览器可浏览、吊销、收窄自己的令牌。OIDC 或医院统一认证：没有实现，方案文档称「接口按 OIDC 兼容设计，进院时接入」，路线图和第九章把 OIDC/LDAP 列为后续扩展（`PJ:docs/AI 辅助病理阅片系统 MVP 方案.md:389,407`，`PJ:docs/guides/reading-system/09-runtime-and-observability.md:107`）。仓库中没有任何 OIDC、LDAP、SSO 或可信请求头的实现代码。

ClinMesh 后台作为服务账号能做的事（【事实】依据授权动作表 `PJ:contracts/README.md:197-230` 和策略表 `PJ:apps/platform/internal/authz/policy.go:86-133`）：

| 操作 | 管理员令牌（需 `administer`） | Agent 令牌 | 必须浏览器或人 |
| --- | --- | --- | --- |
| 导入服务器目录切片（`createImport`）、列导入根 | 能 | 不能 | |
| 上传单文件切片（`createUpload` 加 tus） | 不能 | 能（`manage_slides`） | |
| 改病例关联、显示名、器官、标本类型（`updateSlide`） | 不能 | 能（`manage_slides`） | |
| 列切片、读切片、读分析 | 能 | 能 | |
| 读复核动作、标注、候选区复核、测量（`review.read`、`measurement.read`） | 不能（403） | 能 | |
| 导出 JSON/GeoJSON（`slide.export`） | 不能 | 能（`export`） | |
| 读缩略图、取阅片浏览信息与瓦片 | 不能 | 能但需 `view_images`，应不发放 | 人用浏览器 |
| 写复核决定（确认、否定、修改、补画、已看） | 不能 | 不能（返回 `agent_must_suggest`） | 病理医生本人浏览器，或本人亲自开启 `decide` 的令牌 |
| 提交 Agent 建议 | 不能 | 能（`suggest`） | 采纳或驳回需医生 |
| 建账号、签发和调整令牌 | 能 | 不能 | 开启令牌能力组须管理员浏览器 |
| 启用或停用模型版本 | 不能 | 不能 | 仅科室负责人浏览器，须填原因 |
| 切片软删除、恢复、永久清除、已删除列表、回收队列 | 不能（令牌一律拒绝） | 不能 | 管理员浏览器；医生和科室负责人只能删自己创建的切片，同样要浏览器 |

【推断】ClinMesh 后台至少需要两个 PathJX 身份：一个管理员账号加其令牌（负责建账号、导入切片，其令牌的 `administer` 必须由管理员先在浏览器里开启一次），一个 Agent 账号加令牌（`manage_slides`、`read`、`export`，改病例关联与读复核）。每位病理医生需要各自的医生账号，由 ClinMesh 用管理员令牌创建，密码 12 字符起；PathJX 与 ClinMesh 各登一次。

## 3. 数据模型

【事实】病例是怎么产生的：`cases` 表只有 id、`code`（`C` 加六位序号，如 `C000001`）、`display_name`（可空）、创建时间；病例由平台在创建上传（请求没带 `case_id`）或目录导入（每个文件各建一个新病例）时自动创建，病例号和病例显示名都不能由调用方指定或修改（`PJ:apps/platform/internal/database/migrations/00002_slides_and_audit.sql:30-35`，`PJ:apps/platform/internal/slides/imports.go:285`，`PJ:apps/platform/README.md:26`）。病例没有独立读取接口，只在切片响应的 `case {id, code, display_name}` 中出现；`GET /api/v1/slides` 可按 `case_id` 过滤，`q` 按显示名或病例号子串搜索（`PJ:contracts/openapi/pathjx.yaml:476-568`）。要把多张切片归入一个病例，做法是先导入，再把其余切片 `PATCH case_id` 到第一张切片的 `case.id`。

【事实】切片记录（`slides`）与切片文件记录（`slide_files`）分开：切片记录保存病例、显示名（1–200 字符）、原始文件名（不可改）、器官、标本类型、`data_source{dataset, external_id}`、`protection`、状态、创建人；切片文件记录按内容摘要去重，保存尺寸、层级、两轴 μm/px、组织检测状态（`PJ:contracts/openapi/pathjx.yaml:2944-3168`，`PJ:docs/guides/reading-system/02-domain-and-storage.md:5-33`）。切片状态：`uploading`、`stored`、`identifying`、`viewable`、`unsupported`、`failed`、`source_changed`（原位文件被改动时）。

【事实】词表：器官 `thyroid`、`colorectum`、`stomach`、`other`；标本类型 `biopsy`、`resection`、`esd`、`unknown`（`PJ:apps/platform/internal/database/migrations/00002_slides_and_audit.sql:21-30`）。没有「息肉切除」或「内镜切除」词项；这是已登记的待议契约请求（`PJ:contracts/README.md:295`）。

【事实】导入根：`PATHJX_IMPORT_ROOTS` 是「根名 → 绝对目录」的 JSON，未配置时没有导入根；API 只返回根名；导入时路径解析软链接并拒绝越界；按原位置登记，不复制或修改源文件；一次最多 1000 个文件；识别 `.svs .tif .tiff .ndpi .scn .bif .svslide .mrxs`，MRXS 同名组件目录自动归并；每片保存组成文件的大小和修改时间，之后不匹配则变为 `source_changed`（`PJ:apps/platform/README.md:30-32`）。`ImportCreate` 的 `data_source_dataset` 设置每张切片的 `data_source.dataset`，`external_id` 取文件名去扩展名；`protection` 可设 `locked_test`（`PJ:contracts/openapi/pathjx.yaml:2797-2819`，`PJ:apps/platform/internal/slides/imports.go:288-293`）。导入 API 要求服务器本机路径，这意味着切片文件必须先落在运行 PathJX 的机器上。

【事实】删除、恢复、清除（近期 spec #281，合并于 PR #289，契约记录为 #283 与 #284）：软删除切片后，业务读取全部隐藏（`visible_slides` 统一入口），文件不动；恢复只由管理员浏览器完成；永久清除要求已删除、非锁定、已过瓦片令牌等待期（默认 1800 秒）、没有进行中的作业，并输入精确的显示名确认，成功后删除复核、标注、测量、分析、上传和切片，但病例、模型、账号和审计保留；被引用的托管文件进入持久回收队列，导入的原文件绝不回收；清除后重新导入同一内容会得到新的切片编号（`PJ:apps/platform/README.md:64-84`，`PJ:contracts/README.md:104-137`）。所有令牌（含有 `administer` 的管理员令牌）调用这些接口一律返回 `browser_session_required`（`PJ:contracts/README.md:124`）。spec #281 本身的正文在 GitHub 上，本次没有读取，上述内容取自合并后的契约与平台 README。

【事实】保护级别：`standard` 与 `locked_test`。锁定切片对非管理员是 404，对管理员也不能改、不能分析、不能阅片、不能复核、不能导出；不做组织检测（`PJ:contracts/README.md:232`，`PJ:apps/platform/internal/authz/policy.go:135`）。保护级别没有修改接口（`SlideUpdate` 只有 `case_id`、`display_name`、`organ`、`specimen_type`，`PJ:contracts/openapi/pathjx.yaml:3286-3302`）。

## 4. 分析

【事实】导入或上传完成后的自动链路：识别作业（CPU）→ 切片可浏览 → 对可分析且非锁定的切片排组织检测 → 组织检测成功后，对每个器官匹配、且已有启用模型版本的分析任务自动排整片分析，系统身份、优先级 200；模型版本启用时，会为缺少该版本整片分析的切片补排（优先级 100）；区域分析由人或 Agent 提交，优先级 300 或 150（`PJ:apps/platform/README.md:34,42`）。没有人触发也会自动分析，但前提是科室负责人已在浏览器里启用了对应模型版本；没有启用版本时切片可浏览，工作列表显示「未分析」（`PJ:docs/clinical-wording.md:93`）。

【事实】结直肠任务编码 `colorectal_grades`，当前模型 `colorectal-v1.1-filtered`，类别 `non_neoplastic`、`low_grade`、`high_grade_plus`，标签字典 `colorectal_labels` 版本 1（`PJ:tools/model-packaging/first-models-v1-1/colorectal/manifest.json`，`PJ:tools/model-packaging/first-models-v1/README.md:32-36`）。

【事实】`not_applicable` 的条件，按平台视图的判定顺序（`PJ:apps/platform/internal/database/migrations/00014_analysis_visibility.sql:22-30`）：切片器官不在模型清单的 `organs`（`organ_not_applicable`）；标本类型不是 `unknown` 且不在清单的 `specimen_types`（`specimen_type_not_applicable`）；识别阶段判定的 `readiness_reason`（`missing_physical_scale` 或 `insufficient_resolution`）；任一轴 μm/px 缺失（`missing_physical_scale`）；较粗的一轴大于清单 `coarsest_mpp`（结直肠为 0.5）的 1.02 倍（`insufficient_resolution`）。HunCRC 的 0.1213 μm/px 满足；PathJX 清单的 `specimen_types` 为 `biopsy` 与 `resection`。【推断】标本类型为 `unknown` 时 PathJX 不会判定不适用，因此息肉切除切片若登记成 `unknown`，会被分析且界面不会警示标本类型；登记成 `resection` 则会被分析并显示适用范围说明里「手术切除标本只作外部参考」的文字。两种登记都不会阻止对肠切除标本给出 AI 提示，必须由 ClinMesh 在病例分配阶段控制哪些标本配片。

【事实】分析结果对象：`Analysis`（状态 `queued/running/succeeded/failed/cancelled/not_applicable`、`reason`、`failure`、`attempts`、`result`）；成功后的 `AnalysisResult` 含 `slide_score{score, value, k}`、`candidates[]`（`index`、`class_code`、`geometry`、`peak_level0`、`patch_count`、`area_level0_px2`、`area_mm2`、`max_score`、`mean_score`、`grade{score,value,k,threshold}`）、网格、热图描述和模型来源；热图 PNG 另有接口（`PJ:contracts/openapi/pathjx.yaml:4193-4394`）。候选区是图块级的近似范围，约 112 μm 图块；区域分析的 `slide_score` 为空（`PJ:contracts/README.md:23,266`）。切片响应里的 `tasks[]` 用 `current_analysis_id` 指向当前整片结果，`from_previous_version` 表示显示的是上一个模型版本的结果。

【事实】模型能力边界（PathJX 第一版说明，所有数字参考标准是数据发布方标注，未经 PathJX 团队病理复核）：HunCRC 锁定集 46 名患者上结直肠第一版全部及格；已知盲区是锯齿状病变、炎症再生性改变、电灼伪影；档位只作参考（`PJ:docs/reports/first-version-summary.md:119`）。

## 5. 复核与取回

【事实】PathJX 里「复核」有这些对象（`PJ:contracts/openapi/pathjx.yaml:4620-5115`）：

| 对象 | 内容 | 谁能写 |
| --- | --- | --- |
| 复核动作 `ReviewAction`（七种 `kind`） | `viewed`（`candidate_ids`、`display_downsample`、`dwell_ms`，只记录看过，不是确认）、`confirm`、`reject`、`modify`（轮廓加类别）、`draw`（补画）、`comment`（`text`，可挂候选区或整片）、`void`（作废本人记录，必填 `reason`）；每条带 `id`、`slide_id`、`task_id`、`analysis_id`、`model_version_id`、`candidate_id`、`actor{id, role}`、`created_at` | 医生或科室负责人（`decide` 或 `comment`） |
| 标注 `Annotation` | 确认、否定、修改、补画产生，含 `class_code`、`polarity`、`source`（`confirmed_ai` 等）、`geometry`、面积、`supersedes_annotation_id`、`actor`；只追加 | 同上 |
| 候选区复核 `CandidateReview` | 每个候选区的稳定 UUID、`candidate_index`、`current_action`（最近一条未作废的确认、否定或修改）、`viewed`、`viewed_by_me`、`negative_overlap_annotation_ids` | 派生，只读 |
| 测量 `Measurement` | 长度或面积，含像素量和物理量，可作废 | `measure` |
| Agent 建议 | 待医生采纳；采纳后才生成标注 | Agent 提交，医生采纳 |

【事实】复核进度：切片响应里每个任务可带 `review_progress{candidate_count, candidate_counts_by_class, viewed_count, processed_count, has_comments}`，只对有 `review.read` 的调用方返回（`PJ:contracts/openapi/pathjx.yaml:3054-3075`）。没有「整片复核完成」或「病理医生签字」动作，也没有整片结论字段；`has_comments` 只说明有人写了意见。

【事实】ClinMesh 能取回病理医生做了什么的接口（均 Agent 或医生令牌可用，管理员不行）：

| 接口 | operationId | 用途与注意 |
| --- | --- | --- |
| `GET /api/v1/slides/{slide_id}/review-actions` | listReviewActions（行 1448） | 全部动作，按 UUIDv7 倒序分页（`limit` 1–200、`cursor`），含作废项；没有 `since` 或按人过滤参数，增量只能靠记住最新 id 往回翻 |
| `GET /api/v1/slides/{slide_id}/annotations` | listAnnotations（行 1477） | 标注历史，含 `voided`、`excluded_from_training` |
| `GET /api/v1/analyses/{analysis_id}/candidate-reviews` | listCandidateReviews（行 1506） | 候选区当前状态；`viewed_by_me` 对 Agent 令牌是「Agent 自己」，不能代表病理医生，要看动作里的 `actor` |
| `GET /api/v1/slides/{slide_id}/measurements` | listMeasurements（行 1823） | 测量与作废 |
| `GET /api/v1/slides/{slide_id}/exports/json` | exportSlideJson（行 1884） | `SlideExport`：切片、任务、模型版本（含适用范围说明）、全部分析及结果、候选区与复核、标注、测量、复核动作、可选 Agent 建议、`exported_at`、`exported_by`；一个可重复读快照，不受分页截断 |
| `GET /api/v1/slides/{slide_id}/exports/geojson` | exportSlideGeoJson（行 1908） | level 0 像素坐标的 FeatureCollection（候选区、标注、测量），顶层 `properties.coordinate_system=level_0_pixels` |
| `GET /api/v1/slides?task_code=…` | listSlides（行 476） | 用任务状态里的 `review_progress` 在列表层面批量看进度 |

【事实】坐标全部是 level 0 像素，原点在左上角；μm/px 任一轴缺失时物理面积为 null（`PJ:contracts/README.md:20-23`）。时间是 UTC，`Z` 结尾。

【事实】事件、回调、webhook：没有。OpenAPI 的 operationId 清单里没有订阅或推送接口，仓库搜索 webhook、EventSource、WebSocket 只命中无关文件；内部的 `LISTEN/NOTIFY` 只用于作业完成通知，不对外（`PJ:apps/platform/internal/jobqueue/settler.go:179`）。前端自己也是轮询（阅片页每 5 秒刷新复核，`PJ:apps/web/README.md`）。审计日志不提供读取接口。【推断】ClinMesh 只能轮询，且只需要轮询「有未完成病理会诊申请且已打开阅片的切片」，数量很小；可用 `review-actions` 取最新页比较最新 id，再按需取导出快照。没有「完成」信号，因此由 ClinMesh 的病理医生在 ClinMesh 内点击「开始写报告」或「签发」作为流程边界。

## 6. 阅片器入口

【事实】`apps/web` 的路由（`PJ:apps/web/src/app.tsx:239-266`）：`/`（按是否已登录跳 `/worklist` 或 `/login`）、`/login`、`/worklist`、`/upload`、`/models`、`/tokens`、`/viewer/$slideId`、`/print/$slideId`、`/deleted-slides`，以及无需登录的设计参考页 `/design*`。

【事实】深链：`https://<PathJX 同源>/viewer/<slide_id>`。可选查询参数 `task`、`status`、`review`、`specimen`、`uploaded`、`q`、`suggestions`（来自工作列表，决定返回地址和前后切片顺序）以及 `viewTask`（分析任务编码）、`analysis`（指定一次历史或区域分析）、`lang`、`theme`（`PJ:apps/web/src/app.tsx:255`，`PJ:apps/web/README.md`）。只有医生和科室负责人能打开阅片页；管理员被重定向到 `/worklist?denied`，Agent 账号登录后会被立即登出（`PJ:apps/web/src/app.tsx:116-120,191`）。

【事实】登录行为：未登录或会话过期时，任何请求得到 401，前端清空缓存并跳到 `/login?reason=expired`；登录成功后一律导航到 `/worklist`，不会回到原来的深链（`PJ:apps/web/src/app.tsx:46-53,160-172`）。【推断】病理医生先登录 PathJX 一次后，ClinMesh 的深链才能直达；会话 12 小时不续期，过期后第一次点击会落到 PathJX 工作列表。

【事实】阅片页里的「返回」按钮执行 `window.location.assign('/worklist?…')`（`PJ:apps/web/src/app.tsx:194`）。工作列表对医生角色展示 PathJX 中所有可见切片，不按病例限制（`PJ:contracts/README.md:209`）。

【事实】iframe 与 Cookie：平台代码里没有设置 `X-Frame-Options`、`Content-Security-Policy` 或 `frame-ancestors` 的位置（对 `apps/platform` 和 `python/tiles` 的响应头设置逐一核对，只发现上传、问题响应、缓存相关头）；会话 Cookie 是 `SameSite=Lax`，`Secure` 默认开（`PJ:apps/platform/internal/httpapi/server.go:207`）；瓦片服务只有按 `Origin` 的 CORS 白名单。【推断】PathJX 自身不阻止被嵌入，但是：跨站 iframe 里 Lax Cookie 不会发送，阅片页全部请求 401；只有 ClinMesh 与 PathJX 同站才行（同一可注册域名下的不同子域，或本机 `localhost` 不同端口），而且 `127.0.0.1` 与 `localhost` 算不同站；进入 iframe 后「返回」会把框架导航到 PathJX 工作列表，病理医生能浏览不属于本病例的切片。ClinMesh 前面的反向代理、Tailscale 等是否追加这些头不在本次范围。【建议】第一版用新标签页深链打开，不使用 iframe。

## 7. CLI 与技能

【事实】CLI `pathjx`，版本 0.5.0，输出 schema 版本 1.4.0，平台 API 主版本 1（`PJ:apps/cli/cli/app.go:16-19`）。配置只靠 `PATHJX_URL`、`PATHJX_TOKEN` 或 `PATHJX_TOKEN_FILE`，不接受令牌命令行参数。默认输出一个 JSON 文档，失败时 stderr 输出 JSON 错误；退出码 0、1（平台拒绝）、2（输入）、3（凭据）、4（网络或写结果未知 `submission_unknown`）、5（超时）、130（中断）（`PJ:apps/cli/README.md:29-75`）。

命令清单（`PJ:apps/cli/README.md:29-221`）：`identity`、`catalog labels|tasks|models`、`upload`（tus 续传，`--wait tissue`）、`slide show|edit`（含 `--case-id`）、`worklist`、`wait`、`slides image`（取区域图，需 `view_images`）、`analyses list|submit|show|wait|cancel`、`candidates`、`reviews create|list`、`annotations`、`measurements add|list|void`、`export --format json|geojson --file`、`suggestions submit|list|get|withdraw|adopt|reject`、`admin imports roots|run|wait`、`admin tasks register`、`admin models register|wait|history`、`admin users create|list|update|names`、`admin tokens create|list|capabilities|revoke`、`skills list|read|install`、`schema`、`version`。所有写命令支持离线 `--dry-run`。CLI 不提供病例创建、模型启停、切片删除和永久清除。

【事实】随 CLI 分发 11 个技能（一个底座和十个能力技能，嵌入二进制；`PJ:apps/cli/skills/pathjx-*/SKILL.md`）：

| 技能 | 能力组 | 内容 |
| --- | --- | --- |
| `pathjx-core` | 无 | 先 `identity`，处理错误、等待恢复和坐标 |
| `pathjx-read` | `read` | 读工作列表、切片、分析、候选区、标注与历史 |
| `pathjx-slides` | `manage_slides` | 上传、等待识别、改切片元数据 |
| `pathjx-analyze` | `analyze` | 区域分析、等待、取消 |
| `pathjx-images` | `view_images` | 按候选区或 level 0 区域取图，可叠加轮廓 |
| `pathjx-comment` | `comment` | 人写意见、作废自己的意见 |
| `pathjx-suggest` | `suggest` | Agent 提交或撤回建议、写意见 |
| `pathjx-decide` | `decide` | 人记录复核决定、采纳或驳回建议 |
| `pathjx-measure` | `measure` | 保存测量 |
| `pathjx-export` | `export` | 导出 JSON 或 GeoJSON |
| `pathjx-administer` | `administer` | 导入、登记任务与模型、管理账号令牌 |

`skills install` 先查询真实身份，只安装当前身份允许的技能和底座；`--all` 是无需凭据的全量分发（`PJ:apps/cli/README.md:222-243`）。

【事实】取图能力：`pathjx slides image` 把平台瓦片拼成最大 4096×4096 的 JPEG 文件，只取瓦片，永不提供标签图和宏观图；`pathjx-images` 技能自己写明「向外部大模型或其他服务发送图像需要独立的用户授权，院内试用应按部署约定关闭取图或使用本地大模型」。与 ClinMesh 的冲突见「合同冲突清单」第 3 项；缓解措施是 PathJX 令牌不开 `view_images`，关闭后已签发的瓦片令牌最长 30 分钟才失效（`PJ:contracts/README.md:166`）。

## 8. 数据集与许可

【事实】本机 `/home/claude/PathJX-01/data` 下只有说明文件 `README.md`（3,559 字节），没有任何切片文件、特征或模型。在 `/home/claude` 下搜索切片扩展名的命令因耗时超过 60 秒被终止，没有得到完整结果；`/mnt/d` 是 Windows 盘，没有逐项核对。结论只限于「PathJX 工作区的 `data/` 是空的」。PathJX 自己说明该目录在 2026-11-06 清理后只保留演示与验收所需切片，且在另一台机器（算法线 `/root/project/PathJX-01`，D 盘 `D:\PathJX-*`）上（`PJ:data/README.md`，`PJ:docs/demo/first-version.md:9`）。

| 数据集 | 内容与格式 | 许可原文与署名 | 在 PathJX 中的角色 | 对 ClinMesh 的用处 |
| --- | --- | --- | --- | --- |
| HunCRC（TCIA 的 Hungarian Colorectal Screening，package 741） | 200 名患者各一张 WSI，3DHistech Pannoramic 1000 的 MRXS 多文件格式，40×，约 0.1213 μm/px；单片组成文件 0.5–5.1 GB，16 张对比片合计 28.8 GB，全集约 431 GB；活检与息肉切除两种标本；类别 adenoma、CRC、non_neoplastic_lesion、negative | TCIA 的 WSI、patch、临床 CSV 标 CC BY 4.0，须给出完整数据引用和 DOI；Figshare 的全局 CSV、临床 CSV、掩膜标 CC0。数据引用：Pataki, B., et al. (2021). Digital pathological slides from Hungarian (Europe) colorectal cancer screening (Version 3) [dataset]. The Cancer Imaging Archive. https://doi.org/10.7937/tcia.9cjf-0127 ；论文：Pataki, B. Á. et al. Scientific Data 9, 370 (2022), https://doi.org/10.1038/s41597-022-01450-y | 154 张开发池（5 折交叉验证）加 46 张锁定测试集；PathJX 模型在开发池上训练 | 唯一合适的结直肠 WSI 来源；开发池可供病理医生阅片，锁定集不可用 |
| EBHI（figshare 16999363 v1） | 内镜活检的显微镜相机图像，2048×1536 JPG，200× | CC BY 4.0 | 外部参考探针，只用图像 | 不是 WSI，PathJX 不能导入（支持的扩展名不含 JPG/PNG），不适用 |
| UniToPatho（IEEE DataPort） | 结肠息肉与腺瘤 800 DPI（0.44 μm/px）ROI 图块，PNG | CC BY 4.0（DataPort JSON-LD 的 license 字段）；作者代码仓库的 MIT 不是数据许可 | 外部探针，仅开发证据 | 同上，不适用 |
| CRC-VAL-HE-7K | 7,180 张 224×224 图块，0.5 μm/px | CC BY 4.0 | 外部探针与背景训练补充 | 同上，不适用 |
| PRET 的 CRC 队列（4 张 SVS 演示片，外部参考） | 结直肠整片外部参考（SVS） | 数据卡同时有 Apache-2.0 元数据和非商业用途声明；PathJX 项目负责人「已为本项目取得授权」 | 外部参考，不是开发池 | 授权只覆盖 PathJX 项目，不能转给 ClinMesh；不建议使用 |

出处：`PJ:datasets/README.md`、`PJ:datasets/huncrc/`、`PJ:docs/research/data-model-validation/20261021-huncrc/primary-sources.md:53-67`、`PJ:docs/research/data-model-validation/20261021-public-datasets/colorectal.md`、`PJ:datasets/ebhi/README.md`、`PJ:datasets/unitopatho/README.md`、`PJ:datasets/pret/dataset.toml:7`。PathJX 路线图把「许可不约束数据选用」当作 MVP 不商用的决定（`PJ:docs/roadmap.md` 已定表「许可」行），这是 PathJX 自己的口径，不能代替 ClinMesh 对署名与再分发的核对。

【事实】HunCRC 划分清单 `PJ:datasets/huncrc/splits/v1/manifest.csv` 含逐片 `slide_id`、`purpose`、`specimen_type`（`Biopsy`/`Polyp`）、`polyp_type`、`label`、`neoplastic`、`high_grade`。开发池 154 张：活检腺瘤 43、息肉腺瘤 37、活检癌 35、活检非肿瘤性病变 20、息肉非肿瘤性 9、活检阴性 8、息肉阴性 1、息肉癌 1；锁定集 46 张。清单是元数据，本次只统计了列数，没有打开任何影像。这些标签是数据发布方的标注，PathJX 自己也声明未经团队病理复核（`PJ:docs/reports/first-version-summary.md:26,120`）。

【事实】HunCRC 的开发池不是「模型没见过的切片」：基础模型选型、交叉验证和任务头训练都用它（`PJ:docs/adr/0001-foundation-model.md:22`，`PJ:docs/reports/first-version-summary.md:24`）。【推断】PathJX 在这些切片上的 AI 提示是样本内结果，ClinMesh 不能把它当作 AI 能力的演示或证明。

【事实】基础模型 H-optimus-0 在 PathJX 的选型快照里是 Hugging Face 门控模型（`gated=auto`），模型卡标 Apache-2.0（`PJ:docs/research/data-model-validation/20261021-foundation-models/models.md:10`）；本次没有访问 Hugging Face，以此快照为准。

## 9. 用语约束

【事实】PathJX 的用语规则分两处：界面措辞表 `PJ:docs/clinical-wording.md`（2026-10-24 用户审定），和第一版说明的「能说和不能说」与对外用语表（`PJ:docs/reports/first-version-summary.md:124-150`）。ClinMesh 的报告和界面要遵守的部分：

| 规则 | 要求 | 来源 |
| --- | --- | --- |
| AI 输出的性质 | 是「请先看这里」的提示，不是诊断；不用「检测出」「诊断」「阳性」「阴性预测」描述 AI 结果 | `PJ:docs/clinical-wording.md:9` |
| 可能被读成阴性的地方 | 无候选区、未分析、只做局部分析、候选已看完，都要写明不代表阴性或没有病变 | `PJ:docs/clinical-wording.md:10,27,30-31,57-58,100` |
| 已看 | 只是记录看过，不等于确认；确认、否定、修改才是医生的判断 | `PJ:docs/clinical-wording.md:11,54` |
| Agent | 只能提交建议，医生采纳后才成为标注 | `PJ:docs/clinical-wording.md:12,71` |
| 报告 | 本系统不签发报告；打印摘要叫「阅片记录摘要」，不叫报告 | `PJ:docs/clinical-wording.md:13,100-102` |
| 标签 | 可疑度列名保留 AI 前缀，写作「AI 可疑度」；徽标写「AI 提示 · 不是诊断」；候选区叫「AI 候选区」 | `PJ:docs/clinical-wording.md:25,49-50` |
| 失败或不适用 | 写「没有 AI 提示，请按常规阅片」，不得猜测原因；原因文字使用表中审定措辞 | `PJ:docs/clinical-wording.md:35-43,61-62,106-123` |
| 能说的 | 考试规则先于成绩写定；列出的及格数字；标明使用次数与参考标准 | `PJ:docs/reports/first-version-summary.md:124-131` |
| 不能说的 | AI 能诊断或能判断整片阴性；只说准确率百分比而不说明样本量、参考标准和证据级别；把锁定集称跨中心或跨扫描仪验证；结直肠已验证用于手术切除标本；能用于冰冻切片和细胞学；能分辨良性结节、能发现微小癌 | `PJ:docs/reports/first-version-summary.md:133-139` |
| 对外说法 | 使用「跨院适配」，不用「本院校准」「本院适配」（只对甲状腺模型版本名有约束，PathJX 自己用检查脚本把关） | `PJ:docs/reports/first-version-summary.md:143-150` |
| 结直肠档位 | 低级别与高级别的区分存在医生间差异，档位只作参考；类别对应和阈值待病理复核 | PathJX 模型清单适用范围说明（`intended_use.statement`） |

【推断】对 ClinMesh 的具体含义：病理医生报告的诊断文字必须由病理医生自己写，不由 AI 提示预填；报告里若引用 PathJX 的 AI 信息，只能写「AI 提示的候选区，供阅片参考」并附模型版本和适用范围说明，不得写成所见或诊断；没有候选区的切片不得写「未见异常」之类结论性语句；ClinMesh 的界面如显示 PathJX 状态，沿用上述措辞，不自造「AI 诊断」「AI 阳性」。

## 10. 与 ClinMesh 合同的冲突清单

对照 `CM:AGENTS.md`（origin/main）、`CM:docs/architecture/simulation.md`、`CM:docs/architecture/clinical-workflows.md` 的「病理会诊」一节与 `CM:CONTEXT.md`。

| # | ClinMesh 合同 | 冲突 | 影响 | 可选处理 |
| --- | --- | --- | --- | --- |
| 1 | 「影像素材例外」：只允许 `imaging-assets/` 与 `pathology-assets/` 登记的公开授权去标识像素，像素不进 Git、日志、模型输入或 SQLite（`CM:AGENTS.md:51`）；`Slide Asset` 与 `Pathology Consultation` 词条绑定乳腺 TCGA-BRCA（`CM:CONTEXT.md:119-125`） | 切片改由 PathJX 保存后，ClinMesh 自己不再持有像素，例外中「病理素材清单」变成无对象；但病理像素仍会出现在 ClinMesh 开发与验收产物里：深链打开的 PathJX 阅片页、截图、PR 录屏 | 例外条款的适用对象要改写；演示、截图和录屏仍须保留 HunCRC 的数据引用与许可；Agent 开发和验证不得读取含切片的截图，PathJX 页面的浏览器验证只能用文字快照 | A. 例外条款改为只保留放射素材，病理像素由 PathJX 持有并在 ClinMesh 文档中登记来源与署名；B. ClinMesh 对 PathJX 的浏览器验收不进入阅片页，只验证到深链地址生成与新标签页打开 |
| 2 | 「所有演示数据必须是合成数据」，唯一例外是公开授权、已去标识的影像像素，且必须在清单登记（`CM:AGENTS.md:51`） | HunCRC 是真实匈牙利筛查人群的去标识 WSI；患者、病史、就诊仍是 Synthea 合成的，切片与合成病例之间没有真实对应关系 | 例外要明确覆盖「通过外部系统展示的去标识真实切片」，并说明 PathJX 的切片与 ClinMesh 的合成患者之间的绑定是人为构造的 | 在 ClinMesh 的病理素材文档里登记来源 DOI、许可、署名和用途边界；绑定规则只写在管理员可见的位置 |
| 3 | 像素不进模型输入、Agent 不看切片；Agent 工具使用窄 schema，不提供任意 URL、SQL、Bundle（`CM:AGENTS.md:49,51`；`CM:docs/architecture/agent-integration.md:60`） | PathJX CLI 的 `slides image` 和 `pathjx-images` 技能可把切片像素导出成 JPEG 交给任何调用方；PathJX 的 `slide.view` 对 Agent 令牌开放 | 若 ClinMesh 的 Agent 或 DSH 运行环境持有开启 `view_images` 的 PathJX 令牌，像素就可能进入模型输入 | ClinMesh 签发给 PathJX 的令牌不开 `view_images`，不安装 `pathjx-images` 技能；ClinMesh 的 Agent 工具不直接封装 PathJX CLI，只通过 ClinMesh 自己的窄 schema 工具访问病理会诊状态和报告 |
| 4 | 私有边界：病例与素材的绑定、匹配依据、素材标识和来源 UID 只在管理员接口可见，医生、Agent 的 DTO、CLI 输出、FHIR 资源和患者模型载荷都不包含它们（`CM:docs/architecture/simulation.md:123`） | PathJX 是病理医生看到的界面：显示名、原始文件名（不可改）、病例号 `C000…`、器官、标本类型都会显示；PathJX 的 `slide_id`、复核记录 id 与 FHIR 资源之间的引用关系如果写入 ClinMesh 的 FHIR（如 Provenance、Specimen）就会泄漏；HunCRC 原始文件名（如 `023.mrxs`）和数据划分里的 label 若被带进界面会泄漏答案 | 切片编号、文件名、病例号都是私有信息；病理医生是在 ClinMesh 内被授权的岗位，但 PathJX 里的切片记录对所有 PathJX 医生都可见，不受 ClinMesh Workspace 授权约束 | 在 import 根下用中性文件名（硬链接或复制到不含数据集信息的路径）；显示名用 ClinMesh 的病理申请号；PathJX 标识只存在 ClinMesh 的私有表，FHIR 里只放 ClinMesh 自己的标识 |
| 5 | Epoch 重置：新 Epoch 以全新运行事实开始，旧 Epoch 的结果不能影响新 Epoch；没有 purge 入口；每个读取都校验 Workspace/Epoch、责任医生或完诊读取权限（`CM:docs/architecture/simulation.md:98-106,125`） | PathJX 没有 Workspace 或 Epoch 概念；复核记录、标注、测量只追加且永不改写；删除、恢复、永久清除只能管理员在浏览器里做；同一路径重复导入得到的是同一条切片记录，而该切片上的历史复核对所有医生可见；PathJX 阅片页的授权是「角色加对象可见性」，不是病例责任 | 同一张切片在第二个 Epoch 里被打开时，会带着前一个 Epoch 病理医生的确认、否定、补画和意见；ClinMesh 在 PathJX 里无法按 Epoch 限制谁能看哪张切片 | A. 每次使用为同一张文件建立独立的切片记录：目录导入按路径去重，所以在导入根下为每次使用建一个新的硬链接路径（MRXS 需同时建立同名组件目录），PathJX 会识别为同一份文件并共用文件记录，但切片记录与复核历史独立（【推断】基于 `PJ:apps/platform/README.md:32` 的「不同路径内容相同，各自的病例和元数据独立」；没有实际运行验证）；B. ClinMesh 只读取申请开立时间之后、且 `actor` 是该病理医生的复核动作，其余忽略（PathJX 界面上旧标记仍可见）；C. 每次重置由管理员在浏览器里批量软删除并永久清除（人工、有等待期）；D. 向 PathJX 提 Issue，见清单第 1 项 |
| 6 | 病理会诊报告由「本院病理科受控系统执行者」经 outbox 受理、开始、报告，一个短事务内创建 Specimen、ImagingStudy（SM）、DiagnosticReport 与 Provenance，收片与签发时间取 Virtual Time（`CM:docs/architecture/clinical-workflows.md:679-689`；`CM:CONTEXT.md:27`） | PathJX 的时间是真实时间（`created_at` 为 UTC 实际时间）；它没有报告对象；ImagingStudy 需要的切片序列、层级和瓦片信息现在在 PathJX 里，不能放进 ClinMesh 的 FHIR（私有边界） | 新岗位由真人（或 Agent）在 PathJX 看片、在 ClinMesh 内写并签发；报告时间要用 Virtual Time，不能用 PathJX 的 `created_at`；FHIR R5 的 DiagnosticReport 里的 `study` 引用无处指向 | 保留 Specimen（采集时间取来源手术或活检时间）、DiagnosticReport 与 Provenance，去掉 ImagingStudy 或改为不含像素描述的占位；PathJX 的动作时间只作为审计事实记录在 ClinMesh 私有表；FHIR 版本保持 R5 `5.0.0`，不扩展未实现的资源 |
| 7 | 复杂状态变化通过共享 Command 模块执行，Agent tools 使用幂等键与预期版本（`CM:AGENTS.md:43,49`） | PathJX 的写接口不接受幂等键，普通写请求不自动重放，CLI 对结果未知的写返回 `submission_unknown`；契约要求先读业务状态再决定 | ClinMesh 调用 PathJX 的适配器要自己做幂等：创建上传或改属病例失败后不能盲目重试 | 适配器先读后写（按 `case_id` 和显示名查找已有切片），失败后以读取结果为准；PathJX 写入由 ClinMesh Command 的 outbox 驱动，使用 ClinMesh 的幂等键关联 PathJX 切片编号 |
| 8 | 「开发与验收默认使用合成 Provider、受控模型流和临时数据库；真实模型开发验证须有用户针对本次运行的明确许可」（`CM:AGENTS.md:52`） | PathJX 的真实分析要在 GPU 上运行真实视觉基础模型（H-optimus-0）；这是否算「真实模型」条款所指，原文没有说明（条款面向语言模型调用还是所有模型） | 联调时用 `make demo-start` 的真实编码器，可能触发该条款；用 `--encoder fake` 则 AI 提示没有意义 | 先问用户该条款是否覆盖视觉模型，再决定联调方式；默认联调使用假编码器并在界面标明 |
| 9 | 病理会诊范围只含乳腺切片、门诊会诊服务、已有 `pathology-assets/` 与 `pnpm pathology:*` 命令（`CM:docs/architecture/clinical-workflows.md:681,689`；`CM:package.json` 的 `pathology:*` 脚本） | 方向 3 要求下线，涉及面大：`origin/main` 中约 181 个文件提到 pathology，主要在 `apps/web/src`（35）、`apps/server/src`（33）、`apps/server/tests`（25）、`apps/web/e2e`（19）、`packages/contracts/src`（9）、`apps/dsh-web/src`（8）、迁移（6）、决策记录（4）、`skills/clinmesh-doctor` 等 | 属于实施成本，不是合同冲突，但决定拆票方式 | 先出需求，再按纵向切片拆（申请与受理、PathJX 登记与深链、复核取回与报告、旧链路下线），不在此列具体顺序 |
| 10 | 患者模型只得到「会诊已受理」，不含报告正文、镜下所见或诊断（`CM:docs/architecture/clinical-workflows.md:687`） | PathJX 里的 AI 提示和复核内容与患者模型无关，不构成冲突；但深链与账号体系若让患者模型或 Agent 能看到病理界面，则越界 | 无直接冲突 | 病理入口只在病理医生岗位页面出现，不进入患者模型载荷与 Page Context |
| 11 | Agent-facing CLI 的 `cliPath`、schema、错误或恢复合同变化，需同步 Operation Catalog、`clinmesh-*` 技能和漂移测试（`CM:AGENTS.md:50`） | 病理医生岗位的 ClinMesh 命令（申请受理、开始阅片、签发报告）是新增 CLI 合同 | 实施时要同步 | 在需求里列出，不在本研究展开 |
| 12 | 授权与读取边界：医生只读本人经治病例或已完诊读取（`CM:docs/architecture/simulation.md:125`） | 病理医生在 PathJX 里的账号权限是全局的，不受 ClinMesh 的病例责任约束；ClinMesh 其他岗位（门诊医生等）没有 PathJX 账号，也就不再能打开切片 | 门诊医生原先能在签发后读取切片，改后只能读报告文字 | 属于产品取舍：如需让门诊医生看片，需为其建 PathJX 账号，会进一步放大第 4、5 项问题；建议第一版门诊医生只看报告 |

## 11. 需向 PathJX 提 Issue 的清单

按「动机、最小诉求、是否阻塞第一版」列出。适配全在 ClinMesh，以下只是少数 ClinMesh 无法自行解决的点，且 PathJX 不一定接受，全部以「请求」而不是「要求」对待。

| # | 动机 | 最小诉求 | 阻塞第一版？ |
| --- | --- | --- | --- |
| 1 | ClinMesh 每次重置 Epoch 都需要把切片的复核状态还原，但 PathJX 令牌不能删除切片，导入按路径去重（`PJ:contracts/README.md:124`，`PJ:apps/platform/README.md:32`） | 允许指定的服务账号令牌软删除并永久清除自己登记的切片；或允许导入时强制创建新的切片记录（同一路径可多次导入，各自独立）；或提供「按切片清空复核记录」的受控入口 | 不阻塞：可用方案 A 的硬链接路径或方案 B 的时间过滤绕过，但需要在第一版文档里写明限制 |
| 2 | 结直肠息肉切除没有词项，只能归入 `resection` 或 `unknown`，界面不能区分已验证与未验证的标本（`PJ:contracts/README.md:295`） | 词表加「息肉切除」或「内镜切除」，并让 `colorectal_grades` 清单的适用范围包含它；PathJX 已把此项列为待议，请求提高优先级 | 不阻塞：ClinMesh 可登记 `unknown`，但需要在界面上提示适用范围 |
| 3 | 病例号由平台生成，病例显示名没有写入口，ClinMesh 无法把本院申请号写入 PathJX 病例（`PJ:contracts/README.md:133-137`） | 允许在导入、上传或 PATCH 时设置病例显示名，或增加任意字符串的「外部编号」字段并支持按它查询 | 不阻塞：可用切片显示名携带 ClinMesh 申请号，按 `q` 搜索 |
| 4 | 导入服务器目录要求 `administer`，该能力同时带来账号与令牌管理权，权限过大（`PJ:contracts/README.md:208`） | 为导入单独拆出能力组，或允许 Agent 角色在受限导入根里导入 | 不阻塞：可接受一个管理员令牌，但要在安全文档里登记 |
| 5 | 复核完成没有信号，也没有事件；ClinMesh 只能轮询（`PJ:docs/guides/reading-system/03-upload-and-jobs.md:200`） | 提供按时间或增量游标读取复核动作的参数（如 `since`、`actor_id`）；可选 webhook 或 SSE | 不阻塞 |
| 6 | 深链登录后不回到目标页，首次点击会落到工作列表（`PJ:apps/web/src/app.tsx:160-172`） | 登录页接受 `next` 或 `return_to` 参数，登录后回到同源的目标路径，并限制为同源相对路径 | 不阻塞，但影响病理医生体验 |
| 7 | 需要单点登录或免二次登录；目前只有本地账号（`PJ:contracts/README.md:236-241`） | 增加 OIDC 登录，或受信反向代理传入身份的可信请求头 | 不阻塞第一版，作为后续；第一版接受两次登录 |
| 8 | 嵌入与跨站 Cookie；平台既没有提供也没有禁止被嵌入 | 明确是否支持嵌入，并提供受配置的 `frame-ancestors` 与可选 `SameSite=None; Secure` Cookie | 不阻塞：第一版用新标签页 |
| 9 | 阅片页的「返回」把用户带到全库工作列表；切片文件名不可修改且显示在阅片页（`PJ:apps/web/src/app.tsx:194`，`PJ:apps/web/src/viewer/ViewerPage.tsx:203`） | 深链可带 `return_to`，或支持隐藏「返回工作列表」；允许修改显示的原始文件名，或不展示 | 不阻塞 |
| 10 | 主仓没有开源许可证，ClinMesh 引用、内嵌或随产品分发其 CLI 与技能的授权边界不清（`PJ:README.md` 的数据与许可节） | 明确主仓许可或书面授权范围 | 不阻塞适配器开发，阻塞任何分发 |
| 11 | 切片响应没有「最后复核时间」，列表层面发现变化只能逐片拉取 | 在切片或任务状态里增加 `last_review_at`，或提供跨切片的复核动作增量流 | 不阻塞 |

## 未决问题

1. 病理医生看片是新标签页打开还是 iframe。【建议】新标签页；iframe 需要同站部署并向 PathJX 提第 8、9 项。
2. 切片「每次使用一份」还是「全局复用」。取决于 Epoch 隔离要多强：影响硬链接目录管理、PathJX 磁盘和软删除运维（第 10 节第 5 项）。
3. 谁运维 PathJX：真实模型需要 GPU 和 HunCRC 数据下载；开发联调用假编码器时 AI 提示不可用于展示（第 1、8 节）。
4. 视觉基础模型的真实运行是否受 `CM:AGENTS.md:52` 的「真实模型」许可条款约束（第 10 节第 8 项）。需要用户回答。
5. 病理会诊的结直肠标本范围：Synthea 的结肠部分切除（43075005）对应手术切除标本，PathJX 没有为它验证模型，也没有可用素材；【建议】第一版只支持肠镜活检和息肉切除，且 Synthea 不给组织学类型，ClinMesh 需要自定义「病例到切片类别」的映射，并把映射保持在私有边界内。
6. 是否让 AI 提示出现在 ClinMesh 界面或报告里：PathJX 的用语规则允许显示，但必须带限制说明；【建议】第一版不在 ClinMesh 内展示 AI 内容，只在 PathJX 内看。
7. 其他岗位（门诊医生等）能否打开切片：第 10 节第 12 项，需要产品取舍。
8. 病理医生账号开通：ClinMesh 创建 PathJX 医生账号的初始密码如何生成与交付，管理员令牌的 `administer` 如何首次开启（一次人工浏览器操作）。
9. PathJX 的许可证与 HunCRC 署名文字落在 ClinMesh 的哪个文档里登记（第 10 节第 1、2 项）。
10. 报告的 FHIR 形态：去掉 ImagingStudy 后 DiagnosticReport、Specimen、Provenance 如何表达「在外部系统阅片」，需要在需求阶段确定。

## 本次没有核实的事项

- PathJX spec #281 的 GitHub 正文，只读了合并后的契约与平台 README。
- 任何真实运行结果：没有启动 PathJX，没有验证 iframe、Cookie、深链、硬链接导入、`unknown` 标本类型是否真的绕过适用性检查，只是静态阅读源码与迁移 SQL。
- `/home/claude` 与 `/mnt/d` 下是否另有切片文件（搜索超时，只确认 `PathJX-01/data` 为空）。
- H-optimus-0 的最新许可状态（只读了 PathJX 的选型快照，未访问 Hugging Face）；TCIA 页面的当前许可状态（只读 PathJX 保存的核查记录）。
- ClinMesh 前面可能存在的反向代理或隧道对响应头的影响。
