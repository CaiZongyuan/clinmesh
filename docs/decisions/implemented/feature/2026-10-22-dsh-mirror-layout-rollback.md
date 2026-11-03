# Agent Note: 助手会话保持宿主右侧原生位置，镜像布局预设仅作兼容保留

Status: implemented

## Problem

[镜像布局预设决策](2026-10-20-dsh-mirror-layout-preset.md)让助手会话列位于左侧，以配合“中病例 + 右建议栈”的内容区布局。集成宿主的「医院工作台」导航以同 slot 同 id 替换了上游启动器，布局下拉随之消失，镜像预设没有用户可见的切换路径，只能作为 ClinMesh 表面的默认形态。实机体验后确认会话列应保持宿主右侧原生位置。默认值改回后，短暂镜像默认期已经持久化的 `workspace-mirror` 偏好仍需可恢复，否则注册表恢复阶段会把它静默净化。

## Decision

ClinMesh Surface 注册声明 `default: 'workspace'`，不新增布局切换入口。`supported` 继续包含 `workspace-mirror`：注册表只恢复受支持的存量布局，升级函数依赖快照读出该值；移出 `supported` 会让恢复阶段静默丢弃偏好，落盘状态永远无法修复。Surface 注册时由 `upgradeLegacyMirrorLayout` 将存量 `workspace-mirror` 偏好升级为 `workspace`，`setLayout` 即落盘，只发生一次。`workspace-mirror` 预设本身保留在上游桥接仓库 `dsh-react-surface`。

队列折叠卡片不再与镜像布局绑定：`surfaceDisplay.queuePresentation: 'rail'` 是 DSH 面所有布局的统一队列形态，贴内容区左缘、默认收起，展开后含在诊、待诊、完诊页签。宿主侧栏保持默认收起，所有权不变。

## Alternatives considered

保留镜像布局为默认：与宿主原生会话位置不一致，实机体验否定。未采用。

从 `supported` 移除 `workspace-mirror`：声明更干净，但存量偏好会在恢复阶段被静默净化而非升级，持久化状态无法自愈。未采用。

把宿主侧栏改造为会话助手（会话嵌入，路线 B）：需要上游提供会话列注入接口并单独立项评估，ClinMesh 不自行复制宿主会话栈。不随本线交付。

## Consequences

ClinMesh 布局默认与上游 `workspace` 一致，助手保持原生升级路径。`workspace-mirror` 的兼容声明和升级函数需随存量偏好一同保留；确认不再有存量偏好需要升级后，才能一并移除声明和升级函数。

