# Agent Note: Clinician Assistant 前后端双轨协作与 pi-durable Park+Signal 桥接 @ui-sdk/react

Status: proposed

## Problem

ClinMesh 已在 Step 2 将前端交互组件迁移至 `@ui-sdk/react`，并在 Step 3 用 `@earendil-works/pi-durable` 落地了持久化双智能体运行时（当前通过 SSE + POST 驱动）。在进入 Step 4 打通 `Clinician Assistant` 与临床工作台联动时，面临五个直接影响稳定性、医疗安全与部署兼容性的结构性矛盾：

1. **持久服务端引擎 vs 瞬时浏览器 DOM 状态**：`pi-durable` 是可跨刷新/重启续跑的服务端任务引擎，而 `@ui-sdk/react` 的 `createAgent()` 存活于单标签页内存（`ref` 刷新即失、多标签页可同时打开、人类确认最长可等待数分钟）。若在服务端用常驻 WebSocket + 内存 Promise 阻塞等待前端工具返回，不仅多维护一条有状态长连接，也会破坏休眠与进程重启恢复语义，并带来断线重放误点击风险。
2. **前后端工具职责不清**：若全靠前端读屏，助手会漏掉未打开页签/历史就诊的临床事实；若放任内置助手绕过前端直接写后端状态，医生在界面上看不见、改不了、难信任，且丢失未保存的本地草稿上下文。
3. **100 组件快照上限与跨页签抖动**：`@ui-sdk/react` 的 `snapshot()` 上限为 100 个组件；门诊与住院工作台控件密集，若无渐进式读取且不隔离侧栏自身按钮，不仅挤爆快照预算，还会因盲目 `reveals: true` 触发频繁切页闪烁或组件卸载。
4. **草稿覆盖与盲点确认风险**：纯手写字段锁和建议条会与 React 表单态双写；而在右侧聊天框里直接提供一键批准高风险医疗操作，容易诱发医生不核对左侧病历/处方内容便盲目点击同意。
5. **编程脚本与高风险确认的冲突**：`codemode` 嵌套调用采用同步等待，一旦脚本内部触及可挂起数分钟的人工确认动作，会长期锁死沙箱且在重启时引发重放失真。

## Proposal

1. **确立前后端互补双轨边界**：
   - **后端只读面**（`Clinical Read View`）：负责全量结构化临床事实、既往史、检验/影像报告、目录、确定性评分、质控与指南读取，不受当前页签/分页遮挡，服务端硬隔离 `Case Truth`。
   - **前端 `@ui-sdk/react` 面**（`Workspace Surface`）：负责读取未保存草稿、视觉呈现、页面导航、草稿暂存（`Staged Draft`）及发起正式提交。内置 `Clinician Assistant` 不挂载绕过界面的后端写工具。
   - 侧栏容器 `<aside data-clinmesh-assistant-sidebar>` 必须标注 `data-agent-hidden`，彻底隔离助手自身控件。
2. **采用 `pi-durable` 原生 Park + Signal 桥接（零新增 UI WebSocket）**：
   - 所有客户端 UI 工具（`ui_snapshot`、`ui_query`、`ui_act`、`ui_stage`、`ui_undo_agent`）标记为 `replay: "unsafe"` 的易失交互（`Volatile Interaction`）。
   - 执行时在会话文档写入带唯一 `dispatchId` 与浏览器标签页租约 `clientLeaseId` 的待执行任务，随即返回 `{ kind: "sleep", signals: [UiToolResult.key(dispatchId)], until }` 休眠挂起，释放全部服务端内存与 CPU。
   - 浏览器复用现有 SSE 流（`GET /api/agents/sessions/:sessionId/events`）接收待执行任务，校验单标签页租约后在本地执行 `@ui-sdk/react` 桥接调用，完成后通过 `POST /api/agents/sessions/:sessionId/ui-tool-results/:dispatchId` 触发 `harness.signal()` 唤醒任务。
   - 刷新页面、切换患者、失去租约、点击停止（触发工具 `cancel()`）或超时，均以明确 `stale_cancelled` 结束且绝不自动重放。
