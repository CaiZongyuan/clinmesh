# DSH 插件能力与 ClinMesh 界面融合路线

## 范围与判断

核验日期：2026-10-02。本文研究官方 DSH 插件、主题、页面组合与 Agent 接口，作为后续产品设计输入；不声明已完成升级、原型或生产验证。ClinMesh 当前行为以[前端架构](../frontend-architecture.md)、[系统架构](../architecture.md)和[上游锁定清单](../../dsh-upstreams.lock.json)为准。

**研究判断：现有 React Surface 适合快速复用一个独立 React 应用；面对“医生熟悉的 HIS 工作面、Agent 对话和工作舞台”这一目标，它未必是最合适的最终边界。优先验证官方业务主面板内嵌原生 Conversation 的路线，短期用主题映射改善当前 Surface；独立 ClinMesh 前端加 DSH 后端保留为备选。** 这是对下面来源事实的设计推论。

方案遵循现有约束：通过 ClinMesh 与桥接插件扩展 DSH，不修改或 fork DSH 官方源码。

## 版本与来源边界

| 对象 | 核验结果 | 能证明什么 |
| --- | --- | --- |
| ClinMesh 当前 DSH | `0.1.5-rc.2`，官方 tag commit `fb2c4b9e698e30edb738bca4cf0618587db7d203` | 本仓库锁定组合，不能按最新版文档直接开发；见[锁定清单](../../dsh-upstreams.lock.json)与[旧版源码][dsh-old] |
| 官方最新公开非 alpha | `0.2.0-rc.2`，2026-09-29 发布，commit `639ed015397290b3745d163aafe02ffee4aa3f84` | 本文“最新版”均指该已发布 RC；见[Release][dsh-release] |
| 官方正式版 | 核验时 GitHub Releases 中没有 `prerelease=false` 项，npm 版本表没有不带预发布后缀的版本；`latest`、`next` 均指 `0.2.0-rc.2` | `latest` 标签不等于稳定正式版；见[Releases API][dsh-releases-api]与[npm 元数据][dsh-npm] |
| 官方 `master` | 核验时与 `0.2.0-rc.2` 同一 commit | 本文没有把尚未发布的主分支功能算入可用能力；见[固定源码][dsh-current] |
| React Surface | 社区项目 `CaiZongyuan/dsh-react-surface`，本仓库锁定 `a7ab85c55ff7dc5d33a915dff857e0238d868a71` | ShadowRoot、Surface 布局、品牌映射和页面生命周期由该桥接层提供，不能称为 DSH 官方接口；见[社区源码][surface] |
| AG-UI 桥接 | owner 为社区项目 `CaiZongyuan/dsh-ag-ui`；ClinMesh 锁定 `keaideppk` fork 的 `521740953be41cc37bd770ecf41b36bd7b0824d9` | 当前主要使用原生 browser Tool broker；不是已经启用独立 Gateway 会话；见[锁定清单](../../dsh-upstreams.lock.json) |
| AG-UI owner 当前主分支 | `c3a8ea1b2c5e36193c75cd2478d034cf33f7fcb8`，README 仍声明精确适配 DSH `0.1.5-rc.2` | 新桥接能力不代表已经适配 DSH `0.2.0-rc.2`；见[社区 README][agui-current] |

## 官方插件实际提供的组合能力

### Profile 可以重组应用，普通插件不必嵌一个完整应用

官方插件是通过 `apply(ctx)` 注册服务、工具、事件或 UI 的模块。Bundle 提供 `dsh.bundle.patch`，Profile 决定组合哪些 bundle；配置层可以按 row id 覆盖或禁用已有插件。顺序为 bundle 列表、Profile patch、用户 home patch、命令行 patch，后层优先；覆盖 `config` 时替换整个对象，不做深合并。[插件教程][plugin-first]、[打包与 Profile][plugin-publish]

因此，“复用 DSH 的 Agent、Session 和对话”与“保留 DSH 默认全部窗口区域”不是绑定条件。官方 Web bundle 把传输、Session Controller、主题、布局、会话和具体功能列成独立插件；已有 `web`、`headless`、`sdk` 等不同组合。但移除 UI 包前必须检查它是否同时提供别的包依赖的服务，不能假定一个包只画一个面板。[Web bundle][web-bundle]、[Profile 启动][profiles]

