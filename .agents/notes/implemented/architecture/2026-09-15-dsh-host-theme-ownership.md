# Agent Note: DSH 统一管理 Surface 主题

Status: implemented

## Problem

DSH 和 ClinMesh 同时提供主题选择时，“跟随系统”分别指向操作系统与宿主生效主题，本地显式偏好还会覆盖宿主结果。任务合同见 [issue #99](https://github.com/CaiZongyuan/clinmesh/issues/99)。本决策取代[宿主承接工作台导航](2026-09-14-dsh-host-workspace-navigation.md)中的独立主题操作和[侧栏平铺岗位导航](2026-09-14-dsh-inline-workspace-routes.md)中的底部主题分组，保留导航、权限、全屏及生命周期合同。

## Decision

DSH 拥有 Surface 的主题选择。Client adapter 继续订阅宿主解析后的 light/dark，Web application 在自己的根节点应用该结果，覆盖工作台和公共组件目录；隐藏但保留挂载的 Surface 也持续接收变化。缺少宿主主题输入时使用浏览器系统主题，不回退到旧的本地显式选择。

Surface 中移除医院工作台菜单、账户菜单、通用设置和组件目录的主题控件。导航注册只提供路由、当前页面、语言与受限导航回调，不传递主题选择。底部按钮保持“医院工作台”，打开后的菜单标题与可访问名称为“设置”或“Settings”。主题样式与 Portal 隔离保留，宿主菜单独立跟随宿主配色。

独立 Web 继续使用设备本地主题偏好，组件目录和 UI Lab 保留预览。Surface 主题同步不改写该偏好，也不修改语言与字号。当前产品边界由[系统架构](../../../../docs/architecture.md#71-surface-与-host-边界)拥有。

## Alternatives considered

**只隐藏主题按钮。** 本地已保存的 light/dark 仍会优先覆盖 DSH，用户失去恢复同步的入口。

**把本地偏好强制写为 system。** 能使 Surface 跟随，却改变持久化的独立 Web 选择；由运行模式决定主题来源无需迁移存储。

**保留组件目录的全局主题预览。** 该控件直接改变应用根并保存偏好，仍构成另一条主题控制入口。Surface 使用宿主主题即可预览明暗状态，独立目录保留原能力。

## Consequences

主题应用由应用生命周期拥有，不依赖某个业务路由挂载。WebApp 集成测试覆盖旧偏好、实时变化、重挂载、控件移除、语言字号、独立 Web 和浮层隔离；DSH adapter 测试通过主题事件驱动真实 application，并验证隐藏期间同步及卸载清理。真实 DSH 入口验证菜单、设置、组件目录与全屏往返。
