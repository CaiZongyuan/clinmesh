# 工程记忆

本文保存用户的稳定协作偏好和从实际操作中提炼的低频坑。产品行为、架构和测试合同仍由各自 owner 文档负责；高频且每次都必须看到的防错规则提升到根或子目录 `AGENTS.md`。

## 协作与交付偏好

- 用户更换 ClinMesh 模型后，希望新请求和新的人工重试采用新选择；正在执行的请求保持原模型，已有成功结果只在显式重新生成时调用新模型。具体行为由[系统架构](../architecture.md#103-场景定义)拥有。

- DSH 原生文件全屏应完整覆盖 HIS。不得为让 HIS 控件始终可点而抬高整个 Surface 层级；退出文件全屏后再操作 HIS。菜单也应沿用正常覆盖关系，不能通过逐层抬高 z-index 修补遮挡。

- 已确认局部 UI 调整方向且用户明确要求“直接开干”时，以当前对话作为实施合同，直接完成本地修改和必要验证，不再增加 issue 草稿、拆票或阶段确认；外部发布仍按已有授权执行。
- 不使用 superpowers 插件及其 skills；开发与交付遵循仓库自身工作流。
- 开发协作偏好按任务选择独立 skills，常用能力是代码简化和文档编写；不恢复 DSH 系列 skills 或强制贯穿每项任务的完整开发生命周期。
- ClinMesh 与实际必需的 DSH 桥接组件（React Surface、AG-UI）持续适配最新公开正式版和 RC，不跟踪 alpha。升级范围按实际需要确定，不因插件已安装就升级或逐项验收全部插件；其他插件保留原配置和数据。接口或行为变化时主动更新 ClinMesh 和必要组件，不以长期停留旧版本或修改 DSH 来迁就旧实现作为维护方案；DSH 官方仓库 `deepseek-ai/deepseek-harness` 由官方维护，不修改其源码，也不维护宿主补丁或 fork；集成需求由 ClinMesh 与必要桥接组件通过现有宿主扩展能力实现，能力不足时调整方案。桥接组件未及时适配时优先贡献修复，必要时维护桥接组件 fork。依赖锁用于复现已验证组合，不代表停止跟进上游。持续升级自动创建 PR，由用户决定合并。
- 已批准的 spec、测试 seam 和拆票结构没有未决分支时，直接实施，不重复展示最终待发布全文，也不逐项请求内容批准。
- 用户要求“完整整个 issue”时，一口气完成全部 tickets，最终只提一个集成 PR。Tickets 用于执行和追踪，不自动等于一个 ticket 一个 PR。
- Merge、发布或合并现有工作区变更仍以用户明确授权为边界；授权已经给出后直接执行，不再增加一次确认。
- 用户授权合并 PR 时，收尾包含切回本地 `main`、同步到最新 `origin/main`，并删除该 PR 已合并的本地开发分支；先确认没有未保存修改、合并后新增提交或其他 worktree 占用，保留这些内容后再清理。涉及子模块开发提交时，同时核对子模块的 PR、主分支和父仓库引用，取得该仓库的合并授权后完成对应收尾。
- 用户明确要求把当前工作区 changes 一并提交时，先辨认并保真保存这些修改，再纳入目标 PR；不丢弃、不改写为自己的内容，也不额外推送原工作分支。
- 用户询问进度时，先报告已经完成、正在处理和剩余阻塞，然后继续执行，除非用户要求暂停。
- 用户询问合成演示账号或密码时，从当前 Scenario 或 seed owner 直接给出可试用信息；真实凭证、平台密钥和患者信息永不写入本文或公开 artifact。
- 用户要求运行开发分支进行手工测试时，启动该分支的真实应用，沿用已有 Provider 配置和完整参考目录，并使用持久化业务数据；需要隔离时使用现有数据的一致备份，明确告知数据副本的边界，不用少量 fixture 代替实际运行环境。
- UI 预览参考 `agentic-axum-saas-demo` 的体验设计方式，按任务交付可运行且保留版本的交互体验，不在正式 Web 内维护长期 mock 展示站或方案切换器；具体规则见[交互预览](../agent-development.md#交互预览)。

- ClinMesh 与 DSH 会话保持左右分屏，不因窄窗口改为上下排列或自动全屏。DSH 模式的岗位导航直接铺在宿主侧栏“新会话”和“工作区”之间，底部按钮保留“医院工作台”，仅点开后的菜单内部标题显示“设置”；菜单保留设置与应用操作，DSH 内的 ClinMesh 始终跟随宿主主题，不提供独立主题选择，ClinMesh 内部不显示左侧栏；独立 Web 保留侧栏。全屏由用户手动切换，切换与返回按钮放进现有页头，不额外占一行；全屏时先返回分屏再使用宿主导航。账户与岗位切换保留在页头，右上角账户菜单不放设置入口；设置统一由左侧栏承接，独立 Web 使用侧栏底部入口。

- 当前 DSH 环境作为 ClinMesh 工作台使用：宿主左侧栏的 Logo 与名称固定显示 ClinMesh，不随应用打开或关闭切回 DSH；使用官方品牌插槽和项目现有标志。新会话中央也使用该标志与项目产品标语，不保留鲸鱼和“探索未至之境”。

## 产品参考优先级

- Agent 操作反馈采用已确认的 A 方案“环绕柔光”；人工审阅、批准、拒绝和人工提交保持静态，不用这些阶段展示 Agent 动效。已接受的独立 HTML 保留作设计参考，后续补充要求优先于原型中的模拟行为。

- ClinMesh 与 DSH 的长期目标包括 Agent 参与整个 HIS、扮演患者或医生、多方仿真实验，以及从实践中发现基础设施和流程问题并形成持续改进（RSI）；医生使用场景同时重视提效、辅助诊断、医疗教学和病例落库后的重复分析。这些是产品方向，当前能力以 owner 文档和实现为准。
- 医生前端应先提供熟悉的诊疗体验，再引入 Agent；保留对话栏，并为 Agent 的工作过程与结果提供可见的“舞台”。具体布局仍需通过原型确认。
- 中国公立医院 HIS 的业务语义、岗位交接、正向流程和逆向状态以 OpenHIS 为首要参考；FHIR Repository、history、Search、授权和审计基础设施以 Medplum 为首要参考。两者是长期业务与技术参照，但不授权复制其物理架构或未实际闭环的菜单和占位实现。
- Tairex 虚拟诊室研究只参考虚拟诊疗产品模式和体验；`references/DSH-AGUI-demo` 与其他 Agent 案例只参考 UI 和交互布局，不作为 HIS 业务事实来源。发生冲突时以 OpenHIS、Medplum、当前 ClinMesh owner 文档和可执行流程为准。

## 运行与验证边界

- React 18 的普通函数组件不会接收 `ref`；共享输入组件需要沿用 `forwardRef`，并用 ShadowRoot 的 `activeElement` 核对真实返回焦点。Query 刷新时重建的 mutation 回执对象不能作为清空草稿的效果依赖，按病例与业务版本处理，并忽略旧回执；相关回归与决定见[诊断与处方两阶段视图](../../.agents/notes/implemented/architecture/2026-10-10-diagnosis-prescription-workspace.md)。

- Base UI 的可换行 TabsList 使用 `h-auto!` 覆盖 `group-data-horizontal/tabs:h-8`；普通 `h-auto` 的优先级不足，英文大字号窄屏下可能遮挡后续按钮。浏览器回归验证真实指针命中，不能只检查文本可见。
- 目录读取失败后，重设相同搜索条件不会改变 TanStack Query key，重试需显式 `refetch`。回归从真实页面观察第二次 HTTP 读取和恢复，不只断言搜索回调被调用。
- 真实 WebApp 浏览器合同使用 `localhost` 或 HTTPS 的有效 origin：`about:blank` 的 opaque origin 无法使用存储，普通 HTTP 域名不提供 `crypto.randomUUID`。沿用产品需要的浏览器能力，不为测试给生产代码加 polyfill。
- DSH 标签页品牌验证须覆盖初始 HTML、宿主赋值后的同步读取和刷新；布局会主动写入默认产品标题，MutationObserver 只能事后纠正，下一帧正确不能证明标签页没有闪烁。标题保护通过首页扩展在首个宿主脚本前同步规范当前 document 的标题赋值，浏览器回归覆盖同步改名、延迟改名和重复刷新。
- Base UI 弹框关闭依赖动画帧完成卸载；Chrome `--virtual-time-budget` 下即使轮询定时器已结束，渲染帧仍可能未执行。验证关闭卸载的浏览器合同使用真实时钟并限时等待 DOM 消失，不缩减关闭断言。
- Surface 集成测试在 Tool 切换页面或打开影像后，须等新的受信 Tool 绑定发布再执行下一动作；控件已启用不证明已发布 action 快照同步。提案工具先返回 `awaiting-human-review`，测试在 `act` 内等待准备结果，人工点击后另行观察正式写入和 Tool result，不能用准备 Promise 代表 Command 已完成。

- 页面 Tool 读取表单时应复用控件实际使用的解析后值，并同步缓存依赖；原始输入状态可能为空，而控件已从持久化草稿或目录默认值补齐。回归同时比较人工选择后与重新打开草稿后的可见内容和 Tool 返回值。


- 整表写入工具的字段高光回归应包含只改一项、改多项、无变化、当前未保存输入与保存后表单刷新；不能把工具提交了哪些字段直接当作哪些字段发生了变化。

- Agent 视觉反馈的时序验证必须覆盖真实页面 Tool 和 Surface 工具重新注册：`connecting` 可能是同一页面发布新工具列表的正常过程，不能一概当作页面失活；仅向反馈组件注入完成事件会漏掉这类提前清理。

- Agent 状态摘要与动画资格须独立统计；回归覆盖提案仍在准备、另一动作已完成的并发顺序，避免用动画筛选漏掉静态执行状态。当前语义由[环绕柔光 Agent Note](../../.agents/notes/implemented/architecture/2026-10-07-agent-workspace-glow.md)拥有。

- 浏览器高光坐标测试应比较目标的可见部分；headless Chrome 的默认视口可能裁掉目标底部，不能把完整 `getBoundingClientRect()` 与已按视口裁剪的边框直接比较。保留裁剪断言，不通过放大窗口掩盖差异。

- 底部输入区的浏览器布局回归须加载实际 Surface 样式和完整父布局，包含承载成功提示的中间容器；只有 `min-height` 的中间层不能为子级百分比高度建立可靠约束。覆盖窄宽度下输入区完整可见、消息区仍可滚动以及启用后的发送按钮可命中；滚动分区还须检查头部坐标不变和末尾操作可达。跳过生产容器直接挂载内部布局会漏掉高度链断裂。父容器使用 `overflow-hidden` 时，内容区须同时具备受约束的高度和自身的 `overflow-y-auto`；`min-h-full` 只有高度下限，不能提供滚动。共用父布局的不同详情分支应各自验证末尾内容可达。

- 目录表格同时支持行双击确认和行内选择切换时，选择按钮须阻止 `dblclick` 冒泡，避免快速选中再取消触发行确认。药品包装切换只更新当前选择，不复用取消选择逻辑。

- DSH Tool 报 `ClinMesh Tools require an active Page Context binding` 时，先核对真实调用参数中的 `contextId`、`scopeKey` 和宿主会话关联；不要根据调用顺序推断绑定被读取消耗或已过期。对照发送给模型的 schema 与实际 Tool arguments，区分模型漏传必填参数和页面签发故障。

- DSH 工具缺失时，同时检查后端 Page Context 的 `allowedOperationIds` 和前端 action 的 `enabled` 条件。失败后的恢复工具也必须经过两层筛选；仅用返回全部 catalog operations 的前端 mock，无法发现后端漏授权，需补真实 HTTP Page Context 回归。

- Surface 宿主限制每个 Tool 的最终 description 不超过 512 字符；Web 包装器会追加通用编辑说明，预算必须按拼接后的文本计算。单个描述超限会使整份 lease 注册失败、全部 ClinMesh 工具缺失，不能仅以页面上下文签发成功或 mock register 测试通过判断桥接可用。
- DSH lazy-CJS 包装器会缩进多行模板字符串，导致构建产物中的 Tool 描述比源码更长；验收必须执行真实产物并检查浏览器 lease 响应。非开发模式的宿主还会缓存插件脚本，重新构建后按[部署说明](../deployment.md#dsh-web-原生入口)重新加载宿主，核对实际返回的脚本，不能仅看磁盘时间或刷新页面。
- DSH 产物体积受 Bun 编译器版本影响；本地或 CI 超标时，先用 CI 的精确 Bun 版本构建同一源码和锁定依赖再比较，不能直接归因于依赖漂移或放宽预算。已验证版本与体积依据见[病理阅片引擎 Agent Note](../../.agents/notes/implemented/architecture/2026-10-02-slide-pyramid-engine.md)。

- React 缓存的 Agent action 配置必须依赖其读取的 mutation 状态。连续问诊回归须包含已有病历草稿、病例刷新先于队列完成的时序，并验证完成后的工具清单；无草稿时临时创建的文书对象可能让缓存每次重算，掩盖缺失依赖。

- DSH Surface 的页面元素位于 ShadowRoot 内，`document.getElementById` 无法找到内部标签。页面 Tool 应持有当前业务容器的 ref 并在容器内定位目标，避免误命中宿主同名元素；回归须把真实组件挂载到 ShadowRoot 后调用注册的 Tool，普通 DOM 测试不能证明宿主路径可用。

- DSH 构建标记不证明子模块的已安装依赖完整。启动时报缺少 peer 包时，在 owning workspace 按锁执行 `bun install --frozen-lockfile` 并检查 tracked diff；不要仅因已有构建标记跳过依赖修复，也不要修改上游源码绕过缺失依赖。

- 本地 UI 修改交付前先确认用户正在使用的入口。热更新页面通过不能证明 Server 静态 Web 或 DSH Surface 已更新；按实际入口重建对应 artifact，并核对服务返回的资源。构建与启动方式见[部署指南](../deployment.md)。

- DSH 报插件 overlay `ENOENT` 时，同时核对该包声明的 patch、入口文件和本地安装内容；已禁用的插件仍可能在 Profile 合成阶段读取 overlay。若同版本官方 tarball 包含缺失文件，先核验 registry integrity 并备份本地目录，再恢复缺失文件；启动并验证带凭证首页后，停止验证实例，避免占用用户手动启动的端口。

- 手动通过 Node `--env-file` 启动全局 DSH 时使用 `.env` 的绝对路径。`dshmarket` 调用 DSH CLI 更新插件时继承 `process.execArgv`，但把工作目录切到 CLI 所在目录；相对路径会让更新和旧构建恢复同时报 `.env: not found`。修正启动参数后再验证同一全局 Profile，不修改上游源码。

- Windows 进程树测试必须在启动器自身仍存活时检查后代退出；只在启动器退出后检查，可能被 Node 的进程清理掩盖。用 `.cmd` 中间层和 detached 后代覆盖实际包管理器链路，并保留无关进程存活断言。

- Windows 的 `core.symlinks=false` 会把 Git 符号链接检出为存放目标路径的普通文件。修改 `CLAUDE.md` 前先检查 Git mode；`120000` 的 blob 是链接目标，不能按 Markdown 添加末尾换行。文档或格式检查受 CRLF、符号链接、POSIX 权限影响时，在支持这些语义的 Linux checkout 验证，不改坏链接或放宽检查。
- 从 Windows 用 `git archive` 同步 Linux 验证副本时，显式使用 `git -c core.autocrlf=false archive`；否则归档可能带入 CRLF，导致按 LF 字节锁定的合成数据校验和失败。先比较归档、Git blob 和检查副本，不修改校验和或测试阈值。

- DSH 的启动地址包含临时访问 token，直接请求无凭证的 `/` 不能证明 Web 是否就绪。隔离 smoke 在内存中使用启动 token 完成登录，再携带返回的 Cookie 检查首页；保存或发布启动日志前必须移除该 token。候选子进程使用受限环境和临时 npm 用户配置，不能把父进程的 GitHub/npm/模型凭证传给安装脚本。

- 审查自动升级时同时核对人工提交历史和最终执行目标：快进追加仍可能覆盖人工指定的支持 SHA。版本号相同也不能证明安装内容相同；发现摘要必须绑定实际下载文件与重建锁。当前保护和恢复方式见[DSH 持续升级](../deployment.md#dsh-持续升级)。

- GitHub 的 PR ref 或 commit API 能访问某个支持 SHA，不代表从上游仓库普通 clone 后可检出；该对象可能只在贡献者 fork 的分支上。验收必须用声明的 source 新建 clone 并执行精确 checkout，不能复用含额外对象的本地仓库作为公开来源证据。

- `pnpm reference:sync` 固定写入默认路径 `.data/clinmesh-reference.sqlite`，不读取 `.env` 的 `CLINMESH_REFERENCE_DATABASE_PATH`；`.env` 指向自定义路径时会与同步结果分叉，出现"诊断药品正常、检验目录为空"（旧 Release 不含 `laboratory-cn`）。排查时直接查库：`reference_release` 表按 `release_id` 看 `laboratory_definition_count`。当前 Release 默认取 `reference-data.lock.json` 的 `compositeRelease.releaseId`，不要在 `.env` 手抄该 ID 制造双事实来源；运行中 Server 不热切换参考库，修复后必须重启。

- 本地项目目录迁移后，DSH Profile 的 `link:` 插件依赖可能仍指向旧绝对路径。`pnpm dsh:setup` / `pnpm dev:dsh` 每次启动都会重验 `.data/dsh-runtime` Profile 的三个链接并自动修复指向当前仓库，无需人工处理；仓库外手工维护的沙箱仍需按原方法备份 Profile 的 `package.json` 核对更新并运行 `dsh plugin --profile web install`，插件自身依赖须在各自 workspace 按锁恢复。启动见[部署指南](../deployment.md)。

- pnpm 11 默认的 `verifyDepsBeforeRun=install` 会在脚本前自动安装，可能重解析锁文件并给 file dependency 的 bin 源文件增加可执行权限。验证前先执行 `pnpm install --frozen-lockfile`，验证进程使用 `pnpm_config_verify_deps_before_run=error`，发现不一致时显式处理；安装后检查锁文件和子模块权限。全局 pnpm 与仓库指定版本不一致且启动器卡在联网解析时，可直接调用已缓存的精确版本，并让子进程 PATH 使用同一版本。缓存中的 `pnpm.cjs` 可能没有可执行位，仅把其目录或符号链接放进 PATH 不会生效；使用可执行的 shell wrapper 通过 `node` 调用该文件。

- 当前 Web 交付使用 Node.js 真实入口即可证明运行时和数据库生命周期；没有明确容器验收条件时，不安装、不启动也不要求 Docker。
- 验证必须对应 outgoing diff。纯 Markdown、设计资产或 PR 媒体变更不触发代码单元测试、全量 `pnpm test` 或 `pnpm check`；只运行 owning 文档检查、媒体解码或发布可达性检查。
- 已经通过且没有被后续变更失效的证据不因 commit、push、review、Ready 或 merge 再次运行。
- 生产 Docker build 不能假设 `better-sqlite3` 一定有预编译件。Build stage 保留 `python3`、`make` 和 `g++` 供 `node-gyp` 回退编译，runtime stage 不携带工具链；升级 Node.js 或 `better-sqlite3` 后必须用实际 Docker build 和健康启动验证。
- Command receipt 是跨版本持久数据。响应 DTO 新增必填字段时提供向后兼容默认值或迁移旧回执，并用原幂等键重放升级前响应形状；只验证新命令成功不能发现这类回归。
- Better Auth 在 `NODE_ENV=test` 下默认跳过 origin 校验；ClinMesh Auth 必须显式保持 origin check 开启，相关 HTTP 测试同时携带会话 Cookie 和 `Origin`，否则无法捕获开发 Web origin 的 CSRF 配置回归。
- `scripts/dev-lan.ts` 的进程生命周期覆盖完整子树。POSIX 上 Server 和 Web 必须使用独立进程组；任一分支退出或收到终止信号时，向两个完整进程组转发原信号。只终止顶层 `pnpm` 会遗留 Turbo、Vite 或 `tsx watch` 子进程，并在下次启动时产生错误的端口占用。
- POSIX 上进程组 kill 已生效后，孤儿进程在被收养方收尸前仍处于僵尸/退出中状态，`kill(pid, 0)` 会把它探测为存活。判定幸存者必须在断言前轮询等待全部不可探测（如 50ms 间隔、数秒上限），超时仍存活才上报失败；Windows 无僵尸进程，本地全绿不能证明 Linux 无竞态。探测只把 `ESRCH` 视为已死、其余错误如实抛出，并拒绝非正整数 pid（`Number` 解析出的 NaN 会被强转为 pid 0，探测到探测方自身进程组）。
- DSH React Surface Client 以 classic lazy-CJS 加载；任何构建后仍存在的 `import.meta` 都会在模块执行前触发语法错误，即使该分支在运行时不可达。开发标记使用可被构建器静态消除的 `process.env.NODE_ENV`，artifact verifier 必须拒绝残留 `import.meta`。
- Surface 构建器不压缩依赖，并会把已压缩的代码重新排版：大体积第三方库引用其压缩构建，实际增量以引入前后 `lib/client.js` 的字节数为准，不能按压缩文件大小估算（OpenSeadragon 压缩构建约 35 万字节，产物增加约 55 万字节；默认入口会超出预算）。压缩构建没有类型声明时，在 `apps/web` 放环境模块声明并在 `apps/dsh-web/tsconfig.json` 的 `include` 中列出；oxlint 不允许三斜线引用。
- 依赖真实渲染帧的组件（OpenSeadragon 的动画与瓦片调度）在 Chrome `--virtual-time-budget` 下不可靠，这类浏览器合同用 Playwright 的真实时钟并有界轮询。合成 JPEG 瓦片带填充色时，色度上采样会让填充色渗入相邻一两列有效像素；按像素统计验证时为图像边缘留出小于 0.5% 的容差。
- `vendor/dsh-react-surface` 的 `lib/` 是未跟踪的生成目录。ClinMesh 的 Vitest 若直接导入由 DSH 注入的 `dsh-react-surface/client` external，必须通过显式测试 alias 解析到本地 stub；测试不能依赖开发机曾构建 submodule 后遗留的 `lib/client.js`。
- WSL2 中 pnpm 为 Bun bin 生成的 shim 可能优先选择同目录 `bun.exe`，并把 Linux 路径转换成无法由该 Bun 解析的 UNC 路径。React Surface 构建脚本应由当前 Linux `bun` 直接执行 builder 的 TypeScript CLI，不能依赖该 shim；诊断时先比较实际 Bun 与 shim 目标，不要重复安装 Bun。
- Windows 上 Turborepo 包装 `tsx watch` 的持久任务（旧根 `pnpm dev:server`）会以约三成概率把整棵进程树冻结在启动阶段：父进程 IPC 管道已建、子进程已派生，但双方 CPU 归零、服务永不监听，且 forensics 期 inspector 无响应。常驻开发服务器一律直连 pnpm（`pnpm --filter @clinmesh/server dev`），不进 turbo；诊断该类挂起先用“绕开包装层”隔离，再比较冻结与正常实例的 CPU 增量。
- Turborepo strict env 只转发任务声明的 `passThroughEnv` 变量，turbo 包装的任务拿不到未声明的 `CLINMESH_AI_*` 等变量。核对环境变量是否生效要从实际业务进程取证，只看父 shell 会把 provider 未配置误判为产品错误；这也是根 `dev:server` 改为直连 pnpm 的原因之一。
- SQLite perf gate 统计数据库、WAL 和 SHM 总增长；同一 Command completion 更新的多个 nullable 关联列若各建独立索引，会放大短事务 WAL pages。优先按真实验证查询建立一个复合索引，并用 `pnpm perf:ci` 证明增长，而不是放宽预算。
- 跨 CRLF/LF 工作区复用 SQLite 时，`Applied migration checksum changed` 可能只来自 SQL 换行差异。先逐项确认已应用 checksum 匹配来源 SQL，且来源与目标 SQL 仅换行不同；保留原库并建立一致备份后，只在隔离副本中重算对应迁移记录，核对迁移验证、完整性与业务 canonical hash。不能据此跳过校验、覆盖原库或接受实际 SQL 内容差异。
- VitePress 构建把公开页面里裸写的 `http://localhost:*` URL 当作内部死链并使 `pnpm docs:check` 失败（`127.0.0.1` 不受影响）。进入文档站投影的页面中所有本机地址一律写成代码 span，不起链接。
- 隔离验证副本复用已安装依赖时，VitePress 会在仓库根 `node_modules` 自动创建 `vue` 符号链接。验证副本应保留自己的 `node_modules` 真目录，将已有包分别链接到依赖缓存，让构建新增链接写入验证副本；整体链接共享依赖目录会把构建写入带到共享目录。
- pnpm 在 Windows 的 `node_modules/.bin` 只生成 `.cmd`/`.ps1` shim，且 Node 直接 `execFile` `.cmd` 会被拒绝。需要子进程调用 workspace 依赖的 CLI 时，用 `process.execPath` 加包内 JS launcher（如 `node_modules/cn-health/bin/cn-health.js`），不要拼 `.bin` 路径；Linux 测试传 `cliPath` 桩会掩盖该断裂，默认解析路径必须有独立测试。`cn-health dataset materialize` 支持多进程并行写同一 `--data-dir`（内部有锁），默认 Dataset 可并行 materialize；`cn-health@0.5.1` 起子进程在 stderr 自带分阶段进度，reference-sync 逐行转发到 `onProgress`。升级被 `reference-data.lock.json` 的 `cli.version` 锁定，与 receipt 的 `cliVersion` 严格相等，升级时 lock、根 devDependency、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 三处必须同步，且旧版本条目会因排除清单移除而被 `minimumReleaseAge` 政策拒绝——先临时双列排除完成重解析、`pnpm clean --lockfile` 清陈旧条目后再收窄清单。

- Windows checkout 若把仓库中的 CLAUDE.md 符号链接物化为链接目标文本，文档换行检查会误报；CLI 的 POSIX 权限与文件符号链接测试也不能由该 checkout 证明。使用 Linux 文件系统上的独立 Git 检出验证，并把 Linux Node、pnpm 与 Bun 放在 PATH 前端，避免子进程拾取 Windows pnpm shim。跨命令复用的 WSL 验证副本和产物使用持久目录，避免重启清理 `/tmp`。

- Agent Note 格式检查当前按 LF 分行，Windows CRLF 检出会把空行和状态行误报为格式错误。隔离验证 Git 中的文本时使用 `git -c core.autocrlf=false archive`，再覆盖待提交的新 Note；默认 `git archive` 也可能按 `core.autocrlf` 转换换行，不能当作原始 Git blob。该验证只证明文本格式，不替代 POSIX 权限或符号链接验证。

- `publint` 会再调用包管理器打包；pnpm script 注入的 Node 目录可能让子进程选择 Corepack shim，而不是父进程使用的 pnpm。若父构建成功、打包却卡在解析 pnpm 版本，核对实际 PATH 和 Corepack 缓存，预先缓存仓库 `packageManager` 指定的版本；需要代理时在缓存准备步骤启用 Node 的代理支持，不通过跳过 publint 或覆盖宿主环境规避。

- DSH 的内置 bundle 由宿主槽位提供；Profile 不重复安装它们的依赖闭包。出现 `profile reload requires the root Include entry` 时，先比较官方默认 Profile，再核对配置编辑器与启动入口解析出的 `dsh-app-boot` 是否是同一模块实例。HTTP 首页成功不能证明设置持久化和热重载可用；当前装配与验收归属见[部署指南](../deployment.md#dsh-web-原生入口)。

- npm 11 的依赖安装脚本默认审批策略可能让 `npm ci` 成功却没有构建原生 helper。依赖原生组件的安装模板要维护明确的 `allowScripts`，并按依赖锁核对审批目标；不要依赖另一个 Profile 的 pnpm 构建结果，也不要通过允许全部脚本掩盖缺失的项目策略。

- 浏览器合同从包级 runner 迁到根 runner 时，Vite 的 `resolve.dedupe` 会改用根目录解析 React；build 必须显式设置 owning app 的 `root`。动画回归同时保留“完成后仍保持高光”的阶段断言和有界卸载等待，固定 sleep 不能证明渲染帧已经执行。

- 替换 Agent 反馈渲染器时，分别处理真实执行、完成反馈可见性与资源清理，沿用既有完成停留合同。快速本地 Tool 的开始和完成可能被 React 合并为一次渲染，不能依赖执行阶段创建过 Canvas；回归须包含同批开始/完成、静态停留与停止绘制，并保持业务无额外延迟。当前时序由[能力参考](../agent-capabilities.md#反馈时序)拥有。

- WSL 全量测试在高并行度下可能因 CPU 争用触发既有 5s/10s 超时，并在超时清理后出现数据库已关闭的次生错误。确认单项通过后，可用 `taskset -c 0-3 pnpm check` 限制本次验证的 CPU 亲和性，让 Node/Vitest 降低并行度；若多个包仍同时争用 CPU，先用 `taskset -c 0-3 pnpm exec turbo run test --filter=!@clinmesh/mobile --concurrency=1` 串行验证包级集合，再运行 `pnpm check` 复用仍有效的成功缓存。保留完整测试集合、原断言和原超时，不修改业务实现来掩盖资源争用。`apps/server` 的单项超时为 15 秒（`vitest.config.ts`），因为完整 HTTP 闭环在 CI runner 上要 4–5 秒；仍超时时先查是否真变慢，不继续加大上限。

- 精确运行 Vitest 文件时使用 `pnpm --filter <package> exec vitest run <file>`。脚本经 `pnpm --filter <package> test -- <file>` 转发时会保留 `--`，当前 Vitest 可能运行整个包而未应用文件筛选；以实际 Test Files 数量确认范围。

- 验证副本和隔离 worktree 放在仓库外。Git 忽略的 `.data/` 仍可能被根 Vitest 的脚本文件 glob 遍历，仓库内嵌套 checkout 会重复运行它的测试；不能靠 `.gitignore` 隔离测试发现。

## 浏览器演示经验

- 将构建后的 JavaScript 或 CSS 内嵌到单文件 HTML 时，`String.replace` 使用返回正文的函数作为 replacement。直接传正文字符串会把其中的 `$$`、`$&` 等解释为替换标记并损坏产物；导出后用浏览器从本地文件打开，验证渲染与交互。

- `agent-browser record start` 会创建新标签页并保留旧标签页。录制 DSH 原生 Tools 前关闭本次验证的旧标签页，再打开 Surface；同一 Session 的多个页面实例可能让 Tool 作用于非录制页面。只关闭自己创建的验证标签页，不关闭用户标签页。

- `agent-browser click` 对滚动容器外的 ref 可能返回成功但页面未发生变化。先 `scrollintoview` 再点击，并以预期页面状态确认结果；异步 mutation 后的即时 snapshot 可能仍是旧状态。
- PowerShell 将中文脚本通过 stdin 管道交给 Node 或浏览器前，显式设置 UTF-8 `$OutputEncoding`，避免默认 ASCII 把中文替换为问号。正式文件优先使用结构化 patch 或显式 UTF-8 写入。

- Windows 的 `agent-browser eval --stdin` 若返回 `null` 且脚本未执行，改用 UTF-8 Base64 与 `eval -b`，并读取预期 DOM 状态确认执行；返回 `null` 本身不能证明注入成功。视频录制期间保持 viewport 尺寸不变，窄屏另开录制，避免编码器把不同宽度画面拉伸到初始尺寸。

- `agent-browser` 原生 WebM 会忠实记录自动化输入和等待，未经编排的完整闭环可能远慢于人类观看速度。优先按业务阶段分段录制，成片统一到 3–4 倍速并添加开场、岗位/动作字幕和结束状态。
- Headless 录制默认看不到鼠标指针。点击高亮必须在录制开始前注入已审查的同源脚本，由真实 `pointerdown` 或 `click` 事件在实际坐标显示短暂圆环；不能根据成片猜测并伪造历史点击位置。
- 字幕应持续显示当前岗位和动作，不用字幕复述页面上已经清楚可见的全部文字。压缩优先降低等待时长和分辨率，其次调整码率；临床字段、状态和错误信息必须仍可读。
- 发布媒体使用 append-only assets 分支和新文件名，不覆盖或改写已经发布的对象。PR body 记录 commit、入口、Scenario、时长、尺寸、大小和 SHA-256，并链接新版文件。
- 每次 `record start` 都配对 `record stop` 和进程清理。停止命令超时后检查 encoder 子进程，只对确认属于该录制会话的进程发送终止信号，避免后台 FFmpeg 无限驻留。
- `agent-browser` 会话守护进程存活时，单独终止 Chrome 可能触发自动重启。正常 `record stop`/`close` 超时后先终止该命名会话的守护进程，再清理其 Chrome 和 encoder 子进程；随后用 `ps`/`ss` 验证，不重新连接已关闭会话。
- `agent-browser record start` 会在现有命名会话中新增录制 tab，原 tab 仍可保有 DSH Surface leader lease。录制 DSH browser Tools 时必须关闭旧 tab，等待录制 tab 取得 `active` lease，再让 Agent 读取新的 Page Context；否则 Tool 可能正确更新旧 leader，而录制 tab 只显示未变化的 contender Surface。
- `agent-browser record start` 创建 fresh context 后，`eval`/`click` 可能仍作用于旧 tab，成片只有空白帧。start 之后必须显式 `open` 目标 URL，并用 `tab list` 与页面状态（tab 文本、队列条数）确认操作落在录制 tab 上；随后再注入点击高亮脚本。
- 视图切换会重排 snapshot refs：同一 `@eN` 在不同视图解析到不同元素，旧 ref 的 click 返回成功却点错位置。每次切换视图后重新 snapshot 取新 ref，再以成片抽帧核对关键画面（切换、选中、空态）是否都发生。
- Windows FFmpeg 的 `drawtext` 引用盘符路径时，冒号会截断 filter 参数；命令行内联转义易被 shell 吃掉。把 filter 写进文件并用 `-filter_complex_script` 执行，路径统一写成 `'C\:/path/...'`（引号包裹 + 转义冒号）。正在写入的 WebM 无法被 FFmpeg 读取（EBML header 未完成），抽帧核对只能在 `record stop` 之后进行。
- 使用 FFmpeg 前先检查依赖；缺失时报告而不是自行安装。后期只改变播放速度、字幕和编码，不拼接来自不同 Scenario、workspace、epoch 或 commit 的业务证据。
- 一次 FFmpeg 命令抽取多个时间点时必须为每个输出显式指定 input/map，或为每个时间点单独执行；依赖默认 stream mapping 可能让多个输出都取自第一个输入，形成看似正常的重复截图。
- 浏览器录制的媒体时间轴不一定等于自动化脚本的墙钟耗时。裁剪前用 ffprobe 和解码画面定位起止，不直接使用脚本执行时间作为视频时间戳，以免裁掉首次操作。

## GitHub 操作经验

- Actions 的 `pull-requests:write` 不等于仓库允许机器人创建 PR；出现明确的创建权限错误时先核对仓库设置，不反复重试。没有管理员权限时，可按[持续升级故障恢复](../deployment.md#dsh-持续升级)验证已有候选 PR 的更新与验收，并单独保留首次创建权限限制。

- 分支范围以当前 canonical issue 正文为准；不能仅凭分支名或提交主题判定串票。整理旧分支前先核对 issue 全文、关联 PR 状态和远端提交，避免拆散已经批准的一次集成交付。
- 本地 main 落后且子模块显示 `M` 时，先比较 main 记录、子模块实际 HEAD、远端 main 记录，并检查子模块内部是否干净。实际 HEAD 已与远端一致时，这是版本指针差异，不能称为用户源码改动；可快进 main 后在当前目录开分支，不应仅因此创建额外 worktree。

- PR 使用 squash merge 后，旧 feature branch 与 `main` 的 SHA 历史会显示分叉，即使交付内容已经进入 `main`。清理时先检查 PR 和 tree 内容，让本地 `main` 对齐 `origin/main`，只移植 squash 后新增的提交；不要再次 merge 整条旧 feature 历史。
- 删除非 main 分支前先枚举本地 branches、remote heads 和占用它们的 worktrees。Assets 分支是已发布 PR 媒体的 owner，删除会使历史链接失效；用户仍明确要求只保留 `main` 时按要求删除并报告影响，不把媒体二进制转存到 `main`。
- `gh pr edit` 可能因 GitHub Classic Projects 的 GraphQL 字段废弃而失败。PR 正文更新可改用 REST：`gh api repos/<owner>/<repo>/pulls/<number> --method PATCH -f body=...`。
- `gh pr merge` 成功时可能没有标准输出。只用一次 `gh pr view --json state,mergeCommit` 确认结果，不因空输出重复合并或重跑检查。
- GitHub Raw 可能把包含 VP8/VP9 视频流的 `.webm` 响应标为 `audio/webm`。不要只按该 header 判定文件损坏；同时核对 HTTP 状态、字节数、校验和以及媒体流的 codec、尺寸和时长。
- 已合并 PR 的正文仍可补充更清晰的演示链接，但不得改写 merge commit 或 force-push 源分支。更新后只核对 PR 状态、head SHA 和新链接，不重跑产品测试。

- 上游自动更新中，无新版本与活动候选有效是两件事；撤销检查需覆盖旧候选，不能只检查 main 基线或 tarball 是否仍可下载。失效状态绑定精确 HEAD，并防止并发验收写回成功。

- 自动发布的目标基线从目标分支精确提交读取，不能沿用 workflow_dispatch 所选分支的本地锁。活动候选失效检查放在新版本发现前；回归需覆盖真实 CLI 的提前抛错路径，单独测试发布函数不足以证明旧状态能失效。

- npm 撤销需区分包仍存在但版本缺失与整包直接 404；候选失效检查覆盖两者。权威 404 的判断限定到固定官方 registry 且禁止重定向，不能把权限错误、服务故障或通用 HTTP 404 当作撤销。

- OpenRouter 部分模型（尤其 free 档）不支持结构化输出，`response_format: json_schema` 请求固定 400，tool call 输出可能整段缺失必填字段或返回空串且每次不同。`completeJson` 的 `validate` 回调是内容质量闸门，新增调用点必须传与后续 `parse` 相同的 Zod schema（`safeParse(value).success`），否则可解析的坏 tool-call 内容会掩盖后续 prompt 降级策略。生成类 `*_RESPONSE_INVALID` 报错先用 `patient-persona-live-smoke` 复现并确认模型的 structured outputs 支持情况。

- 影像流水线经代理访问 TCIA 时须设置 `NODE_USE_ENV_PROXY=1`；Node 的 `fetch` 默认不读取 `HTTPS_PROXY`，缺少该变量时 `pnpm imaging:sync` 和 `imaging:record` 表现为连接超时。下载在后台运行并轮询结果文件，不在前台阻塞等待。

- 影像与病理素材文件校验为 `ready`，但覆盖清单全部显示 `REVIEW_STALE` 时，先核对报告规则文件的换行字节；它们按原始字节参与复核签署，Windows 的 `core.autocrlf` 转换会使签署失效。`.gitattributes` 为两个素材包的 `prompts/*.md` 固定 LF；既有检出仅在确认内容与 Git 一致后恢复 LF，不通过重新签署掩盖字节变化。定向病例不显示时分别检查运行中 Provider 的 `targetedGeneration` 和定向条目接口是否为空；Docker 已启动不代表运行中的容器已使用 Compose 当前指定的镜像。

- 病理素材流水线从 IDC 公开存储桶（`idc-open-data`）匿名下载，经代理时同样需要 `NODE_USE_ENV_PROXY=1`；一个 20 倍实例可达数百 MB，来源客户端按区间下载并只重试失败的区间。会话的 `/tmp` scratchpad 会随机器重启清空：需要跨重启保留的下载缓存和研究数据放在仓库的 `.data/` 下，其中不放测试或脚本文件。清单条目里的临床字段从重新下载的来源文件转录并登记文件哈希，不凭记忆填写。

- `jpeg-js` 解码三分量 JPEG 时，`colorTransform` 缺省会把 Adobe APP14 transform=0（RGB）的码流当作 YCbCr 转换；需要按码流标记显式传入。`@cornerstonejs/codec-openjpeg` 的 Emscripten 模块默认逐瓦片向标准输出打印 INFO，创建模块时传入空的 `print` 与 `printErr`。验证真实切片的颜色解释不看像素：解码已安装层级后统计通道均值与近白像素比例，H&E 组织像素的红、蓝明显高于绿，背景接近白色。

- Playwright 使用与锁定版本匹配的 browser cache；跨项目参考配置时同时核对 runner 版本与已安装 revision，缺失时用本仓库的 `pnpm exec playwright install chromium` 安装。运行合同与真实入口的方式见[测试策略](../testing.md#用户界面验证)。
- `tsconfig.browser.json` 的 E2E 入口会递归导入 Server 实现，但不会自动加载 Server 项目中的 ambient module 声明；Server 新增无类型依赖时，同时将对应声明文件纳入浏览器类型检查入口，不能只凭包级 `tsc` 通过判断完整类型检查通过。修改 `apps/web/e2e/` 后运行 `pnpm exec tsc --noEmit -p tsconfig.browser.json`；Playwright 会转译 TypeScript，但不做类型检查，E2E 通过不能替代这项检查。

- 验证真实影像时不读取像素或截图：用 Playwright locator 或文字快照核对报告、状态和控件，用页面内脚本返回 canvas 尺寸、非零像素比例、均值和翻片前后的校验和变化等聚合量。帧切换计时以 canvas 内容发生变化为准，页码文字会先于像素更新。

- `agent-browser click @ref` 对位于嵌套滚动容器可视区之外的按钮可能不产生点击且不报错；先 `scrollintoview @ref` 再点击。Base UI 的 Select 用 `focus` 加 `press Enter` 打开，直接 click 不展开选项。

- Base UI Select 的长选项换行须同时处理 ItemText 的 `whitespace-nowrap`、`shrink-0`，以及选中值的单行限制与 Trigger 固定高度；ItemText 默认渲染为 `div`，不要凭其他组件的结构假定为 `span`。使用真实 DOM 核对文字宽高和裁切，覆盖窄窗口中的菜单与选中状态。

- 固定宽度的状态标签须验证中英文与三档应用字号。仅检查 Badge 或列表项边界会漏掉被 `overflow-hidden` 裁切的文字；浏览器回归用 DOM Range 检查各行文字边界，并验证内部换行后业务区末尾仍可滚动到达。字号偏好通过实际应用根的 `data-clinmesh-app` 与 `data-font-size` 生效，fixture 须沿用这些属性。

- 验证独立滚动时只设置目标区域的 `scrollTop` 或使用真实滚轮，等待页签切换和滚动后的渲染帧，并将末尾边界与实际宿主比较。`scrollIntoView` 会滚动 `overflow-hidden` 祖先，可能掩盖内容已被固定头部挤出宿主的问题；头部 fixture 同时覆盖多条过敏、长文本、矮屏和大字号。

- DSH 页面未显示前端修改时，区分磁盘产物、宿主按 revision 实际提供的 `/plugins` 脚本与浏览器已加载的页面；不能只凭独立 Web 通过就声明当前 DSH 已生效。Surface 布局复现应使用宿主的 ShadowRoot 基础样式（尤其 `contain: strict` 与内容容器），并断言弹层文字没有超出 Surface 边界。

- 合成 fixture 须贴近 Synthea 的真实导出形态。Synthea 在导出时已写下之后的病程：本次就诊诊断的急性病带有就诊之后的 `abatementDateTime`。按“字段是否存在”判断状态的规则在 fixture 上通过、在真实病例上全部失配；涉及来源时间的规则以 Index Encounter 时间为界，并用真实 Provider 生成的病例验证一次。
- `PERSONA_DIAGNOSIS_LEAK` 的失败输出不会保存，错误码本身不能证明模型真正泄露。先核对可见既往史与隐藏诊断术语，使用合成文本复现“已知病名中包含禁词”和“已知并发症已命名基础疾病”的误判，并同时验证另一处新增诊断、未知子型和编码仍被拦截。删除标点的归一化可能把不同分句拼成已知病名；禁词豁免须保留分句边界，回归同时覆盖跨分句泄漏和用标点拆开诊断的绕过尝试。
- 按年份偏移日期时，替换年份字符串会产生无效的 2 月 29 日，JavaScript 的 `setUTCFullYear` 则会自动进位到 3 月；需要月末截断语义时，使用 UTC 日历运算并把进位结果退到原月份最后一天，回归包含非闰年与世纪年份。

- 用模块过滤让 Synthea 定向生成病例时，一个批次中任一患者死亡会让 Provider 返回 502，任一患者没有合格的 Index Encounter 会让整个任务以 `INDEX_ENCOUNTER_NOT_FOUND` 失败。定向搜索使用 `count: 1` 的多个任务并更换 seed；低患病率疾病（如存活的肺癌患者）每个任务最多内部重试十次，耗时按分钟计；更快的做法是先在 Provider 镜像的临时离线容器里用与 Provider 相同的 Synthea 命令行并行预筛种子，命中后把同一组 population/clinical seed 提交给正式生成任务，得到的患者一致。Synthea 的肺癌模块只在 45–65 岁发病且数年内死亡，存活患者集中在 48–66 岁。

- 隔离验证实例须覆盖仓库 `.env` 中的 `CLINMESH_PUBLIC_ORIGIN` 与 `CLINMESH_TRUSTED_ORIGINS`，否则登录返回 `INVALID_ORIGIN`；数据库迁移从 `apps/server` 目录运行。没有配置 `CLINMESH_AI_*` 时 Persona 任务无法完成，合成病例不能开始就诊。

- Synthea keep module（`-k`）的内部重试只重跑临床模拟，患者的年龄、性别等人口属性在第一次抽取后固定；抽到无法满足条件的年龄时会耗尽 `generate.max_attempts_to_keep_patient`（默认 1000，约 100 秒）后放弃；放弃时进程仍以 0 退出，只是导出的患者少于请求数（全部落空时连 `fhir` 目录都没有），判断依据只能是导出数量。定向生成必须由外层换 seed 重试，并用较窄的年龄范围提高命中率；不要只靠调大内部尝试次数。
- Synthea GMF 的 `Observation` 条件在患者没有该 Observation 时做值比较会抛出 `NullPointerException` 并中止整次运行（只有 `is nil` / `is not nil` 不抛）；`And` 按书写顺序短路。写进 keep module 的 Observation 取值条件必须先放同一编码的 `is not nil`，再放 `==` 比较；编码值比较要求 `value_code` 的 system 与模块中一致（SNOMED 为 `SNOMED-CT`），类型不符的比较同样抛出异常。

- DSH browser Tool broker 每次注册最多 32 个 Tool。医生“接诊”页按当前诊疗栏目发布，新增医生 Tool 时在 `agentToolCatalog` 中为它声明所属栏目，只有确实跨栏目的动作才不声明；跨栏目 Tool 占用每个栏目的名额。合同测试 `publishes only narrow, role-scoped tools within the broker limit` 逐个岗位、视图与栏目断言不超过 32；Web 测试切换栏目后须在 `act` 之外等待新 Tool 注册，在 `act` 回调里等待注册会因状态不刷新而超时。

- 新增会写入每个 Epoch 的基线数据（例如新的 Hospital Service）时，`perf:ci` 的 `scenario-install-reset-application` 写入行数会变化；该基线上下限相同，需要随基线数据同步更新 `apps/server/performance-baselines.json`。`verify:boundaries` 按文本匹配 `window.`、`document.` 等写法，`packages/core` 与 `packages/contracts` 中不要把变量或参数命名为 `window`。

- DSH 0.2 的会话列表不再含 `current`；应用和桥接订阅公开的 `uiSession.adapter.current`，从 binding 的 `key` 读取主会话。依赖与类型检查通过后还需在真实宿主核对 Page Context 签发和 lease：旧字段会让页面正常显示，却静默跳过 Agent 发布。

- DSH 的 Snapshot Store 是带实例方法的公开服务；给 `useSyncExternalStore` 传回调时通过 `() => store.getSnapshot()` 与 `(listener) => store.subscribe(listener)` 保留 receiver，并把包装放在注册作用域保持稳定。只用箭头函数 stub 会漏掉真实宿主中的 `refreshSnapshot` 绑定错误；会话历史回归使用依赖 `this` 的 Store fixture。

- DSH 桥接升级时同步核对 runtime peers、CI 安装的 CLI 和兼容说明；React Surface 的 E2E 从 runtime peer 读取期望版本，旧 CLI 会在挂载前退出。DSH 0.2 的桌面首次启动向导新增“开始设置 → 跳过 → 我知道了”；真实入口测试须通过可见按钮正常关闭向导后再操作侧栏，不能强制点击穿透遮罩。向导保存和换页是异步过程，应有界等待侧栏恢复可交互，并在失败时报告残留弹窗文字；固定点击轮数在本地通过后仍可能在 CI 提前退出。CI 成功日志不打印带临时访问 token 的启动 URL 或宿主原始 stdout。

- 审查 `dsh-ag-ui` 的宿主合同升级时，根目录 `pnpm check` 只检查 Gateway；嵌入入口 `dsh-ag-ui-adapter` 有独立的宿主、Cordis 和 loader 依赖，必须同步核对其 manifest 与实际锁定版本。pnpm 11 的 `--workspace-root` 会把递归命令限制在根包，覆盖整个 workspace 应使用 `pnpm -r --workspace-concurrency=1 --include-workspace-root check`；adapter 测试会构建 Gateway，串行执行避免与根包构建互相清理产物。用真实工具结果验证调用身份和正文，只验证纯文本对话不能发现工具消息结构失配。
- HTTP 上传取消回归须等原生存储实际读取第一个数据块后再断开，并等清理完成后验证重试；固定短延迟可能在路由安装取消监听器前结束请求，使测试通过却没有验证取消路径。
- DSH 0.2 JSONL 持久化允许延迟物化会话，`append` 是尽力写入，`sessionPersistence.flush()` 或 handle 的 `flush()` 才是持久化屏障。验证 SIGKILL 后恢复时先建立该屏障，不能用固定延迟代替落盘证据。

- 新 clone 或 worktree 单独运行 DSH client 测试前，先生成 `styles.generated.ts`（`pnpm --filter @clinmesh/dsh-web build:styles`，包级 `typecheck` 也会生成）。首次样式生成与 Vitest 入口加载不能并行，否则 `index.test.ts` 会因缺少生成文件而在收集阶段失败；这种环境失败不能作为有效的行为回归 red。

- DSH 0.2 的 `ctx.remote` RPC 返回 `{ ok, value }` 或 `{ ok: false, error }`，失败不一定抛异常。适配器先验证并解包，再验证业务数据；stub 也要保留该包装。自定义 `LlmAdapter.listModels(provider)` 的每个模型必须带匹配的 `provider` 字段，仅有 `id/name` 会被宿主目录拒绝。真实 Profile smoke 可以发现这两类被宽松 stub 掩盖的合同错误。

- DSH 模型流以 `finish.reason` 携带标准失败码，消费方按 code 分类，不解析原始消息或把所有失败归成网络故障。超时回归同时覆盖宿主返回 `TIMEOUT` 与本地 `AbortSignal` 到期；只验证本地计时器会漏掉宿主超时被误归为调用失败的路径。同一 Provider 下的模型可有不同访问权限；单模型返回 403 不证明整个 Provider 不可用。可用性验证通过真实桥接向其他完整 Provider／model 路由发送最小合成请求，不修改已有任务绑定，也不输出凭据或模型私有输入。

- TanStack Query 的 `invalidateQueries` 默认不抛出刷新失败，不能靠它把成功写入同步到界面。保存成功后先校验并应用服务端返回的已提交值与 revision，取消可能覆盖该值的旧读取，再刷新目录。用户偏好：设置已经保存成功且界面保留已确认值时，只提示“已保存”，后续自动刷新失败静默处理，不展示“已保存但刷新失败”等内部同步提示；首次加载和实际保存失败仍须明确反馈。回归同时覆盖设置读取失败、目录读取失败、失败后的再次保存和延迟到达的旧响应，避免界面与实际生效值分叉。

- 排查 DSH Tool 参数失败时，对照该步的真实 `request/header` 与 `tool/call`：参数匹配模型收到的 schema、却被执行时新 schema 拒绝，是生成期间更新的竞态，不能只归因为模型填错。检查 SQL 报错时先核对运行中数据库路径和当前 schema，旧演示库的表名不能用于运行库。业务 preset 与恢复规则见 [DSH 页面操作](../agent-capabilities.md)。
- DSH 工具目录交接回归必须在同一用户回合连续执行动作并检查第一条后续模型请求的实际 schema；分多个用户回合等页面稳定后再调用会漏掉竞态。测试模型收到结果后立即继续，不能用固定延时、重试或等待注册再发送第二条用户输入作为交接证据。
- 新 worktree 的文档检查若把 `CLAUDE.md` 中的 `AGENTS.md` 路径当正文并报缺少末尾换行，先检查 Git 的 `120000` mode 与 `core.symlinks`：禁用 symlink 的 checkout 会生成普通文本占位文件。只在隔离 worktree 中按已跟踪 blob 恢复原链接，不修改文档内容或共享 Git 配置。

- `pnpm install --lockfile-only` 自动解决锁文件冲突时可能重新解析间接依赖，顺带升级两侧均未改动的版本。常规主分支整合先按合并后的 manifest 合并两侧已有锁条目，核对 package 版本与 integrity 沿用原值，再用 `pnpm install --frozen-lockfile` 验证；不要把自动解冲突成功等同于依赖范围未变。
