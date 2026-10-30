# Agent Note: 共用卡片工作台与原位审阅

Status: implemented

## Problem

岗位页面各自管理队列、患者横幅、分区和主操作，Web 与 DSH 的视觉及窄屏行为不同。模态 proposal 审阅遮挡对象；若批准时重新读取可编辑状态，等待审批期间的输入可能替换人类实际核对的内容。[工作台规格](../../../spec/2026-10-30-workspace-card-redesign.md)要求全岗位一致，同时保留全部业务、权限和未知结果恢复。

## Decision

Web application 内的 `workspace-card-layout.tsx` 组合通用 UI primitive，统一流程线、可收起队列、患者页头投影、分区、只读右栏和底部主操作。业务数据、状态机和 Command 仍归原模块。TanStack Query 拥有服务端状态；Zustand 只记录队列收起、页签和门诊／住院等客户端视图。临时输入与来源按账户、Actor、Workspace/Epoch、岗位和患者／业务对象隔离，不复制服务端结果。

响应式按内容容器的 900／600px 断点切换；更多页签保留当前项，窄屏保留主操作的可到达空间。医生右栏继续承接七项完诊、质控和建议。本决定部分替代[医生建议栈 Note](2026-10-20-doctor-suggestion-stack-banner-progress.md)的专属断点与窄屏抽屉，以及[内联完诊 Note](2026-10-06-doctor-inline-completion-checklist.md)的模态完诊呈现；七项门禁、确定性计数、草稿隔离和合法纠错继续有效。

proposal 继续使用单一 Agent review controller、原 receipt 和 decision gate，只将审阅投影到对象行或底部。需要核对的勾选仍约束确认，Abort、卸载和上下文变化使原审阅失效。正式写入使用准备审阅时固定的输入、版本、预览与幂等键；批准后不从变化后的表单重新组装意图。页面内的不可逆人工动作采用相同的后果确认形式，不改变已有 Command 门禁。安全边界详见[Agent 接入](../../../architecture/agent-integration.md#75-人工审阅语义)。

三岗模式与身份作用域绑定。收费员住院模式发布 `inpatient` 上下文，但实际路由仍为 `/billing`；助手的逻辑导航同步切换模式。挂号员与药师保留各自的窄能力，模式切换不授予其他角色的住院工具。全局应用 CSS 分别从 Web `main.tsx` 和 DSH `styles-entry.ts` 加载，避免组件跨包导入样式突破 Surface builder 的仓库边界。

## Alternatives considered

- 保留各岗位外壳，只替换颜色：无法统一分屏布局、操作位置和审阅生命周期。
- 由通用卡片组件接管业务状态与提交：会复制 Command 或造成服务端状态双份归属。组合只负责呈现，业务页面继续拥有操作。
- 保留模态 proposal 或批准时读取最新输入：前者打断原位核对，后者可能提交未经核对的新金额、数量或内容。
- 放宽 Surface builder 的仓库边界或修改宿主源码：样式入口已有平台归属，无需扩大依赖和信任范围。

## Consequences

共享组合需要验证真实父布局和高度链，不能以纯组件快照代替窄屏可达性。Web 与 React 18／19 ShadowRoot 合同覆盖真实入口、门户、焦点、固定审阅输入、身份切换和报告显示证明；旧业务旅程只迁移布局与文案定位，保留金额、版本、权限及恢复断言。确认样式不代表业务已提交，完整结果仍由 Command 回执与后续查询确定。当前行为与 token 归[UI 设计合同](../../../ui/design.md)，跨端装配归[前端架构](../../../frontend-architecture.md)。