### Slots 是正式的页面组合机制

官方 Slots 有 `single`、`list`、`keyed`、`chain` 四种基数；`single` 和已占用的 `keyed` cell 可以被更高优先级的注册替代，数值更小的 `priority` 优先。这给出了替换呈现的机制，而不是保证任意替换都能保留原行为。[Slots][slots]

| 需要 | 官方接口 | 边界 |
| --- | --- | --- |
| 增加“诊疗工作台”入口 | `sidebar.panellist` 注册独立 `id` | 官方侧栏自动处理文字、图标、折叠态和选中状态；不需要查找宿主 DOM 插入节点 |
| 创建诊疗主页面 | 在 `main` keyed slot 注册同一 key，通过 `ctx.layout.selectPanel(id)` 选择 | 页面默认 root scope，不自动绑定当前 Session；`conversation` 为原生会话保留 key |
| 修改品牌 | `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark` | 替换品牌不改变工作区、会话或患者的组织语义 |
| 增加任务动作或结果 | 会话 header/input 的子 slot、`conversation.chat.node` 或 Tool view | 在既定位置内扩展；完整页面不应放在悬浮装饰层 |
| 替换整个侧栏 | `sidebar` single slot | 其子 slot 与交互由原 owner 声明；替代者必须承担新的导航合同 |
| 重写整个根布局 | 机制上 `root` 也是 single slot | 官方外部 UI 插件指南明确建议不要替换 app root；不作为本研究首选 |

表中能力由[侧栏参考][sidebar]、[布局参考][layout]、[Slots][slots]和[UI 插件指南][ui-plugin]直接定义。`main` 面板与主题接口在当前 `0.1.5-rc.2` 已存在，当前缺乏一致性不能全部归因于版本落后。[旧版布局][layout-old]、[旧版主题源码][theme-old]

Slot 的每个子声明只能有一个 owner，注册、卸载和子树收拢沿 Cordis 生命周期联动。普通插件只能通过 owner 授权的 `renderSlot` 渲染子 slot，不能从别的功能包直接 import 内部页面组件再任意重排。替换父 slot 要保全相关子树与生命周期；简单“优先级覆盖 root，再把原组件放回来”不是已验证的组合方式。[Slots][slots]

### 已发布新版可以嵌入原生 Conversation

最新版 `ui-conversation` 注册了 `conversation.content` Component Factory，复用会话正文与 Composer；调用者选择 `variant: 'embedded'`，可以用局部 `views` 固定 Chat，并省略主 Conversation Header 与宽度拖动控件。它通过 `renderFactorySlot()` 使用，不需要导入内部 Conversation React 组件。[Conversation][conversation]、[Factory 合同][factory-note]

这不是只有文档描述的抽象能力：官方 `ui-subagent` 已用 `sessions.retain()` 获取子 Session reference，再用 `<SessionProvider session={reference}>` 包裹自有 slot，在里面渲染该 Factory，提供侧栏内的原生子 Agent 对话。[官方嵌入实现][embedded-chat]

Factory 本身不接收 `sessionId`，Session 由所在位置的 Provider 决定。新 Provider 可显式绑定 `SessionReference`，并随 reference generation 管理生命周期；reference 保持客户端上下文与历史流存活，不等于保持 Host Agent 运行。[Session UI][session-ui]、[Session Controller][session-controller]

这组能力不在当前 `0.1.5-rc.2` 中：Factory 实现 commit 为 `c094b663fb`，首个包含它的非 alpha tag 为 `0.1.7-rc.1`，最新版 RC 已包含。采用它需要升级与适配，不能在现锁版本中只改调用方式。[Factory 引入][factory-commit]、[当前版源码][dsh-current]

**硬限制：同一个 Session 当前不支持同时挂载两个可编辑 Composer root。** 切到诊疗面板时必须确保默认主会话 Composer 不同时编辑同一 Session。另一个限制是右侧原生详情区由默认 Conversation 的选中状态驱动；自有主面板要明确决定如何承载文件、成果或其他详情，而不能假定它们自动跟随。[Conversation 输入合同][conversation]、[布局参考][layout]

## UI 可以统一到什么程度

### 颜色与视觉规范有现成接口