3. **全面复用 `@ui-sdk/react` 原生协作能力与三层渐进式前端上下文工程**：
   - **L0 轻量增量大纲（~200 tok，尾置在当轮用户消息后以保护 Prompt Cache）**：携带当前路由、病例/就诊绑定、激活页签、未保存脏字段摘要，以及由 `agent.subscribe()` 采集的医生最近手工编辑增量。
   - **L1 作用域按需读取**：优先按当前激活卡片/弹窗作用域快照或 `ui_query`，避免全页倾倒与盲目 `reveals: true` 切页。
   - **L2 批处理与极少量临床复合原语**：常规多步表单走 `ui_act({ steps })` 单次批量执行；针对两栏开单弹窗、多行处方/诊断与结构化病历等高频多步交互，补充 3–5 个带声明式 `agent` key 的 `definePrimitive`。
   - **草稿暂存与手改保护**：复用 `stageChanges` + `createHistory(agent)` / `history.undoSource("agent")` 实现一键撤回助手修改且保留医生后续手改；对正在聚焦或已由医生手改（`source !== "agent"`）的冲突字段，在回调中 `details.cancel()` 拦截静默覆写并仅对冲突字段展示采纳/忽略建议条。
4. **防盲点原位确认与脚本安全红线**：
   - 命中 `data-agent-confirm` 的高风险动作严格执行“拒绝可双端点，高风险批准必须左侧临床目标控件原位核对后点击”；右侧侧栏同步展示静态等待卡片与一键定位滚动按钮，不提供聊天框内直接提交批准。
   - 可能触发 `data-agent-confirm` 的工具通过 `callers: ["model"]` 禁止在 `codemode` 脚本内部嵌套调用，必须由模型在顶层显式发起。
5. **无感伴随模式（`Ambient Mode`）严格降权**：
   - 默认关闭；开启后仅由高价值临床事件（新问诊终态轮次、新报告签发）触发 `Ambient Trigger`，不监听敲键输入。
   - 通过 `pi-durable` `whenBusy: "followUp"` 投递，绝不打断医生正在进行的主动对话；通过会话级 `beforeTool` 钩子硬禁在 Ambient 回合触发任何高风险 `UI Confirmation`。

## Alternatives considered

- **为 UI 桥单独建立常驻 WebSocket + 内存 Promise 等待**：多一套连接与重连状态机，无法兼容休眠驱逐，且进程重启会丢失等待态。
- **内置医生助手直接调后端写 Command 再刷新页面**：绕过医生对未保存草稿和界面变化的直观审阅，破坏人机互信，且与现有前端受控状态机形成双写。
- **纯手写表单字段锁 + 聊天框一键批准**：重复造轮子（忽略 `@ui-sdk/react` 原生 `observe`/`history`/`stageChanges`），且聊天框审批存在临床误点风险。
- **允许 `codemode` 脚本内部直接调用高风险 `ui_act`**：会导致长等待挂死 QuickJS 沙箱并把高风险医疗提交隐藏在脚本副作用中。

## Acceptance criteria

- 侧栏容器标有 `data-agent-hidden`，`agent.snapshot()` 不包含任何助手侧栏控件。
- `ui_act` 触发 `data-agent-confirm` 后，服务端工具任务进入 `sleeping` 挂起状态，在左侧目标控件原位点击确认后唤醒 `pi-durable` 并完成正式提交；刷新页面、切换患者或点击停止均干净终止且后端零写入、零重放。
- 医生手改某字段后，助手再尝试修改该字段不会静默覆写；点击撤回助手草稿调用 `history.undoSource("agent")` 只回退助手改动并保留医生手改。
- `codemode` 脚本尝试调用高风险确认动作时被 `callers` / `beforeTool` 硬性拒绝。
- Ambient Mode 开启时仅在问诊终态轮次或新报告签发后经 `followUp` 触发草稿更新，且严禁弹出 `data-agent-confirm` 确认条。

## Risks

- 浏览器多标签页打开同一会话时若租约切换不严谨，可能出现旧标签页回传迟到结果；需在服务端校验 `dispatchId` + `clientLeaseId` 单次消费且 `harness.signal()` 对重复投递返回 `duplicate`。
- 少数高频临床复合 `definePrimitive` 需同步编写 `@ui-sdk/react` Agent-Ready 测试与视觉像素 Diff 测试，防止引入样式偏移或 WebMCP 行为不一致。
