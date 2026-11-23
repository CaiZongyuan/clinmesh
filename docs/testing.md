# 测试策略

本文定义 ClinMesh 的测试层级、检查选择、浏览器验证与各领域合同矩阵。可执行脚本名称以根目录 `package.json` 为准。

## 层级

### Unit

`pnpm test:unit` 通过 Turborepo 运行各包 Vitest 测试并运行根脚本测试；`pnpm test` 同时包含浏览器合同与 Web E2E。单元测试覆盖边界、拒绝路径与核心不变量，不以行覆盖率数字代替行为断言：

- Zod schema、FHIR 引用格式与错误分类。
- 临床状态转换、确定性风险算子、定点金额／数量、权限与药事安全纯函数。
- TanStack Query key、cache updater 与无平台依赖的 API client。
- 文档投影重写、路径安全与 Agent Page Context／Tool catalog／岗位 view／execution proof／结果 schema。

### Adapter

HTTP、FHIR、SQLite、文件持久卷、Electron IPC、浏览器 `sessionStorage`、DSH Host proxy/proof bridge 与移动安全存储均属于 adapter。测试通过公开接口驱动真实 adapter，mock 仅停留在外部网络、时钟或独立进程边界：

- **Server HTTP 与 SQLite 持久化边界**：路由测试严格解析响应 schema；SQLite 合同使用真实临时文件验证 `BEGIN IMMEDIATE` 事务回滚、`(workspace_id, epoch)` 复合外键、WAL 锁竞争、幂等键与 `expectedVersions` 条件写、outbox 租约回收与重启恢复、在线备份还原合并门诊号高水位，以及非空旧库前向迁移保真与归属歧义原子回滚。
- **跨层异常与脱敏边界**：Server 注入未知 HIS/FHIR 异常断言结构化响应、`X-Correlation-Id` 与脱敏日志；Web HTTP adapter 覆盖超时、取消、非 JSON 与 schema 失配分类；Web composition 让子树抛出渲染异常断言 Error Boundary 恢复；CLI 子进程断言 correlation ID 不改变退出码、`retryable` 或 `ambiguous_outcome` 恢复语义。
- **Agent CLI 六重互补 seam**：Catalog 映射拥有 operation/route/schema/Skill 分类，Identity HTTP 拥有 Grant 哈希／单岗位 allowlist／过期矩阵，CLI 子进程拥有 `argv/stdin/stdout/stderr/exit`（含人工财务命令缺少 `--yes` 返回 `confirmation_required/definitely_not_sent` 不发请求，而 Agent Grant 不受人工确认标志阻塞），HIS 场景套件拥有业务状态机，Skill 套件将命令示例交给真实 parser 校验标志与版本，ambiguous 套件在写响应丢失后凭原 `operationId + idempotencyKey` 查询公开 receipt 证明唯一 Effect。
- **跨岗位临床、专病内核与支付 DRG 联合 HTTP 合同**：从固定 PCI 来源及五例心肾专病 `Authored Case Pack` 出发，在真实临时 SQLite、单岗位 Grant 与 DSH Page Context／`doctor-queries`／proposal 链路上零实模走通门诊独立检查预付费放行、多费用合并收款与逐分配原款退款、品规级甲乙丙混合处方医保结算、双层事中质控 `409` 越权留痕、住院医嘱发药与护士集中给药／健康教育／PRN（PRN 仅生成待办 Task 不直接计费给药）、多支造影与手术耗材预留／核实／更正、未知收款门禁恢复、病案归档冻结、CHS-DRG 预分组／术后核查／医保办核定及结算后财务与医保补偿，全程断言零 `Case Truth` 泄漏且后续账务更正不改写原费用、首次结算、冻结分组或临床状态。默认 CI 使用自编有限规则包（hook 10 秒、用例 15 秒）；显式提供 `CLINMESH_TEST_REFERENCE_DATABASE`、`CLINMESH_TEST_REFERENCE_RELEASE_ID` 与 `CLINMESH_TEST_DRG_RULES_DIRECTORY` 时复制约 26.9 万药品完整参考库快照与完整 v2 条件程序联跑（60 秒预算），对照依据见[DRG 条件核验](research/2026-10-25-drg-condition-verification.md)、[PCI 部署核验](research/2026-10-27-pci-drg-demo-enablement.md)及[从零旅程分层决策](decisions/implemented/testing/2026-10-27-pci-from-zero-journey.md)。