DSH 的 `ui-theme` 拥有 `--dsw-*` 色板、语义别名、字体、动效、阴影与滚动条，`ui-layout` 把主题快照应用到 document。功能组件消费 `--dsw-alias-*`；`ctx.theme.overrideTokens(source, overrides)` 支持同时提供 light/dark 值，卸载时释放这一层覆盖。这个机制在当前 `0.1.5-rc.2` 已有。[主题参考][theme]、[旧版主题源码][theme-old]

ClinMesh 当前定义为 `branding.shell: 'preserve'`，没有配置 Surface semantic tokens；主区导入自己的 UI 样式，额外宿主区域也通过 `createStyledRoot()` 创建 ShadowRoot 并注入 ClinMesh CSS。它实现了共享明暗状态，但没有建立完整的共同颜色、控件与间距语言。[Surface 定义](../../apps/dsh-web/src/client/index.tsx)、[样式入口](../../apps/dsh-web/src/client/styles-entry.ts)、[额外样式根](../../apps/dsh-web/src/client/styled-root.ts)

社区 Surface 已提供 `shell: 'surface'` 和 `accent/background/surface/foreground/border/fontFamily/radius` 等语义 token；其中配色与字体可在激活时映射到它验证过的 DSH tokens，`radius` 仍是 Surface 自身变量。因此 ShadowRoot 并不意味着完全无法统一；可以让 ClinMesh 消费宿主语义值，或通过现有桥接协调双方。但该接口不会自动改变按钮结构、列表密度、患者信息布局或对话语义。[Surface 品牌接口][surface]、[映射实现][surface-branding]

**推论：短期应先选一个视觉权威并映射 token，再整理布局；全面替换按钮库不是解决空间争夺的前提。** 继续使用 ClinMesh 的业务控件也可以形成一致的视觉，但需要统一尺寸、字体、边框、弹层与交互规则，不能只同步 light/dark。

### 原生控件可复用，但不是稳定的第三方 UI SDK

官方 `ui-primitives` 有 Button、Input、Menu、Modal、Tooltip、Tabs、状态标记及 Markdown/工具输出组件；它无 Cordis runtime 依赖，读取宿主 tokens。官方内部样式规范推荐 CSS Modules 和共享 primitives，不再引入另一套组件库或 Tailwind。[Primitives][primitives]、[样式规范][styling]

同时，官方随 Agent 分发的外部插件实践明确警告：plain-JS 插件不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 或其他 Client runtime 包，因为这些接口可能无通知变化、缺少类型检查的调用会使 slot 崩溃；它推荐 tokens 作为更低风险的公共依赖。内部复用规范与外部插件稳定性建议适用范围不同，不能只引用前者就承诺长期兼容。[插件实践][practices]

**推论：** 需要原生控件时，通过很薄的、带类型检查和固定兼容验证的 ClinMesh adapter 使用；业务 UI 保持自己的边界。对公共语义 token 的依赖风险更低，但也需验证升级后的视觉。Shared `packages/ui` 不应因此直接依赖宿主功能包；这还必须遵守[前端架构](../frontend-architecture.md)。

### 官方已提供一部分界面减法

最新版 Web 与 Desktop 的“显示代码工作视图”开关可控制编程相关呈现；它控制展示及 HTML preview 权限，不改变 Host 授权或 Session 记录。可以作为医生模式的一个输入，但不能把隐藏菜单当作撤销工具能力。[设置参考][settings]

官方插件实践要求页面渲染在 React slot 中、使用宿主 tokens 与 locale，并明确指出选错渲染位置后，局部样式无法补救整体一致性；指南也避免 iframe、在组件外写 DOM 和另向 `document.body` 追加完整应用。这支持减少宿主 DOM 探测与位置补丁的方向，但不意味着当前 ShadowRoot 必须全部移除。[插件实践][practices]、[UI 插件指南][ui-plugin]

## 三条路线比较

下表是基于已核验接口的产品建议，尚未运行 ClinMesh 完整原型。

