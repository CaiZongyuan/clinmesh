# UI/UX 现状审计：从零重构的事实基础

研究日期：2026-10-29。范围：standalone Web（`apps/web`）、DSH Surface（`apps/dsh-web`）、共享包 `packages/ui` 与 `packages/views`、Desktop 与 Mobile 壳，以及仓库内既有设计材料。证据以当前工作区代码为一手来源，引用格式为 `path:line`；统计来自本文末尾列出的只读命令。本文不定义当前行为，也不构成实施授权；当前 UI 合同以 [UI 设计合同](../ui/design.md) 和[跨端前端架构](../frontend-architecture.md)为准，需求与验收以[规格索引](../spec/README.md)为准。

用户已决定 UI/UX 重构从零开始，不以 `design/` 七步法产物和 `design-preview/` 候选作为基线。本文因此把材料分为三类：工程硬约束（重来也必须遵守）、现行视觉与交互惯例（重来可以推翻）、既有设计材料（只作参考输入）。外部风格与 HIS 模式证据由[HIS UI/UX 一手参考](his-ui-ux-references.md)、[现代专业 UI 参考](modern-ui-design-references.md)和[UI 设计风格选型研究](2026-10-22-ui-design-styles.md)拥有，本文不重复。

标注约定：**事实**可由所引文件或命令复现；**推断**是基于事实的判断，未经运行验证；**建议**不代表用户决定。

## 核心结论

1. 事实：几乎全部业务 UI 位于 `apps/web/src/app`（192 个文件，非测试源码约 3.5 万行）；`packages/views` 只有一个 34 行的工程骨架 `AppShell`（`packages/views/src/app-shell.tsx:13`），仅被 Desktop 使用（`apps/desktop/src/renderer/src/main.tsx:2`）。DSH Surface 直接挂载 `apps/web` 的 `WebApp`（`apps/dsh-web/src/client/index.tsx:2`）。推断：重写 `apps/web` 的界面会同时改变 standalone 与 DSH 两个面；跨端共享视图层实际上不存在，从零重构可以自由决定是否启用它。
2. 事实：token 纪律整体较好。业务代码中 Tailwind 色阶共 45 处，其中 18 处在未提交原型、10 处在阅片器黑底画布，其余 4 处为登录页与侧栏 Logo 的 `bg-white` 和住院阶段对勾的 `text-green-700`（`apps/web/src/app/inpatient-patient-workspace.tsx:143`）。推断：换视觉语言主要是改 token 值与 primitive 变体，业务文件里需要逐个修的硬编码颜色很少。
3. 事实：浅色主题下语义色作为前景文字时对比度不足：`warning` 2.89:1、`success` 3.25:1、`info` 3.79:1、`destructive` 4.34:1（对 `#fdfdfe` 背景，WCAG 相对亮度公式计算，token 见 `packages/ui/src/styles.css:173-177`）；Badge 的 `success`/`info`/`destructive` 变体正是“同色浅底 + 同色文字”（`packages/ui/src/components/badge.tsx:14-22`）。这是现行 token 值的问题，属于可推翻的惯例。
4. 事实：文案有三套并行机制：类型化字典 `workspace-i18n.ts`（1,984 行）、局部 `t(cn, en)` 辅助函数（12 个文件约 575 处）、内联 `zh ? … : …` 或 `locale === 'zh-CN' ? …` 三元式（755 处，最多的是 `doctor/doctor-recommendations.tsx` 72 处）。推断：从零重做时文案迁移量与组件重写量相当，需要单独决定。
5. 事实：存在巨型组件。`DoctorCaseController` 是单个函数，跨 `doctor/doctor-case-controller.tsx:358-3118`（约 2,760 行），全文件 26 个 `useState`、41 处 `useQuery/useMutation`；`registrar-workspace.tsx` 757 行只有 3 个顶层函数。推断：“逐岗位重做”在医生工作台会先遇到拆分这个控制器的成本。
6. 事实：Agent 能力依赖 DOM 钩子。`agent-action-feedback.tsx:70,136,155,220` 通过 `querySelector` 读取 `data-agent-consultation-message`、`[role="dialog"][data-agent-catalog]`、`data-agent-feedback-status`；源码共使用 15 种 `data-agent-*` 属性（`data-agent-catalog` 26 处、`data-agent-selection` 13 处）。这些属性、`DoctorCaseSection` 枚举和 Page Context 合同在[医生工作台规格](../spec/2026-10-19-ai-native-doctor-workspace.md)范围中明确“保持不变”。这是硬约束。
7. 事实：DSH 单文件产物已无体积余量。已提交预算为 5,000,000 字节（`git show HEAD:apps/dsh-web/src/verify-artifact.ts` 第 15 行；[预算 Note](../decisions/implemented/testing/2026-10-07-dsh-client-size-budget.md)），未提交的本地修改把门禁临时放宽到 5,200,000，注释记录实际产物为 5,065,297 字节（`apps/dsh-web/src/verify-artifact.ts:15-17`，该数值本次未重新构建核实）。推断：任何新增运行时依赖（动效库、图表库、组件库）都会直接触碰预算，需要先决定预算处置。
8. 事实：浏览器测试以可访问名称和中文文案定位元素：`apps/web/e2e`（49 个 spec 与 28 个辅助文件）中 `getByRole` 1,747 处、`getByLabel` 472 处、`getByText` 283 处，DSH 浏览器合同（36 个 `*.browser.test.ts`）中 `getByRole` 741 处；`data-testid` 全仓只有 1 处。推断：保留语义角色和可访问名称的重做可以复用大部分测试；改动按钮文案、标签或页签名称会成批打断测试，文案也就成了事实上的测试合同。

