# Agent Note: 以 DSH 宽度重排外壳并统一提交反馈

Status: implemented

## Problem

[卡片工作台](2026-10-30-workspace-card-composition.md)按 900／600px 切换三栏、两栏和单栏。DSH 宿主 1280 宽时 Surface 约 826px，右栏落到主区下方，编辑区只剩约 300px；宿主对话区加 Surface 右栏在屏幕上形成四栏。提交时只有按钮变灰，成功后没有交接说明，队列选中与悬停难以区分。[外壳与反馈规格](../../../spec/2026-11-02-dsh-shell-feedback-redesign.md)要求以 DSH 实际宽度为基准重排，并让每次提交都有进行中、完成和受阻反馈。

## Decision

外壳只保留 48px 顶栏、队列卡和主卡。`WorkspaceShell` 提供患者、队列按钮和流程三个页头插槽，`workspace-card-layout.tsx` 把流程和队列开关投影进去；顶栏页头宽度窄于 40rem 时隐藏流程，保住患者名。主卡从上到下是患者头部、页签、内容区和操作栏。所有岗位不再有右栏：门诊医生的完诊清单、质控和推荐并入患者头部的事实标签与「助手已准备」行，其余右栏内容改为头部标签或内容卡。本决定取代卡片工作台 Note 的 900／600px 断点与右栏，部分取代[医生建议栈 Note](2026-10-20-doctor-suggestion-stack-banner-progress.md)的位置要求；七项门禁和建议的数据来源不变。

ResizeObserver 测得卡片容器窄于 800px 时，Zustand 视图状态记 `queueNarrow`，队列默认收起，从顶栏按钮以浮层打开；在队列条目内选择、点遮罩或按 Esc 后收起。浮层状态与宽屏的 `queueCollapsed` 分开保存，宽窄切换不改写用户在宽屏的选择。队列不再叠到主卡上方，旧的 600px 横排样式已删除。

`WorkspaceActionBar` 的 `busy` 文字（或 `WorkspaceSubmittingProvider` 提供的默认文字）让主按钮换成转圈的同名按钮。正在运行的操作栏把自身登记给布局，布局沿它的祖先链把每层兄弟节点设为 `inert`。住院操作栏通过 portal 挂进包裹层或留在内容区，只排除 `.clinmesh-card-action` 直接子元素会把它一并冻结，按钮重新挂载时也拿不到焦点。成功提交调用 `announceHandoff` 写明结果与交接对象。队列行被单独移除时，克隆节点在原位置淡出；克隆去掉 `id` 与 `data-agent-*`，页面上下文和定位器只看到一行。减少动效时这些动画全部关闭。

住院岗位的「助手已准备」行只取正在等人确认的 Agent 审阅标题（`useAgentReviewTitle`）。护士、住院医生和收费员的助手能力都在 Agent 被调用后才准备，DRG 预分组和耗材预计是确定性服务；系统计算的待办数不标成助手成果（2026-11-02 用户决定）。医保核定把归档分组与费用移到核定说明之前，说明仍在审阅前填写并随金额指纹一起冻结，原位确认提交的就是审阅时看到的内容（2026-11-02 用户决定）。

## Alternatives considered

- 保留三栏，只在 DSH 中压缩右栏：826px 下编辑区仍不足 520px，且宿主对话区加右栏仍是四栏。
- 窄屏把队列叠在主卡上方：长队列把主卡推出首屏，用户已决定改为浮层。
- 提交时只禁用表单或给 `.clinmesh-card-main` 直接子元素加 `inert`：前者仍能聚焦与触发快捷键；后者冻结住院 portal 中的操作栏。
- 「助手已准备」显示确定性待办数：与原型一致，但会把非 AI 结果标成助手成果。

## Consequences

窄屏旅程必须先从顶栏展开队列；`apps/web/e2e/queue-overlay.fixture.ts` 提供 `openQueue` 与 `expectConsultationStarted`，选中后浮层收起时改用主卡可见状态确认进度。切换门诊／住院是另一个工作台视图，浮层需要重新展开。`inert` 与 `aria-busy` 由 jsdom 单元测试覆盖嵌套操作栏；选中蓝边、离开克隆、虚线禁用和步骤动画由 React 18／19 Surface 合同测试覆盖。当前布局与 token 归 [UI 设计合同](../../../ui/design.md#共用卡片工作台)。
