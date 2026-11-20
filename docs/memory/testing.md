# 测试与验证排障

处理测试筛选、并发争用、测试替身、异步屏障或草稿回执恢复时查阅；测试层级与门禁合同见 [`docs/testing.md`](../testing.md)，包级约束见 `apps/*/AGENTS.md`。其他主题见[工程记忆入口](memory.md)。

## 运行筛选、并发与性能门禁

- **Vitest 定向命令**：单跑文件统一用 `pnpm --filter <package> exec vitest run <file> [-t <pattern>]` 并核对 `Test Files` 数量——`pnpm --filter <pkg> test -- <file>` 会保留额外 `--` 跑整包，根级裸跑 `npx vitest run apps/server/tests/...` 会套用根默认 `5s` 超时使 `apps/server` 的 `15s` 配置失效。共享重型夹具放入局部 `beforeAll`/`beforeEach`（配 `afterAll`/`afterEach` 释放），每个 `it` 只测单一行为；交互最重的单测触及 `5s` 边界时按文件内先例局部标 `15_000`，不全局放宽默认时限。
- **多任务并发争用与缓存隔离**：本地多 worktree 共用 CPU/内存，重检查可用仓库外 `flock` 串行化；小内存宿主跑 `@clinmesh/web` jsdom 可传 `--maxWorkers=4`，全局限流若设 `TURBO_ENV_MODE=loose VITEST_MAX_WORKERS=1` 须注意与默认 `strict` 缓存隔离，且报告中如实注明受限并发。长检查运行期间禁止中途改源码，中断 Turbo 串行链须按整棵进程树停止。
- **Tailwind 扫描范围与双版本并发**：DSH Surface 样式与 Web 字号/主题合同以仓库根扫描 Tailwind 候选，修改 Markdown 中类名文本也可能改变生成 CSS。双版本重型浏览器合同并发超时而单例正常时，可沿用 `test.describe.configure({ mode: 'default' })` 串行同文件用例并保留全部隔离与断言；先前文件若触发生产 Vite build 污染 `NODE_ENV`，检查 Better Auth 是否在复用 worker 中开启了生产注册限流。
- **`perf:ci` 与集合判重陷阱**：`perf:ci` 在临时 SQLite 上运行固定合成门禁（约 13 秒，无需压测许可），统计主文件 + WAL + SHM 总增长——短事务更新多列优先建单个复合索引而非多个单列索引；新增每 Epoch 基线数据（如新 Hospital Service）时同步更新 `apps/server/performance-baselines.json`。Zod `superRefine` 校验可选字段不重复时先 `filter` 非空项再进 `Set`，严禁用 `x.field ?? ''` 把多项缺值全部判为重复。

## 私稿、持久写意图与跨页状态

- **私稿异常与退出恢复矩阵**：私稿回归须分别注入 `getItem` 抛错、损坏 JSON 与 `setItem` 失败（覆盖坏键排在有效未知稿之前及空行丢弃可达），确认丢弃前保留原文、确认后零业务 POST；验证“丢弃服务端已存草稿”须等公开读取确认 autosave 落库后再清空并真实 `signOut` 重登（仅重挂载会被残留 `sessionStorage` 遮蔽）。比较业务意图按稳定标识与解析后值判断，不用 `JSON.stringify` 直接比对不同路径对象（字段序差异会触发同步死循环）。
- **确定拒绝（4xx）与结果未知（5xx/断网）分流**：409 等确定拒绝须验证原键重放后解除冻结、保留输入并允许改后用新键提交（若退出后仅剩原意图而无草稿，先回填输入再释放门禁）；503、断网或坏响应属结果未知，必须等待恢复按钮可操作（而非仅 `toBeVisible`）并用原幂等键查询回执，活动态与完诊/离院只读态均须覆盖。
- **跨患者迟到响应与分页保持**：TanStack Query 默认 `invalidateQueries` 只刷 active query，离开病例后迟到回填须定向刷新该 ID 的 inactive query；Mutation 的 `isSuccess`/`data` 不会随自动切下一患者清空，提示渲染必须绑定原对象与选择代次。分页队列写操作后须验证保持原页码、原选中病例与整单余额。

## 浏览器、JSDOM 与测试替身

- **Playwright 定位与路由拦截**：组件挂载 fixture 须先注册路由并 `goto` `localhost` 有效 origin（`about:blank` 无存储与 `crypto.randomUUID`）；`.all()` 按实时序号重解析，点击改变筛选状态（如展开 `details:not([open])`）时改用循环 `.first()` 或稳定标识；Toast 同样具有 `role="dialog"`（`aria-modal="false"`），定位模态窗须限定名称或 `[data-slot="dialog-content"]`，等待 Toast 自然消失前移开指针，收起态需按 `F6` 展开后再点关闭；页签随异步计数可能收入“更多”菜单，用 `expect(...).toPass()` 兼容直点 tab 或展开 `menuitem`；Surface 代理叠加故障用 `route.fallback()`（`continue()` 会绕过底层转发），投影单资源按精确 `pathname` 匹配，拆毁自建后端前先 `page.unrouteAll({ behavior: 'wait' })` 排空后续刷新请求。
- **Base UI、动画时钟与 JSDOM 清理**：Base UI `Checkbox` 含隐藏 input，Playwright 用 `getByRole('checkbox', { name })` 而非 `getByLabel`；JSDOM 测 `Select` 用聚焦 + `{Enter}` + `findByRole('option')`；`Testing Library` 的 `getByRole` 默认精确匹配且不接受 `exact` 参数（混用致 `typecheck` 失败）。JSDOM 卸载组件并 `QueryClient.clear()` 后在 `act` 内排空 `notifyManager.schedule` 再拆环境（防迟到 observer 报 `window is not defined`）；ShadowRoot 切换原生 `hidden` 后注意 jsdom 样式缓存。Playwright 测短暂高光用 `clock.pauseAt()` 采样，测弹框动画关闭与 OpenSeadragon 瓦片用真实时钟有界等待，修改 `data-font-size` 后先等 computed `font-size` 到位再点击。
- **业务与模型替身保真**：Vitest 与 Playwright 共享 HTTP/SQLite helper 一律用 `node:assert/strict`（禁引 `vitest`）；完诊预览 stub 须覆盖全部 7 项编码，病历质控 stub 同时拦截 GET 轮询与 POST 并回显 `clientId`/`clientRevision`；开启模型用量账本后合成 bridge 响应须带匹配 `attemptId` 的核算回执（否则落入 `MODEL_OUTCOME_UNKNOWN`）；药库扩充后浏览器选药避免子串歧义（如精确匹配 `肝素钠注射液` vs `依诺肝素钠注射液`），按目录规则区分频次与剂量输入控件，带外轮询后台生成成功后仍须等页面自身轮询渲染新草稿再点确认（防旧 `expectedDraftRevision: 0` 触发 `409`）；跨岗位切换登录前等当前表单解除写入阻塞（防丢回执进入恢复门禁），只读验收在上一岗位页面完全卸载后再挂网络监听。