| 路线 | 结构与收益 | 必须承担的代价 | 适用判断 |
| --- | --- | --- | --- |
| A：继续 Surface，统一主题与信息层级 | 保留现有独立 Web 复用、页面 Tools 与生命周期；补 token 映射、收起重复信息、减少常驻栏位 | 仍受 Surface 与原生会话、详情栏几层布局的组合约束；桥接升级持续有成本 | 当前界面止痛与回退方案 |
| B：官方诊疗主面板，内嵌原生 Conversation | ClinMesh 在自己的 `main` 面板安排“患者工作面 + Agent 对话”；用官方 Factory 复用 Chat、Composer、原生工具/审批呈现 | 需要新版 DSH、Session 生命周期适配、Surface Tool binding 迁移，以及原生详情能力的重新承载 | **优先验证的候选终态** |
| C：ClinMesh 拥有整套前端，DSH 作为 Agent 后端 | 最大限度掌握医生导航、对话、教学与多方仿真界面；通过 AG-UI 或官方服务/协议连接 | 对话投影、恢复、审批、文件、子 Agent 状态和持续升级由集成侧承担更多责任 | B 无法满足关键产品合同后再投入 |

### 优先候选 B 的具体边界

```text
DSH Profile：Agent / Session / 工具 / 存储 / 原生对话能力
  └─ 官方 AppFrame 与主题
      ├─ sidebar.panellist：诊疗工作台入口
      └─ main['clinmesh']：ClinMesh 自有页面
          ├─ 当前患者、病历、检查、诊断、处方与成果
          └─ SessionProvider → conversation.content（嵌入式对话）
```

“舞台”由 ClinMesh 主面板组织：Agent 整理病史时，工作对象是病史时间线与待审草稿；辅助诊断时，是证据、候选诊断与缺失信息；教学时，是病例、学习者操作和复盘。对话用于委派、解释与追问；原生对话中的工具记录继续可见，但不必承担全部临床成果展示。这是产品设计建议，不声称 DSH 已实现医疗视图。

技术上先保留 `ui-conversation`、`ui-session`、Session Controller、主题和 Slot infrastructure，让主面板选择切到 `clinmesh`，而不是禁用提供 Factory 的包。`sidebar.panellist` 提供正规入口；若患者导航需要替换工作区列表，再评估 `sidebar.workspaces` 的呈现扩展，不能直接关闭仍提供标准 hooks 的整个 `ui-workspace`。[Slots][slots]、[Conversation 注册][conversation-apply]、[Web 架构][web-client]

这个方案让舞台的尺寸、患者上下文与成果位置归 ClinMesh，同时保留 DSH 原生对话。教学、多 Agent 扮演和 RSI 仍要由 ClinMesh 建立角色可知信息、病例范围、运行记录与评价机制；嵌入多个不同 Session 的能力不能自动建立这些业务边界。

### 备选 C 的真实接口与缺口

官方 Web 的 Session Controller 提供创建/恢复、prompt、队列、取消、历史分页、follow 与 control streams，并有 React-free Client model 处理流与请求竞态。它位于官方 API Gateway/Remote 体系，可以作为深入集成的基础；这不是一个已经为外部医院前端稳定封装的通用 REST 产品。[Session Controller][session-controller]、[Web 架构][web-client]

官方 TypeScript SDK 可启动 `sdk` profile，经 stdio JSON-RPC 驱动 Agent；低层 prompt 返回入队 receipt，高层 `run()` 收集到整个 Agent 再次 idle。它没有每 Session close 或 prompt cancel，客户端到服务端通知、反向请求也未实现，因此不能把它直接当成完整交互式医生助手后端。[SDK client][sdk-client]、[SDK server][sdk-server]

社区 AG-UI 提供 HTTP/SSE、BFF 代理、共享状态与前端 Tools。owner 当前 README 已描述原生审批/问答的 `resume[]`、成果 activity、签名文件和多模态输入；这些不能当成本仓库旧锁版本已具备。该版本仍有 partial SSE reconnect 缺失、意外 HTTP 断开取消 turn、`STATE_DELTA`/reasoning 未适配、人机交互仅支持根 Agent、进程重启不恢复等待中的 browser Tools/人类请求 Promise 等限制。[AG-UI 当前合同][agui-current]

**推论：** C 的自由度真实存在，但比较成本时必须计入原生对话已处理的恢复与交互语义。B 若满足核心医生流程，会比一次性重建完整对话栈更容易保留行为。

## 升级与原型必须验证的事情

`0.2.0-rc.2` 的 Session writer 常量为 `SESSION_FORMAT_VERSION = 4`，当前桥接 README 描述 `0.1.5-rc.2` 为 v3；因此升级涉及持久化读取与事件形态，不只是 UI 导出变化。Session 格式状态汇总可能滞后，取证应以固定 tag 的源码与实际迁移路径为准。[当前 Session 常量][session-v4]、[AG-UI 兼容声明][agui-current]

