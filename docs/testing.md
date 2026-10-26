# 测试策略

本文定义 ClinMesh 的测试层级和检查归属。命令以根目录 `package.json` 为准。

## 层级

### Unit

`pnpm test:unit` 通过 Turborepo 运行各包的 Vitest 测试并运行根脚本测试；`pnpm test` 同时包含浏览器合同与 Web E2E。Unit test 覆盖：

- Zod schema、FHIR reference 和错误分类。
- 状态转换、金额/定点数量、权限和场景纯函数。
- Query key、cache updater 和无平台 API client。
- 文档投影的 link rewriting 和路径安全。
- Agent Page Context、Tool catalog、岗位 view、execution proof 和结果 schema。

测试应覆盖边界、拒绝路径和不变量，不以行覆盖率数字代替行为断言。

### Adapter

HTTP、FHIR、SQLite、文件持久卷、Electron IPC、浏览器存储、DSH Host proxy/proof bridge 和移动安全存储属于 adapter。测试通过公开 interface 驱动真实 adapter，mock 只停在网络、时钟或平台进程等昂贵/非确定输入。

Server route 测试必须解析响应 schema。SQLite 正确性 Spike 使用真实临时数据库文件验证事务回滚、外键、WAL 写竞争、幂等竞争、expected-version 条件写、outbox 重启恢复、备份还原和 Epoch reset。

运行时错误测试按 owner 分层：Server HTTP adapter 注入未知 HIS/FHIR 异常并断言结构化响应、correlation ID 和脱敏日志；Web HTTP adapter mock network 与 response stream，断言 timeout、cancellation、非 JSON 和 schema mismatch 分类；Web composition 让子树抛出渲染异常，断言 Error Boundary fallback 和重新挂载；CLI process/HTTP adapter 断言 correlation ID 不改变退出码、retryable 或 ambiguous 语义。

Agent CLI 使用六个互补 seam：Catalog test 拥有 operation/route/schema/Skill 分类，Identity HTTP test 拥有 Grant hash、岗位、allowlist 与失效矩阵，CLI process test 拥有 argv/stdin/stdout/stderr/exit，HIS 场景测试拥有业务状态机，Skill test 把示例交给真实命令 parser，ambiguous test 在响应丢失后通过公开 receipt 观察唯一 Effect。上层不复制 Server 已有 Command 输入矩阵。

财务命令风险分级变化通过 CLI process/HTTP adapter 验证：human 缺少 `--yes` 时返回 `confirmation_required/definitely_not_sent`，不消费 stdin、不发送请求；显式确认后保留原输入与幂等键。Agent mode 无此人工标志仍可按 Grant 发起请求；读取和预览保留无需确认的路径。Skill 示例同时交给真实 parser 检查标志与 Catalog 版本。

### Application composition

共享业务视图在 `packages/views` 测试；Web 路由和平台 wiring 在 `apps/web` 测试。DSH composition 额外覆盖可注入 API base、Memory Router、ShadowRoot Portal、Page Context 续签、稳定 page scope、detached review 和 artifact contract。Desktop 或 Mobile 进入实际开发后在对应 app 增加平台证据。一个产品行为只有一个完整矩阵归属，其他层保留 wiring、可访问性和真实入口验证，不重复纯函数矩阵。

Mobile 只共享产品语义，不共享 DOM 测试。移动测试覆盖 Expo Router wiring、AppState/NetInfo、SecureStore、QueryClient 和原生交互。

### End-to-end

当前主诉的输入与语义回归由 `clinical-document-quality-http.test.ts` 验证分诊原文和派生摘要去重、来源身份与时间、缺失保存时间、文书版本上下文、同文保存复用，以及正常整理和真实胸痛冲突的成对候选及独立复核。页头组件覆盖工作稿、清空和最新签署修订；`doctor-document-quality.spec.ts` 覆盖真实保存冲突不丢稿、空主诉保存刷新与共享签署旅程，`doctor-document-quality-reuse.spec.ts` 验证真实病例切换时工作稿隔离与恢复；`document-quality.browser.test.ts` 覆盖 React 18/19 ShadowRoot 中的即时主诉投影。原生 `smoke-dsh-consultation.ts --quality-only` 验证主诉清空保存、宿主刷新后重开 Surface、真实病例切换及未保存工作稿恢复，再执行编辑与签署的共享旅程。合成模型仅证明来源及双阶段接线，真实模型偶发误报的完整根因与临床准确率不由此推断。

E2E 从真实入口执行，并从外部观察结果：重新读取资源、数据库投影、页面或审计事件，不以 Agent 自己声称成功作为断言。DSH Web 验收从统一 launcher 打开 Surface，要求原生 Session 实际调用 browser Tool，并覆盖一个草稿 action 和一个 proposal → 人工批准 → Command Effect；Tool call、proposal、review、request、audit 和 trace 必须可关联。

`pnpm test:e2e` 使用 Playwright 从 standalone Web 的生产构建运行登录、岗位切换、窄屏外观设置和问诊自动记录旅程。每个测试使用独立的真实 Hono listener、临时 file-backed SQLite 和浏览器 context；Web 构建由同一 worker 复用。端口由系统分配，账户、密码、Auth secret 与数据库均由 fixture 创建并清理，不读取开发 `.env`、已有会话、真实影像或模型配置。页面断言与受 schema 验证的 HTTP 会话查询共同证明保存和刷新后的状态；此集合不替代原生 DSH Session 验收。

