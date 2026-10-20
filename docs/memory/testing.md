# 测试与验证排障

选择验证范围、定位资源争用，或处理替身、时钟和异步断言时查阅。本文保存会影响证据有效性的操作经验；测试层级、必需检查和真实入口要求由[测试策略](../testing.md)拥有。业务专属回归另见[临床数据与模型任务排障](clinical-data.md)，宿主专属回归见[DSH 集成排障](dsh-integration.md)。

其他操作经验见[工程记忆入口](memory.md)。

## 范围、快照与资源争用

- 当前 Web 交付使用 Node.js 真实入口即可证明运行时和数据库生命周期；没有明确容器验收条件时，不安装、不启动也不要求 Docker。

- 验证必须对应 outgoing diff。纯 Markdown、设计资产或 PR 媒体变更不触发代码单元测试、全量 `pnpm test` 或 `pnpm check`；只运行 owning 文档检查、媒体解码或发布可达性检查。

- 已经通过且没有被后续变更失效的证据不因 commit、push、review、Ready 或 merge 再次运行。

- 资源竞争使既有测试超时时，可在验证进程用 `VITEST_MAX_WORKERS=1` 收窄单元测试并发，不扩大超时或削弱断言。Turbo strict 环境会过滤此变量，通过 Turbo 的验证同时使用 `TURBO_ENV_MODE=loose` 才能把 worker 设置传给 Vitest；仅设置前者不证明实际并发已经收窄。不同包仍可并行，需要进一步隔离时用 `pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1` 串行完成包级测试，再由 `pnpm check` 复用有效缓存并继续其他阶段。

- 定向 Vitest 回归使用 `pnpm --filter <package> exec vitest run <file> -t <pattern>`，并核对实际文件和用例计数。当前 pnpm/Vitest 组合中，`pnpm --filter <package> test -- <file>` 把额外 `--` 传给 Vitest 后仍运行完整包，不能仅凭命令文本认定已限制范围。

- WSL 全仓验证的较多 Vitest worker 可能使宿主导航和长 SQLite HTTP 测试触及原有超时。先用原断言聚焦复现并区分功能失败与资源争用；核对 `taskset -pc $$` 的可用 CPU 后，可限制整个检查进程树的 CPU affinity，已实际验证 `taskset -c 0-3 pnpm check`。不通过扩大超时或改变业务时序掩盖失败。

- WSL 全量测试在高并行度下可能因 CPU 争用触发既有 5s/10s 超时，并在超时清理后出现数据库已关闭的次生错误。确认单项通过后，可用 `taskset -c 0-3 pnpm check` 限制本次验证的 CPU 亲和性，让 Node/Vitest 降低并行度；若多个包仍同时争用 CPU，先用 `taskset -c 0-3 pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1` 串行验证包级集合，再运行 `pnpm check` 复用仍有效的成功缓存。验证记录须明确 CPU affinity、worker 或串行限制，不把受限并发结果说成默认并发通过。保留完整测试集合、原断言和原超时，不修改业务实现来掩盖资源争用。`apps/server` 的单项超时为 15 秒（`vitest.config.ts`），因为完整 HTTP 闭环在 CI runner 上要 4–5 秒；仍超时时先查是否真变慢，不继续加大上限。

- 包级串行仍可能因包内测试文件并行，让 CLI 子进程启动触发原有超时。先测真实启动耗时并单独运行失败文件；若单项通过，可将上述包级集合绑定到一个空闲 CPU，让 Vitest 按 `os.availableParallelism()` 串行测试文件。也可用 `VITEST_MAX_WORKERS=2 pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1 --env-mode=loose` 显式限制文件并发；Turbo 默认 strict 环境会过滤该变量，仅在父进程设置它并不会约束包内 Vitest。选择 CPU 时避开其他正在验证的任务；不增加超时或缩减测试集合。

- 浏览器动效的保持、淡出或 Canvas 卸载断言若在并行整组失败、单文件通过，可用 `pnpm exec playwright test --project=contracts --workers=1` 验证完整合同集合，保留原断言和超时。交付证据应区分串行集合通过与默认并行 `pnpm check` 未通过，不把单项重跑成功作为整组成功。

