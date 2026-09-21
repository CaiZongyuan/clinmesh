# Agent Note: 门诊医生病例上下文改为 DSH 会话右栏原生标签页

Status: implemented

## Problem

[surface 模式挂载 DSH 原生右列](2026-09-17-dsh-host-case-context-rightbar.md)以 `priority: -1` 影子化占用 `rightbar` 槽,把整个右列从宿主 dock 手里拿走:门诊医生页停留期间,患者信息与会话文件互斥,用户无法在患者上下文与会话文件间以宿主原生方式切换。任务合同见 [issue #115](https://github.com/CaiZongyuan/clinmesh/issues/115),本次反转向设计:患者信息与 DSH 会话"做在一起",以标签页形式切换。

## Decision

DSH 会话右侧的"文件栏"是官方 `ui-sidebar-right` 插件的标签页停靠面板(dockkit),并以两段式合同向第三方开放标签类型(官方 `ui-sidebar-documentpreview` 即公开路径的活证):

- **阶段一**:`ctx.sidebarRightTabs.register` 注册页面型标签定义(`id: '@clinmesh/dsh-web'`、`kind: 'clinmesh.case-context'`、无 `patterns` 即按 kind 打开)。`title` 与 `guide` 胶囊均为 thunk,每次使用重读宿主 locale,语言切换无需重注册;guide 在右栏引导页提供手动入口。
- **阶段二**:标签体注册进 keyed 槽 `sidebar.right.pane.tab`、活动 chip 标题注册进 `sidebar.right.pane.tab.title`,key 均为定义 `id`。标签体在独立 ShadowRoot(`createStyledRoot`)内 portal 渲染 `DoctorCaseContextRail`,主题/语言订阅与快照 locale 优先级逐行沿用上一版;快照为 null 时渲染空态文案而非卸载。
- **自动打开按会话记账,统一延迟尝试**:门控条件为 `activeId === 'clinmesh.his' && snapshot !== null && 当前会话存在`,订阅 surfaces 注册表、快照 port 与 `sessions.list` 三路事件。右栏停靠面按会话隔离(每会话一份布局,切换会话时详情栏在绘制前关闭,原标签不在新会话布局里),因此"已请求"以会话 id 记账而非布尔边沿,会话变化即对新的当前会话重新请求。**关键时序**:座位绑定跟随会话 surface 的 React 挂载效果(`bindService → controller.bind`),而 store 事件先于提交触发——同步 `openTab` 要么落进旧会话布局(成功但不可见,且记账后不再重试),要么因座位未挂载抛 `no session surface is mounted` 且不再有事件。因此触发事件只做记账比对,真正的 `ctx.sidebarRight.openTab(kind)` 一律推迟约 200ms 执行(此时新会话座位已绑定);失败(座位未挂载)以短定时器自愈重试直到成功或门控失效,不依赖下一次事件,每个失败段只记录一次错误。页面型标签幂等去重(已开即聚焦,同一步展开右列);离开医生页重置记账,回到医生页即使同会话也重开。hero 态(新会话未发首条消息)无会话 id 可绑定,等会话激活事件补开;若宿主在 hero 期已给出会话 id,重试循环会在座位挂载后自动补开——两种宿主语义下均收敛。
- **不自动关闭,但提供手动恢复**:下降沿(切完诊、切角色、切 surface、切病例 pending)不关标签——标签页语义下关闭是用户操作,无快照时标签体显示空态。这消除了上一版"让位宿主 dock"的槽位竞争,也不再调用 `ctx.layout.openRightbar/closeRightbar`(右列开合归 `ui-sidebar-right` 所有)。为避免"关掉后无法恢复",三方合同增加反向通道:`WebSurfaceCaseContext.requestOpen?()`(宿主经 `port.setOpenRequester` 挂入打开实现,dispose 摘除),医生页患者横幅在 surface 模式且通道存在时渲染"显示患者信息"按钮——手动请求**强制**尝试(绕过会话记账:已关重开、已开即聚焦并展开右列),座位未挂载(hero 会话)时并入同一条重试链,会话生成后自动补开;attempt 入口统一 `clearRetry`,防止手动强制与自动重试并发孤儿化定时器形成双重链。
- **手动显示与隐藏**：`WebSurfaceCaseContext.visibility` 提供可见状态订阅及切换入口。标签体通过宿主注入的 `useTabInfo().tab.visible` 注册可见实例，隐藏、切换标签及卸载均释放对应实例；按钮通过 React 18/19 共有的 `useSyncExternalStore` 跟随真实状态，切换“显示患者信息／隐藏患者信息”及 `aria-expanded`。隐藏时通过可见患者标签自身的 `tab.actions.close()` 关闭实例，保留其他文件和宿主右栏布局；最后一个患者标签关闭后，宿主可显示引导页。浮动患者标签也可能是活动标签，`active()` 不能证明其停靠状态或其他窗格为空，因此按钮不收起整个右栏。主动隐藏取消挂起的打开重试并按会话抑制自动打开，病例快照注销再注册不会撤销用户选择；主动显示恢复打开尝试，新会话仍按既有规则自动打开。仅实现 `requestOpen` 的宿主保留单向展示入口。
- **状态所有权**：病例查询与草稿状态仍由 WebApp 拥有；宿主消费病例快照并拥有右栏可见状态。standalone 使用原有内嵌 rail，不接入宿主开关。
- **依赖形态**:`@deepseek-ai/dsh-client-ui-sidebar-right` 仅作 devDependency 提供 `declare module` 类型增强;运行时服务经 `ctx.get` 访问,`import type` 构建擦除,产物 `require` 集与 `verify-artifact` 白名单不变。宿主加载顺序由 `dsh.client.inject` 与运行时 `inject` 导出声明(`sidebarRightTabs`、`sidebarRight`)。

## Alternatives considered

**保留右列影子化并在面板内自绘标签条切换"患者信息/文件"。** 文件栏是宿主 dock 的私有 UI,`rightbar` 是 `single` 槽(最低 priority 独占渲染),第三方无法在占用右列的同时渲染宿主 dock,自绘等于复刻文件栏,侵入且必然漂移。

**打开后按下降沿自动关闭标签。** 关闭需要 tabId,而 `ISidebarRight` 只暴露 `active()` 无枚举;在上升沿捕获 `active()` 并记录有误关用户文件标签的风险(打开未必改变焦点时)。空态标签已消除"滞留陈旧数据"问题,自动关闭收益不抵风险。

**快照 null 即关闭标签、重新发布再开。** 切病例 pending 与切完诊都会瞬时清空快照,关开会抖动、丢失标签位置;空态是更诚实的表达。

**注册 `sidebar.right.pane.tab.title` 活动标题座以外的方案(仅靠定义 `title`)。** chip 文案在打开时被捕获进布局记录,语言切换后旧标签保持旧语言;活动标题座读取宿主 locale 订阅,切换即更新,成本约十行。

## Consequences

用户在门诊医生页打开病例 → 右栏自动出现"患者信息"标签并与文件标签并列,可自由切换、可手动关闭(✕);关闭后离开医生页再回来,或切换/新建 DSH 会话(会话激活后)都会重新打开。非激活期的标签显示空态而非消失;DSH 会话自身的右侧栏折叠/展开、浮起、分屏等能力原生可用。已接受限制:hero 态(新会话未发首条消息)右栏座位不可达,患者上下文要等会话激活后自动打开;guide 入口依赖宿主右栏引导页的既有样式;标签 chip 初始文案在打开瞬间捕获,极端情况下与活动标题有一帧差。`rightbar` 槽恢复为宿主 dock 独占,ClinMesh 不再注册该槽;上一版 Note 的"影子化占用"机制由本 Note 完整取代。