门诊收款的完整余额、组合方式、拒付/未知、原尝试查询、并发幂等、权限、重启及检验/药房全额放行矩阵由 `outpatient-workflow-http.test.ts` 通过公开 HTTP 与文件 SQLite 验证；`payment-ledger-migration.test.ts` 验证历史事实保留、零价兼容及归属歧义时原子回滚。`billing-payments.spec.ts` 从真实收费入口验证分次、组合、未知刷新与原支付恢复，React 18/19 的 `billing-payments.browser.test.ts` 复用生产收费组件和真实 HTTP，覆盖 ShadowRoot 审阅、焦点、键盘取消及窄宽度；浏览器并发合同另在网络边界延迟响应，验证进行中选择保护和迟到回调隔离。

门诊独立检查从真实草稿与正式开立入口生成原应收，不能通过插入费用或旧兼容检验开单替代。`outpatient-investigation-boundaries-http.test.ts` 通过公开医生、收费与 FHIR 查询证明缺价开立原子回滚、服务与价目变化重审、开立后原价持久化、两笔同类及跨类别精确付款和跨岗拒绝；`outpatient-investigation-lifecycle-http.test.ts` 分别直接调用受理与开始 Command，证明未收齐拒绝受理、缺少首次放行快照拒绝执行。影像与病理临床 HTTP 回归经收费员公共收款入口补齐前置条件，再验证报告、已阅、重试、取消和修订。`outpatient-workflow-http.test.ts` 继续拥有分次组合资金、未知查询、医保在受理前后撤销、取消冲减及原交易退款的时序矩阵，并从完诊和发药入口证明退款责任未结清时 Run 保持 active，退款确认或恢复后仅完成一次。`outpatient-investigation-billing-migration.test.ts` 使用非空旧库验证原费用、旧预览分配、资金、三类历史计费策略、外键保护和歧义回滚。

独立检查的浏览器旅程从医生“检验检查 → 添加 → 加入申请 → 开具选中项目”开始，覆盖检验、放射与病理的价格审阅，再切收费员处理原费用，返回医生观察原申请执行。standalone Web 与 DSH Surface 分别验证真实接线；分次组合支付、未知刷新后原尝试恢复和取消后原交易退款保留在用户旅程，完整金额与竞争矩阵归 Server。React 18/19 与 ShadowRoot 合同覆盖共享审阅、缺价禁用、价目变化后重新审阅及资金状态，单独挂载收费组件不能替代 DSH 医生入口。CLI/Agent 仅验证原 ChargeItem 目标、受信绑定、岗位、人工审阅及 receipt，复用同一业务矩阵。全部使用合成 Provider、受控资金结果和临时文件 SQLite；放射与病理只观察文字、报告引用和聚合统计。

