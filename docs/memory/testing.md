# 测试与验证排障

- 分页队列上的写操作回归须包含第二页及操作后仍留在同一筛选状态的场景，核对页码、患者选择与金额刷新；只测第一页或晚到回执无法发现无条件跳回第一页。支付历史分页同时验证整单余额、跨页恢复入口，以及历史页切换不改变收费队列选择。

选择验证范围、定位资源争用，或处理替身、时钟和异步断言时查阅。本文保存会影响证据有效性的操作经验；测试层级、必需检查和真实入口要求由[测试策略](../testing.md)拥有。业务专属回归另见[临床数据与模型任务排障](clinical-data.md)，宿主专属回归见[DSH 集成排障](dsh-integration.md)。

其他操作经验见[工程记忆入口](memory.md)。

## 范围、快照与资源争用

- CLI Skill 示例漂移测试读取 Markdown 后统一将 CRLF 转为 LF，再解析代码块；否则 Windows checkout 的有效 JSON 示例会被仅匹配 `\n` 的正则漏掉。统一在读取 helper 归一化，不批量改产品文档换行或放宽业务 schema。

- 新增 Operation Catalog 路径参数时，同时核对真实 UI 的持久化意图发送器：只替换已有 `admissionId` 的 adapter 不会自动绑定新的 `adjustmentId`。公开 HTTP 直接调用正确路径仍可全部通过，须从真实按钮验证请求路径及丢回执后的原意图恢复；回归见[后续医保更正入口](../../apps/web/e2e/inpatient-insurance-adjustments.spec.ts)与 React 18/19 Surface 合同。

- 跨包测试调用 Server 迁移时，显式用测试文件的 `import.meta.url` 解析 `apps/server/drizzle/` 并传给 `applyMigrations`。默认目录只覆盖 Server 包或仓库根目录；从仓库根运行测试可能通过，而 Turbo 在其他包目录执行时会报 `ENOENT`。用 `pnpm --filter <package> exec vitest run <file>` 复核实际 CI 工作目录，参见 `apps/dsh-web/src/model-bridge.test.ts`。

- 合并含独立迁移的分支时，非空旧库测试必须显式排除该历史基线尚不存在的全部迁移，不能只排除原分支待应用的文件，否则新迁移会混入旧库夹具。保留旧库固定版本、迁移完整身份和事实不变断言，当前目标版本使用 `expectedSchemaVersion()`；先验证合并前夹具失败的原因，再核对迁移顺序、重开及回滚。先例见[住院与主分支旧库迁移](../../apps/server/tests/inpatient-main-migration.test.ts)。

- 待开具项目的操作文案会随异步核验状态从“调整”变为“核对”；验证重开详情时，使用包含项目名称的稳定“查看待开具”入口，并继续断言编辑值、焦点和正式确认结果。只定位“调整”会在核验状态晚到时超时，不能用增加超时或固定等待规避；对应回归见 `apps/dsh-web/src/client/diagnosis-prescription.browser.test.ts`。

- Web composition 测试若只有总时限超时，先分段计时区分停滞与累计交互成本；状态展示、报告已阅、取消冲突、草稿删除等可独立验收的流程使用同一初始化 helper、每例重新挂载，保留请求版本、人工确认和切换病例后的隔离断言。不要把多个独立流程串在一个用例后扩大默认时限；对应回归见 `apps/web/src/app/role-workspaces.test.tsx`。

- 当前 Web 交付使用 Node.js 真实入口即可证明运行时和数据库生命周期；没有明确容器验收条件时，不安装、不启动也不要求 Docker。

- 验证必须对应 outgoing diff。纯 Markdown、设计资产或 PR 媒体变更不触发代码单元测试、全量 `pnpm test` 或 `pnpm check`；只运行 owning 文档检查、媒体解码或发布可达性检查。

- 已经通过且没有被后续变更失效的证据不因 commit、push、review、Ready 或 merge 再次运行。