最新版 Profile 在加载前检查 DSH peer dependency 范围。现有 React Surface 的多个 DSH peer 精确锁定 `0.1.5-rc.2`，AG-UI 当前主分支也声明该版本；不能只把 ClinMesh 锁文件改成新版就声称组合兼容。[Profile 兼容检查][profiles]、[Surface manifest][surface-manifest]、[AG-UI 当前合同][agui-current]

| 原型验证项 | 成功标准 |
| --- | --- |
| 官方主面板 + Factory 可组合性 | 独立 ClinMesh 插件创建主面板，通过 SessionProvider 显示真实 Chat 与 Composer；不改 DSH 源码、不访问其他插件 DOM |
| 单一编辑入口 | 默认会话与诊疗面板切换时，同一 Session 只存在一个可编辑 Composer；草稿、发送、停止和队列行为一致 |
| 主题一致性 | 明暗、字体、按钮密度、菜单和对话框在同一视觉规则下；不能仅检查主题状态值相同 |
| 病例与 Tool 生命周期 | 切换患者/Encounter、角色、Session、浏览器 tab、卸载/重挂载时，context binding、proof/lease 与工具清单保持正确；新面板不能绕过现有授权与审计 |
| 原生交互完整性 | Tool 调用、人工审批/问答、文件/成果查看、错误恢复均能从新入口到达；不用静态假对话代替 |
| 旧会话升级与恢复 | 在隔离数据副本上验证 v3→v4 恢复、持续运行与中断语义；明确旧版回退的数据边界 |
| 空间与任务完整性 | 窄窗口下病例主操作与对话仍可使用，患者详情就近展开；用“看病例→委派→审阅并修改成果”验证舞台，而非只展示首页 |

证据范围为官方与社区固定源码、文档和发布元数据；上述原型与兼容验收尚未执行。迁移范围应由一个诊疗面板的端到端原型确定，重点证明 B 能保留现有业务与原生对话行为。

## 直接来源

以下官方链接固定到已发布版本；社区接口仅由各自 owner 定义。

[dsh-old]: https://github.com/deepseek-ai/deepseek-harness/tree/fb2c4b9e698e30edb738bca4cf0618587db7d203
[dsh-current]: https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84
[dsh-release]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2
[dsh-releases-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases
[dsh-npm]: https://registry.npmjs.org/@deepseek-ai%2fdsh
[plugin-first]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/user/develop/basic/index.md
[plugin-publish]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/user/develop/basic/publish.md
[profiles]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/README.md
[web-bundle]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/bundle/web-app/cordis.patch.yml
[slots]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/slots.md
[sidebar]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-sidebar/README.md
[layout]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/README.md
[layout-old]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/client/ui-layout/README.md
[theme]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-theme/README.md
[theme-old]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/client/ui-theme/src/client/index.ts
[styling]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/web-styling.md
[primitives]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/README.md
[ui-plugin]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md
[practices]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md
[conversation]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-conversation/README.md
[conversation-apply]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-conversation/src/client/apply.ts
[factory-note]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md
[factory-commit]: https://github.com/deepseek-ai/deepseek-harness/commit/c094b663fb
[embedded-chat]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx
[session-ui]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-session/README.md
[session-controller]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/session-controller/README.md
[web-client]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/web-client.md
[settings]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-settings/README.md
[sdk-client]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/client/README.md
[sdk-server]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/server/README.md
[session-v4]: https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/types.ts#L89
[surface]: https://github.com/CaiZongyuan/dsh-react-surface/blob/a7ab85c55ff7dc5d33a915dff857e0238d868a71/README.md
[surface-manifest]: https://github.com/CaiZongyuan/dsh-react-surface/blob/a7ab85c55ff7dc5d33a915dff857e0238d868a71/packages/runtime/package.json
[surface-branding]: https://github.com/CaiZongyuan/dsh-react-surface/blob/a7ab85c55ff7dc5d33a915dff857e0238d868a71/packages/runtime/src/client/shell-branding.ts
[agui-current]: https://github.com/CaiZongyuan/dsh-ag-ui/blob/c3a8ea1b2c5e36193c75cd2478d034cf33f7fcb8/README.md
