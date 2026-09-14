# Agent Note: DSH 宿主承接医院工作台导航

Status: implemented

## Problem

DSH 的侧栏与 ClinMesh Surface 内部侧栏同时占用横向空间。岗位导航、设置、外观与全屏入口又不能随内部侧栏一起丢失。任务合同见 [issue #88](https://github.com/CaiZongyuan/clinmesh/issues/88)。本决策取代[手动全屏与容器响应式](../bug-fix/2026-09-11-surface-responsive-layout.md)中 Surface 内部侧栏及全屏按钮的位置，保留其手动布局与草稿保留约束。

## Decision

岗位入口的位置由[DSH 侧栏平铺岗位导航](2026-09-14-dsh-inline-workspace-routes.md)取代；本记录保留宿主承接、权限注册、全屏与生命周期的决策依据。

DSH adapter 通过官方 `sidebar.footer.action` 插槽注册“医院工作台”菜单，以较低 priority 承接 `dsh-react-surface-launcher` cell，避免折叠侧栏同时挤入两个启动按钮；卸载时恢复原入口。其他已注册 Surface 保留在菜单的“其他应用”分组。ClinMesh 应用发布当前可见路由、页面、语言、主题及受限回调；菜单不获取完整 Session、不复制 Query cache，也不拥有第二套路由或岗位权限。岗位变化、会话失效和应用卸载会替换或撤销注册，过期回调不再执行。应用尚未登录或尚未挂载时，不显示医院业务路由，仅提供打开 ClinMesh 的入口。

菜单在独立 ShadowRoot 中复用 ClinMesh 菜单组件与作用域样式，跟随 DSH 外观，浮层留在该根内。宿主侧栏的展开与折叠决定按钮展示文字或标志。点击路由先显示保留的 Surface，再调用应用自己的白名单导航；内部导航仍使用 Memory Router，不修改 DSH URL。主题操作仍更新应用偏好，宿主菜单不写 DSH 主题。

Surface 外壳只显示现有页头与业务内容。全屏与返回分屏按钮在页头中，账户和岗位切换位置不变。全屏时 DSH 侧栏不可访问，用户先返回分屏再导航；登录、加载和错误状态保持独立返回入口。Standalone Web 保留自己的侧栏。

## Alternatives considered

**仅隐藏内部侧栏。** 会失去导航、主题快捷切换和全屏返回入口，不能满足完整操作路径。

**扩展 DSH 常驻业务导航分组。** 当前固定版本没有该插槽，且本需求可由官方底部菜单承载，因此不增加宿主协议和升级边界。

**使用全局 panel 导航或替换 Workspace 浏览区域。** 全局 panel 的点击切换 DSH 主面板，不能表达 Surface 内部路由；替换 Workspace 插槽会覆盖原生会话浏览器。

## Consequences

宿主导航只在 ClinMesh 已有会话能力范围内提供操作。隐藏 Surface 保留应用与导航注册，重新打开不会因宿主菜单创建新的业务实例；失效会话由应用现有认证路径撤销菜单。布局往返不改变业务状态、医院 Command 或 Agent 授权边界。

Web 外壳测试覆盖内部侧栏移除、岗位导航发布及撤销、设置往返和独立 Web。DSH adapter 测试覆盖官方插槽生命周期、折叠菜单与旧回调失效；真实浏览器覆盖菜单、手动全屏往返和草稿保留。