四项病历质控的完整输入矩阵由 `clinical-document-quality-http.test.ts` 通过公开 HTTP、真实 SQLite 和 DSH Provider 网络边界验证，包含辅助检查或可选字段伪缺项的拒绝、分诊记录与患者自述的语境核对、来源不能核验的解释、说明变更与旧缓存失效；大量既往资料不进入实时输入，本次来源仍完整检查，本次正文实际超限仍返回不完整。`doctor-document-quality.spec.ts` 与共享旅程验证未保存编辑不写入草稿、待补充仅在详情展示及逐条依据入口隐藏、两类问题的具体影响与处理建议、直接修改后重新检查、无逐条确认或保留写请求及签署汇总；`document-quality.browser.test.ts` 覆盖 React 18/19 ShadowRoot、键盘、文字边界和迟到响应，组件测试保留旧处理记录的只读展示。`pnpm exec tsx scripts/smoke-dsh-consultation.ts --quality-only` 从原生 DSH 入口运行同一旅程并验证实际 Agent 草稿 Tool 和模型 schema 白名单；默认仅使用合成模型；加 `--live` 后在新合成病例中通过当前配置的真实模型核对未保存、保存及第二客户端的同输入复用，分别记录持久任务和实际模型调用数量。真实样本不代表临床准确性；入口及证据字段见[部署教程](deployment.md#问诊自动记录原生验收)。

问诊组合旅程由 `apps/web/e2e/consultation-recording-journey.ts` 同时驱动 CI Web 与原生 Surface，覆盖生成后正文直接更新、无来源入口及独立核对提示、局部人工保护、未保存编辑、患者更正与矛盾记录、暂停补录、失败重试、签署准备冻结、取消恢复和人工签署。自动记录的 Web 与 React 18/19 ShadowRoot 回归还验证失败文字不常驻、重复错误合并为按需说明、原文保存和恢复入口。HTTP/SQLite 测试继续拥有完整业务输入矩阵。`pnpm smoke:consultation:native` 使用锁定的真实宿主与合成 `LlmAdapter`，额外执行真实 Session browser Tool 草稿保存与签署 proposal，并关联 Command 回执、审计和 Trace；`pnpm smoke:consultation:live` 再为一个新合成病例调用真实模型。后者验证成功输出及逐字来源约束，不代表医学语义质量评估。两种 smoke 均显式运行，不进入常规 CI；前置配置见[部署教程](deployment.md#问诊自动记录原生验收)，分层取舍见[组合验收决策](decisions/implemented/testing/2026-10-10-native-consultation-recording-journey.md)。

句子编号协议由 Server 的 `recording-sentence-references.test.ts` 验证确定性句界、原文位置、快照隔离、旧协议与序列化字节；`dsh-model-integration.test.ts` 通过真实 Provider 和宿主 handler 验证新输出 schema、格式修复、否定核验、旧 SQLite 在途快照与重复消费。自动记录不再执行逐片段核对；`doctor-recording-source-http.test.ts` 与 `consultation-auto-record-http.test.ts` 验证多片段、补录、重试、重启和重复消费的独立核对调用为零，旧状态及 outbox 安全退役；质控 HTTP 合同持有旧事实保留、更正/冲突及拒绝事实无新依据重现的语义检查。状态机旧 fixture 的测试适配不能代替这条传输边界。输入预算在初次请求及格式修复的实际序列化边界验证，不运行压测或真实模型。

检验目录的 React 18/19 浏览器合同按版本在 `beforeAll` 中构建生产 fixture，同一文件复用产物；构建与交互分别受原有时限约束，原因见[浏览器回归决策](decisions/implemented/testing/2026-10-02-playwright-frontend-tests.md)。

CLI E2E 先构建真实 bin，再启动 Node listener 与 file-backed SQLite，并从独立 `clinmesh` 子进程执行 human login 和 Agent operation。主场景从生成 Synthetic Case 与 Brief 的受控 setup 开始，由不同单岗位 Grant 依次完成挂号、分诊、问诊、检查与报告确认、诊断、处方、病历签署、完诊、药品支付、处方审核和发药。响应丢失场景必须先证明 Server 已提交，再用原 operation ID/idempotency key 查询 receipt，并通过正式 query 证明 Effect 没有重复。

指南建议由 `doctor-recommendations-http.test.ts` 从真实 DSH Provider 的网络边界验证引用、语义否定、字段缺证、动态目录、授权、迟到结果与恢复，并验证无指南的病例思路、仅缺指南时的只读降级、不同核验失败原因及模型顶层泛化缺项不发布；公开 HTTP 和真实 SQLite 保持真实。`doctor-recommendations.spec.ts` 与共享旅程从真实 Web 核对后台准备、折叠说明及诊断、处方、检验清单直接确认与开具，处方缺项保持待补充，正式操作前保留医生选择和手改；共享旅程同时验证只读诊断和检查思路、分类说明、实际病例引用及没有采纳入口。两组 DSH 浏览器合同同时覆盖 React 18/19 的五种建议、来源类型、ShadowRoot、Portal、焦点及窄宽度。`pnpm smoke:recommendations:native` 复用锁定的原生宿主与合成外部模型运行同一旅程，`pnpm smoke:recommendations:live` 再读取新合成病例，使用显式配置的真实模型验证建议响应与实际提供的引用，且不采纳或创建临床事实。真实模型样本不代表全病种医学质量或药学安全评估；这两个显式 smoke 不进入 CI。

免费全文检索的 `guideline-corpus.test.ts` 使用真实临时 SQLite 验证跨主题召回、原文保留、许可、撤回、重复导入和独立 writer 更新；`import-guideline-source.test.ts` 在网络边界提供合成官方响应，验证重定向、预算、哈希、缓存和真实合成 PDF 页提取；`guideline-sync.test.ts` 覆盖同步、只读查询与失败更新。`doctor-guideline-corpus-http.test.ts` 经公开 HTTP 验证新增糖尿病主题的原文同时进入生成和独立核验，来源更新导致旧建议失效，撤回和替代也阻止固定引文复用。共享 Web／原生 DSH 旅程先通过真实病历 UI 引入合成糖尿病资料，核对导入正文的来源引用，恢复原病例后继续待确认清单、编辑保护与医生正式确认流程；合成模型证明接线合同，不代表实模或临床质量。

大病例回归使用 596 条合成历史与超过单次预算的检验目录，验证授权批量读取、完整诊断分页、全部历史批次覆盖、单条原文选择与重打包、短句柄到真实来源的追溯、旧安全信息、跨建议种类复用、输入变更失效、失败不发布和核验完整候选分批；筛选阶段的紧凑索引与瘦身目录、字节预算打包和已选记录收敛轮由同套件持有（见[信封预算规格](spec/2026-10-20-recommendation-envelope-budget.md)）。限流回归组合真实模型桥与 Provider，验证有界等待、初次生成与格式修复共享原始截止时间、预算耗尽后不再调用、共享一次限流重试、取消和建议 outbox 不叠加重试。SQL 数量、模型请求数、实际字节与并发边界作为稳定性能合同，公开 HTTP 耗时单独记录；不以裸 SQL 下界代替整条读取链，也不固定真实模型墙钟时间。输入组织和恢复边界见[分批读取决策](decisions/implemented/architecture/2026-10-15-recommendation-context-budget.md)、[记录级筛选决策](decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)与[信封瘦身决策](decisions/implemented/architecture/2026-10-20-recommendation-envelope-slimming.md)。

核心病例轨迹见[场景测试](#144-场景测试)。每次运行固定 app build、数据库 schema、Operation Catalog hash、Workspace policy version、Synthea commit、localization profile、生成参数与 Case Revision；未来实际发布 IG 时再把对应版本加入固定输入。

## 测试设计

每个新增或修改的测试必须对应一个目标回归，并能在该回归出现时失败。先选择拥有行为语义的最低层级，再为上层保留 wiring、平台集成、可访问性和长用户旅程；上层不重复下层的完整输入矩阵。

- 通过公开 interface 驱动行为，断言可观察结果、拒绝路径或不变量，不复述实现步骤。
- 只在网络、时钟、平台进程、真实支付或其他昂贵、非确定边界使用 mock；同进程 owner 尽量使用真实实现。
- 一个测试覆盖一个清晰行为分支。只有共享 setup 能显著降低理解成本时才合并场景。
- Coverage 用于发现未执行路径，不代替场景正确性；不得降低 threshold、缩窄 source scope 或使用空测试通过选项隐藏缺口。
- 只被无生产消费者 API 使用的测试不是保留该 API 的理由。删除或收窄行为前先确认是否存在公开 contract 或 Agent Note。
- 浏览器层只证明浏览器、平台载体和长用户旅程；资源语义、Command 状态机和错误矩阵由更低层 owner 证明。

## 可观察测试证据

写测试或运行检查前，Agent 向用户说明：

- 要证明的验收行为及目标回归。
- 测试文件、测试层级和关键断言。
- 为什么选择这些测试，以及为什么不需要更宽的集合。

运行时说明实际命令。长命令开始后持续提供简短阶段状态，不用无边界日志或内部推理代替进度。已经通过且未被后续修改失效的检查不因 commit、review 或 push 重复执行。

完成后报告每条实际命令的结果和耗时，列出新增或修改的测试用例，并明确未运行的检查及原因。失败证据保留原始命令、失败测试和关键错误；环境差异必须被验证，不能靠推测归因。

## 检查命令

```sh
pnpm typecheck          # Web/Desktop/Server/Docs/shared packages
pnpm check:mobile       # Expo typecheck + dependency compatibility
pnpm lint
pnpm test
pnpm test:unit          # Vitest 单元、组件、adapter 与脚本测试
pnpm test:browser       # Playwright Web/DSH 浏览器合同
pnpm test:e2e           # Playwright standalone Web 真实入口旅程
pnpm doc-sync
pnpm check              # 非 Mobile 主检查集合
```

开发期间先运行目标包检查，例如：

```sh
pnpm --filter @clinmesh/core test
pnpm --filter @clinmesh/cli test
pnpm --filter @clinmesh/server typecheck
pnpm --filter @clinmesh/dsh-web test
pnpm --filter @clinmesh/dsh-web build
pnpm docs:check
```

## GitHub CI 的检查选择与并行

主 CI 沿用 PR 创建、更新、重新打开及 `main`/`master` push 触发。`plan` 用本次事件的 base/head 校验实际候选合并提交，并从第一父提交到候选结果读取完整净改动；checkout 保留两层历史。无法核验事件、提交或完整差异时选择全量。主线 push 固定全量。

| PR 改动 | 检查范围 |
| --- | --- |
| 只有根 README 或 docs 下普通 Markdown | `doc-sync`；Agent 规则、`docs/agents/` 工程 skills 配置和运行时 Skills/提示词不在此范围 |
| 只有已修改的独立测试入口，可包含普通文档 | 逐文件运行全部用例、所属包 typecheck、定向 lint；Web E2E 追加浏览器 tsconfig，文档变化追加 `doc-sync` |
| 明确的普通 Web 页面、DSH 显示组件、共享 UI/views 源码 | 全局类型/lint/边界、短性能预算、文档和构建；UI/views、Web、DSH、Desktop 组件测试；完整 Playwright `contracts` 与 `web` |
| 其他、关键边界、服务端影响范围过广或无法识别 | 全量，覆盖原 `pnpm check` 与 `pnpm check:mobile` 的完整集合 |

具体路径、状态和混合改动的选择以 [CI 入口](../scripts/ci.ts)为准。新增、删除、重命名测试、共享 fixture/setup、导出或被静态引用的测试入口回退全量。普通前端路径也排除鉴权、API/Agent/Proof、恢复、受信写意图、宿主设置等混合协议边界；不能把整个 Web 或 DSH 包都视为普通显示代码。未建立可靠窄影响集合的 Server 代码保持全量。

前端选择省略整套 Server Vitest 和 CLI 单元集合，但保留两个完整 Playwright 项目中使用真实 Server、临时 SQLite 的入口验证。上层构建通过 Vite 动态加载 UI，HTTP 消费者也不等同于包依赖，因此不依赖静态导入图自动删减浏览器或 E2E。

选中的 `checks`、`unit`、`browser`、`e2e` 在独立 runner 上并行，固定同一 `github.sha`。每个非文档执行组在安装依赖后显式准备 DSH 生成样式，不能假定其他 runner 的 typecheck 产物可见。基础组包含适用的类型、lint、边界、性能预算、文档、构建和 Mobile；测试组保留原 worker、断言和超时。浏览器组各自准备 Chromium，所有数据与端口继续由既有 fixture 隔离。

最终 `verify` 始终汇总计划及四组结果。计划失败、必需组失败/取消/意外跳过、结果缺失或未知状态均失败；只有计划明确排除的组允许跳过。计划与汇总入口仅依赖 Node 内建能力，不需要先安装业务依赖；执行组调用已有 pnpm/Vitest/Playwright 命令，文件名经验证后作为 argv 传递。

选择、真实 Git/进程边界及汇总回归由 `scripts/ci.spec.ts`、`scripts/ci-cli.spec.ts` 持有，CI 脚本与测试纳入 `tsconfig.ci.json`。设计理由见 [CI 分流与并行决策](decisions/implemented/testing/2026-10-25-selective-parallel-ci.md)，正式验收条件见 [规格](spec/2026-10-25-selective-parallel-ci.md)。`verify` 输出与仓库分支保护是不同能力，强制拦截合并仍需管理员单独启用规则。

跨包 interface、workspace 配置、构建、文档投影或发布 workflow 变化运行 `pnpm check`。只有 Mobile 文件、共享给 Mobile 的 contract/core 入口或 Expo 配置变化时才运行 `pnpm check:mobile`。

## 测试数据

- 只使用合成患者、机构、临床、医保和支付数据。
- Fixture 的稳定 logical id 使用预分配 ID 或确定性 UUID。
- 真实提交时间、request ID、lease 和 duration 不进入 canonical state hash。
- 测试自行创建和清理 workspace/epoch；旧 callback 不得写入新 epoch。
- 敏感字段不出现在 snapshot、异常信息和 CI artifact。
- 常规测试只使用 fake Synthea 和 fake Chat Completions provider，必须在没有模型 API key、没有外网和没有付费调用时通过。真实 provider 只进入显式 live smoke。

## 用户界面验证

用户界面修改默认使用 Playwright 在 standalone Web 与受影响的 DSH Surface 真实入口验证；`agent-browser` 按探索或现有会话接管需要选用。布局需要覆盖长中文文本、窄宽度、缩放和空/错误/加载状态；DSH `workspace` 在缩放和原生右栏开关时保持左右分屏，并验证手动全屏往返恢复侧栏及分栏偏好、保留病例和草稿。容器缩放与动画卸载使用真实浏览器帧和有界状态等待。用户要求演示时再录制绑定精确 commit 的原生 WebM，成片使用 3–4 倍速、步骤字幕和真实点击高亮，在临床文字仍可读的前提下压缩体积。WebM 不替代自动回归测试。Desktop 进入实际开发后再增加真实 renderer 证据。

`playwright.config.ts` 的 `contracts` project 拥有 `*.browser.test.ts`，Vitest 排除这些文件；`web` project 拥有 `apps/web/e2e/*.spec.ts`。合同保留现有 Vite/Tailwind 生产构建、React 18/19、ShadowRoot、布局和合成 canvas 断言。Playwright 在 worker 内复用 Chromium，每个测试有独立 context/page；默认两 worker、零重试，runner 限时等待 fixture 的结果信号，不用 Chrome DOM 导出取得结果。字号合同断言 standalone computed font-size、布局尺寸、Desktop 默认 token、Surface 字号和宿主隔离。

Playwright 的 Node 宿主固定使用 `NODE_ENV=test`，避免同一 worker 中的 Vite 构建改变后续服务端模块的生产默认值。浏览器合同显式定义生产 bundle；Web E2E 仅在 Vite 构建期间切换到 `production`，无论构建成功或失败都先恢复宿主环境，再启动真实 HTTP fixture。认证的 origin 与 CSRF 校验继续保持开启。

首次安装依赖后安装与锁定 Playwright 版本匹配的 Chromium；CI 同时安装系统依赖：

```sh
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:e2e
pnpm test:browser --grep 'React 18'
pnpm test:e2e --workers=1
```

默认从 Playwright browser cache 解析可执行文件，不依赖系统 Chrome；需要指定浏览器时使用 `CHROME_PATH`。常规回归关闭 trace、截图和视频，生成目录不进入 Git。真实影像验证只读取文字树和 canvas 聚合统计，不保存或读取像素截图；独立的合成影像合同允许读取已知 fixture 像素。

录制只使用合成医院场景和隔离的 workspace、epoch 与客户端状态。画面不得包含真实患者信息、医保或支付凭证、平台密钥、无关浏览器标签或通知。

Mobile 功能先列出与 Web/Desktop 必须一致的语义，再验证移动端允许不同的导航和控件。运行 `pnpm check:mobile` 和相关移动测试，并报告真实设备或模拟器证据缺口；不能用一张 Web 截图证明移动端正确。

## 性能合同

短性能门禁属于 `pnpm check`。它在隔离的 file-backed SQLite 上运行 Reference Release 导入、独立 Reference SQLite 的疾病/药品/检验全文搜索、本院服务目录 HTTP 查询、普通与重 Command、测试专用 Trace 对照和内置 Scenario install/reset。门禁只 gate statement/query/write、rows written、数据库增长、Trace rows/bytes、错误和索引计划。Trace bytes 是 `action_trace` 全部持久化 TEXT 字段的 UTF-8 字节数，不代表 SQLite page allocation。P50/P95/P99、transaction time 和吞吐始终进入结果，但不作为跨机器 PR hard gate。SQLite 当前不提供可靠 rows-read，因此结果 schema 明确不声明该指标。

Scenario install/reset 的存储采样在工作负载前后分别完成 `wal_checkpoint(TRUNCATE)`，再合计主文件、WAL 与 SHM 的字节数，比较 checkpoint 后的持久分配增长。两次 checkpoint 均在 SQL 计数与延迟采样之外；这一指标不表示操作期间的 WAL 峰值，避免将初始化数据的延迟刷盘计入场景增长。存储预算以 `apps/server/performance-baselines.json` 为准。CLI 在预算断言前输出完整结果并写入可选的 `--output` 文件；超限仍以非零状态退出，存储错误同时报告实际增长与预算字节数。

```sh
pnpm perf:ci
pnpm perf:trajectory
pnpm perf:saturation
pnpm perf:full-import -- --manifest /absolute/path/to/release.json
```

影像像素读取的预算由 Server HTTP 合同测试持有：读取检查描述和每个像素块各自不超过固定的只读语句数，零写入、零 Audit Event、零 Action Trace，单块不超过 2 MiB，预算不随 CT 层数增长。病理切片的每个瓦片请求遵守同一预算，不随层级或瓦片数增长。DSH 通道由代理合同测试覆盖整块 2 MiB 像素的原样透传与缓存策略。首帧延迟、翻片耗时和切片瓦片吞吐属于跨机器不稳定的时间指标，按上面的原则只在真实入口验证中记录，不作为 hard gate。

`trajectory` 使用共享 application interfaces 从内置虚拟患者完成问诊、检验、诊断、处方、文书和完诊；Synthetic Case generation、历史、Brief、direct start、Investigation snapshot 与新 Epoch no-AI replay 由下述 Server HTTP 集成合同覆盖。`saturation` 以独立 Worker/SQLite sandbox 覆盖 1、5、10、25 actors，并报告 load runner 自身的 busy/retry；`full-import` 只读取调用者已合法取得的 manifest 和 artifact。所有 profile 只使用合成运行状态，不提供关闭 Audit Event 或 Action Trace 的运行开关。详细取舍见 [SQLite 性能工作负载与稳定门禁分离](decisions/implemented/testing/2026-08-28-sqlite-performance-contract.md)。

## 影像合同

常规测试使用完全合成的 DICOM、患者与 Provider，不访问真实数据集、模型或公网；真实素材只出现在显式的真实入口验证中。

- 素材流水线测试从公开入口覆盖清单校验、逐文件哈希、不支持的传输语法与方向、单块 2 MiB 上限、原子安装、离线修复、标注导出，以及报告自动核对与复核签署的发布门禁。
- 病理切片素材流水线测试使用测试内生成的小型 RGB 金字塔 DICOM（JPEG、来源形态的 RGB JPEG 与 JPEG 2000 瓦片、缩略图、标签图和宏观图），从同一公开入口覆盖：丢弃非组织实例、20 倍上限与 40 倍降采样、10 倍层级生成、JPEG 原样复制、JPEG 2000 转码与重建的字节确定性、打包偏移索引、UID 不符与不支持的压缩、颜色、几何的拒绝、原子安装与离线修复，以及安装文件、清单和命令输出不含来源头部的患者标识。报告自动核对与复核签署用结构化字段和报告文本的正反例覆盖，并核对仓库清单中每张切片的草稿都通过自动核对；IDC 来源客户端用模拟存储桶覆盖分段下载、ETag 绑定和重试。
- 病例影像准备的 Server HTTP 测试覆盖阳性、阴性、未覆盖疾病、冲突手术史、人口学不符、同一病例单一适配条目、不可变修订和病例开始后的绑定冻结；本次就诊的疾病按 Synthea 的真实导出形态带有就诊之后的缓解时间。管理员接口的身份负例与临床角色不可见性在同一 seam 验证。
- 放射申请的 Server HTTP 测试从开单走到已阅和完诊门禁，并覆盖取消竞争、未取得结果后的重试与取消、报告更正、检验操作作用于放射申请的稳定冲突、临床读模型不含素材标识，以及患者模型载荷只含检查名称与时间。
- 病理病例准备的 Server HTTP 测试覆盖受体、淋巴结与 T 类别全部一致才就绪、冲突与未知的优先级、来源手术须早于本次就诊、病例开始后的绑定冻结、已发布报告改动后以同一修订号重新签署时未开始病例的重新评估，以及一个素材包清单无效时另一个素材包的定向生成条目照常可选。
- 病理会诊的 Server HTTP 测试从开单走到已阅和完诊门禁，并覆盖没有相符切片与其他故障三次后的未取得结果、重试与取消、报告更正、检验与放射操作作用于病理申请的稳定冲突、临床读模型不含素材标识，以及患者模型只知道会诊已受理。
- 影像读取边界测试覆盖无权限、跨病例、跨 Epoch、越界位置和素材缺失，并持有像素读取的数据库预算。
- Agent 测试覆盖放射 Tool 随病例状态发布、输入与当前病例资源的绑定、检验与放射 Tool 互不串用，以及影像未显示时拒绝已阅提案。
- 显示规则的纯函数测试用已知合成像素验证 HU、窗宽窗位、反相、方向、层面顺序和比例；React 18/19 双版本浏览器合同测试读取少量真实渲染输出像素。DSH 代理合同测试覆盖整块像素的原样透传。

## 合成病例合同

- Transformation 测试覆盖 Index Encounter 合格性、确定性最后选择、new-problem/follow-up/preventive 推断、时间与引用闭包、Visible Source History 投影，以及当前隐藏资源泄漏阻断。
- Server HTTP 集成测试提交 generation request，等待异步任务并通过公开管理员 API观察 Profile、Case、provenance 与有界 translation warning；同时证明缺译保留来源 display 而结构错误仍失败、最多十次 Index Case 重试、失败不留部分资产、来源历史可分页/查看详情且猜测隐藏引用仍不可读取。
- Brief 测试覆盖异步状态、严格 schema、诊断泄漏拒绝、成功 revision 不可变、失败不覆盖成功、显式选择和无活动 Brief 禁止开始。客户端不能覆盖 provider URL、model、header、key 或 body，日志和 DTO 不含凭证。
- Direct start 测试证明一个 Case 正常流程只能开始一次，并原子创建本院 R5 Patient、Registration、Encounter 和 Queue Task；来源 R4 历史与全局 Reference rows 不得写入本院 R5/operational store。
- 管理员 Laboratory Service 测试覆盖 orderable Reference 候选分页、expected candidate version、50 项批次上限、fake enrichment、panel 闭包、原子发布、失败状态和幂等 job；医生目录测试只接受 active、doctor-orderable Hospital Service，并覆盖无 capability 文案、明确选择、自动保存与正式开立。
- Investigation 测试覆盖单项和完整 panel 的精确 Observation 命中、partial panel 只生成缺失叶子、数量与定性 strict output、单位/范围/闭包拒绝、outbox 三次自动尝试、首个成功 snapshot 冻结和复查新 evidence hash；连续失败不创建临床资源。
- Reset/replay 测试在新 Epoch 重新物化同一 Case Revision，复用 Brief、Case Truth 与 evidence hash 相同的 Investigation Result Snapshot，断言 provider 调用计数不增加、旧 callback 不能写入新 Epoch。
- Docker smoke 使用固定 Synthea commit、全部模块模式、中国 profile/localization provenance、非 root、只读文件系统和有界资源，从真实 HTTP 入口完成多患者 generation，并验证全部 Bundle 成功以及 translation warning 按 ordinal 关联，再继续覆盖 history、Brief、direct start、诊断、检查与 LIS 结果。
- OpenAI-compatible live smoke 是开发者显式运行的单个合成 Brief 检查，读取本机启动配置，不进入 `pnpm test`、`pnpm check` 或 CI，且不输出 prompt、响应正文、API key 或 provider header。

## 14. 测试策略

模型用量从公开 HTTP、真实临时 SQLite 与受控外部 Provider 边界验证逐次尝试、缺失用量、实际模型、账本故障、病例责任、跨 Epoch 和重启。`model-usage-control.test.ts`、`model-usage-http.test.ts` 与 `model-usage-host.test.ts` 共同拥有双层停用、零上限、原子请求预占、独立累计起点、无限切换、控制拒绝及三类派发的重试检查；屏障只放行少量确定性请求，不运行持续负载。直接 Provider 与 DSH bridge 分别证明派发前记账；DSH 合成流验证 usage 帧、断流与取消，保留 #235 的请求次数和成功步骤复用回归。Host 独立识别用真实识别器、Host 任务 handler 与 Server 控制接口共同验证一次性许可、权限失效零 stream、同病例续签、身份或岗位切换、切走返回、用量帧、回执绑定的停用取消、控制待办恢复、结算失败、幂等重报与重启未知；完全失联的回归不发送终态，推进时钟后经真实读取证明超期未知、进度不续期、迟到结算与去重保留。真实 SDK 的缺失 adapter 和不支持的推理配置验证预检拒绝不计请求；原生 AgentLoop/Tools 合同保留正常委托和工具交接。Web/DSH 从真实设置导航验证总览、识别功能筛选、详情、管理员额度保存与刷新、普通成员只读及明确覆盖范围，DSH 使用 React 18/19 合同。常规验证不调用真实模型，也不运行压测；执行许可由[根工程规则](../AGENTS.md)拥有。

Token 与人民币控制的公开 HTTP／SQLite 矩阵由 `model-usage-cost-control.test.ts` 拥有，覆盖调用时单价与汇率快照、原币与人民币估算、各层各维度首次设限、无限切换持续累计、重启、未知占用、部分核对、显式补算、修订幂等及当前管理员授权。三类真实派发回归分别位于 `model-usage-control.test.ts` 与 `model-usage-host.test.ts`：缺少可信计量边界时有限 Token／金额拒绝且外部请求或 stream 为零，切回无限后正常派发并保留边界原因。通用内核的有界合成适配器用于证明有限预占与并发结算，不能据此宣称生产适配器已有硬 Token 上界。`model-usage-transport.test.ts` 和 DSH SDK 合同继续验证实际尝试、配置与缓存／推理口径；价格纯函数用手算合成金额验证六位小数、整数安全范围、零价格、缺价、缺汇率及向上预占，金额不是实测账单。界面验证覆盖三项独立额度、只读统一价表、未知费用与预占分开显示、核对／补算及 React 18/19 对话框；完整权限与额度矩阵保留在服务端，不在浏览器重复。

明细生命周期的公开 HTTP／真实临时 SQLite 矩阵由 `model-usage-retention.test.ts` 拥有。受控真实时钟覆盖默认 90 天、任意有效正天数、永久、恰好到期、设置版本与幂等、普通成员只读、清理后重启及延长期限不恢复明细；不等待真实天数。少量混合已结算／未结算请求证明清理保留全部筛选维度和跨日汇总、缺价与未知金额标记、各层各维度累计与独立起点、无限期间累计及未决占用，并证明过期未结算请求仍能部分核对。检查必要修订证据留存、完整回执过期、旧幂等键不能恢复明细和重复清理不重复计量；已有病例责任、活动与旧 Epoch、跨 Workspace 负例继续适用。非空旧库迁移沿用 `database-lifecycle.test.ts` 的文件先例，Web／DSH 从真实设置入口验证自定义天数、永久、刷新与清理后的总览／明细边界，复用 React 18/19 宿主合同。该生命周期独立于业务恢复队列和配额计数，不以清理触发新模型请求。

### 14.1 应用与 Web 测试

- Hono 与真实临时 SQLite 的场景测试覆盖认证、角色、Scenario、挂号、分诊、医生首诊/复诊、签署/修订、支付三结局、LIS、发药和 Epoch 隔离。
- Command 与 Repository 聚焦测试覆盖幂等、expected version、事务回滚、审计链、outbox lease/retry/ambiguous 和 SQLite 生命周期。
- React 组件测试覆盖认证缓存隔离、五岗位 wiring、加载/空/错误/冲突/无权限状态、分页、支付拒绝重试、长中文文本和 locale/theme 控件。
- DSH adapter 测试覆盖 proxy 限制、Cookie/Origin、proof 防重放、单文件 artifact、Page Context 续签、动态 Tool schema、detached review 和 ShadowRoot/Memory Router composition。

### 14.2 FHIR 合约测试

- CapabilityStatement 与实际 resource ownership、interaction 和 SearchParameter registry 一致。
- HTTP 黑盒测试覆盖 read、vread、instance history、白名单 search、完整 `self`/`next` link、`_total=none|accurate` 和弱 ETag。
- 两个 Workspace/Epoch 的 current、history、total 和签名 cursor 互不泄漏，cursor 不能跨 query、resource type、Workspace 或 Epoch 重放。
- 未知资源、未知参数、坏 cursor 和 generic `PUT` 返回稳定 OperationOutcome。
- 当前没有官方 R5 Profile Validator、OperationDefinition、create/update、If-Match、tombstone 或 `Prefer` 合约测试，因为服务器不宣告这些能力。

### 14.3 Repository 合同测试

首期 Repository contract suite 运行于真实临时 SQLite 文件。未来增加数据库 adapter 时，同一套外部行为测试必须同时运行于新旧 adapter，不能用 mock 声称可迁移。

覆盖：

- 当前资源 + 历史 + Search 索引原子更新与索引重建。
- transaction/约束失败整体回滚、条件 update 零行识别和错误分类。
- idempotency key 并发首请求、完成重放和不同 payload 冲突。
- Workspace/Epoch 复合 foreign key、Registration、Prescription 和库存条件写。
- outbox lease 竞争、过期回收、重复消费、retryable failure、ambiguous 和 Epoch abandon。
- audit head 并发推进不分叉，审计与关键业务同事务提交。
- reset 与晚到 callback 并发时旧 epoch 不得影响新数据。

### 14.4 场景测试

每个业务能力必须以可执行场景验收，而不是以类、页面或表存在验收。

首期病例轨迹从 generation、Visible Source History、Brief、direct start、分诊、首诊、Investigation、复诊、处方与文书签署、Encounter 完诊、药品支付到发药和 Scenario Run 完成。自动化故障矩阵覆盖无合格 Index Encounter、Brief 泄漏拒绝、重复开始、模型失败、过敏拦截、旧版本冲突、支付拒绝/ambiguous、LIS 重试、未支付处方禁止发药、已签文书禁止覆盖、部分发药和 reset 后晚到结果隔离。

### 14.5 Agent 安全测试

当前自动化覆盖：

- Page Context 严格 schema、岗位/view 不匹配、Hidden Fact/任意字段拒绝和 Epoch reset 失效。
- execution proof 篡改、过期、Tool/operation/scope 不匹配、call replay 和重复 completion。
- 动态岗位/view Tool 目录、32 Tool 上限、岗位导航收窄、DSH JSON Schema 子集和 context 到期注销。
- 草稿 action 更新 context 但保持 page lease；proposal 立即返回 pending，明确批准关联 Command/Audit/Trace，取消或 scope 变化不产生 Effect。
- 固定 loopback proxy、Cookie/Origin、body/response/timeout 限制和非 loopback 拒绝。

Catalog seam 验证 operation、CLI path、HTTP mapping、岗位、风险、schema、canonical HIS route 覆盖和 FHIR 白名单。Identity seam 使用真实 SQLite 与 HTTP 验证 token hash、单岗位 allowlist、伪造 context header、Client 禁用、撤销、过期、Epoch reset、Catalog hash 和 policy version 失效。CLI process seam 验证 stdout/stderr/exit、stdin/file、human profile、Agent fail-closed 和 request shape；真实 Node listener 测试在服务端已提交但响应丢失后通过 receipt 恢复，并证明相同 idempotency key 不重复 Effect。Skill seam 要求每个命令示例存在于当前 Catalog。

当前没有附件/OCR、Agent OAuth、MCP、自治 Agent Run 或不可信插件。模型内容安全仍需在引入具体 runner 或嵌入式助手时增加针对 prompt injection、恶意病历、术语 display、附件/OCR、历史结果和出站网络的运行时测试；CLI 的结构化 schema、DSH Tool schema 与服务端授权不能替代该层验证。