- 长时间运行 `vitest run` 或 `pnpm check` 时固定被测快照。执行期间修改源码和回归可能让转换缓存与新读取的测试混用不同版本；这类结果不能作为最终提交证据，应固定代码后重跑受影响集合，只复用未被修改影响的成功检查。跨平台副本在启动最终检查前，核对任务的全部 tracked diff、新增文件清单及统一换行后的内容；只按增量复制不能证明快照完整。

- 精确运行 Vitest 文件时使用 `pnpm --filter <package> exec vitest run <file>`。脚本经 `pnpm --filter <package> test -- <file>` 转发时会保留 `--`，当前 Vitest 可能运行整个包而未应用文件筛选；以实际 Test Files 数量确认范围。

- Playwright 使用与锁定版本匹配的 browser cache；跨项目参考配置时同时核对 runner 版本与已安装 revision，缺失时用本仓库的 `pnpm exec playwright install chromium` 安装。运行合同与真实入口的方式见[测试策略](../testing.md#用户界面验证)。

- `tsconfig.browser.json` 的 E2E 入口会递归导入 Server 实现，但不会自动加载 Server 项目中的 ambient module 声明；Server 新增无类型依赖时，同时将对应声明文件纳入浏览器类型检查入口，不能只凭包级 `tsc` 通过判断完整类型检查通过。修改 `apps/web/e2e/` 后运行 `pnpm exec tsc --noEmit -p tsconfig.browser.json`；Playwright 会转译 TypeScript，但不做类型检查，E2E 通过不能替代这项检查。

- 医生工作台 e2e 的布局断点全部是容器查询：Playwright 默认视口 1280px 扣除应用侧栏后建议栈列不满足 1080px 容器宽度而隐藏，进入 `/consultation` 前先 `page.setViewportSize` 设定目标宽度，不以默认视口断言三栏元素。登录提交是异步请求：点击"登录"后先等待"候诊队列"可见再 `goto` 其他路由，否则跳转会中断登录请求，应用回到登录页并让后续定位超时。

- 全仓测试因并发争用触发既有交互超时时，先用原断言及原超时串行复现；本机需要限制 Vitest worker 时可使用 `TURBO_ENV_MODE=loose VITEST_MAX_WORKERS=1 pnpm check`。Turbo 严格环境模式会过滤未声明的 `VITEST_MAX_WORKERS`，单独设置该变量不影响其子任务；可用 dry-run 的 envMode 确认实际传递，不通过扩大超时或跳过用例制造通过。

## 替身、异步屏障与断言

- 医生工作台测试替身合同由建议栈决定：完诊预览 stub 必须恰好覆盖全部 7 个条目编码（schema superRefine 拒绝缺项，`items: []` 无效）；质控 GET 需为未声明病例返回干净的 ready 默认态而不是抛错。建议栈把查询失败显式渲染为"加载失败 + 重试" alert，旧替身里原本静默的坏 stub 会以可见失败暴露；替身报错时先核对 schema 完整性再怀疑组件。

- 质控替身必须同时拦截 GET 轮询与 POST check 并在同一份 `qualityRevisions` 里回显 `clientId`/`clientRevision`：只拦 POST 时，1.5s `refetchInterval` 的 GET 因缺 clientId 触发 `DOCUMENT_QUALITY_INPUT_CHANGED` 错误路径，目标断言经由无关的 stale alert 变绿（假阳性，组件不改动测试也过）。新测试先跑一次确认无实现时确实为红，再实现转绿；`console.log` 在该 vitest 配置下不输出，取证用 `writeFileSync` 落盘 DOM 文本。

- 恢复操作保留任务代次时，回归须覆盖“服务端已受理但回执丢失”、另一入口继续后的重新读取，以及完成后迟到的受理回执；只验证本地 mutation 成功会漏掉缓存停留失败和旧传输错误阻止确认。用受控请求屏障观察持续轮询与最终可确认状态，复用[建议恢复回归](../../apps/web/src/app/doctor/doctor-preparation-state.test.tsx)和[真实 Web 恢复入口](../../apps/web/e2e/doctor-recommendation-recovery.spec.ts)，业务合同见[临床流程](../architecture/clinical-workflows.md#81-门诊闭环)。

- 验证重叠请求共享一次模型执行时，先等待第二个请求的公开受理回执，再释放首个模型请求；`setImmediate` 或固定等待不能证明第二个请求已通过授权并加入执行，可能只验证到完成后的串行回放。共享执行和完成后回放分别保留断言。

- 质控问题的 Badge 与正文共享一个段落时，`getByText(message, { exact: true })` 无法单独匹配正文；将定位限定到对应字段 region，再用 `toContainText(message)` 核对，保留标签的独立断言。综合浏览器回归将生产 fixture 构建放在 `beforeAll`，分别保留构建和交互原有时限，避免编译挤占交互预算；不能增加时限掩盖真实断言失败。

- 诊断、处方浏览器合同填写有效草稿后，先等待对应 `[data-agent-section]` 内的“草稿已自动保存”，再切换外观或检查焦点。保存期间编辑区会暂时禁用并清除焦点；`focus()` 只执行一次，后续 `toBeFocused()` 重试不会重新聚焦。沿用 [Web E2E](../../apps/web/e2e/diagnosis-prescription.spec.ts) 的保存完成条件，保留原断言与超时，避免用固定等待或重复聚焦掩盖竞态。

- 勾选聊天风格、结果顺序或按需教学等模型行为前，核对部署 preset/persona，并以新建 Session 的实际模型请求证明规则已装配。规格描述、普通工具测试和脚本化替身的回答不能证明真实模型持续遵守这些要求；接线证据与实模体验分别记录。

- 检查后台回填不会触发额外自动保存时，在触发回填前控制 Timeout，完成回填与渲染后推进整个保存窗口，并在 finally 恢复真实时钟；不能等定时器已排定才启用假时钟。用额外保存的故障校准保留否定断言的有效性，避免用固定墙钟等待挤占 CI 用例预算。

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

- Better Auth 在 `NODE_ENV=test` 下默认跳过 origin 校验；ClinMesh Auth 必须显式保持 origin check 开启，相关 HTTP 测试同时携带会话 Cookie 和 `Origin`，否则无法捕获开发 Web origin 的 CSRF 配置回归。

- `vendor/dsh-react-surface` 的 `lib/` 是未跟踪的生成目录。ClinMesh 的 Vitest 若直接导入由 DSH 注入的 `dsh-react-surface/client` external，必须通过显式测试 alias 解析到本地 stub；测试不能依赖开发机曾构建 submodule 后遗留的 `lib/client.js`。

- 在独立 worktree 或干净克隆运行 DSH 浏览器合同前，先执行 `pnpm --filter ./apps/dsh-web build:styles` 生成 gitignored 的 `apps/dsh-web/src/client/styles.generated.ts`；缺失时相关 fixture 在 Vite 构建阶段报 `Could not resolve "./styles.generated.ts"`，表象是成批 dsh-web 合同失败而非单条断言失败。该文件不进入提交。

- 浏览器合同从包级 runner 迁到根 runner 时，Vite 的 `resolve.dedupe` 会改用根目录解析 React；build 必须显式设置 owning app 的 `root`。动画回归同时保留“完成后仍保持高光”的阶段断言和有界卸载等待，固定 sleep 不能证明渲染帧已经执行。

- 首诊浏览器旅程在点击“开始首诊”后，先等待“在诊”队列已选中，再切换问诊页签。Command 回执后的队列刷新可能重建详情；只等待点击完成会把旧详情上的页签选择丢失，最终超时在“向患者提问”输入框。

- 合成 DSH 模型的异步生成器在 `yield finish` 后不保证再次恢复执行；测试完成标记放在终止事件之前，再以 outbox 无在途 claim 和公开业务状态确认消费结束。不要把终止事件后的日志缺失当作晚到写入或恢复失败。

- 更新增量病史输入后，同时运行 `pnpm smoke:consultation:native`：共享 Web 旅程通过不证明原生合成 Adapter 匹配。Fixture 需沿用[增量记录合同](../decisions/implemented/architecture/2026-10-15-low-latency-document-recording.md)的短引用与取消信号，不能依赖自动片段必有重复正文，也不能等待已取消请求正常返回。

- HTTP 上传取消回归须等原生存储实际读取第一个数据块后再断开，并等清理完成后验证重试；固定短延迟可能在路由安装取消监听器前结束请求，使测试通过却没有验证取消路径。
