# Agent Note: 保留宿主覆盖层级

Status: implemented

## Problem

提高 HIS 所在 overlay 的层级会使原生文件全屏无法完整覆盖工作区，并遮挡向右展开的医院工作台菜单。本决策取代 [Surface 会话整体收起](../feature/2026-09-15-surface-conversation-collapse.md) 中提高 overlay 层级的方案，任务仍归属 [issue #101](https://github.com/CaiZongyuan/clinmesh/issues/101)。

## Decision

Surface 不修改宿主 overlay 的 z-index。原生文件全屏、浮窗和菜单沿用宿主与组件的正常层级；原生文件全屏可覆盖整个 HIS。用户退出文件全屏后再操作 HIS 的会话收起入口。

会话收起仍整体隐藏会话及其文件区域并保留挂载状态；展开恢复原生状态。此能力不承诺在覆盖 HIS 的原生窗口上方显示应用按钮，也不调整宿主菜单、文件窗口的层级。官方 DSH 源码保持不变。

浏览器集成测试使用真实医院工作台菜单与 Surface，并在重叠坐标检查点击命中；覆盖菜单在 HIS 上方、原生文件全屏与浮窗在 HIS 上方，以及退出文件全屏后收起入口恢复可用。

## Alternatives considered

**提高 HIS 层级，再逐个提高菜单层级。** 破坏原生全屏含义，并产生跨组件的层级竞争。

**在原生文件全屏上额外显示 HIS 按钮。** 增加未经需要的交互入口，仍干扰原生全屏；退出文件全屏即可恢复应用操作。

## Consequences

原生窗口覆盖 HIS 时，HIS 的按钮可被遮住，这是宿主正常的覆盖关系。回归测试必须同时验证应被覆盖与应保持可操作的区域，不能把所有应用控件始终可点当作正确行为。
