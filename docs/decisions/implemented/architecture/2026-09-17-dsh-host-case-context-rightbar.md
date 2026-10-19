# Agent Note: 门诊医生病例上下文栏挂载 DSH 原生右列

Status: implemented

> 2026-09-17 反转:右列影子化占用由[病例上下文改为会话右栏原生标签页](2026-09-17-dsh-host-case-context-tab.md)完整取代,`rightbar` 槽恢复宿主 dock 独占;本文仅保留三方合同与勘察记录的参考价值。

## Problem

Surface 模式下,门诊医生页面的病例上下文栏渲染在 ClinMesh 内容区右侧,而 DSH 会话区被 workspace 布局钉在屏幕最右,两套右栏相邻堆叠,视觉重复且挤占内容宽度。任务合同见 [issue #115](https://github.com/CaiZongyuan/clinmesh/issues/115)。

## Decision

沿用 [DSH 宿主承接医院工作台导航](2026-09-14-dsh-host-workspace-navigation.md)建立的三方合同模式,把快照通道从导航换成病例上下文:

- **查询与状态所有权留在 WebApp**(`apps/web`)。`CaseDetail` 在 surface 模式下用 `useMemo` 组装与内嵌 rail 完全一致的快照(caseId、detail、completion、section、statusText、locale),经 `runtime.surfaceCaseContext.register` 发布;`CaseDetail` 卸载(切完诊 tab、切角色、登出)即自动 disposer,宿主收列。发布点选在 `CaseDetail` 而非 controller:本地 `activeSection` 是与主内容 tab 一致的真源,controller 镜像在切病例时会单独重置,产生短暂不一致。
- **宿主面板活在 DSH 树**(`apps/dsh-web`)。`ctx.slots.inject('rightbar', …)` 注册占用者,`useSyncExternalStore` 订阅快照,在独立 ShadowRoot(复用 `createStyledRoot`)内 portal 渲染 `DoctorCaseContextRail`;主题与语言订阅逐行复刻 [DSH 统一管理 Surface 主题](2026-09-15-dsh-host-theme-ownership.md)与 [DSH 宿主承接语言](2026-09-16-dsh-host-locale-ownership.md)的写法。开合走 `ctx.layout.openRightbar/closeRightbar`,以 `active && state` 门控(keep-alive 切走即收列,回来重开)。
- **以 `priority: -1` 动态影子化宿主 dock 占用者**。rightbar 是 `kind: 'single'` 槽,宿主 shell 自带一个匿名 priority 0 占用者(即会话右侧栏 `ui-sidebar-right` 的停靠面,见 layout 包 README);运行时按"最低 priority 渲染"投影(`entriesOfSlot` 每个 cell 只暴露头部条目)。初版按"槽内无占用者"的错误勘察以 priority 0 常驻注册,真实宿主加载即抛 `single slot "rightbar" already has a registration` 并使整个插件 apply 失败(loader 对 effect 内异常零容忍)。第二版改为 -1 常驻,又把宿主会话右侧栏永久遮蔽(DSH 会话内打开自己的右侧栏时仍显示患者信息)。最终形态:**注册由活动门控驱动**——`registerCaseContextPanel` 订阅 surfaces 注册表与快照 store,仅当 `activeId === 'clinmesh.his'` 且存在病例快照时注入条目,其余时刻撤销注册把右列还给宿主 dock;开合随条目挂载生命周期(`mount → openRightbar(true,false)`,`unmount → closeRightbar`),不再依赖组件内 active 判断。
- **vendor 零改动**。dsh-react-surface 布局引擎本就把 `[data-rightbar-col]` 宽度从 workspace bounds 扣除,三列顺序 [ClinMesh 内容][会话][患者信息] 天然成立;中心列保底 400px、右列最小 300px 由 vendor 保证。
- **standalone 逐字不变**。`surfaceCaseContext` 缺省时 runtime 不含该键,`useSurfaceCaseContextPort` 不发布,`DoctorCaseLayout` 走原有 inline rail + Sheet 折叠路径。`useOptionalWebRuntime`(可空变体)供直接挂载的视图与测试读取 runtime 而不强制 Provider。
- `messages` 不进快照:宿主面板按快照 `locale` 自取 `getWorkspaceMessages`(按 locale 缓存、身份稳定),快照保持 JSON 可序列化视图数据。

## Alternatives considered

**把 rail 移到 DSH 会话区左侧的 ClinMesh 内容内并压缩会话区。** 只能缓解宽度,两栏仍相邻堆叠,未消除重复感;且会话区宽度归 vendor 管理,不可压缩。

**iframe 承载右栏。** 多一份 React 运行时与样式表,快照需跨窗序列化,主题/语言/字号同步成本高;现有 surface 体系本就同树同 React。

**发布 `onSectionChange` 让宿主 rail 可切换 section。** section 真源在 `CaseDetail` 本地 state,rail 纯展示从不发起切换;上提 state 会改变 standalone 的"切病例后 tab 保留"语义,收益不抵风险。

**`canShow` 回灌 WebApp 控制发布。** 会形成 WebApp 感知宿主布局状态的反向依赖。接受限制:侧栏展开且视口 <964 时右列暂不可达,数据仍在发布,变宽后自动可见;日后再补宿主侧 reopen 徽标。

**宿主右列复刻 44px 折叠形态。** DSH rightbar 没有折叠语义,`onExpandedChange` 缺省即不渲染折叠按钮;44px 折叠是 standalone 专属交互。

## Consequences

`conversationCollapsed` 收起会话时右列随 vendor 现有语义一起 inert + 隐藏,快照保持发布,恢复后自动可见;视口不足时轨道解为 0 亦同理。切病例 pending 期间快照清空、右列收合,数据到达再开(与内嵌 rail 的 Skeleton 行为对齐)。活动门控的已接受限制:在门诊医生页停留期间,若用户点击 DSH 会话自身的右侧栏按钮,右列仍显示患者信息(头部被本面板占据);离开门诊页或切走 surface 即恢复宿主 dock。rail 头部的"右侧边栏"眉题标签已删除(宿主右列下冗余,standalone 同步简化,折叠语义不受影响)。未来若加入浮层类组件于宿主右列,须纳入 catalog-dialogs 双版本合同测试。另注:用户日常宿主(`~/.dsh`)与仓库沙箱(`pnpm dev:dsh` 的 `.data/dsh-runtime`)是两套安装,验证行为时以实际加载 @clinmesh/dsh-web 的那份为准。