## A. 代码现状审计

### A1. 技术栈与 token 体系

技术栈（事实）：React 19.2.3 / Tailwind CSS 4.3.3 / Base UI `@base-ui/react` 1.7.0 / TanStack Query 5.101.4 / TanStack Router 1.170.32 / lucide-react 1.33.0（`pnpm-workspace.yaml:13-34`）。shadcn 配置为 `base-nova` 风格、`cssVariables: true`、图标库 lucide（`packages/ui/components.json`）。组件以源码形式放在 `packages/ui/src/components/`，基于 Base UI 而非 Radix（`packages/ui/src/components/badge.tsx:1-2`）。

token 结构（事实，`packages/ui/src/styles.css`）：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| Tailwind 映射 | `:11-57` | `@theme inline` 把语义变量映射为 `--color-*`、`--radius-*`、`--font-*` |
| 基线浅色 | `:59-105` | `:root`，oklch 冷灰 + 青绿主色 `oklch(0.43 0.09 166)`，圆角 0.5rem；Desktop 与无 Web 根节点的场景使用 |
| 基线深色 | `:107-142` | `.dark` |
| Web 浅色 | `:144-197` | `[data-clinmesh-app="web"]`，hex 值，靛紫主色 `#6353d8`，圆角 0.375rem，字号 token 乘以 `--clinmesh-font-scale`，`--clinmesh-glow` |
| 字号档位 | `:199-205` | `data-font-size="larger"` 1.125、`"large"` 1.25 |
| Web 深色 | `:219-254` | `[data-clinmesh-app="web"].dark` |
| 旧壳兼容 | `:292-372` | `.cm-*` 类，只服务 `packages/views` 的 `AppShell` |

