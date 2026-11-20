# Agent Note: DSH 原生 ClinMesh React Surface 与宿主壳层协同

Status: implemented

## Problem

ClinMesh 需要让 DSH 原生会话中的 Agent 感知当前医院工作台状态并执行受控前端动作，同时保留 standalone Web、Hono、SQLite、共享 Command、审计与隐藏真值隔离。若采用 iframe 或复制第二套页面会分裂状态所有权；若让 Surface 与宿主各自维护侧栏、右栏、主题、语言和多栏断点，会在 1280px 宿主窗口中挤压出四栏布局并造成中英文或明暗主题冲突；若让 Agent 直接提交正式医院写命令或读取完整 DOM／缓存，则会绕过人类岗位责任并泄漏无关患者与 Case Truth。

## Decision

保留 standalone Web，将 `apps/dsh-web` 作为复用同一 Web 应用接口的原生 DSH React Surface 适配器，协议与壳层边界分别由[Agent 集成](../../../architecture/agent-integration.md)、[前端架构](../../../frontend-architecture.md)、[临床 UI 设计](../../../ui/design.md)与[部署指南](../../../deployment.md)拥有：

1. **上游版本锁与 0.2.2+ 原生桥接**：DSH、dshvm、React Surface（git submodule）与 AG-UI 的精确版本与支持提交统一由 [`dsh-upstreams.lock.json`](../../../../dsh-upstreams.lock.json) 锁定，Node.js 最低版本随宿主对齐至 24.9，Bun `1.4.2` 仅执行上游 Surface 构建与单文件 lazy-CJS 产物校验（无动态 chunk、React 外置、白名单 `require`）。主会话绑定订阅公开 `uiSession.adapter.current`，工具执行对齐 `@deepseek-ai/dsh-tool-executor-native`，追问接续通过公开 `sessionProjections.snapshot(session, ['userQuestions'])` 读取客户端视图，不在 ClinMesh 内复制宿主会话日志或问答状态。
2. **宿主主题／语言归属、字号设置与侧栏导航**：DSH 统一拥有 Surface 生效主题与语言（Surface 内移除独立主题／语言切换控件且不回写 standalone Web 本地偏好）；ClinMesh 通过官方 `settings.general.item` 注册专属三档字号选择器（持久化于 `clinmesh.dsh.font-size:v1`，首次只读继承旧 Web 字号）。侧栏首次挂载默认收起宽栏，通过官方品牌插槽固定 ClinMesh 标识，在 `sidebar.workspaces` 前渲染经 Web 授权注册的平铺岗位路由，底部 `sidebar.footer.action`「医院工作台」菜单承载应用返回与辅助入口，会话标题栏 `conversation.header.leading` 弹层复用宿主公开 Session／Workspace 控制器与受版本约束的 `DirectoryFlow` 提供历史搜索、新建与切换。401 响应仅在绑定原登录代次时卸载工作台并撤销宿主导航。
3. **适配 DSH 宽度的两卡壳层与统一提交反馈**：工作台外壳收敛为 48px 顶栏、队列卡与主卡（患者头部、页签、内容区、底部操作栏），移除独立业务右栏与早期宿主右栏患者标签页；门诊完诊七项、质控与建议汇总并入患者头部，住院岗位的「助手已准备」行仅统计真实待确认的 Agent 提案（`useAgentReviewTitle`），不把确定性预分组或规则待办伪装成 AI 成果。容器窄于 800px 时队列默认收起为顶栏触发的浮层（`queueNarrow` 与宽屏 `queueCollapsed` 分离）。`WorkspaceActionBar` 提交期间沿祖先链将兄弟节点设为 `inert`（保留住院 portal 操作栏焦点），完成后通过 `announceHandoff` 播报结果与交接岗位。
4. **同源窄代理、受信页面上下文与原位人工审阅**：宿主同源代理除 `/clinmesh-api` 转发 `/api` 外，仅将精确校验 ID 的 `GET /fhir/R5/Patient/<id>` 映射至 `/clinmesh-api/_fhir/R5/Patient/<id>`（其余裸 `/fhir` 路径或非 GET 一律 404/405）。浏览器提交白名单 `PageContextClaim` 与单调 revision，Server 重验会话、岗位、Workspace/Epoch 与权威资源后签发 5 分钟 `PageContextSnapshot`（不含 Case Truth、DOM 或其他患者缓存）；Host 在 `tools/pre-execute` 签发一次性 execution proof（短期 Context 续签与语义 revision 绑定见[业务 Agent Harness](2026-10-07-dsh-business-agent-harness.md)）。读取、导航与草稿可由 Agent 直接执行；正式医院状态变更只创建 `.propose` 提案并立即返回 `awaiting-human-review`，在工作台原位锁定准备时的输入、版本与幂等键等待人类批准，经 Server decision gate 核验后以当前登录人类为最终 Actor 提交共享 Command，失活或上下文变化记为 `stale`。

## Alternatives considered

- **使用 iframe、复制 DSH 专用业务页面或建立第二条 AG-UI Gateway 会话**：分别引入跨框焦点／认证割裂、业务状态分叉或双份会话日志所有权。
- **保留 Surface 内部侧栏、三栏右轨或宿主 `rightbar` 影子独占**：在 1280px 分屏下将编辑区压缩至约 300px 或覆盖宿主原生文件停靠栏；收口为紧凑宿主侧栏加两卡主工作台可兼顾分屏对话与表单密度。
- **在 Surface 与宿主同时暴露主题／语言控件或写回同一本地存储键**：造成中英文混排并污染 standalone Web 独立偏好。
- **代理任意 `/fhir` 路径或让 Agent 直接提交正式写 Command／等待单次 browser lease 完成人工审阅**：扩大非必要资源暴露、混淆医疗法律责任主体，或因人工审阅超时导致弹窗与工具状态分裂。

## Consequences

standalone Web 与 DSH Surface 共享同一套业务组件、TanStack Query 缓存策略与 React 18/19 双版本 ShadowRoot 合同（API 约束见 [Surface React API 面约束](../bug-fix/2026-09-16-dsh-surface-react-api-surface.md)，产物压缩与体积门禁见 [DSH 客户端语法压缩](../testing/2026-11-13-dsh-client-syntax-compaction.md)）。侧栏岗位定位与 `DirectoryFlow` 复用依赖锁定版 DSH 插槽结构，升级宿主须通过[上游候选隔离验收](../process/2026-09-15-dsh-upstream-candidate-verification.md)核实真实 DOM、会话切换与工具执行。当前同 Profile 桥接仅适用于受信插件与全合成演示数据。