- 资源竞争使既有测试超时时，可在验证进程用 `VITEST_MAX_WORKERS=1` 收窄单元测试并发，不扩大超时或削弱断言。Turbo strict 环境会过滤此变量，通过 Turbo 的验证同时使用 `TURBO_ENV_MODE=loose` 才能把 worker 设置传给 Vitest；仅设置前者不证明实际并发已经收窄。不同包仍可并行，需要进一步隔离时用 `pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1` 串行完成包级测试，再由 `pnpm check` 复用有效缓存并继续其他阶段。预验证与后续检查须保持相同的 Turbo 环境模式；strict 与 loose 使用不同任务缓存，切回默认模式可能让包级测试再次并行运行。

- 定向 Vitest 回归使用 `pnpm --filter <package> exec vitest run <file> -t <pattern>`，并核对实际文件和用例计数。当前 pnpm/Vitest 组合中，`pnpm --filter <package> test -- <file>` 把额外 `--` 传给 Vitest 后仍运行完整包，不能仅凭命令文本认定已限制范围。

- 收费真实入口和 Surface 浏览器合同从仓库根运行 Playwright，并沿用根配置。收费 HTTP fixture 以当前工作目录定位 `apps/server/drizzle`；从 `apps/web` 启动会错误查找 `apps/web/apps/server/drizzle`，尚未执行业务断言。根 runner 的 `--project=web` 与 `--project=contracts` 分别选择真实入口和组件合同。

- WSL 全仓验证的较多 Vitest worker 可能使宿主导航和长 SQLite HTTP 测试触及原有超时。先用原断言聚焦复现并区分功能失败与资源争用；核对 `taskset -pc $$` 的可用 CPU 后，可限制整个检查进程树的 CPU affinity，已实际验证 `taskset -c 0-3 pnpm check`。不通过扩大超时或改变业务时序掩盖失败。

- WSL 全量测试在高并行度下可能因 CPU 争用触发既有 5s/10s 超时，并在超时清理后出现数据库已关闭的次生错误。确认单项通过后，可用 `taskset -c 0-3 pnpm check` 限制本次验证的 CPU 亲和性，让 Node/Vitest 降低并行度；若多个包仍同时争用 CPU，先用 `taskset -c 0-3 pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1` 串行验证包级集合，再运行 `pnpm check` 复用仍有效的成功缓存。验证记录须明确 CPU affinity、worker 或串行限制，不把受限并发结果说成默认并发通过。保留完整测试集合、原断言和原超时，不修改业务实现来掩盖资源争用。`apps/server` 的单项超时为 15 秒（`vitest.config.ts`），因为完整 HTTP 闭环在 CI runner 上要 4–5 秒；仍超时时先查是否真变慢，不继续加大上限。

- 包级串行仍可能因包内测试文件并行，让 CLI 子进程启动触发原有超时。先测真实启动耗时并单独运行失败文件；若单项通过，可将上述包级集合绑定到一个空闲 CPU，让 Vitest 按 `os.availableParallelism()` 串行测试文件。也可用 `VITEST_MAX_WORKERS=2 pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1 --env-mode=loose` 显式限制文件并发；Turbo 默认 strict 环境会过滤该变量，仅在父进程设置它并不会约束包内 Vitest。选择 CPU 时避开其他正在验证的任务；不增加超时或缩减测试集合。

- 资源争用也可能是内存超卖而非 CPU：小内存宿主（如 6.8 GB 的 WSL2）上 `@clinmesh/web` 的 jsdom 套件按 `os.availableParallelism()`（16）开满 worker 时会进入 swap 抖动，失败集合每次运行都不同且与 diff 无关。先看 `free -h` 的 swap 占用区分于 CPU 争用；单项复跑通过后，对同一套件用 `pnpm --filter @clinmesh/web exec vitest run --maxWorkers=4` 重取证据（已实际验证 624/624 通过），并照上一条的规则在验证记录中注明受限并发。

