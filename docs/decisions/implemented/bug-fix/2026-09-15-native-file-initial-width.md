# Agent Note: 工作区原生文件栏首次宽度

Status: implemented

## Problem

DSH `0.1.5-rc.2` 在原生右栏没有宽度偏好时，首次打开取窗口宽度的 45%；2048px 窗口得到 922px。Surface 工作区还需容纳应用与会话，该默认值挤压两者。手动拖动会建立原生宽度偏好，因此关闭重开后正常。任务归属 [issue #101](https://github.com/CaiZongyuan/clinmesh/issues/101)。

## Decision

`dsh-react-surface` 通过官方 root 插槽公开的共享 store 声明，为自身 overlay 注册同一个 store；实例生命周期及组件的 `useStore`、`actions` 注入由宿主 renderer 管理。Surface 不创建布局实例，也不访问 `LayoutController` 的私有字段。

适配器观察从未设置宽度且关闭的原生右栏到首次打开的转换。仅当活动应用使用 workspace 布局、会话展开、原生右栏非全屏时，在布局 effect 中调用宿主 `setRightbar(360)`。此前已打开过的右栏、手动宽度、应用全屏和会话收起均保留原生行为；只打开应用不会提前写入偏好。360px 为工作区初始偏好，实际边界约束仍由宿主执行。

共享 store 的字段和 action 形状属于固定 DSH 版本的适配边界，运行时验证必需字段；缺少 store 或不兼容时保留宿主尺寸。官方 DSH 源码与覆盖层级均不变，层级合同见 [保留宿主覆盖层级](2026-09-15-preserve-host-overlay-order.md)。

## Alternatives considered

**修改官方默认比例。** 影响所有原生工作区，并违反不修改官方 DSH 的约束。

**每次打开强制设置宽度。** 覆盖用户拖动偏好；只处理没有既有偏好的首次转换。

**仅用 CSS 限制文件栏。** 宿主保存宽度与实际列宽分离，后续拖动可能跳变。共享宿主 store 保持宽度来源一致。

## Consequences

宿主升级时需复核 root store 的共享实例语义与字段/action 形状。浏览器回归覆盖首次宽度、拖动保留、先于应用打开、文件全屏、应用全屏和收起状态；真实官方宿主验证共享 store 接入及拖动重开后的实际列宽。兼容能力缺失时不能声称首次宽度已受控。
