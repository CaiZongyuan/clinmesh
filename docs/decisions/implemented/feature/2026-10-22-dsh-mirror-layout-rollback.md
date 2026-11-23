# Agent Note: DSH 助手会话保持宿主右侧原生位置、镜像预设兼容升级与会话整体收起

Status: implemented

## Problem

在探索 AI 原生医生工作台期间，上游桥接仓库曾新增将会话列置于左侧的 `workspace-mirror` 布局预设；但 ClinMesh 接管宿主侧栏底部启动槽后隐藏了布局切换下拉，且实机验证表明左侧会话列背离 DSH 宿主右侧对话习惯。将默认值切回右侧 `workspace` 时，若直接从 `supported` 移除 `workspace-mirror`，注册表恢复阶段会静默丢弃存量偏好导致落盘状态无法升级修复；同时，用户在分屏下希望临时收起右侧会话及原生文件面板以释放横向空间，而全屏模式会连带遮挡左侧岗位导航。

## Decision

固定右侧原生会话默认布局、保留一次性存量镜像偏好自愈，并提供保持挂载的右侧会话整体收起能力，当前壳层边界见[Agent 集成](../../../architecture/agent-integration.md)与[前端架构](../../../frontend-architecture.md)：

1. **默认右侧 `workspace` 布局与存量 `workspace-mirror` 自动升级**：Surface 注册声明 `default: 'workspace'` 且不暴露镜像布局切换入口，但在 `supported` 中继续保留 `workspace-mirror`（纯几何预设保留在上游 `dsh-react-surface`），使 `upgradeLegacyMirrorLayout` 能在注册恢复时读取存量 `workspace-mirror` 偏好并通过 `setLayout('workspace')` 一次性落盘修复。`surfaceDisplay.queuePresentation: 'rail'` 与镜像预设解耦，统一作为 DSH 面各布局的左侧可收起队列形态。
2. **不卸载 DOM 的右侧会话与原生文件栏整体收起**：Surface registry 按应用在内存维护默认展开的会话收起状态（不改写用户分栏宽度持久化偏好），在 ClinMesh 页头右侧提供开关。收起时由通用 Host Adapter 对右侧会话区、显式声明 `visibility: visible` 的原生文件停靠栏以及挂载到 `body` 的原生浮动文件预览同步施加 `inert`、`aria-hidden`、`visibility` 与 `opacity` 隐藏，保持左侧岗位导航可见且不销毁会话 DOM、不关闭已开文件、不中断后台运行中的 Agent 回合；关闭或卸载应用时自动恢复原状。

## Alternatives considered

- **将会话 UI 迁入 ClinMesh 内容区自绘（会话嵌入路线 B）**：需在应用内长期复刻宿主聊天列表、工具绑定与输入框，每次 DSH 升级均产生高昂对齐成本。
- **直接从 `supported` 删除 `workspace-mirror`**：导致存量持久化偏好在快照读取前被静默净化而无法写回 `workspace`。
- **用 `full-frame` 全屏替代会话收起，或收起时主动关闭原生文件标签后手动重建**：全屏遮住左侧岗位导航，手动关开文件栏则引入第二套文件状态竞争。

## Consequences

ClinMesh 与 DSH 宿主原生右侧对话布局保持一致，历史镜像偏好无感升级，医生可一键临时折起右侧对话与文件栏扩宽病历表格而不打断在途会话；待确认不再存在存量旧偏好后可同步移除 `workspace-mirror` 兼容项。