事实：同一个文件维护两套完全不同的主题（基线青绿 oklch 与 Web 靛紫 hex），由 `data-clinmesh-app` 选择。DSH 与 standalone 都渲染带该属性的应用根（`apps/web/src/app/web-app.tsx:500`），所以两个面实际都使用 Web 主题；基线主题只剩 Desktop 骨架在用。
事实：[2026-10-19 评审](2026-10-19-workspace-ui-review.md#1-独立-web-深色主题不生效)记录的深色不生效缺陷已修复：standalone 模式同时在 `<html>` 和应用根上应用主题类（`apps/web/src/app/web-app.tsx:460-469`，`apps/web/src/app/preferences.ts:64-70`）。

字号与密度（事实）：正文 13px（`--text-sm: 0.8125rem`，`styles.css:149`），控件小号 0.8rem，按钮高度 24/28/32/36px（`button.tsx:25-28`），Badge 高 20px、12px 字（`badge.tsx:8`）。没有密度 token，密度由各处的 Tailwind 间距类直接决定；三档字号只缩放字体 token，不缩放间距与控件高度（[design.md](../ui/design.md#密度与排版)）。
事实：`tabular-nums` 在业务源码出现 41 处，等宽数字依赖逐处手写，没有对应 token 或组件变体。

绕过语义 token 的统计（事实，排除测试文件）：

| 类别 | 数量 | 例子 |
| --- | ---: | --- |
| Tailwind 色阶类 | 45 | 原型 18；阅片器 `bg-black`、`text-white/80` 10（`imaging/grayscale-stack-engine.tsx:200-271`）；Logo 衬底 `bg-white`（`workspace-shell.tsx:215`、`web-app.tsx:261`）；`text-green-700`（`inpatient-patient-workspace.tsx:143`） |
| className 中任意 hex/rgb/oklch | 0 | — |
| 任意字号 `text-[10px]` | 2 | `inpatient-patient-workspace.tsx:147` 与原型 |
| 内联 `style={{}}` | 5 | 侧栏宽度、进度条宽度、阅片器定位等运行时几何 |
| 独立 CSS 中的硬编码颜色 | 2 文件 | `agent-action-feedback.css:44-45`、`doctor/clinical-document-updates.css:2-3` 的 `#39b6ff` / `#bd45fb` 动效渐变色，不随主题切换 |

推断：阅片器黑底属于医学影像显示惯例，重做时应作为有意例外登记，而不是当作违规清理。

### A2. 组件库盘点

`packages/ui/src/components/` 共 34 个文件（事实）：alert、alert-dialog、avatar、badge、breadcrumb、bubble、button、card、checkbox、dialog、dropdown-menu、empty、field、input、input-group、label、marker、message、message-scroller、portal-context、progress、select、separator、sheet、sidebar（733 行，最大）、skeleton、spinner、table、tabs、textarea、toast、toggle、toggle-group、tooltip。另有 hooks `use-mobile`、`use-container-compact`。`packages/ui/tests/accessibility.test.tsx` 有 4 个测试。

`packages/views` 只导出 `./app-shell`（`packages/views/package.json`），没有任何岗位视图（事实）。

使用面（事实，按导入该组件的非测试文件数）：Alert 57、Field 52、Badge 41、Skeleton 26、Table 19、Empty 19、AlertDialog 17、Tabs 11、Card 10、ToggleGroup 10、Dialog 9、Sheet 4、Select 4（另有包装组件 `workspace-select.tsx` 被 31 个文件使用）、Spinner 1、Progress 1、Marker 1、Breadcrumb 1。

组件目录 `component-catalog.tsx` 没有导入 `dialog`、`label`、`sidebar`、`portal-context`（事实，对比导入列表与组件目录）；[design.md](../ui/design.md#开发者组件目录)要求新增共享组件同步加入目录，Dialog 已被 9 个文件使用但不在目录里。

重复与不一致（事实）：

- 错误提示：至少 8 个文件各自定义同签名或近似的错误组件，`ErrorAlert` 出现在 `doctor/laboratory-page.tsx:115`、`doctor/clinical-document-page.tsx:39`、`doctor/prescription-page.tsx:58`、`doctor/doctor-case-controller.tsx:4011`、`doctor/doctor-queue-module.tsx:24`；另有 `PharmacyError`（`pharmacy-workspace.tsx:686`）、`PaymentError`（`billing-workspace.tsx:666`）、`CompletedCaseError`（`doctor-completed-cases.tsx:385`）、`ReadError` / `Loading`（`model-usage-workspace.tsx:44-48`）。
- 可选列表行：患者或单据列表用原生 `<button>` 手写选中态，分布在 `inpatient-doctor-patient-list.tsx:33`、`inpatient-nurse-bench.tsx:87`、`inpatient-insurance-review.tsx:81`、`synthetic-patient-library.tsx:299,327`；门诊医生另有 `DoctorQueueRail` / `DoctorQueueModule`（`doctor/doctor-queue-rail.tsx:11`、`doctor/doctor-queue-module.tsx:77`），住院病案有 `RecordQueue`（`inpatient-record.tsx:39`）。`packages/ui` 没有列表或选择行 primitive。
- 患者横幅：门诊 `PatientBanner`（`doctor/patient-summary.tsx:73`）与住院横幅（`inpatient-patient-workspace.tsx`）各自实现，规则分别写在 [design.md 门诊](../ui/design.md#门诊医生工作台)与[住院](../ui/design.md#住院工作台)两节。
- 状态到 Badge 变体的映射分散在各页面内联，没有共享映射；只有 `recordStatusBadge` 是命名函数（`inpatient-record.tsx:32`）。
- 门诊/住院子页签直接写在岗位分发里，含内联双语三元式（`role-workspaces.tsx:31-60`）。

一致的部分（事实）：原生 `<table>`、`<select>`、`<dialog>` 在产品代码中为 0（只有原型使用）；`window.confirm` 为 0，破坏性确认统一用 AlertDialog。

### A3. 信息架构与导航

岗位（事实）：`roleCodeSchema` 定义 10 个岗位代码（`packages/contracts/src/his.ts:19-30`）：administrator、cashier、outpatient-doctor、inpatient-doctor、ward-nurse、medical-records、medical-insurance、pharmacist、registrar、triage-nurse。**没有检验、放射或病理技师岗位**；检验检查是门诊医生病例里的页签，报告由受控系统生成。

路由（事实，`apps/web/src/app/workspace-shell.tsx:65-82`）：`/`（overview）、`/scenario-data`、`/registration`、`/triage`、`/consultation`、`/billing`、`/pharmacy`、`/inpatient`；设置 `/settings`、`/settings/model-usage`、`/settings/developer/components`；另有公共 `/components`（`web-app.tsx:343-346`）。工作区里还有未提交的 `/prototype/inpatient` 路由（`git diff apps/web/src/app/web-app.tsx`），文件注释标明不得合入 main。

岗位到页面（事实，`workspace-shell.tsx:113-124` 与 `role-workspaces.tsx:20-63`）：

| 岗位 | 首页 section | 页面 |
| --- | --- | --- |
| 门诊医生 | consultation | `DoctorWorkspace` |
| 挂号员 | registration | Tabs：门诊登记 `RegistrarWorkspace` / 住院登记 `InpatientWorkspace` |
| 分诊护士 | triage | `TriageWorkspace` |
| 收费员 | billing | Tabs：门诊收费 `BillingWorkspace` / 住院费用 `InpatientWorkspace` |
| 药师 | pharmacy | Tabs：门诊药房 `PharmacyWorkspace` / 住院药房 `InpatientPharmacy` |
| 住院医生、病区护士、病案、医保办 | inpatient | `InpatientWorkspace` |
| 管理员 | scenarioData | `ScenarioDataWorkspace` |

岗位不匹配 section 时返回空 `<div />`（`role-workspaces.tsx:62`）。

全局壳（事实）：standalone 使用 `ResponsiveSidebarProvider` + `Sidebar collapsible="icon"`，侧栏宽 13.75rem（220px）、折叠 3rem（`workspace-shell.tsx:528-536`），顶栏 3.375rem（54px），含唯一 `h1`（`workspace-shell.tsx:467-473`）。岗位切换在右上角人物菜单，按门诊/住院/系统三组分组（`workspace-shell.tsx:166-175`）；设置在侧栏底部入口。Surface 模式不渲染侧栏，只保留顶栏和 `main`（`workspace-shell.tsx:516-524`），岗位导航注册到 DSH 宿主侧栏。

页面滚动模型（事实）：主面板对 `consultation`、`inpatient` 使用无边距 `overflow-hidden` + `bg-background`，其他 section 使用 `p-4 overflow-y-auto` + `bg-muted/40`（`workspace-shell.tsx:491-494`）；而视口锁高同时作用于 consultation、inpatient、registration、billing、pharmacy 五个 section（`workspace-shell.tsx:529`）。推断：同一个壳里有两种画布底色和两种滚动模型，是“页面风格不一致”体感的来源之一。

DSH Surface 挂载（事实）：`createDefinition` 以 `layout.default: 'workspace'`、`fallback: 'shrink'`、`minSurfaceWidth: 360`、`supported: ['workspace','full-frame']`、`lifecycle: { mount: 'lazy', retention: 'keep-alive' }` 注册（`apps/dsh-web/src/client/index.tsx:158-170`）；样式经 `createStyledRoot` 注入 ShadowRoot 内的 `<style>`（`apps/dsh-web/src/client/styled-root.ts:4-12`）；使用 Memory History（`index.tsx:52`）、宿主主题、语言与字号（`index.tsx:22-44`）。未提交修改移除了 `workspace-mirror` 布局支持与存量升级逻辑（`git diff apps/dsh-web/src/client/index.tsx`）。

Desktop 与 Mobile（事实）：Desktop renderer 只渲染 `AppShell` 骨架（`apps/desktop/src/renderer/src/main.tsx`，13 行）；Mobile 只有 `app/_layout.tsx` 与 56 行的 `app/index.tsx`。[跨端前端架构](../frontend-architecture.md)写明二者首期不交付。

### A4. 各岗位页面体量与布局模式

最大的非测试源码文件（事实，`wc -l`）：

| 文件 | 行数 | 说明 |
| --- | ---: | --- |
| `doctor/doctor-case-controller.tsx` | 4,055 | 门诊病例控制器，单函数约 2,760 行 |
| `api-client.ts` | 2,072 | HTTP adapter，非 UI |
| `workspace-i18n.ts` | 1,984 | 文案字典 |
| `inpatient-prototype.tsx` | 1,372 | 未提交原型 |
| `doctor/catalog-picker-dialogs.tsx` | 1,366 | 三类目录弹窗，28 个 `useState` |
| `doctor/laboratory-page.tsx` | 1,255 | 检验检查页签 |
| `synthetic-patient-library.tsx` | 966 | 管理员患者库，20 处 Query |
| `doctor/prescription-page.tsx` | 938 | 处方 |
| `doctor-completed-cases.tsx` | 845 | 已完诊病例库 |
| `registrar-workspace.tsx` | 757 | 挂号，3 个顶层函数 |
| `pharmacy-workspace.tsx` / `billing-workspace.tsx` | 694 / 677 | 药房 / 收费 |

布局模式（事实）：

- 门诊医生：容器查询三栏，`>=1080px` 为 200px 队列 + 病例 + 280px 建议栈，`720–1080px` 为两栏，`<720px` 切换显示（`doctor/responsive-layout.tsx:32-95`）；病例区五个业务页签；目录在弹窗内完成选择与填写（[开具工作区决策](../decisions/implemented/architecture/2026-10-19-clinical-order-workspace.md)）。
- 住院：患者列表 → 患者详情，七个阶段导航按入院/在院/出院/病案分组，未访问阶段不挂载、已访问阶段保留挂载（[住院阶段工作台 Note](../decisions/implemented/architecture/2026-10-21-inpatient-stage-workspace.md)）。
- 挂号、分诊、收费、药房：列表 + 详情表单，挂号、收费、药房外层再套门诊/住院 Tabs。
- 管理员：患者库与生成任务，页面式滚动。
- 实际使用 `@container` 或 `useContainerCompact` 的文件只有 6 个；`useIsMobile` 在 `apps/web` 中未被使用（事实）。

未提交原型 `apps/web/src/app/inpatient-prototype.tsx`（事实，文件头 `:1-8`）：一次性住院闭环原型，四种形态 D 完整流程（默认）/ A 病区白板 / B 住院时间线 / C 岗位队列，数据全部为内存假数据，按钮只推进本页状态、不调用 Command；通过 `?variant=` 切换（`:898-942`）。它自带 `ProtoBadge` 与 18 处色阶类，不受 token 纪律约束。

### A5. 可访问性与 i18n

可访问性属性统计（事实，`apps/web/src/app` 非测试 `.tsx`）：`aria-label` 307、`aria-hidden` 162、`aria-labelledby` 56、`role="status"` 53、`aria-invalid` 21、`role="alert"` 19、`tabIndex` 15、`aria-expanded` 11、`aria-describedby` 7、`aria-live` 6、`aria-current` 6、`onKeyDown` 1、`autoFocus` 0。焦点环由 primitive 统一提供（`button.tsx:8` 的 `focus-visible:ring-3 ring-ring/50`）；`outline-none` 用在可聚焦容器上，例如工作区主面板（`workspace-shell.tsx:493-494`）和阅片画布（`imaging/grayscale-stack-engine.tsx:200`）。推断：这些容器聚焦时没有可见焦点指示，需要逐个确认是否只作程序化聚焦目标。

动效偏好（事实）：`prefers-reduced-motion` 只在 `agent-action-feedback.css:91`、`doctor/clinical-document-updates.css:42` 和 `agent-workspace-glow.tsx:14,23` 处理；primitive 依赖 `tw-animate-css` 的进出动画（`styles.css:2`），没有统一的减弱动效规则。

对比度（事实，按 WCAG 2.x 相对亮度公式计算 token 对，未在浏览器实测渲染结果）：

| 前景 / 背景 | 浅色 | 深色 |
| --- | ---: | ---: |
| `muted-foreground` / `background` | 4.91 | 7.08 |
| `muted-foreground` / `muted` | 4.63 | — |
| `primary` / `background` | 5.49 | 5.42 |
| `destructive` / `background` | 4.34 | — |
| `info` / `background` | 3.79 | — |
| `success` / `background` | 3.25 | — |
| `warning` / `background` | 2.89 | 7.30 |
| `success-foreground` 白 / `success` | 3.30 | — |
| `info-foreground` 白 / `info` | 3.86 | — |
| `warning-foreground` / `warning` | 4.57 | — |

浅色下 `text-warning` / `text-success` / `text-info` / `text-destructive` 在业务代码中共出现 22 处，Badge 变体另以 `/15` 浅底叠加同色文字（`badge.tsx:14-22`），实际对比度更低。推断：浅色主题的状态文字整体低于 WCAG 1.4.3 的 4.5:1。

i18n（事实）：语言只有 zh-CN / en-US。主字典 `workspace-i18n.ts` 以 `zhCN` 对象定义键并由 `getWorkspaceMessages` 取用（`:1`、`:1982`）；另有 `component-catalog-i18n.ts`、`model-usage-i18n.ts`。并行存在 `t(cn, en)` 局部函数（12 个文件）与 755 处内联三元式。岗位标签、门诊/住院子页签名称直接写在 `role-workspaces.tsx:32-60`。DSH 侧 `dsh-prose-standard` 要求客户端 UI 文案进入类型化字典；ClinMesh 没有对应的 i18n 检查脚本（`package.json` scripts 中无此项）。

### A6. 测试与验证基础设施

事实：

- `playwright.config.ts:27-28` 定义 `contracts` project（`**/*.browser.test.ts`，36 个文件，34 个在 `apps/dsh-web/src`）与 `web` project（`apps/web/e2e/*.spec.ts`，49 个 spec）。
- React 18/19 双版本合同：至少 10 个 DSH 浏览器合同包含 React 18 矩阵（catalog-dialogs、pci-preparation、workspace-history、inpatient-referral、investigation-billing、consultation-composer、consultation-history、model-usage、queue-rail、agent-feedback），运行入口 `pnpm test:browser --grep 'React 18'`（[测试策略](../testing.md#用户界面验证)）。
- 单元/组件测试：`apps/web/src` 下 60 个 `*.test.ts(x)`；`packages/ui/tests/accessibility.test.tsx` 4 个测试。
- 专项布局合同：`responsive.browser.test.ts`、`surface-layout.browser.test.ts`、`font-size.browser.test.ts`（DSH 与 Web 各一）、`web-theme.browser.test.ts`、`borders.browser.test.ts`、`menu.browser.test.ts`、`doctor-section-scroll.browser.test.ts`。
- 定位方式以角色和名称为主（见核心结论第 8 条），`data-testid` 几乎不用。

重构必须保持的验证合同（事实，来自[测试策略](../testing.md#用户界面验证)）：Playwright 在 standalone Web 与受影响的 DSH Surface 真实入口验证；覆盖长中文、窄宽度、缩放、空/错误/加载；DSH `workspace` 缩放与右栏开关保持左右分屏；全屏往返保留病例和草稿；双 React 版本；ShadowRoot；合成 canvas 断言；Agent 开发与验证不读取影像像素或截图。

### A7. 硬约束与可推翻惯例

**工程硬约束（重来也必须遵守）**

| # | 约束 | 对 UI 重构的具体限制 | Owner |
| --- | --- | --- | --- |
| H1 | 双 React 版本 | 共享代码只用 18.3.1 与 19.2 共有 API，禁止 `useEffectEvent` 等 19-only API；对话框类组件纳入双版本浏览器合同 | [根 AGENTS.md](../../AGENTS.md)、[React API Note](../decisions/implemented/bug-fix/2026-09-16-dsh-surface-react-api-surface.md) |
| H2 | ShadowRoot 与 Portal | 样式以字符串注入 ShadowRoot；所有浮层挂 `PortalContainerProvider` 提供的 portal root（`web-app.tsx:496,519`）；不得假设全局 `document` 样式或 `:root` 变量生效 | [跨端前端架构](../frontend-architecture.md#dsh-web) |
| H3 | 宿主拥有主题、语言、字号与根元素 | Surface 跟随宿主 light/dark，不提供本地主题选择；字号缩放只能作用于应用根，不能修改宿主根字号，因此“改根字号 + rem”方案在 DSH 中不成立 | [design.md](../ui/design.md#密度与排版)、[主题所有权 Note](../decisions/implemented/architecture/2026-09-15-dsh-host-theme-ownership.md) |
| H4 | 宿主 overlay 层级 | 不抬高 Surface 或菜单 z-index；原生文件全屏覆盖 HIS | [overlay Note](../decisions/implemented/bug-fix/2026-09-15-preserve-host-overlay-order.md) |
| H5 | DSH 布局 | 左右分屏、`shrink` 回落、最小 360px、手动全屏；DSH 内不显示 ClinMesh 侧栏，导航铺在宿主侧栏 | [响应式 Note](../decisions/implemented/bug-fix/2026-09-11-surface-responsive-layout.md)、[产品偏好](../memory/product-references.md#工作台布局与交互偏好) |
| H6 | 单文件 lazy-CJS 产物 | 不生成动态 chunk，不打包第二份 React；预算 5,000,000 字节且当前已超出（核心结论第 7 条）；整套运行时组件库与大型依赖实际不可行 | [预算 Note](../decisions/implemented/testing/2026-10-07-dsh-client-size-budget.md)、[压缩 Note](../decisions/implemented/testing/2026-10-22-dsh-client-whitespace-compaction.md) |
| H7 | 包依赖方向 | `ui` 不依赖 `core`、不含业务概念；`views` 不导入 Vite/路由/Electron；`contracts`/`core` 不读 DOM 与 `localStorage`；新共享抽象须已有两个实际消费者；`pnpm verify:boundaries` 校验 | [packages/AGENTS.md](../../packages/AGENTS.md) |
| H8 | 状态所有权 | TanStack Query 独占服务端状态；Zustand 只存筛选、布局、草稿和临时选择；复杂状态变化走共享 Command，界面不复制状态机 | [根 AGENTS.md](../../AGENTS.md)、[跨端前端架构](../frontend-architecture.md#状态所有权) |
| H9 | Agent 钩子与 Page Context | `data-agent-*` 属性、`DoctorCaseSection` 枚举、`data-agent-page-title`（`workspace-shell.tsx:470`）与 Page Context 注册由 Agent tools 和反馈读取；重做必须保留或在同一 diff 迁移 Tool、Skill 与漂移测试 | [医生工作台规格](../spec/2026-10-19-ai-native-doctor-workspace.md#范围)、[Agent 集成](../architecture/agent-integration.md) |
| H10 | 写入恢复语义 | 结果未确认的写入保留原输入、预期版本和幂等键；会导航、支付、发药、退费的流程等服务端成功后才清理本地状态；界面需能表达 ambiguous 等未知结果 | [跨端前端架构](../frontend-architecture.md#web)、[住院写入恢复 Note](../decisions/implemented/bug-fix/2026-10-20-inpatient-command-intent-recovery.md) |
| H11 | 合成数据与像素纪律 | 演示数据全部合成；Agent 开发验证不读取影像像素或截图；显示名称不加“合成”前缀 | [根 AGENTS.md](../../AGENTS.md)、[design.md](../ui/design.md#门诊医生工作台) |
| H12 | 不虚构能力 | 界面不出现未实现能力的按钮；FHIR 只声明实际实现的能力 | [根 AGENTS.md](../../AGENTS.md) |
| H13 | 验证入口 | Playwright 真实入口 + DSH 浏览器合同 + 双 React 矩阵；只报告实际运行的检查 | [测试策略](../testing.md#用户界面验证) |
| H14 | 双语 | zh-CN / en-US 都必须可用 | [design.md](../ui/design.md#颜色与主题) |

**现行视觉与交互惯例（重来可以推翻）**

以下均写在 [design.md](../ui/design.md) 或 token 值里，属于当前选择而非工程约束；推翻时需要同步更新 design.md 与相关 Agent Note：六条核心原则（安静的密度、表面优先于阴影等）；220px 侧栏 / 54px 顶栏 / 16–20px 页边距；13px 正文与按钮四档高度；6px / 8px 圆角；靛紫主色、“方向四 AI 原生工作台”视觉语言与 `--clinmesh-glow` 柔光；Card 使用限制；门诊三栏的 200/280px 栏宽与 720/1080px 断点；患者横幅两行格式；五个业务页签的顺序与分组；“目录与表单在同一弹窗”的开具交互；住院七阶段导航与分组；挂号/收费/药房的门诊/住院子页签；岗位切换放在右上角人物菜单；三档字号的具体比例；全局字距 0 与等宽数字（推断：后两项与中文排版和数值核对强相关，推翻前需要理由）。

**介于两者之间（推翻代价高，需要用户明确取舍）**

- 可访问名称与中文文案：不是工程约束，但约 3,400 处测试定位调用依赖它们（核心结论第 8 条）。
- `packages/ui` 基于 Base UI + shadcn `base-nova`：换 primitive 底层不违反硬约束，但会触及 H1、H2、H6 的全部合同测试。
- 已确认的用户偏好（[产品偏好](../memory/product-references.md)）：自动记录保持安静、Agent 反馈采用环绕柔光、医生前端先熟悉再引入 Agent、DSH 不改上下排列。这些是用户决定而非工程约束，推翻需要用户本人重新确认。

## B. 既有设计材料盘点

本节只列内容要点与仍可复用的输入，不评估进度，也不建议继承任何方向。`design/`、`design-preview/` 与 `feature-inventory-2026-10-28.md` 均为未跟踪工作区内容（`git status`），本文以代码路径提及，不建立链接。

### B1. `design/`

| 材料 | 内容要点 | 可复用输入 |
| --- | --- | --- |
| `design/00-方法模板-v0.1.md` | 七步法提示模板：简报 → 需求层 → 领域层 → 设计规则层 → 巧思层 → 原型与自检 → 诊断式迭代 | 方法本身可选用；用户已决定不沿用其产物 |
| `design/01-brief.md` | 三类画像（临床决策 / 事务执行 / 管理评估）、三个关键场景、10 条硬约束、5 条成功标准、8 维评分表 | 画像与场景描述、硬约束清单（与本文 A7 基本一致）、评分维度 |
| `design/02-screens.md` | 岗位 × 界面模式表（M1 队列-上下文工作台至 M7 设置）、功能清单到界面落点的覆盖核对、6 个压力测试页面 | 岗位任务、使用频率与出错后果表；覆盖核对表可作为重做的完整性清单 |
| `design/03-domain.md` | 门诊/住院/收费/药房/管理员真实工作流与回头点，8 级安全优先级，10 条“界面必须避免的错误” | 安全优先级与“必须避免的错误”是领域事实，与风格无关，最有复用价值；术语以 [CONTEXT.md](../../CONTEXT.md) 为准 |
| `design/04-design-system.md` + `design/tokens.css` | 语义色、6 级字阶、4px 间距集合、两档密度、八态组件、动效时长、10 条自检清单；三方向 × 明暗 token | 自检清单、对比度标准与八态清单可作为验收条件参考；“经根字号缩放、token 用 rem”与 H3 冲突 |
| `design/05-ideas.md` + `05-ideas-preview.html` | 门诊医生工作台 12 条交互点子（逐句溯源、待核实三态就地处置、完诊门禁即视化、目录语境预筛、处方双闸预检、病例切换护栏、迟到 AI 草稿隔离等） | 点子源于真实合同（完诊门禁、迟到草稿隔离、开单拒绝），可作为交互候选池 |
| `design/prototypes/` | P1 三方向（临床仪器 / 安静诊疗 / 机构信任）+ P2–P6 机构信任压力页 + DSH 嵌入示意 + 275KB 总览；README 附模拟边界声明 | P2–P6 合成场景（PCI 围术期、组合收款与未知结果、近效期批次、危急分诊、Scenario 两段重置）可作为测试场景脚本；README 自述 `color-mix` 派生色未实测对比度 |
| `design/style-trio/` | 门诊医生工作台三种交互范式：A 病历流（时间轴）、B 控制台（多面板 + 键盘 + ⌘K）、C 病案册（证据 → 结论双页）；README 自述均未做双主题 | 交互范式层面的对照（非视觉）可作为“信息组织方式”候选 |
| `design/references/` | OpenEMR、GNU Health、Open Hospital 三份 UI 研究 | 外部证据；`docs/research/` 中尚无这三份的已跟踪版本 |

材料之间的冲突（事实）：`design/01-brief.md` 写“风格从零制定，不继承仓库内部任何既有风格结论”，`design/style-trio/README.md` 又写“不继承 `design/01`–`05` 与 `tokens.css` 的任何设计语言”，与 `design/prototypes/README.md` 的“方向已选定：机构信任”并存；`design/02-screens.md` 写“9 个人类岗位角色”，随后列出 10 个代码。现行 [design.md](../ui/design.md) 仍声明“方向四 AI 原生工作台”为当前视觉语言。按用户本次决定，这些冲突不需要调和，重做以本文 A7 的硬约束为起点。

### B2. `design-preview/`（17 个 HTML，按日期）

| 日期 | 文件 | 方向（取自 `<title>` 与正文） |
| --- | --- | --- |
| 10-23 | `candidate-a-swiss-minimal` … `candidate-e-porcelain-gold` | 五个视觉候选：极简效率、暗色驾驶舱、温和医疗、墨金、瓷白鎏金；均含门诊医生工作台与挂号收费两视图 |
| 10-23 | `redesign-prototypes` | 四个隐喻方向：病区白板、电子单据、值班观片、诊疗导视 |
| 10-23 | `workbench-functional` | 医生工作台可交互原型 |
| 10-25 | `inpatient-functional` | 住院岗位工作台（病区一览板） |
| 10-26 | `celadon-ink-refined` | 青墨语言：门诊精修 + 住院重构 |
| 10-26 | `direction-a-clinical-focus` / `-b-clinical-command` / `-c-guided-care`、`ui-ux-directions` | 澄明临床工作台 / 夜航临床指挥台 / 青白引导式诊疗；对比“医生下一步看什么、做什么” |
| 10-26 | `dsh-clinmesh-three-directions` | ClinMesh × DSH 一体化三方向：棱镜、脉冲、织光，含助手会话 |
| 10-26 | `full-product` | 门诊 + 住院全场景，纸张编辑风 |
| 10-26 | `language-board`、`premium-language-trio` | 设计语言对比板（同一内容 × 4–5 套语言）；玄墨 / 素笺 / 锋线 |

可复用输入：多份文件用同一合成内容（危急值横幅、患者卡、任务卡、费用表、Agent 建议行）对比不同语言，这套“对比内容块”本身可以复用为新方向的评审样本。

### B3. 已跟踪的 UI 研究、规格与 Note

- [HIS UI/UX 一手参考](his-ui-ux-references.md)：OpenHIS、Medplum、OpenMRS O3、Bahmni 的岗位、患者上下文、队列、半成功与审计模式，固定 commit。仍有效。
- [独立 Web 工作台 UI 评审观察](2026-10-19-workspace-ui-review.md)：8 项发现。深色主题缺陷已修复（见 A1）；内部数据暴露、枚举未映射、横幅与表格密度等发现本次未逐条复核现状。
- [现代专业 UI 参考](modern-ui-design-references.md)：Linear、Grafana、shadcn 生态、Radix Colors、cmdk、TanStack Table、Base UI 等资产核验。仍有效。
- [UI 设计风格选型研究](2026-10-22-ui-design-styles.md)：六类风格的一手来源与适配度；其“整套运行时组件库与 H2/H6 冲突”的结论与本文一致。
- [AI 原生医生工作台规格](../spec/2026-10-19-ai-native-doctor-workspace.md)（implemented）：定义当前门诊三栏、建议栈、A6–A8 工程合同与 A11 三页签结构。从零重做会替代它的布局部分，A8 工程合同继续有效。
- 相关 Agent Note：[UI 合同与组件目录](../decisions/implemented/architecture/2026-08-26-clinical-ui-contract-and-catalog.md)、[开具工作区](../decisions/implemented/architecture/2026-10-19-clinical-order-workspace.md)、[建议栈与横幅进度](../decisions/implemented/architecture/2026-10-20-doctor-suggestion-stack-banner-progress.md)、[住院阶段工作台](../decisions/implemented/architecture/2026-10-21-inpatient-stage-workspace.md)、[Agent 柔光](../decisions/implemented/architecture/2026-10-07-agent-workspace-glow.md)、[字号偏好](../decisions/implemented/feature/2026-09-02-web-font-size-preference.md)。布局类 Note 在重做后需要标记替代；工程类 Note（H1–H6 引用的）继续有效。
- `feature-inventory-2026-10-28.md`：按九个域列出的功能快照（194 issue / 145 PR / 46 份规格），开放项为 #145 服务启停、#225 门诊住院共享支付与 DRG、PCI 住院 Agent 线。可作为重做的功能覆盖清单。

## C. 综合

### C1. 当前 UI/UX 主要问题（按影响排序）

1. **浅色状态色对比度不足**（事实）：见 A5 表格。影响所有警告、成功、信息、危险状态的可读性，而这些正是临床防错信息。
2. **业务 UI 没有共享层，模式重复实现**（事实）：`packages/views` 为空，错误态至少 8 份、列表选择行 5 处以上、两套患者横幅、Badge 映射分散（A2）。推断：同类页面观感和行为不一致，且任何统一改动都要逐文件修改。
3. **巨型组件**（事实）：`DoctorCaseController` 约 2,760 行单函数（A4）。推断：门诊工作台的任何布局重做都要先拆分它，否则风险集中在一个文件。
4. **壳内两种画布与滚动模型**（事实）：A3 页面滚动模型。推断：岗位切换时页面质感跳变。
5. **文案三套机制并存**（事实）：A5 i18n。推断：重做时双语一致性难以保证，也无检查脚本兜底。
6. **主题双轨**（事实）：基线青绿 oklch 与 Web 靛紫 hex 共存于同一文件，基线只服务 Desktop 骨架（A1）。推断：新 token 体系若不先清理，会出现第三套。
7. **DSH 产物无体积余量**（事实）：A7 H6。推断：限制重做可引入的任何依赖。
8. **零散 a11y 缺口**（事实/推断）：可聚焦容器 `outline-none`、减弱动效未统一处理、键盘处理只有 1 处 `onKeyDown`（A5）。推断：键盘为主的高频岗位（收费、药房）缺少快捷操作。

### C2. 从零重做的范围选项

| 选项 | 内容 | 主要代价 | 受硬约束影响 |
| --- | --- | --- | --- |
| R1 新 token 与 primitive 视觉 | 重写 `styles.css` 为单一 token 体系（含密度、等宽数字、状态色对比度），按新语言重做 `packages/ui` 各 primitive 的变体；业务页结构不动 | 最低；多数测试可保留；但只解决“观感”，不解决重复实现与壳的不一致 | H2（样式进 ShadowRoot）、H3（字号只缩放应用根）、H6 |
| R2 R1 + 新壳与信息架构 | 在 R1 基础上重做全局壳、导航、岗位切换、页面画布与滚动模型、门诊/住院子页签的组织方式 | 中；触及 `workspace-shell.tsx`、`role-workspaces.tsx`、DSH 导航注册与 `surface-layout`/`responsive` 合同测试 | H3、H5（DSH 内无自有侧栏、左右分屏）、H9（`data-agent-page-title`、导航注册） |
| R3 R2 + 新业务组件层 | 新建共享业务组合组件（患者横幅、队列/列表行、状态 Badge 映射、错误/空/加载态、金额与检验值展示），统一文案机制，逐步替换各岗位重复实现 | 高；需决定放在 `packages/views` 还是 `apps/web` 私有目录；文案迁移约 1,300 处 | H7（`views` 不导入路由；新共享抽象需两个消费者，Desktop 未交付时只有 Web 一个消费者）、H1、H13 |
| R4 逐岗位重做页面 | 在 R1–R3 基础上，按岗位重新设计布局与交互流程（门诊医生、住院、挂号、分诊、收费、药房、管理员、设置） | 最高；门诊需先拆 `DoctorCaseController`；约 3,400 处基于角色名称与文案的测试定位随文案变化重写；布局类 Agent Note 与规格需替代 | H8、H9、H10、H12 全部；门诊页签与 `DoctorCaseSection` 枚举改动需同步 Agent tools |
| R5 替换 primitive 底层 | 放弃 shadcn/Base UI，换其他组件体系 | 极高 | H6 使整套运行时组件库实际不可行；H1、H2 需要全量重新验证。[风格选型研究](2026-10-22-ui-design-styles.md)已得出相同结论 |

推断：R1 → R2 → R3 → R4 是可以逐层交付的递进关系；R5 与其余选项互斥，且受硬约束阻碍最大。

### C3. 仍需用户决定的问题

1. 范围取哪一层（C2 的 R1–R4，或某一层只覆盖部分岗位）？
2. DSH 产物体积：当前已超 5 MB 预算，重做前是调高预算、裁减客户端，还是禁止新增任何依赖？
3. 共享业务组件放在 `packages/views`（为 Desktop 预留，但当前只有一个消费者，与 H7 的“两个消费者”规则冲突）还是 `apps/web` 私有？
4. 可访问名称与中文文案是否允许随重做改变？允许则需要接受成批重写 E2E 与浏览器合同。
5. 已确认的产品偏好（环绕柔光、安静自动记录、医生“先熟悉再引入 Agent”、DSH 左右分屏）是否全部保留？
6. 门诊病例的五个业务页签与 `DoctorCaseSection` 枚举是否允许改变？改变需要同步 Agent tools、Skill 与漂移测试。
7. 视觉验收标准：是否以 WCAG 2.x AA（正文 4.5:1、非文本 3:1）作为硬性门槛，并为阅片器黑底等例外登记？
8. 文案机制是否在重做中统一为类型化字典，并增加检查脚本？
9. 未提交的 `inpatient-prototype.tsx` 与 `/prototype/inpatient` 路由如何处置（保留在分支、删除、或作为参考）？
10. Desktop 与 Mobile 是否继续保持范围外？

## 运行的只读命令

- `wc -l`、`find`、`ls`：文件规模与目录清单。
- `grep -rEo` / `grep -rEn`：色阶类、任意值、`style={{}}`、primitive 导入、原生控件、`window.confirm`、内联双语三元式与 `t(cn, en)`、aria 属性、`data-agent-*`、`tabular-nums`、`prefers-reduced-motion`、Playwright 定位方法的统计；均排除 `*.test.*`。
- `python3 -I`：按 WCAG 2.x 相对亮度公式计算 token 颜色对比度。
- `git status`、`git diff`、`git show HEAD:apps/dsh-web/src/verify-artifact.ts`：区分已提交与未提交内容。
- 未运行构建、测试、浏览器或模型；未读取任何图片、截图或影像像素文件。
