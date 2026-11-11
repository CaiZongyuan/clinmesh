# DSH 镜像 workspace 预设可行性研究

## 范围与结论

核验日期：2026-10-20。本文核验自有桥接仓库 `dsh-react-surface`（commit `ab6092e`）的 workspace 布局引擎与 ClinMesh 侧集成面（`apps/dsh-web`、`dsh-upstreams.lock.json`、升级验收流程），回答早期三栏探索中“布局引擎几何模型是否支持会话列换位”的判定问题。核验方式为只读源码与构建产物检查；DSH 宿主包以 `apps/dsh-web/node_modules` 内 `0.2.1-rc.2` 压缩 bundle 的 grep 证据为辅，未运行浏览器验证。当前 Surface 默认布局（`default: 'workspace'`，同时在 `supported` 保留 `'workspace-mirror'`）与回退理由分别见 [Surface 与 Host 边界](../architecture/agent-integration.md#71-surface-与-host-边界) 和 [DSH 镜像布局回退决策](../decisions/implemented/feature/2026-10-22-dsh-mirror-layout-rollback.md)。

**研究判断：镜像预设可行。** 布局引擎的会话列位置不是硬编码的 DOM 搬移，而是"几何 bounds + 会话列内联样式"的纯计算输出；`justify-self: "start" | "end"` 已是引擎内部模型的一等字段，现有 `right-panel` 预设已在产出"原生会话在左、Surface 在右"的镜像几何。新增镜像预设是纯增量改动（估计 250 行上下，含测试），不影响既有预设，可经布局选择器随时回退； ClinMesh 侧不引入该布局即完全回退。真正的开放点不在几何模型，而在真实宿主下镜像会话列的内部呈现细节（原生产物是否假定自己在右侧）与队列卡片钉顶缺少宿主注入点。以下是分项证据。

## 布局引擎与预设机制

预设是闭枚举，共五个：`full-frame`、`center`、`workspace`、`right-panel`、`bottom-panel`，定义于 `packages/runtime/src/client/contracts.ts:5-6` 的 `ReactSurfaceLayout` 联合类型与 `contracts.ts:265-271` 的 `VALID_LAYOUTS` 集合。各预设保留的宿主区域与可调尺寸见桥接仓库文档 `docs/layouts-and-branding.md:7-13`（`workspace` 保留 Sidebar、Conversation、Details，可调会话宽度）。

声明与选择的链路（事实，均为文件行号证据）：

- 应用在 `ReactSurfaceDefinition.layout`（`contracts.ts:155`）声明 `default` / `supported` / `fallback` / 尺寸约束（`contracts.ts:17-40`），`validateLayoutDeclaration`（`contracts.ts:273-305`）在注册时校验。
- 用户从启动器菜单的布局下拉选择（`packages/runtime/src/client/surface-launcher.tsx:262-291`），经 `registry.setLayout`（`packages/runtime/src/client/registry.ts:177-190`）写入，`persist: true` 时持久化到版本化 localStorage 键 `dsh-react-surface:preferences:v1`（`packages/runtime/src/client/surface-preferences.ts:28,63-68`）；注册时恢复受 `supported` 约束的偏好布局（`registry.ts:77-86`）。
- 解析入口是纯函数 `resolveReactSurfaceLayout`（`packages/runtime/src/client/layout-engine.ts:67-121`），输入只有几何数字、语义布局、约束与保留尺寸，不接触 DSH DOM（`layout-engine.ts:66` 注释；`docs/architecture.md:51`）。
- Host Adapter 在真实 DSH DOM 上定位侧栏、会话、右栏元素（`packages/runtime/src/client/dsh-host-adapter.ts:290-322`；优先 `[data-pane]`/`[data-rightbar-col]` 语义属性，回退到实测 `0.1.5-rc.1` 帧结构 `contentChildren.at(0/1/…)`，`dsh-host-adapter.ts:300-314`；该策略声明见 `docs/architecture.md:49`），把测量结果喂给布局引擎，再把解析结果应用为 Surface 层的 top/right/bottom/left 内联 inset 与会话列的内联样式（`dsh-host-adapter.ts:368-376,400-424`）。

ClinMesh 当前的布局声明是 `default: 'workspace'`、`fallback: 'shrink'`、`fullFrameKeepDetails: true`、`minSurfaceWidth: 360`、`supported: ['workspace', 'full-frame']`（`apps/dsh-web/src/client/index.tsx:154-162`）。

## 会话列位置：参数化程度与镜像改动点

**事实：DSH 帧是三列 grid，会话列是中间列；runtime 不搬 DOM，只给会话列设 width、justify-self、border 内联样式。** ClinMesh 侧模拟宿主帧即 `grid-template-columns:280px 1fr 300px` 加 `data-pane="sidebar"` / `data-pane="conversation"` / `data-rightbar-col` / `data-shell-overlay` 四个子元素（`apps/dsh-web/src/client/surface-layout.browser.fixture.tsx:72-77`）；真实宿主 `@deepseek-ai/dsh-client-ui-layout` bundle（压缩产物，`apps/dsh-web/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`，无行号，grep 证据）的帧模板为 `gridTemplateColumns: ${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`。会话列几何由 `workspace()` 输出：`bounds.right = detailsWidth + conversationWidth`，`nativePane: { width, justifySelf: "end", borderLeft: true }`（`layout-engine.ts:229-243`），即会话贴中间列右缘、Surface 占其余。

**事实：`justify-self` 的 `"start" | "end"` 是 `ReactSurfaceNativePaneLayout` 的既有字段（`layout-engine.ts:27-36`），且 `right-panel` 预设已经在产出镜像几何**——原生会话 `justifySelf: "start"` 贴左、Surface 在右（`layout-engine.ts:291-304`）。因此“几何模型不支持会话列换位”的担忧不成立：换位所需的全部原语（bounds 两侧 inset、会话列贴边方向、resize 元数据）都已在模型中。

镜像预设（下称 `workspace-mirror`）需要的具体改动点（事实为文件行号，行数为推断）：

| 位置 | 改动 | 量级 |
| --- | --- | --- |
| `contracts.ts:5-6` 与 `:265-271` | 联合类型与 `VALID_LAYOUTS` 增加 `"workspace-mirror"` | 约 2 行 |
| `layout-engine.ts:81-120` | `switch` 增加镜像分支，折叠态处理与现 `workspace` 相同（折叠 bounds 为 `{left: sidebarWidth, right: 0}`，与会话在哪侧无关，`:94-104`） | 约 10 行 |
| `layout-engine.ts:178-256` | 新增镜像 `workspace()` 函数：`bounds.left = sidebarWidth + conversationWidth`、`bounds.right = detailsWidth`、`nativePane: { width, justifySelf: "start", borderRight: true }`，`shrink` 分支（`:195-215`）同式镜像，resize 为 `{ key: "conversation", edge: "left" }` | 约 80 行 |
| `layout-engine.ts:27-36` | `ReactSurfaceNativePaneLayout` 增加 `borderRight?: boolean` | 1 行 |
| `dsh-host-adapter.ts:413-424` | `ShellPatch.apply` 增加 `border-right` 样式应用（镜像现有 `border-left` 块） | 约 6 行 |
| `surface-preferences.ts:32-38` | 偏好清洗 `VALID_LAYOUTS` 增加同名成员 | 1 行 |
| `surface-launcher.tsx:15-21` | `LAYOUT_LABELS: Record<ReactSurfaceLayout, string>` 增加标签（类型完整性强制） | 1 行 |
| `surface-host.tsx` | 无需改动：resize 手柄已支持 `edge: "left"`（`:212-217`），拖拽数学 `startValue - (coordinate - startCoordinate)`（`:233-237`）对左缘手柄方向正确（向右拖＝会话变窄），键盘方向键语义一致（`:250-263`） | 0 行 |
| 上游测试 | `layout-engine.test.ts` 镜像几何用例、launcher/preference 标签与清洗用例、`scripts/e2e-mount.ts` 镜像布局段（现有一段在 `:161-176` 选择布局并断言分隔条） | 约 100 行 |

风险评估（区分事实与推断）：

- **事实：Composer、工具面板、浮层挂载点均不受镜像影响。** Composer 是 DSH 会话列内部的原生渲染（宿主 `dsh-client-ui-conversation` bundle 内 `renderSlotChain("conversation.composer", …)`，压缩产物 grep 证据），runtime 对会话列只施加 width/justify-self/border/inert 五类内联样式（`dsh-host-adapter.ts:400-460`），不改内部结构；Agent 工具绑定走 `uiSession`/lease 链路，与布局几何无关（`docs/architecture/agent-integration.md:38,66`）；浮层经 `portalRoot` 留在 Surface ShadowRoot（`contracts.ts:124`、`surface-host.tsx:319-363`），启动器菜单挂 `document.body`（`surface-launcher.tsx:113-124`），均与会话列在哪侧无关。
- **事实：过渡动画、inert 逻辑、会话收起都是侧向无关的。** 折叠/展开动画针对 layer 的 left/right inset 与会话列透明度（`dsh-host-adapter.ts:50-66`）；收起把会话与右栏一起隐藏、Surface 占满侧栏以外（`layout-engine.ts:94-104`、`dsh-host-adapter.ts:436-441`）。
- **推断：真实宿主下的主要不确定点是 DSH 会话列内部呈现是否假定自己在右侧**（例如右锚定浮层、头部控件的贴边方向）。镜像只改几何，理论上会话内容随容器流动，但这只能经 `bun run test:e2e` 真实宿主验证（现 e2e 覆盖 `workspace` 与 `right-panel`，无镜像段）。这是回落判据之一，见文末建议。
- **观察（待验证）：`right-panel` 现实现的 border 画在会话列左缘**（`layout-engine.ts:303`），而该预设中会话与 Surface 的接缝在会话列右缘；若非刻意（依赖宿主自绘分隔线），说明新增 `borderRight` 时应顺手核对边线语义，避免镜像预设复刻同一边线方向疑点。

## 队列卡片钉顶能力

**事实：宿主会话列没有"顶部注入卡片"的公开 slot。** ClinMesh 插件现用的宿主 slot 为 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`（`apps/dsh-web/src/client/profile-brand.tsx:96-117`）、`settings.general.item`（`font-size-settings.tsx:126`）、`sidebar.footer.action`（`workspace-navigation.tsx:283`）；`dsh-react-surface` 的公开接口（`contracts.ts:202-234`）不提供向会话列注入内容的任何通道。宿主 `dsh-client-ui-conversation` bundle 中存在的会话侧扩展点是 `conversation.input.dock` slot 链——Composer 上方的 dock 区，DSH 自身的 `queue`（order 20）与 `todo`（order 0）dock 即挂在这里（压缩产物 grep 证据，无行号）——位置在底部而非钉顶，且语义是会话输入区扩展，不匹配 A3 的"钉顶助手列"。

结论（推断）：**钉顶形态无现成宿主能力，需新增上游机制或走回落形态。** 可能的路径有三：其一，向 `dsh-react-surface` 提议新的会话列注入接口——超出"布局几何级"的改动承诺，不建议随镜像预设捆绑；其二，复用 `conversation.input.dock` 挂队列 dock——位置不符钉顶，但功能等价（扫读、切换、叫号均可承载），可作为与规格 owner 重新确认的候选；其三，直接采用规格 A3 已定义的回落形态。**回落形态（卡片默认收起、贴内容区左缘）由 ClinMesh 侧实现更合适**：内容区左缘就是 Surface ShadowRoot 的左边界，ClinMesh 完全可控，无上游依赖；且可联动既有会话收起接口 `registry.setConversationCollapsed`（`registry.ts:192-199`，adapter 已接线为 `surfaceDisplay.conversation.toggle`，`apps/dsh-web/src/client/index.tsx:132-135`）在窄屏下让卡片独占左侧空间。

## 单 Composer 约束

**事实：镜像布局下单 Composer 自然保持。** Surface 应用不渲染任何 Composer（`apps/dsh-web/src/client/index.tsx:22-89` 的 Surface 组件树无输入组件），唯一可编辑 Composer 是 DSH 原生会话列的；镜像只移动该列的几何位置。"同一 Session 不支持双 Composer"的硬限制（[DSH 插件路线研究](dsh-plugin-integration-options.md) 第 58 行）属于路线 B 的风险，本预设不触及。队列卡片的交互必须是按钮类动作（切换、叫号），不含输入框，不构成第二个 Composer；实施时只需约束卡片组件不引入文本输入。

## 窄屏回落推演

**事实：最小宽度语义。** `minSurfaceWidth`（ClinMesh 声明 360）是分栏回落阈值：可用宽度减去会话最小宽后不足 `minSurfaceWidth` 时，`fallback: "shrink"` 进入按最小宽比例共享模式，两列并排、互不隐藏（`layout-engine.ts:195-215`；`docs/layouts-and-branding.md:35`）。ClinMesh 未声明 `conversation` 约束，套用引擎默认 `min: 340, max: 440, initial: round(shell 宽 × 0.31)`（`layout-engine.ts:189-193`）。Surface 内容的窄屏适配完全由容器查询承担（ShadowRoot 建立命名 inline-size 容器 `dsh-react-surface-content`，`surface-host.tsx:57-65`；宿主指导见 `docs/layouts-and-branding.md:37-45`），这正是 A7 要求的机制。

推演（假设：宿主侧栏收态 56px、右栏隐藏，即可用宽 = 壳宽 − 56；数字为按上述公式计算的推断值）：

| 壳宽 | 可用宽 | 模式 | 会话宽 | Surface 宽 |
| --- | --- | --- | --- | --- |
| 1280 | 1224 | 正常分栏 | 397 | 827 |
| 700 | 644 | shrink | 313 | 331 |
| 420 | 364 | shrink | 177 | 187 |
| 360 | 304 | shrink | 148 | 156 |

两个推论：其一，**shrink 模式下 Surface 会跌破自身 360px 名义最小值**（比例共享本来就是"双方各让"的语义），360px 壳宽时 Surface 仅约 156px——窄屏无横向滚动实际要求内容容器在 ~160px 下退化为近单列，折叠断点须按容器查询实测定，不能只按 360 设计；其二，**更实用的窄屏出口是既有会话收起**（点击收起后会话与右栏隐藏、Surface 占满侧栏以外），镜像预设不改这一行为，演示与真实使用都应把"收起会话"作为窄屏首选动作。镜像侧还需要注意：若希望保护 Surface 宽度，可在 ClinMesh 布局声明里显式收紧 `conversation.min`（现为默认 340），这是纯配置级调节。

## 产物与升级合同

**事实：新增预设对产物合同无结构性冲击。** 上游产物检查（`vendor/dsh-react-surface/scripts/verify-artifacts.ts:30-70`）只约束单文件 `client.js`、DSH lazy-CJS 包装、禁止 ESM import 与私有 React、require 白名单；镜像预设全部在既有 runtime 源码内，不新增依赖，不触碰这些断言。ClinMesh 侧 `apps/dsh-web/src/verify-artifact.ts` 同样只约束包装前缀（`:10-11`）、无 ESM/`import.meta`（`:12-13`）、无私有 React（`:14`）、5MB 预算（`:15`，依据 [DSH 客户端产物体积预算](../decisions/implemented/testing/2026-10-07-dsh-client-size-budget.md)）、require 白名单含 `dsh-react-surface/client`（`:17-27`）——布局逻辑在被 externalize 的 runtime 内，ClinMesh 产物体积增量接近零。**需要同步的一处是 stale-runtime 标记检查**：`verify-artifact.ts:99-112` 通过在 `vendor/dsh-react-surface/packages/runtime/lib/client.js` 中查找 `surfaceRuntimeMarkers`（现为 `['fullFrameKeepDetails']`）防止过期 vendor 构建静默吞掉声明的能力；镜像预设落地后应把新标记（如 `workspace-mirror`）加入该数组，否则过期 runtime 会让 `supported` 里的镜像布局在注册时被 `supported.includes` 校验拒绝（`registry.ts:177-185`），症状是布局选择器缺项而非报错，不易排查。另按既有经验，ClinMesh 侧本地类型镜像 `apps/dsh-web/src/client/dsh-react-surface.d.ts:29` 的布局联合类型需同步新成员，否则 `supported` 声明在 `apps/dsh-web` typecheck 失败。

**事实：`dsh-upstreams.lock.json` 升级走文档化流程。** 锁内 `dsh-react-surface` 组件记录来源、owner、锁定 commit、checkout 路径与支持 PR，上游预设 PR 合入后按 [DSH 持续升级](../deployment.md#dsh-持续升级) 推进验证与写锁。

## 结论与后续采用边界

**一句话结论：镜像预设在几何模型上可行（`justify-self` 双向与镜像 bounds 均为引擎既有能力，`layout-engine.ts:27-36,291-304`），而宿主会话列不提供顶部注入卡片的公开 slot。** 后续实现验证并保留了 `workspace-mirror` 作为可选受支持预设，同时因宽屏留白失衡把默认布局回退到 `workspace`，详见 [DSH 镜像布局回退决策](../decisions/implemented/feature/2026-10-22-dsh-mirror-layout-rollback.md) 与 [UI 设计系统](../ui/design.md)。

## 直接证据位置

上游桥接仓库（`vendor/dsh-react-surface`，commit `ab6092e`）：布局引擎 `packages/runtime/src/client/layout-engine.ts`；宿主适配 `packages/runtime/src/client/dsh-host-adapter.ts`；Surface 宿主与 resize 手柄 `packages/runtime/src/client/surface-host.tsx`；布局类型与校验 `packages/runtime/src/client/contracts.ts`；布局选择与标签 `packages/runtime/src/client/surface-launcher.tsx`；注册与偏好 `packages/runtime/src/client/registry.ts`、`surface-preferences.ts`；产物检查 `scripts/verify-artifacts.ts`；e2e `scripts/e2e-mount.ts`；布局文档 `docs/layouts-and-branding.md`、`docs/architecture.md`。

ClinMesh 仓库：Surface 定义 `apps/dsh-web/src/client/index.tsx`；本地类型镜像 `apps/dsh-web/src/client/dsh-react-surface.d.ts`；布局 browser fixture `apps/dsh-web/src/client/surface-layout.browser.fixture.tsx`；产物验收 `apps/dsh-web/src/verify-artifact.ts`；上游锁 `dsh-upstreams.lock.json`；升级流程 `docs/deployment.md`（DSH 持续升级节）；宿主包 grid 模板与 slot 证据为 `apps/dsh-web/node_modules/@deepseek-ai/dsh-client-ui-layout`、`dsh-client-ui-conversation` 压缩 bundle 的 grep 结果（无行号）。