- 浏览器动效的保持、淡出或 Canvas 卸载断言若在并行整组失败、单文件通过，可用 `pnpm exec playwright test --project=contracts --workers=1` 验证完整合同集合，保留原断言和超时。交付证据应区分串行集合通过与默认并行 `pnpm check` 未通过，不把单项重跑成功作为整组成功。 若点击日志停在 `performing click action`，元素已可见且稳定，先隔离其他 worktree 的构建、类型和浏览器重检查，再用原断言复现；worktree 不隔离 CPU 与内存资源。

- 浏览器合同在单文件通过、完整集合却报合成账户初始化失败时，检查前一文件的 Vite 构建是否改变了 `NODE_ENV`。Better Auth 在首次导入时捕获生产默认值，可能只在复用 worker 时触发注册限流；按原文件顺序复现并核对宿主与 bundle 的环境边界，不修改生产认证或增加注册等待。隔离方式见[测试策略](../testing.md#用户界面验证)。

- 长时间运行 `vitest run` 或 `pnpm check` 时固定被测快照。执行期间修改源码和回归可能让转换缓存与新读取的测试混用不同版本；这类结果不能作为最终提交证据，应固定代码后重跑受影响集合，只复用未被修改影响的成功检查。跨平台副本在启动最终检查前，核对任务的全部 tracked diff、新增文件清单及统一换行后的内容；只按增量复制不能证明快照完整。

- 精确运行 Vitest 文件时使用 `pnpm --filter <package> exec vitest run <file>`。脚本经 `pnpm --filter <package> test -- <file>` 转发时会保留 `--`，当前 Vitest 可能运行整个包而未应用文件筛选；以实际 Test Files 数量确认范围。

- 从仓库根目录 `npx vitest run apps/server/tests/...` 不报错且用例照常运行，但加载的是根级配置：`apps/server` 的 `testTimeout: 15_000` 静默失效、回落默认 5s，多次模型请求的重型 HTTP 测试在本机会出现看似回归的超时失败。怀疑超时回归时先核对实际生效的配置入口，再 stash 修复复跑基线判定"变慢"归属；从包目录执行或用 `pnpm --filter` 入口即为正确超时。

- Playwright 使用与锁定版本匹配的 browser cache；跨项目参考配置时同时核对 runner 版本与已安装 revision，缺失时用本仓库的 `pnpm exec playwright install chromium` 安装。运行合同与真实入口的方式见[测试策略](../testing.md#用户界面验证)。

- `tsconfig.browser.json` 的 E2E 入口会递归导入 Server 实现，但不会自动加载 Server 项目中的 ambient module 声明；Server 新增无类型依赖时，同时将对应声明文件纳入浏览器类型检查入口，不能只凭包级 `tsc` 通过判断完整类型检查通过。修改 `apps/web/e2e/` 后运行 `pnpm exec tsc --noEmit -p tsconfig.browser.json`；Playwright 会转译 TypeScript，但不做类型检查，E2E 通过不能替代这项检查。

- 医生工作台 e2e 的布局断点全部是容器查询：Playwright 默认视口 1280px 扣除应用侧栏后建议栈列不满足 1080px 容器宽度而隐藏，进入 `/consultation` 前先 `page.setViewportSize` 设定目标宽度，不以默认视口断言三栏元素。登录提交是异步请求：点击"登录"后先等待"候诊队列"可见再 `goto` 其他路由，否则跳转会中断登录请求，应用回到登录页并让后续定位超时。 “开始首诊”同样须等按钮消失、病例进入首诊后再切页签；点击返回只表示动作已派发，焦点的 `active` 不等于页签的 `aria-selected=true`。问诊恢复场景通过[真实入口测试](../../apps/web/e2e/consultation-reply-recovery.spec.ts)等待这些可观察状态，保留回答复用和重放断言。

- 全仓测试因并发争用触发既有交互超时时，先用原断言及原超时串行复现；本机需要限制 Vitest worker 时可使用 `TURBO_ENV_MODE=loose VITEST_MAX_WORKERS=1 pnpm check`。Turbo 严格环境模式会过滤未声明的 `VITEST_MAX_WORKERS`，单独设置该变量不影响其子任务；可用 dry-run 的 envMode 确认实际传递，不通过扩大超时或跳过用例制造通过。

## 替身、异步屏障与断言

- Testing Library 的 `getByRole` 使用字符串 `name` 时已按完整可访问名称匹配，不接受 Playwright 的 `exact` 选项；混用两者参数可能让 Vitest 运行通过而 TypeScript 检查失败。组件测试省略 `exact`，真实浏览器测试按 Playwright API 保留该选项。

- 验证模型手动恢复时，逐个继续意图核对实际外部派发次数，并在下一次仍失败时证明自动重试没有被一并放开；同时覆盖重放、准入拒绝和重启。任务来源 `trigger: manual` 会延续到后续阶段，不能用它证明某一次请求已获得人工授权；恢复合同见[模型执行恢复](../architecture/storage.md#模型执行恢复)。

- DSH Provider 开启用量账本后，合成 bridge 响应也须提供匹配 `attemptId`、明确 dispatch 与终态的可信核算回执；只返回模型正文、HTTP 401/429/503 或 SDK 结束事件会进入结果未知保护，不能用来验证明确失败的重试。`Persona generation failed` 时先核对任务错误码，`MODEL_OUTCOME_UNKNOWN` 可能是旧 fetch 替身缺回执；未知用量使用 `unknownModelTokenUsage`，无效 JSON 仍保留固定模型路由。超时或断流的替身保留未知语义，先核对派发与核算合同再修改生产恢复逻辑；参考[建议 HTTP 回归](../../apps/server/tests/doctor-recommendations-http.test.ts)、[控制恢复合同](../../apps/server/tests/model-control-recovery-http.test.ts)与[旧任务恢复回归](../../apps/server/tests/agent-usage-risks-reproduction.test.ts)。

- SQLite 队列扫描中的资格检查若会开启写事务，不要在尚未关闭的 `Statement.iterate()` 期间调用；事务提交可能被活动 reader 阻止，并被资格检查的安全回退表现为“始终不可恢复”。使用已完成读取的游标查询，再判断资格；回归同时验证跳过受限任务和恢复原任务，避免只证明后续任务能运行。

- 医生工作台测试替身合同由建议栈决定：完诊预览 stub 必须恰好覆盖全部 7 个条目编码（schema superRefine 拒绝缺项，`items: []` 无效）；质控 GET 需为未声明病例返回干净的 ready 默认态而不是抛错。建议栈把查询失败显式渲染为"加载失败 + 重试" alert，旧替身里原本静默的坏 stub 会以可见失败暴露；替身报错时先核对 schema 完整性再怀疑组件。

- 质控替身必须同时拦截 GET 轮询与 POST check 并在同一份 `qualityRevisions` 里回显 `clientId`/`clientRevision`：只拦 POST 时，1.5s `refetchInterval` 的 GET 因缺 clientId 触发 `DOCUMENT_QUALITY_INPUT_CHANGED` 错误路径，目标断言经由无关的 stale alert 变绿（假阳性，组件不改动测试也过）。新测试先跑一次确认无实现时确实为红，再实现转绿；`console.log` 在该 vitest 配置下不输出，取证用 `writeFileSync` 落盘 DOM 文本。

- 恢复操作保留任务代次时，回归须覆盖“服务端已受理但回执丢失”、另一入口继续后的重新读取，以及完成后迟到的受理回执；只验证本地 mutation 成功会漏掉缓存停留失败和旧传输错误阻止确认。用受控请求屏障观察持续轮询与最终可确认状态，复用[建议恢复回归](../../apps/web/src/app/doctor/doctor-preparation-state.test.tsx)和[真实 Web 恢复入口](../../apps/web/e2e/doctor-recommendation-recovery.spec.ts)，业务合同见[临床流程](../architecture/clinical-workflows.md#81-门诊闭环)。

- TanStack Mutation 的回调按选择归属提前返回，不会清除 `isSuccess`、`isError` 或 `data`。队列刷新自动选中另一患者时，结果提示与预览的渲染也须绑定原费用、作用域和选择代次；回归除核对未跳页外，还须断言新视图没有旧结果提示。复用[收费迟到响应合同](../../apps/dsh-web/src/client/billing-payments.browser.test.ts)中的真实支付提交与延迟响应屏障。

- 验证重叠请求共享一次模型执行时，先等待第二个请求的公开受理回执，再释放首个模型请求；`setImmediate` 或固定等待不能证明第二个请求已通过授权并加入执行，可能只验证到完成后的串行回放。共享执行和完成后回放分别保留断言。

- 质控问题的 Badge 与正文共享一个段落时，`getByText(message, { exact: true })` 无法单独匹配正文；将定位限定到对应字段 region，再用 `toContainText(message)` 核对，保留标签的独立断言。综合浏览器回归将生产 fixture 构建放在 `beforeAll`，分别保留构建和交互原有时限，避免编译挤占交互预算；不能增加时限掩盖真实断言失败。

- 质控旅程把未保存正文恢复成已保存稿时，界面可能直接复用保存稿的检查结果，不再发送 candidate POST；测试须按当前保存稿或候选稿选择结果，不能始终沿用最后一次 POST 的 `clientId/clientRevision`。复用[病历质控旅程](../../apps/web/e2e/doctor-document-quality-journey.ts)中的保存稿分支，避免迟到请求让验收检查旧内容。

- 排查签署质控持续“检查中”时，同时挂载正文与冻结的签署汇总，再让正文收到新医生来源；只测单个 hook 会漏掉两处请求身份互相推进的路径。复用[质控组件回归](../../apps/web/src/app/doctor/document-quality-control.test.tsx)，客户端视图隔离与服务端同输入复用的取舍见[质控输入决策](../decisions/implemented/architecture/2026-10-15-doctor-document-quality-control.md)。

- 勾选聊天风格、结果顺序或按需教学等模型行为前，核对部署 preset/persona，并以新建 Session 的实际模型请求证明规则已装配。规格描述、普通工具测试和脚本化替身的回答不能证明真实模型持续遵守这些要求；接线证据与实模体验分别记录。

- 检查后台回填不会触发额外自动保存时，在触发回填前控制 Timeout，完成回填与渲染后推进整个保存窗口，并在 finally 恢复真实时钟；不能等定时器已排定才启用假时钟。用额外保存的故障校准保留否定断言的有效性，避免用固定墙钟等待挤占 CI 用例预算。

- 浏览器回归在建议清单里调整项目后，先核对 owning UI 的草稿保存合同，再断言草稿是否存在；不要依赖一串操作恰好在 autosave 窗口内完成。需要验证草稿内容时，通过权威读模型等待完整值，并单独断言尚无正式事实，参见[处方调整合同](../../apps/dsh-web/src/client/diagnosis-prescription.browser.test.ts)与 [UI 自动保存合同](../ui/design.md)。

- jsdom 在 ShadowRoot 内切换原生 `hidden` 后可能保留旧的 computed style 缓存，造成已显示控件被无障碍查询误判隐藏。先用最小 DOM 复现确认；测试宿主属性更新可以刷新缓存，保留真实可访问性断言，不用修改生产显示逻辑或忽略隐藏状态规避。

- 隔离测试手动调用 generation、persona 或 outbox `processNext`／`dispatchPending` 时，省略 `autoDispatchIntervalMs` 以关闭自动定时器；设置为 `0` 仍会创建定时器并按最小间隔执行，与手动 claim 竞争，可能使 fixture 误报任务不存在或生成失败。需要自动处理时使用正间隔，并从公开状态等待结果。

- 多病例测试不能在同一 runtime 中反复使用完全相同的 Synthea 来源：生成按来源去重，会返回已经接诊的病例，后续 Persona 因病例状态不允许而失败。替身须返回身份或其他来源事实不同、hash 与内容一致的合成病例，并断言病例 ID 不同。

- JSDOM 中测试 Base UI Select 时，优先在 `act` 中聚焦 Trigger、通过 `user.keyboard('{Enter}')` 展开，再用 `findByRole('option')` 等待选项；单次 `user.click` 后立即 `getByRole` 在 CI 可能遇到控件仍关闭的时序。保留选中后的业务断言，不靠扩大超时或跳过校验处理。真实指针、弹层布局与 Portal 行为仍由 Playwright 合同验证。

- 真实 WebApp 的 Surface Tool 测试先等待当前病例的可观察就绪状态，再断言 Tool 注册；冷启动导入时直接等待注册可能先耗尽 RTL 默认等待时间。使用业务控件的就绪信号同步，不扩大 timeout 掩盖初始化时序。

- 工作台可以同时包含问诊输入状态和病历更新状态。测试具体状态时用 `within` 限定所属区域，不使用全页面的单数 `getByRole('status')`；保留各区域的可访问性提示及原有业务断言。

- Zod 4 的 `z.ZodError` 子类可能不满足 `instanceof Error`；诊断先识别 `z.ZodError` 并读取安全的 `issues`，否则完整校验信息也可能被误记为 `unknown`。不输出原始模型响应或凭证。

- 真实 WebApp 浏览器合同使用 `localhost` 或 HTTPS 的有效 origin：`about:blank` 的 opaque origin 无法使用存储，普通 HTTP 域名不提供 `crypto.randomUUID`。`page.setContent` 不改变 origin；直接挂载真实组件的 fixture 先注册路由并 `goto` loopback origin，再设置内容，所需 QueryClient 由 fixture 显式提供。沿用产品需要的浏览器能力，不为测试给生产代码加 polyfill。

- 临床时间按运行环境时区展示；测试核对首次核实时间未被覆盖时，从固定 ISO 时间计算当地显示值，同时保留首次时间、覆盖时间及业务状态断言。用 `TZ=UTC` 与 `TZ=Asia/Shanghai` 验证，不把 `+08:00` 原文中的钟点当作所有环境的显示时间，也不为测试改产品时区。

- 动效的逻辑寿命与真实渲染采样分开控制：窄时间窗口内的 `setTimeout` 会被机器调度推迟，不能据此断言保持阶段已经提前淡出；计时合同暂停时钟后直接取值，避免 Playwright 自动重试等待错误实现重播结束而误通过。保留真实 CSS、布局与绘制断言，取舍见[浏览器回归决策](../decisions/implemented/testing/2026-10-02-playwright-frontend-tests.md)。

- 共享 HTTP 请求替身改为异步后，调用者必须先 `await` 再判断是否命中；直接比较 Promise 与 `undefined` 会让未处理的普通请求返回空响应。`vi.fn` 的宽松返回类型可能使类型检查通过，主分支整合仍须运行受影响页面的完整测试，并同步最新目录响应合同。

- 自动保存回归中，请求替身捕获 PUT 只证明请求已经发出，不能证明回执、Query 刷新和控件状态已经同步；断言后续操作可用时须等待实际按钮状态。较长交互旅程在本地触及默认时限时，可用命令行时限区分总耗时与断言失败，不通过固定等待或放宽仓库默认时限掩盖状态竞态。

- Playwright 在页签切换后读取提示时，将 locator 限定到目标 tabpanel；退出中的旧面板可能短暂保留同名状态标记。不要用 `.first()` 或固定等待绕过双匹配，保留对目标页面状态的断言。

- Playwright 的 `.all()` 返回按序号重新解析的 locator；若操作会使元素退出当前筛选（如打开 `details:not([open])`），后续序号会移动。逐次读取当前筛选的 `first()`，或按稳定标识定位，避免漏项与超时；不要增加等待掩盖定位变化。

- Base UI 弹框关闭依赖动画帧完成卸载；Chrome `--virtual-time-budget` 下即使轮询定时器已结束，渲染帧仍可能未执行。验证关闭卸载的浏览器合同使用真实时钟并限时等待 DOM 消失，不缩减关闭断言。

- Better Auth 在 `NODE_ENV=test` 下默认跳过 origin 校验；ClinMesh Auth 必须显式保持 origin check 开启。新增 HIS 写接口仍须调用 `identity.assertTrustedMutation`，`resolveRequestActor` 只解析身份，不能替代 Origin 校验。真实 HTTP 回归覆盖 Cookie 请求缺失或不受信 Origin 时拒绝且无业务写入、受信 Origin 正常，以及无 Cookie 的纯 Agent Bearer 例外，见[手术写入口回归](../../apps/server/tests/inpatient-surgery-http.test.ts)。

- `vendor/dsh-react-surface` 的 `lib/` 是未跟踪的生成目录。ClinMesh 的 Vitest 若直接导入由 DSH 注入的 `dsh-react-surface/client` external，必须通过显式测试 alias 解析到本地 stub；测试不能依赖开发机曾构建 submodule 后遗留的 `lib/client.js`。

- 在独立 worktree 或干净克隆运行 DSH 单元测试或浏览器合同前，先执行 `pnpm --filter ./apps/dsh-web build:styles` 生成 gitignored 的 `apps/dsh-web/src/client/styles.generated.ts`；缺失时相关入口在 Vite 加载或构建阶段报 `Failed to resolve import` 或 `Could not resolve "./styles.generated.ts"`，尚未执行测试断言。该文件不进入提交。

- 浏览器合同从包级 runner 迁到根 runner 时，Vite 的 `resolve.dedupe` 会改用根目录解析 React；build 必须显式设置 owning app 的 `root`。动画回归同时保留“完成后仍保持高光”的阶段断言和有界卸载等待，固定 sleep 不能证明渲染帧已经执行。

- 首诊浏览器旅程在点击“开始首诊”后，先等待“在诊”队列已选中，再切换问诊页签。Command 回执后的队列刷新可能重建详情；只等待点击完成会把旧详情上的页签选择丢失，最终超时在“向患者提问”输入框。

- 合成 DSH 模型的异步生成器在 `yield finish` 后不保证再次恢复执行；测试完成标记放在终止事件之前，再以 outbox 无在途 claim 和公开业务状态确认消费结束。不要把终止事件后的日志缺失当作晚到写入或恢复失败。

- 验证流式用量的崩溃持久性时，在用量帧已解析、终态仍被屏障阻塞期间用 SQLite backup 取得快照，再从该快照重启并查询公开账本。先经控制接口建立各维度累计起点，再验证已知消费转入已用、未知维度继续预占、重复恢复不重复累计；只断言用量仍在会漏掉额度永久悬挂。追加实际 SDK 归一化的迟到进度与终态，覆盖累计变化和缓存分项不完整导致的已知转未知，核对双层额度及有限准入，避免恢复结算冻结后续证据。正常完成后把状态改成在途无法覆盖“已收到用量但尚未结算”的丢失窗口；复用[模型用量 HTTP 回归](../../apps/server/tests/model-usage-http.test.ts)与[Host 超期、旧未知记录和写入回滚回归](../../apps/server/tests/model-usage-host.test.ts)。

- 模型恢复的数据库故障注入须覆盖实际请求返回后的用量结算，不能只测派发前账本创建与任务结果检查点。使用临时 SQLite 的结算 UPDATE trigger，恢复写入后分别在原进程和重启后调度，经公开任务／账本查询及合成网络请求次数确认没有重发；复用[控制恢复回归](../../apps/server/tests/model-control-recovery-http.test.ts)。

- 模型超时回归同时覆盖网络异常和真实 HTTP 408／504 响应，经公开后台任务、账本及合成网络次数确认调度与重启后均不重发；只测试本地 AbortSignal 会漏掉网关超时。控制阻塞持久化则分别在首次等待和已有待办恢复时注入 INSERT 失败，并构造缺少恢复输入的旧阻塞状态，经公开病例读取、新补答和合成网络次数证明不会永久等待或重启未知尝试；复用[控制恢复回归](../../apps/server/tests/model-control-recovery-http.test.ts)与[患者回答合同](../../apps/server/tests/consultation-dialogue-http.test.ts)。

- 后台 Agent 权限回归须从带授权的真实 HTTP 入队走到任务领取，并验证派发前撤销授权会阻止模型调用。只直接检查身份服务会漏掉持久上下文 strict schema 拒绝或丢失 `agentGrantId`，以及运行时漏传操作范围的问题；复用[检验目录发布回归](../../apps/server/tests/laboratory-service-publisher-http.test.ts)。

- 更新增量病史输入后，同时运行 `pnpm smoke:consultation:native`：共享 Web 旅程通过不证明原生合成 Adapter 匹配。Fixture 需沿用[增量记录合同](../decisions/implemented/architecture/2026-10-15-low-latency-document-recording.md)的短引用与取消信号，不能依赖自动片段必有重复正文，也不能等待已取消请求正常返回。

- HTTP 上传取消回归须等原生存储实际读取第一个数据块后再断开，并等清理完成后验证重试；固定短延迟可能在路由安装取消监听器前结束请求，使测试通过却没有验证取消路径。

- 病历“未保存”提示回归须包含首次自动记录只写其他字段、`hasSavedDraft=false` 且持久主诉仍为空的场景；页面预填可能与数据库空值不同，保存基准应与编辑器采用同一份预填规则。通过[医生工作台组件](../../apps/web/src/app/role-workspaces.test.tsx)和[真实病历入口](../../apps/web/e2e/doctor-document-quality.spec.ts)同时核对页头与编辑器状态，并保留手工清空、恢复原文和清空保存刷新后的断言；只有完整人工保存稿的 fixture 无法捕获该差异。

- 交互合同类重构（如目录+表单改弹窗）会同时波及四层引用同一交互的测试：组件套件、跨页签集成套件（`role-workspaces.test.tsx`）、DSH browser 合同（fixture 渲染 `WebApp`）、`--project=web` 真实入口 e2e。只跑直接修改的套件会连续漏层：本次弹窗迁移先后两次因未跑 role-workspaces 与 web e2e 在 CI 的 `pnpm check` 才暴露。合同迁移完成后先在本机全量复跑这四层（组件 vitest、role-workspaces、`--project=contracts`、`--project=web`），再推送。

- Node 环境的纯函数回归若在导入工作台时出现 `document is not defined`，先检查新增阅片器是否把 OpenSeadragon 等 DOM 依赖提前带入模块。仅在用户展开影像时以 React.lazy/Suspense 加载既有 viewer，保持 React 18/19 共有 API，不给纯函数测试全局注入 DOM；住院入口的回归见 `inpatient-workspace.test.ts` 与[申请及责任决策](../decisions/implemented/architecture/2026-10-21-inpatient-investigations-and-transfer.md)。

- vitest 默认 `testTimeout` 5000ms 只够轻量用例；交互最重的 `role-workspaces.test.tsx` 场景（450 行、大量 userEvent）本地实测约 4 秒，CI runner 稍慢即越线，表象是三连失败且耗时压在 5000ms 附近（如 5031ms）。判定"边界慢"而非偶发 flake 的依据：多 run 失败于同一用例、超时值贴近上限、本地耗时已过半。修复沿用文件内既有 per-test 先例补 `}, 15_000)`，不改断言、不全局放宽 testTimeout。
