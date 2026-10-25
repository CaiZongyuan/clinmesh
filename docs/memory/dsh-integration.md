# DSH 集成排障

处理 Page Context/Tool 绑定、Surface、Profile、产物加载、桥接升级或宿主日志时查阅。当前行为由[系统架构](../architecture/agent-integration.md#7-agent-适配器与能力边界)、[跨端前端架构](../frontend-architecture.md#dsh-web)与[Agent 操作与反馈](../agent-capabilities.md)拥有；安装和原生验收按[部署指南](../deployment.md#dsh-web-原生入口)执行。

其他操作经验见[工程记忆入口](memory.md)。

## Page Context、Tool 与调用身份

- DSH Tool 恢复回归同时使用医生无绑定字段的纯查询 schema 和其他页面保留 `const` 的读取 schema；给所有工具套用相同绑定 fixture 会掩盖恢复合同漂移。医生目录缺失或完整 schema 无效时，残留旧式 `const` 不能提供恢复；共享工具须覆盖原请求属于医生、目录损坏仍保留来源限制的情况，并验证合法目录回退及非医生页面的绑定恢复。字段诊断还须覆盖绑定 `const` 有效但原始 schema 的根类型或其他业务参数无效的组合；只检查提取后的绑定属性会丢失这些约束。原生连续用例消费实际拒绝结果中的恢复 JSON，并核对错误调用没有 proof 或业务执行、恢复后的写操作只执行一次；合成 browserChannel 不提供真实病例隔离证据，跨患者与任务失效须复用 Surface 和 Server 授权回归。

- DSH 自动诊疗显示“请切换到有权限的岗位后重试”时，先取失败请求的 HTTP 状态、`error.code` 与操作名，核对[前端错误映射](../../apps/web/src/app/workspace-error.ts)和 [Tool 恢复规则](../agent-capabilities.md#tool-绑定与恢复)，不要仅凭提示认定岗位选错。刷新后消失的自动记录错误还需对齐启用请求与接诊成功的实际时间，区分提前触发和旧错误残留；接诊边界见[记录恢复决策](../decisions/implemented/architecture/2026-10-08-consultation-recording-recovery.md)。

- 新增辅助模型的 `schemaName` 时同步 `packages/contracts/src/model-bridge.ts` 的窄白名单，并通过真实 `DshModelProvider` 与宿主 handler 的集成测试。直接 Provider 替身会绕过这条边界，JSON 和应用测试通过仍可能在宿主报 `AI_REQUEST_FAILED`。

- 修改模型传输格式时，同步原生 smoke 中合成 `LlmAdapter` 的响应与证据指纹文件清单。旧状态机 fixture 可在测试边界转换，但新协议必须经真实 Provider 与宿主 handler 直接返回新格式，避免转换适配掩盖线上 schema 漂移。

- Surface 集成测试在 Tool 切换页面或打开影像后，须等新的受信 Tool 绑定发布再执行下一动作；控件已启用不证明已发布 action 快照同步。提案工具先返回 `awaiting-human-review`，测试在 `act` 内等待准备结果，人工点击后另行观察正式写入和 Tool result，不能用准备 Promise 代表 Command 已完成。

- 页面 Tool 读取表单时应复用控件实际使用的解析后值，并同步缓存依赖；原始输入状态可能为空，而控件已从持久化草稿或目录默认值补齐。回归同时比较人工选择后与重新打开草稿后的可见内容和 Tool 返回值。

- DSH Tool 报 `ClinMesh Tools require an active Page Context binding` 时，先核对真实调用参数中的 `contextId`、`scopeKey` 和宿主会话关联；不要根据调用顺序推断绑定被读取消耗或已过期。对照发送给模型的 schema 与实际 Tool arguments，区分模型漏传必填参数和页面签发故障。

- DSH 工具缺失时，同时检查后端 Page Context 的 `allowedOperationIds` 和前端 action 的 `enabled` 条件。失败后的恢复工具也必须经过两层筛选；仅用返回全部 catalog operations 的前端 mock，无法发现后端漏授权，需补真实 HTTP Page Context 回归。

- TanStack Query 的禁用查询在没有缓存时仍是 `isPending`，不能把可选查询的该标志直接计入 Agent 页面加载状态；使用实际首次请求的 `isLoading`，并覆盖“没有选中任务”和“选中任务等待响应”两种真实页面 Tool 交接。只断言工具已注册会漏掉读取成功后始终等待加载结束、最终 `CLINMESH_HANDOFF_TIMEOUT` 停轮的问题。

- Surface 宿主限制每个 Tool 的最终 description 不超过 512 字符；Web 包装器会追加通用编辑说明，预算必须按拼接后的文本计算。单个描述超限会使整份 lease 注册失败、全部 ClinMesh 工具缺失，不能仅以页面上下文签发成功或 mock register 测试通过判断桥接可用。

- DSH lazy-CJS 包装器会缩进多行模板字符串，导致构建产物中的 Tool 描述比源码更长；验收必须执行真实产物并检查浏览器 lease 响应。非开发模式的宿主还会缓存插件脚本，重新构建后按[部署说明](../deployment.md#dsh-web-原生入口)重新加载宿主，核对实际返回的脚本，不能仅看磁盘时间或刷新页面。

- React 缓存的 Agent action 配置必须依赖其读取的 mutation 状态。连续问诊回归须包含已有病历草稿、病例刷新先于队列完成的时序，并验证完成后的工具清单；无草稿时临时创建的文书对象可能让缓存每次重算，掩盖缺失依赖。

- DSH Surface 的页面元素位于 ShadowRoot 内，`document.getElementById` 无法找到内部标签。页面 Tool 应持有当前业务容器的 ref 并在容器内定位目标，避免误命中宿主同名元素；回归须把真实组件挂载到 ShadowRoot 后调用注册的 Tool，普通 DOM 测试不能证明宿主路径可用。

- DSH browser Tool broker 每次注册最多 32 个 Tool。医生“接诊”页按当前诊疗栏目发布，新增医生 Tool 时在 `agentToolCatalog` 中为它声明所属栏目，只有确实跨栏目的动作才不声明；跨栏目 Tool 占用每个栏目的名额。合同测试 `publishes only narrow, role-scoped tools within the broker limit` 逐个岗位、视图与栏目断言不超过 32；Web 测试切换栏目后须在 `act` 之外等待新 Tool 注册，在 `act` 回调里等待注册会因状态不刷新而超时。

- 排查 DSH Tool 参数失败时，对照该步的真实 `request/header` 与 `tool/call`：参数匹配模型收到的 schema、却被执行时新 schema 拒绝，是生成期间更新的竞态，不能只归因为模型填错；参数本身与原 schema 的 `const` 不同则属于调用输入错误。`pageRevision` 是序列化字符串，额外数组包装也会失配，不能按其展示结构重新拼装。恢复提示须按当前只读 schema 核验，不能据统一错误文案断定患者切换或目录缺失。检查 SQL 报错时先核对运行中数据库路径和当前 schema，旧演示库的表名不能用于运行库。业务 preset 与恢复规则见 [DSH 页面操作](../agent-capabilities.md)。

- DSH 工具目录交接回归必须在同一用户回合连续执行动作并检查第一条后续模型请求的实际 schema；分多个用户回合等页面稳定后再调用会漏掉竞态。测试模型收到结果后立即继续，不能用固定延时、重试或等待注册再发送第二条用户输入作为交接证据。

## Surface 品牌与执行反馈

- DSH 标签页品牌验证须覆盖初始 HTML、宿主赋值后的同步读取和刷新；布局会主动写入默认产品标题，MutationObserver 只能事后纠正，下一帧正确不能证明标签页没有闪烁。标题保护通过首页扩展在首个宿主脚本前同步规范当前 document 的标题赋值，浏览器回归覆盖同步改名、延迟改名和重复刷新。

- 整表写入工具的字段高光回归应包含只改一项、改多项、无变化、当前未保存输入与保存后表单刷新；不能把工具提交了哪些字段直接当作哪些字段发生了变化。

- Agent 视觉反馈的时序验证必须覆盖真实页面 Tool 和 Surface 工具重新注册：`connecting` 可能是同一页面发布新工具列表的正常过程，不能一概当作页面失活；仅向反馈组件注入完成事件会漏掉这类提前清理。

- Agent 状态摘要与动画资格须独立统计；回归覆盖提案仍在准备、另一动作已完成的并发顺序，避免用动画筛选漏掉静态执行状态。当前语义由[环绕柔光 Agent Note](../decisions/implemented/architecture/2026-10-07-agent-workspace-glow.md)拥有。

- 替换 Agent 反馈渲染器时，分别处理真实执行、完成反馈可见性与资源清理，沿用既有完成停留合同。快速本地 Tool 的开始和完成可能被 React 合并为一次渲染，不能依赖执行阶段创建过 Canvas；回归须包含同批开始/完成、静态停留与停止绘制，并保持业务无额外延迟。当前时序由[能力参考](../agent-capabilities.md#反馈时序)拥有。

- DSH 页面未显示前端修改时，区分磁盘产物、宿主按 revision 实际提供的 `/plugins` 脚本与浏览器已加载的页面；不能只凭独立 Web 通过就声明当前 DSH 已生效。Surface 布局复现应使用宿主的 ShadowRoot 基础样式（尤其 `contain: strict` 与内容容器），并断言弹层文字没有超出 Surface 边界。

- DSH SDK 会把适配器迭代时抛出的普通异常归一化为 `finish:error/UNKNOWN`；测试直接抛错的简化 stream 会绕过这个转换，掩盖把网络中断当作明确失败的问题。通过真实 `LlmAdapter` 注入合成断流，核对未知结算、已知用量、任务重建不重发与人工继续；恢复分类由[模型控制恢复决策](../decisions/implemented/architecture/2026-10-21-model-request-control-recovery.md)拥有。

## Profile、构建与桥接升级

- DSH 能打开但没有“医院工作台”入口时，先查启动终端的 `entry did not activate` / `failed to import`；宿主导入失败不会出现在浏览器 Console。共享 contracts 的相对导入须保留 `.ts` 扩展名，Bun、Vite 和 Vitest 的解析成功不能证明原生 Node 可加载。用 `node --input-type=module -e "await import('./apps/dsh-web/lib/index.js')"` 验证实际 Host artifact；[原生 ESM 回归](../../packages/contracts/tests/native-esm.test.ts)覆盖所有公开合同入口。修复后重启 DSH 宿主，再核对入口。

- DSH 产物体积受 Bun 编译器版本影响；本地或 CI 超标时，先用 CI 的精确 Bun 版本构建同一源码和锁定依赖再比较，不能直接归因于依赖漂移或放宽预算。预算与已验证版本见[体积预算决策](../decisions/implemented/testing/2026-10-07-dsh-client-size-budget.md)。

- DSH 构建标记不证明子模块的已安装依赖完整。启动时报缺少 peer 包时，在 owning workspace 按锁执行 `bun install --frozen-lockfile` 并检查 tracked diff；不要仅因已有构建标记跳过依赖修复，也不要修改上游源码绕过缺失依赖。

- 本地 UI 修改交付前先确认用户正在使用的入口。热更新页面通过不能证明 Server 静态 Web 或 DSH Surface 已更新；按实际入口重建对应 artifact，并核对服务返回的资源。构建与启动方式见[部署指南](../deployment.md)。

- DSH 报插件 overlay `ENOENT` 时，同时核对该包声明的 patch、入口文件和本地安装内容；已禁用的插件仍可能在 Profile 合成阶段读取 overlay。若同版本官方 tarball 包含缺失文件，先核验 registry integrity 并备份本地目录，再恢复缺失文件；启动并验证带凭证首页后，停止验证实例，避免占用用户手动启动的端口。

- 手动通过 Node `--env-file` 启动全局 DSH 时使用 `.env` 的绝对路径。`dshmarket` 调用 DSH CLI 更新插件时继承 `process.execArgv`，但把工作目录切到 CLI 所在目录；相对路径会让更新和旧构建恢复同时报 `.env: not found`。修正启动参数后再验证同一全局 Profile，不修改上游源码。

- DSH 的启动地址包含临时访问 token，直接请求无凭证的 `/` 不能证明 Web 是否就绪。隔离 smoke 在内存中使用启动 token 完成登录，再携带返回的 Cookie 检查首页；保存或发布启动日志前必须移除该 token。候选子进程使用受限环境和临时 npm 用户配置，不能把父进程的 GitHub/npm/模型凭证传给安装脚本。

- 审查自动升级时同时核对人工提交历史和最终执行目标：快进追加仍可能覆盖人工指定的支持 SHA。版本号相同也不能证明安装内容相同；发现摘要必须绑定实际下载文件与重建锁。当前保护和恢复方式见[DSH 持续升级](../deployment.md#dsh-持续升级)。

- 本地项目目录迁移后，DSH Profile 的 `link:` 插件依赖可能仍指向旧绝对路径。`pnpm dsh:setup` / `pnpm dev:dsh` 每次启动都会重验 `.data/dsh-runtime` Profile 的三个链接并自动修复指向当前仓库，无需人工处理；仓库外手工维护的沙箱仍需按原方法备份 Profile 的 `package.json` 核对更新并运行 `dsh plugin --profile web install`，插件自身依赖须在各自 workspace 按锁恢复。启动见[部署指南](../deployment.md)。

- DSH React Surface Client 以 classic lazy-CJS 加载；任何构建后仍存在的 `import.meta` 都会在模块执行前触发语法错误，即使该分支在运行时不可达。开发标记使用可被构建器静态消除的 `process.env.NODE_ENV`，artifact verifier 必须拒绝残留 `import.meta`。

- Surface 上游构建器会把已压缩的依赖重新排版；ClinMesh 构建还会执行本地空白压缩，实际增量应比较完整构建后的 `lib/client.js`，不能按第三方压缩文件大小估算。排查打印开销时分别保留上游输出和最终输出；不要用第二次 `Bun.build` 代替本地打印步骤，它会将 factory 的 `require` 重命名，使只匹配原名的白名单检查漏检。当前方案与验证边界见[产物压缩决策](../decisions/implemented/testing/2026-10-22-dsh-client-whitespace-compaction.md)。第三方压缩入口没有类型声明时，在 `apps/web` 放环境模块声明并在 `apps/dsh-web/tsconfig.json` 的 `include` 中列出；oxlint 不允许三斜线引用。

- 独立 worktree 不包含 `vendor/dsh-react-surface/packages/runtime/lib/`；运行原生 DSH 验收前按锁定 commit 构建 Runtime 并核对 `index.js`、`client.js`，只构建 ClinMesh Surface 不能满足这项前置。临时 Profile 的首次入口先等待并选择工作区，再等待医院菜单；验收使用与断言一致的浏览器 locale，避免把尚未出现的菜单或默认英文误判为业务失败。部署顺序见[DSH 原生入口](../deployment.md#dsh-web-原生入口)。

- DSH 的内置 bundle 由宿主槽位提供；Profile 不重复安装它们的依赖闭包。出现 `profile reload requires the root Include entry` 时，先比较官方默认 Profile，再核对配置编辑器与启动入口解析出的 `dsh-app-boot` 是否是同一模块实例。HTTP 首页成功不能证明设置持久化和热重载可用；当前装配与验收归属见[部署指南](../deployment.md#dsh-web-原生入口)。

- DSH 0.2.1 不再发布 invariants 服务；升级桥接组件时移除未使用依赖及已下线的可选 companion，不能拼造同版本包。JSONL 持久化插件使用命名空间入口；新版 present 需要 working-directory 服务，隔离文件系统的 preset 同时隔离该服务。全新无模型 Profile 的 GUI 回归依次点击预览说明的继续、添加 API Key、稍后配置，再断言弹框消失；两步引导之间侧栏短暂可点不证明启动完成，不能用任意设置标记替代版本化确认。原生模型设置 smoke 固定浏览器语言并经宿主实际菜单进入；不能依赖常驻设置按钮。升级宿主时同时核对部署教程中手工 checkout 的桥接 SHA 与上游锁；自动搭建和 CI 通过不能证明复制的手工命令仍使用已验收组合。

- 桥接升级须逐项核对安装示例中的包与 owning manifest；代码和锁文件检查通过，仍可能遗漏示例里的旧 Cordis 或已下线服务。跨仓库合并已经验收的精确支持提交时，保留其 SHA 在主分支历史中，合并后确认锁定来源的全新 clone 可检出该 SHA，避免 squash 后只依赖临时 PR 分支。

- `pnpm upstream:verify` 在全部检查通过后才写入候选锁，不能证明写锁后的版本提取测试仍通过。启动器单测使用固定输入验证字段提取，不把当前锁文件与旧发行常量绑定；最终 CI 同时检查提交后的真实锁组合。

- DSH 0.2 的会话列表不再含 `current`；应用和桥接订阅公开的 `uiSession.adapter.current`，从 binding 的 `key` 读取主会话。依赖与类型检查通过后还需在真实宿主核对 Page Context 签发和 lease：旧字段会让页面正常显示，却静默跳过 Agent 发布。

- DSH 的 Snapshot Store 是带实例方法的公开服务；给 `useSyncExternalStore` 传回调时通过 `() => store.getSnapshot()` 与 `(listener) => store.subscribe(listener)` 保留 receiver，并把包装放在注册作用域保持稳定。只用箭头函数 stub 会漏掉真实宿主中的 `refreshSnapshot` 绑定错误；会话历史回归使用依赖 `this` 的 Store fixture。

- Cordis 插件新增 `ctx.llm` 等服务读取时，同步声明使用该服务的 `inject`，或在对应 `ctx.inject` 子作用域执行。裸根 Context 上直接安装 bridge 的测试会掩盖真实插件作用域中“未注入服务”的失败；来源与工具执行回归至少一条通过 `ctx.plugin` 加载实际插件。

- DSH 桥接升级时同步核对 runtime peers、CI 安装的 CLI 和兼容说明；React Surface 的 E2E 从 runtime peer 读取期望版本，旧 CLI 会在挂载前退出。DSH 0.2 的桌面首次启动向导新增“开始设置 → 跳过 → 我知道了”；真实入口测试须通过可见按钮正常关闭向导后再操作侧栏，不能强制点击穿透遮罩。向导保存和换页是异步过程，应有界等待侧栏恢复可交互，并在失败时报告残留弹窗文字；固定点击轮数在本地通过后仍可能在 CI 提前退出。CI 成功日志不打印带临时访问 token 的启动 URL 或宿主原始 stdout。

- 审查 `dsh-ag-ui` 的宿主合同升级时，根目录 `pnpm check` 只检查 Gateway；嵌入入口 `dsh-ag-ui-adapter` 有独立的宿主、Cordis 和 loader 依赖，必须同步核对其 manifest 与实际锁定版本。pnpm 11 的 `--workspace-root` 会把递归命令限制在根包，覆盖整个 workspace 应使用 `pnpm -r --workspace-concurrency=1 --include-workspace-root check`；adapter 测试会构建 Gateway，串行执行避免与根包构建互相清理产物。用真实工具结果验证调用身份和正文，只验证纯文本对话不能发现工具消息结构失配。

- DSH 0.2 JSONL 持久化允许延迟物化会话，`append` 是尽力写入，`sessionPersistence.flush()` 或 handle 的 `flush()` 才是持久化屏障。验证 SIGKILL 后恢复时先建立该屏障，不能用固定延迟代替落盘证据。

- 新 clone 或 worktree 单独运行 DSH client 测试前，先生成 `styles.generated.ts`（`pnpm --filter @clinmesh/dsh-web build:styles`，包级 `typecheck` 也会生成）。首次样式生成与 Vitest 入口加载不能并行，否则 `index.test.ts` 会因缺少生成文件而在收集阶段失败；这种环境失败不能作为有效的行为回归 red。

- DSH 0.2 的 `ctx.remote` RPC 返回 `{ ok, value }` 或 `{ ok: false, error }`，失败不一定抛异常。适配器先验证并解包，再验证业务数据；stub 也要保留该包装。自定义 `LlmAdapter.listModels(provider)` 的每个模型必须带匹配的 `provider` 字段，仅有 `id/name` 会被宿主目录拒绝。真实 Profile smoke 可以发现这两类被宽松 stub 掩盖的合同错误。

- 原生 DSH 验收中，`createClinMeshRuntime` 的 `dshModelBridge` 与 `dshBridgeSecret` 分别启用辅助模型和 Agent Page Context，必须独立装配；模型正常不证明工具授权接口已启用。建立原生 Session 后从 launcher 打开 Surface；宿主刷新会关闭 Surface，需要重新打开，并等待当前浏览器客户端的 `/lease` 成功响应。控件启用或旧客户端注册成功不足以证明当前工具可调用，刷新后的 lease 竞争应通过当前注册状态等待，不能用固定延迟替代。

- 新 worktree 的原生 DSH 验收还需要构建锁定 Surface runtime；只构建 ClinMesh 不能提供外部 `dsh-react-surface/client`。宿主报该模块未进入 client module table 时，在子模块按锁执行 `bun install --frozen-lockfile` 和 `bun run build:runtime`，不修改上游源码；普通 React 浏览器合同通过不证明宿主外部模块已安装。

- 原生 DSH 合成模型替身须覆盖宿主的医生任务意图识别；这条辅助请求接收单条医生原文而非业务 JSON。只实现患者与病史输出的替身会在页面 Tool 前报 `CLINMESH_DELEGATION_UNCONFIRMED`，服务端没有工具记录；按真实输入返回 `discuss` 或合法委托结果，不能跳过执行授权。

- 原生 DSH 验收的临时插件也须在 manifest 中声明非空 `name` 和 `version`。官方 DeepSeek 的插件清单扩展会检查全部 active package；缺少版本时真实模型请求在发出 HTTP 前失败为 `REQUEST_EXTENSION`，合成 adapter 不经过这条扩展，不能证明真实 Provider 可用。

## 模型桥与诊断日志

- 验证桥接派发与调用配置时，至少一条回归使用真实 Cordis/DSH SDK 与合成 `LlmAdapter`；直接替换 `llm.stream` 会跳过 SDK 能力预检和默认配置，掩盖零派发却计数及历史策略遗漏。对照 adapter 实际收到的配置、公开账本和用量帧后、终态前的重启快照，复用[模型桥回归](../../apps/dsh-web/src/model-bridge.test.ts)和[账本 HTTP 回归](../../apps/server/tests/model-usage-http.test.ts)；当前合同见[模型账本](../architecture/storage.md#910-模型调用账本)。

- 独立 Server 测试导入 Host handler 后，Server 编译不会自动经过插件 `index.ts` 的类型增强入口。Host 模块依赖 `Context.webServer`、会话投影或用户问题服务时，在该模块显式保留相应 `import type {}`，不依赖其他入口的导入顺序；同时运行全仓类型检查和 `tsconfig.browser.json`，仅 Host 包编译通过不足以证明跨入口类型完整。

- 多个 worktree 共用 `CLINMESH_DSH_SANDBOX` 时，Profile 中的 `plugins/clinmesh` 与 `plugins/react-surface` 是可变共享链接；只确认 Server 的 cwd 和健康检查不足以证明 Surface 来自同一分支。需要隔离时，先正常停止宿主，再复制独立 Profile 以保留 Provider 与会话，并使用独立 sandbox。通过符号链接复用锁定的版本槽时，`dshvm exec` 可能按真实槽路径重新选择旧隔离目录，覆盖传入的 `DSH_HOME`；可直接运行锁定的宿主 CLI 并显式传入独立 `DSH_HOME`。核对运行中宿主的实际 `DSH_HOME`、两层插件链接、实际返回的客户端合同及真实登录结果，业务数据库仍沿用各 worktree 已确认的数据副本。

- DSH 模型流以 `finish.reason` 携带标准失败码，消费方按 code 分类，不解析原始消息或把所有失败归成网络故障。超时回归同时覆盖宿主返回 `TIMEOUT` 与本地 `AbortSignal` 到期；只验证本地计时器会漏掉宿主超时被误归为调用失败的路径。同一 Provider 下的模型可有不同访问权限；单模型返回 403 不证明整个 Provider 不可用。可用性验证通过真实桥接向其他完整 Provider／model 路由发送最小合成请求，不修改已有任务绑定，也不输出凭据或模型私有输入。

- DSH 桥接在截止时间附近报 `UND_ERR_SOCKET` 时，分别用 gzip 与 identity 协商复现。宿主压缩中间件可能延迟设置 `writableEnded`，超时回调和模型取消后的 catch 会据此重复写响应；仅用原生 `node:http` listener 的测试无法发现。使用实际 DSH WebServer 的压缩路径验证，响应归属规则见[模型调用预算](../decisions/implemented/bug-fix/2026-10-08-consultation-model-output-budget.md)。

- DSH 的 `session.v4.jsonl.zstd` 日志含连续 Zstandard frames；Node `zstdDecompressSync` 可能只返回首个 frame。读取时按 `{ info: true }` 返回的 `engine.bytesWritten` 推进，校验消费边界并拼接全部解压内容后再解析 JSONL，不能把首段未找到调用当作整份日志没有证据。诊断输出只保留必要的 Tool 名称、绑定字段与结果码，不输出凭据或完整医疗内容。

- 原生实模验收的 `verificationEnvironment` 会净化子进程环境；配置了 `HTTPS_PROXY` 仍须显式传递 `NODE_USE_ENV_PROXY=1`。排查全阶段模型超时时先对同一 API 做无凭据连通性探测，区分隔离 Node 没有启用代理与输入规模、推理档位问题；本机桥接保留 `NO_PROXY` 的 loopback 排除项。操作入口由[真实模型验收](../deployment.md#问诊自动记录原生验收)拥有。