### Application composition

跨端工程壳与共享视图边界在 `packages/views` 验证，临床工作台、路由接线、持久写意图与批量私稿隔离在 `apps/web` 验证；DSH composition 额外覆盖可注入 API base、Memory Router、ShadowRoot Portal、Page Context 续签、稳定 page scope、32 Tool 上限、detached review、按需展开分组解释（模型失败时规则仍可读）及单文件 artifact 体积预算。同一产品行为只在一个最低可行层维护完整输入矩阵：Server 持有权限、并发、计算与错误矩阵，组件与 React 18/19 双版本浏览器合同持有 ShadowRoot 挂载、迟到响应隔离与可访问交互，Mobile 独立验证 Expo Router、AppState/NetInfo、SecureStore、QueryClient 与原生交互。

### End-to-end

E2E 从真实入口驱动并仅通过外部可观察事实（重读业务／FHIR 接口、SQLite 投影、页面状态与审计链）断言成功，不以 Agent 自报成功为准：

- **Standalone Web 生产构建旅程（`pnpm test:e2e`）**：每个用例启动独立真实 Hono listener、临时 file-backed SQLite 与隔离浏览器 context（系统分配端口，不读取开发 `.env`、既有会话或真实模型），覆盖登录与岗位切换、空患者库起管理员准备到跨岗位门诊／住院 PCI 闭环、实时自动病历整理（确定性句号引用且零逐片段独立核对请求）与四项文书质控、免费与本地指南导入及同步专题／可执行建议确认（大病例 596 条历史分批筛选与字节预算收敛、初次生成与格式修复共享原始截止时间且不叠加重试）、独立检查开立计费到阅片已阅、跨患者连续办理具名队列（点击下一位仅导航不自动提交），以及跨岗位交接（须等待当前表单恢复可编辑并收到浏览器 Command 回执，不能仅凭后端落库提前切岗）和未知资金／丢回执刷新恢复。
- **CLI 真实子进程旅程**：先构建真实 CLI bin，再启动 Node listener 与文件 SQLite，由不同单岗位 Capability Grant 子进程串联完整门诊与住院关键路径，并验证响应丢失后凭原 `operationId + idempotencyKey` 查询 receipt 无重复 Effect。
- **DSH 原生宿主显式验收**：通过锁定宿主与合成 `LlmAdapter` 运行 `smoke:consultation:native`／`smoke:recommendations:native`，验证真实原生 Session 调用 browser Tool 保存草稿、发起 `.propose` 经人工批准落库并串联 Tool call、proposal、review、request、Audit 与 Action Trace；加 `:live` 的实模自检不进入常规 CI，前置配置见[部署指南](deployment.md#问诊自动记录原生验收)，浏览器与原生分层取舍见[前端浏览器回归决策](decisions/implemented/testing/2026-10-02-playwright-frontend-tests.md)与[诊疗建议架构决策](decisions/implemented/architecture/2026-10-13-doctor-guideline-recommendations.md)。

## 测试设计

每个新增或修改的测试必须对应一个明确的目标回归，并能在该回归出现时失败。先选择拥有行为语义的最低层级，再为上层保留接线、平台集成、可访问性和长用户旅程；上层不重复下层的完整输入矩阵：

- 通过公开 interface 驱动行为，断言可观察结果、拒绝路径或不变量，不复述实现步骤。
- 只在网络、时钟、平台进程、真实支付或其他昂贵、非确定边界使用 mock；同进程 owner 尽量使用真实实现。
- 一个测试覆盖一个清晰行为分支；只有共享 setup 能显著降低理解成本时才合并场景。
- Coverage 用于发现未执行路径，不代替场景正确性；不得降低 threshold、缩窄 source scope 或为迁就旧测试将原型已改 UI 退回旧样。
- 只被无生产消费者 API 使用的测试不是保留该 API 的理由；删除或收窄行为前先确认公开合同或 Agent Note。

## 可观察测试证据

写测试或运行检查前，Agent 先向用户说明目标验收行为与回归、测试层级与关键断言，以及无需扩大运行集合的原因。长命令运行期间提供简短阶段状态，已经通过且未被后续修改波及的检查不因 commit、review 或 push 重复执行。完成后报告每条实际命令的结果和耗时、新增或修改用例，以及未运行检查的原因；失败时保留原始命令、失败用例和关键错误，禁止凭推测归因环境差异。

## 检查命令

```sh
pnpm typecheck          # Web/Desktop/Server/Docs/shared packages
pnpm check:mobile       # Expo typecheck + dependency compatibility
pnpm lint
pnpm test
pnpm test:unit          # Vitest 单元、组件、adapter 与脚本测试
pnpm test:browser       # Playwright Web/DSH React 18 & 19 浏览器合同
pnpm test:e2e           # Playwright standalone Web 真实入口旅程
pnpm doc-sync
pnpm check              # 非 Mobile 主检查集合
```

开发期间优先运行窄目标包检查（如 `pnpm --filter @clinmesh/core test`、`pnpm --filter @clinmesh/cli test`、`pnpm --filter @clinmesh/server typecheck`、`pnpm --filter @clinmesh/dsh-web build`、`pnpm docs:check`）；跨包接口、构建配置、文档投影或发布 workflow 变化时运行 `pnpm check`，触及 Mobile 或其共享 `contracts`/`core` 入口时运行 `pnpm check:mobile`。

## GitHub CI 的检查选择与并行

PR 与主线 push 由 [`scripts/ci.ts`](../scripts/ci.ts) 校验候选合并提交并按完整净改动分流（主线 push 及影响范围无法精确识别的改动固定选择 `full` 全量）：

| PR 净改动范围 | 执行计划 |
| --- | --- |
| 仅根 `README.md` 或 `docs/` 普通说明文档（不含 `AGENTS.md`、`docs/agents/` 与运行时 `skills/`） | `docs`：仅运行 `doc-sync` |
| 仅修改已有独立测试入口（可含普通文档，不含新增／删除／重命名或共享 fixture） | 定向运行该入口全部用例（零用例即失败）、所属包 `typecheck` 与定向 `lint`（含文档追加 `doc-sync`） |
| 明确的普通前端展示与共享 `ui`/`views` 源码（排除鉴权、API/Agent/Proof、写意图恢复等协议边界） | `frontend`：全局类型／lint／边界／短性能／文档／构建、前端组件测试，以及完整 Playwright `contracts` 与 `web` |
| 服务端代码、跨包协议、配置或混合改动 | `full`：完整覆盖 `pnpm check` 与 `pnpm check:mobile` |

`checks`、`unit`（`1/2`、`2/2` 分片）、`browser`（`1/2`、`2/2` 分片）与 `e2e` 在独立 runner 并行执行；浏览器与 E2E 按互斥两阶段先运行 `--grep-invert=@surgery-flow` 常规集合，再无分片独立运行 `@surgery-flow` 手术全程。同一 PR 内各执行组与分片按包含 Git 树、Tailwind 扫描候选类与运行环境的精确输入指纹恢复成功记录，最终由仅依赖 Node 内建能力的 `verify` 汇总全部分片状态（设计理由见[选择性并行 CI 与分片复用决策](decisions/implemented/testing/2026-10-25-selective-parallel-ci.md)）。

## 测试数据

- 只使用合成患者、机构、临床、医保和支付数据；敏感字段不得出现在 snapshot、异常信息和 CI 产物中。
- Fixture 的稳定 logical id 使用预分配 ID 或确定性 UUIDv5；真实提交时间、`requestId`、租约和耗时不进入 canonical state hash。
- 每个用例自行创建和清理 Workspace/Epoch，旧世代 callback 不得写入新 Epoch；常规测试仅使用合成 Provider，必须在无 API key、无外网和零付费调用条件下通过。

## 用户界面验证

UI 修改默认使用 Playwright 在 standalone Web 与受影响的 DSH Surface 真实入口验证（`agent-browser` 按探索或接管会话需要选用）。`playwright.config.ts` 的 `contracts` 项目覆盖 React 18.3.1／19.2 双版本生产 bundle、ShadowRoot Portal、三档语义字号、深浅主题、长中文文本及 `1600/1280` 与 `< 800px` 窄容器（完整十阶段四十组合手术几何矩阵通过 `CLINMESH_SURGERY_FLOW_FULL_MATRIX=1` 显式运行）；`web` 项目在 Vite 构建期切换 `production` 后立即恢复宿主 `NODE_ENV=test`，保持真实 Origin 与 CSRF 校验开启。比较最终几何或触发指针操作前须等待真实浏览器帧及有限 CSS 过渡完成，见[前端浏览器回归与动画采样决策](decisions/implemented/testing/2026-10-02-playwright-frontend-tests.md)。

```sh
pnpm exec playwright install chromium
pnpm --filter @clinmesh/dsh-web build:styles
pnpm test:browser
pnpm test:e2e
pnpm test:browser --grep 'React 18'
pnpm test:e2e --workers=1
```

默认从 Playwright browser cache 解析浏览器（可用 `CHROME_PATH` 覆盖）；常规回归关闭 trace、截图和视频且生成目录不入库。真实去标识影像与切片验证只读取文字树和 canvas 聚合统计，严禁读取像素截图；用户要求演示录屏时在合成隔离场景录制绑定精确 commit 的 3–4 倍速原生 WebM，不替代自动化回归。

## 性能合同

`pnpm check` 内置短性能门禁（`pnpm perf:ci`，预算以 `apps/server/performance-baselines.json` 为准）：在隔离文件 SQLite 上运行 Reference 导入、疾病／药品／检验全文搜索、本院服务查询、轻重 Command、Action Trace 对照与 Scenario install/reset（前后执行 `wal_checkpoint(TRUNCATE)` 测量持久分配增长），仅对 SQL 语句／写入次数、写入行数、数据库增长、Trace 行数／UTF-8 字节数、错误和索引计划设硬门禁；P50/P95/P99 与吞吐随结果输出但不作跨机器 PR 硬门禁。影像帧块与病理瓦片读取由 HTTP 与 DSH 代理合同约束固定只读 SQL 语句数、单块 `<= 2 MiB` 透传、零写入与零审计开销。扩展基准命令如下，取舍见[SQLite 性能工作负载与稳定门禁分离](decisions/implemented/testing/2026-08-28-sqlite-performance-contract.md)：

```sh
pnpm perf:ci
pnpm perf:trajectory
pnpm perf:saturation
pnpm perf:full-import -- --manifest /absolute/path/to/release.json
```

## 影像合同

外部病理阅片另覆盖单片授权、当前人类身份、原意图恢复、实际显示资格、撤权和修订检查点。真实 ClinMesh SQLite 备份搭配受控远端状态验证恢复，不能视为真实 PathJX PostgreSQL 恢复演练。两侧真实 HTTP 合同只在显式配置合成 PathJX 服务和本机 descriptor 后运行，默认跳过；descriptor 不进日志或 Git，不运行真实模型，不读取真实像素，浏览器使用合成瓦片验证显示与消息。

常规测试使用完全合成的 DICOM 与小型合成 RGB 金字塔切片（含 JPEG／JPEG 2000 瓦片及非组织层），零公网访问覆盖：素材包清单与逐文件哈希、20 倍上限与 10 倍层级生成、单块 `<= 2 MiB` 打包偏移索引、患者头信息剥离、原子安装与离线 `repair`、零像素输入的报告草稿自动一致性核对与人工复核签署发布门禁；病例影像与病理准备的阳性／阴性／冲突手术史／五项受体事实匹配及开始后绑定冻结；放射与病理申请开立、预付费放行、重试、取消、修订、跨类别冲突拦截、只读像素权限边界，以及影像／切片未在人类视口成功显示前拒绝 DSH 已阅提案。

## 合成病例合同

- Transformation 套件覆盖 Index Encounter 合格性与确定性最后选择、`new-problem`/`follow-up`/`preventive` 推断、Visible Source History 与私有 `Case Truth` 闭包隔离及缺译 warning。
- 异步生成与 Persona 套件覆盖最多十次重试、失败零残留、严格 schema、隐藏诊断泄漏出口拒绝、不可变修订、显式激活门禁及零凭证日志。
- Direct start、Investigation 与 Epoch replay 套件证明单病例一次性消费原子创建本院 R5 运行资源（不写入来源 R4 历史）、检验服务发布、分阶段（`initial`/`inpatient`/`repeat`/`follow-up`）`Investigation Result Snapshot` 按 `inputHash` 冻结复用，以及新 Epoch 零外部 Provider 调用重放与迟到旧世代 callback 拦截。

<a id="14-测试策略"></a>

## 领域与协议合同矩阵

### 应用与 Web 矩阵

- Hono 与真实临时 SQLite 场景测试覆盖认证、角色 RBAC、门诊与住院闭环、文书签署／修订、共享收款与原款退费三结局、医保待遇、LIS、药房发药及 Epoch 隔离。
- 模型用量、计价与保留期套件在受控 Provider 与受控时钟下验证双层停用、原子请求预占、独立累计起点、Host 独立代问一次性准入与 30 秒超期未知收束、单价／汇率快照、缺少硬 Token 上界时的 `MODEL_METERING_UNAVAILABLE` 阻断、管理员 `reconcile`/`reprice`，以及默认 90 天保留期对未决请求的保护与 `model_usage_daily` 长期汇总归并。
- React 组件测试覆盖认证缓存隔离、岗位接线、加载／空／错误／冲突／无权限状态、分页与长中文文本。
- DSH adapter 测试覆盖 loopback proxy 限制、Cookie/Origin、execution proof 防重放、单文件 artifact、Page Context 续签、动态 Tool schema、detached review 与 ShadowRoot/Memory Router composition。

### FHIR 合约测试

- `CapabilityStatement` 与实际资源所有权、interaction 和 SearchParameter 注册表一致。
- HTTP 黑盒测试覆盖 `read`、`vread`、`_history`、白名单 Search、完整同源 `self`/`next` link、`_total=none|accurate` 和弱 `ETag`。
- 跨 Workspace/Epoch 的 current、history、total 和签名 cursor 互不泄漏，cursor 禁止跨查询、资源类型或世代重放。
- 未知资源、未知参数、损坏 cursor 和 generic `PUT` 返回稳定 `OperationOutcome`。
- 当前不设官方 R5 Profile Validator、OperationDefinition、通用 create/update、`If-Match`、tombstone 或 `Prefer` 合约测试，因为服务器不宣告这些能力。

### Repository 合同测试

Repository 合同套件运行于真实临时 SQLite 文件（未来新增数据库 adapter 时必须同时通过同一套外部行为测试）：

- 当前资源 + 历史 + Search 索引原子更新与 `reindex` 重建。
- 事务或约束失败整体回滚、条件 update 零行识别和稳定错误分类。
- 幂等键并发首请求、完成无写重放和不同 payload 冲突。
- `(workspace_id, epoch)` 复合外键、挂号发号、处方和库存条件扣减。
- outbox 租约竞争、过期回收、重复消费、retryable failure、`ambiguous` 和 Epoch `abandoned`。
- `audit_head` 并发推进不分叉，审计与关键业务同事务提交。
- Epoch reset 与迟到 callback 并发时旧世代结果绝不污染新数据。

<a id="144-场景测试"></a>

### 场景测试

每个业务能力均以可执行跨岗位场景验收：门诊轨迹覆盖病例准备、Visible Source History、Persona、direct start、分诊、首诊问诊、检查报告已阅、诊断、内外延处方与文书签署、完诊、收费与发药结案；住院轨迹覆盖住院证／直接入院、分床、诊断医嘱、检查送检与集中已阅、手术耗材预留与核实、出院结算清床、病案归档冻结与医保办 DRG 核定；故障矩阵覆盖无合格 Index Encounter、隐藏诊断泄漏拒绝、重复开始、模型失败、过敏与药事红线拦截、乐观锁冲突、支付拒绝／`ambiguous`、未支付禁发药、已签文书禁覆盖及 reset 隔离。

### Agent 安全测试

- Page Context 严格白名单 schema、岗位／栏目不匹配拒绝、隐藏事实零暴露和 Epoch reset 失效。
- execution proof 签名篡改、过期、Tool／operation／scope 不匹配、重放拦截和重复完成拒绝。
- 动态岗位／视图 Tool 目录、单页 32 Tool 硬上限、DSH JSON Schema 子集和到期注销。
- 草稿动作更新 context 但维持 lease；`.propose` 立即返回 pending，明确人工批准串联 Command/Audit/Trace，取消或 scope 变化零业务副作用。
- 固定 loopback proxy、Cookie/Origin、请求与响应体积／超时限制及非 loopback 拒绝。
- Catalog、Identity、CLI 子进程与 Skill 四重互补 seam 验证 CLI/Operation 映射、Grant 单岗位 allowlist、丢响应回执恢复与 Skill 命令示例真实性。
