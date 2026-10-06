# Agent Note: DSH 紧凑侧栏与会话历史

Status: implemented

## Problem

宿主侧栏的工作区与会话浏览占用分屏空间，但隐藏整个侧栏会丢失品牌、岗位和设置入口。正式需求见 [spec](../../../../docs/spec/2026-10-06-dsh-compact-sidebar-workspace-history.md)，执行跟踪见 [Issue #150](https://github.com/CaiZongyuan/clinmesh/issues/150)。

## Decision

ClinMesh DSH adapter 在侧栏首次挂载时调用公开 `layout.toggleSidebar()` 收起宽栏，之后不干预用户手动展开。两种形态保留品牌、已授权岗位及底部入口，隐藏原生新会话、全局面板和工作区浏览区域。岗位导航继续使用[侧栏平铺岗位导航](2026-09-14-dsh-inline-workspace-routes.md)的权限、路由和卸载合同；本决策取代其工作区浏览展示位置与保留空间的决定。

会话标题栏的 root-scoped `conversation.header.leading` Slot 提供历史和新会话入口，因此没有当前会话时仍可操作。紧凑弹层只维护打开、搜索、菜单及表单状态；列表订阅 DSH 的 `sessions.list`、`workspaces.list` 与 `uiSession.adapter.current`。选中工作区默认来自当前会话，否则采用最近工作区；搜索通过可取消的公开 Session Controller 合并标题、工作区及内容匹配，并沿用宿主结果数量上限。

会话和工作区写入调用 DSH 公共控制器。Fork 完成后才打开子会话；期间导航或关闭弹层会阻止迟到结果改变选择。活动会话归档拒绝后显式确认停止，工作区删除只移除注册。所有操作保留宿主失败边界并显示错误，不复制会话日志、持久化数据或医院业务状态。

工作区目录选择复用宿主已经组合的 native/browse DirectoryFlow。`pickDirectory()` 只支持系统选择器，不能替代 Web/Linux 的 browse 流程。DSH 不允许跨 owner 渲染已声明的 child Slot，因此 adapter 通过公开注册表的 inspection surface 读取固定版本的获胜无状态 flow entry，将其 component 与 inject 注册到自己的 `clinmesh.history.directoryFlow`，保留原 Slot。此处是有版本边界的兼容适配，不是官方 picker factory；含 store、locale 或 child declarations 的后续 provider 不复用，显示不可用。源 entry 替换或卸载时同步释放 alias；创建目录、隐藏目录、路径浏览与取消仍由官方 flow 提供，路径采纳仍调用公开 Workspace Controller。

## Alternatives considered

**锁定收起并替换品牌展开控制。** DSH 0.2 没有公开的侧栏锁定接口；自行修改宿主布局状态或替换整条侧栏会扩大兼容范围，因此保留原生手动控制。

**把原生 WorkspaceBrowser 直接放入弹层。** 当前宿主不导出完整浏览器挂载接口；自行导入发行包内部组件或复制宿主源码会形成维护分叉。

**简化为仅能切换的历史列表。** 无法保留已确认的工作区和会话操作。Adapter 重做展示，状态及操作仍由宿主拥有。

## Consequences

显示兼容规则限定在宿主 sidebar，并依赖固定版的 Slot 标记与原生新会话按钮名称；品牌按钮通过其品牌 Slot 排除，保留宿主展开控制。卸载移除 stylesheet、入口和岗位节点，恢复宿主展示。宿主升级需验证真实侧栏 DOM 与标题栏定位；不修改官方源码。

标题栏为历史入口预留自然布局空间，原生 utility 和右栏按钮保持可点击；弹层宽度以所在会话列为限。DirectoryFlow 的复用边界同样纳入升级回归，测试源 entry 的替换、卸载和不兼容结构；宿主提供公开 picker factory 后移除该 alias 适配。

弹层使用宿主主题变量和语言，不引入第二份偏好。键盘、失败、搜索取消及迟到结果由 Slot/Adapter 测试覆盖；浏览器合同覆盖 React 18/19，真实 DSH 入口验证布局和公共控制器行为。独立 Web 与医院业务流程不受此 adapter 变更影响。
