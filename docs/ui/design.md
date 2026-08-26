# 临床 UI 设计合同

ClinMesh Web 与 Desktop 使用同一套高信息密度临床视觉语言。界面保持安静、紧凑且可扫描，患者事实、业务状态和可执行动作始终优先于装饰。

## 所有权

| 内容 | Owner |
| --- | --- |
| 亮色、暗色、语义色、字号和圆角 token | [`packages/ui/src/styles.css`](../../packages/ui/src/styles.css) |
| Button、Field、Table、Tabs、AlertDialog、Toast 等 primitive | [`packages/ui/src/components/`](../../packages/ui/src/components/) |
| Web 工作台布局与平台交互 | [`apps/web/src/app/`](../../apps/web/src/app/) |
| 真实组件目录 | [`apps/web/src/app/component-catalog.tsx`](../../apps/web/src/app/component-catalog.tsx) |
| 跨端依赖方向 | [跨端前端架构](../frontend-architecture.md) |

`packages/ui` 不包含 Patient、Encounter 或 Medication 等业务概念。业务页面只通过公开组件入口和语义 token 组合界面，不复制 primitive 的样式。Mobile 使用独立的 React Native UI，不导入本合同中的 DOM 组件。

## 密度与几何

| 合同 | 值 | 用途 |
| --- | ---: | --- |
| 桌面侧栏 | 204px (`12.75rem`) | 岗位导航与当前操作身份 |
| 顶栏 | 54px (`3.375rem`) | 当前工作区、导航切换和账户操作 |
| 正文与 `text-sm` | 13px (`0.8125rem`) | 表单、表格、状态和常规说明 |
| XS / SM / 默认 / LG 按钮 | 24 / 28 / 32 / 36px | 按动作密度选择，不随视口缩放 |
| 状态标签圆角 | 约 5px | 风险、信息、警告、成功和中性状态 |
| 常规控件圆角 | 6px | Button、Input、Tabs 和 Select |
| 页面级最大圆角 | 8px | 独立业务项、弹层和真正需要边框的工具 |
| 字距 | 0 | 中文、英文、数字和控件文字 |

常驻区域不使用投影。页面层级通过背景、1px 边线、间距和固定位置表达；阴影仅用于菜单、Select、Dialog、Sheet 和 Toast 等脱离文档流的临时覆盖层。Card 只包裹独立重复项或真正需要边界的工具，页面分区不使用装饰卡片，也不嵌套 Card。

页面标题保持紧凑，工作台一级标题通常为 20px，分区标题使用 13px 至 16px。临床数值可提高字号和字重，但不使用随视口变化的字号。日期、时间、金额和检验值使用等宽数字特性。

## 色彩与主题

应用只消费语义 token，不在业务组件中写入任意 Tailwind 色阶。

| Token | 含义 |
| --- | --- |
| `background` / `foreground` | 主画布和默认文字 |
| `card` / `popover` | 独立业务项和临时覆盖层 |
| `primary` | 明确主操作和当前选择 |
| `destructive` | 过敏、危急、删除和不可逆风险 |
| `warning` | 偏高、待复核和需要注意 |
| `success` | 正常、通过和已完成 |
| `info` | 常规信息、同步和进行中 |
| `secondary` / `muted` | 中性状态、辅助表面和弱化文字 |
| `border` / `input` / `ring` | 分隔线、控件边界和键盘焦点 |

亮色以白色主画布和冷灰辅助面为主；暗色重新映射画布、文字、边线和各语义色，而不是反相亮色值。Web 在根节点使用 `dark` class 与 `data-theme`，主题选择写入 `clinmesh.preferences:v1`。`/components` 顶栏的亮色/暗色 ToggleGroup 操作同一主题机制，因此展示的是产品实际 token。

语义色只表达含义，不扩散为大面积背景、Logo 或装饰。页面不使用品牌渐变、光斑、渐变球或纯氛围图形。

## 响应式断点

断点沿用 Tailwind 的稳定尺寸，不创建只服务单页的相近断点。

| 宽度 | 行为 |
| --- | --- |
| `< 640px` | 单列内容，紧凑页边距，Tabs 可横向滚动，提交区固定在可视区底部 |
| `640px–767px` | 扩大页边距，仍使用移动导航 Sheet 和单列主流程 |
| `768px–1023px` | 显示 204px 桌面侧栏，表单可转两列，Input 与 Textarea 使用 13px 字号 |
| `1024px–1279px` | 独立预览、反馈和临床辅助区域可并列显示 |
| `>= 1280px` | 业务网格使用完整桌面密度，主任务继续优先占用宽度 |

固定格式控件和状态区域使用稳定高度、网格列或最小宽度。内容过长时换行或让 Table 容器横向滚动，不通过缩小字体隐藏信息。移动端不会把桌面侧栏压成不可读窄栏，而是使用 Sheet。

## 组件组合

### 命令与工具

命令使用 Button。新增、保存、提交、删除等责任明确的动作使用 Lucide 图标加文字；熟悉的纯工具动作可使用带可访问名称的图标按钮。尺寸和 variant 由 Button 的公开 API 提供，页面 `className` 只负责布局。加载按钮为 `disabled` Button 加 Spinner，Spinner 必须保留可本地化的 `role=status` 名称。

### 表单

表单使用 `FieldGroup + Field + FieldLabel`。无效状态同时在 Field 上设置 `data-invalid`、在控件上设置 `aria-invalid`，并用 `FieldError` 绑定具体错误。禁用状态同时落在 Field 和原生控件。二至七个选项使用 ToggleGroup；相关复选项使用 `FieldSet + FieldLegend`。

### Tabs 与数据

`TabsTrigger` 只出现在 `TabsList` 中，并与同值 `TabsContent` 配对。默认键盘合同是方向键移动焦点，Enter 或 Space 激活面板。Table 保留原生表格语义，通过 caption 或 `aria-label` 命名；窄屏由 Table 容器负责横向滚动。

状态使用 Badge 的 `destructive`、`warning`、`success`、`info`、`secondary` 或 `outline` variant。加载集合使用 Skeleton，操作中状态使用 Spinner，错误和需要注意的完整消息使用 Alert。

### 弹层与反馈

AlertDialog 必须包含 Title 和 Description，打开后管理焦点，关闭后把焦点还给触发按钮。Dialog、Sheet 和菜单由 primitive 管理 Portal 与堆叠，不由页面写入 z-index。Toast 使用共享 Base UI manager；成功、警告、错误和加载反馈通过 `type` 映射图标与语义。

### 提交区

长表单和临床编辑器使用底部 `sticky` 提交区。次要动作位于主动作之前，区域通过顶边线与内容分隔，不增加浮动 Card 或常驻阴影。动态文案和按钮状态不得改变工具条高度。

## 真实组件目录

Web 的公共 `/components` 路由不要求登录，也不请求应用 API。页面静态导入 `@clinmesh/ui/components/*`，因此展示、测试和业务页面消费同一份 primitive 源码。

目录分为“控件与表单”“临床数据与状态”“弹层与反馈”三个 Tabs，覆盖：

- Button 尺寸、variant、disabled、真实键盘 focus 和 Spinner loading；
- Field、Input、Textarea、ToggleGroup、无效和禁用表单状态；
- Table、Badge、Skeleton、Alert、长中文和紧凑数字；
- AlertDialog、Toast、亮色/暗色主题和固定提交区。

目录是可执行设计合同，不承担业务流程、组件注册表或完整导出清单。新增共享组件时仍先确认真实消费者；只有属于临床通用状态且需要人工检查的组合才进入目录。

## 可访问性与验证

所有交互控件必须有可访问名称，图标装饰使用 `aria-hidden`，焦点使用 `ring` token 且不可被布局裁切。错误文本命名错误主体，Toast 使用礼貌 live region，确认弹层使用 `alertdialog`。长中文必须在 390px 移动宽度内保持可读，不遮挡相邻内容或固定提交区。

包级契约位于 [`packages/ui/src/components/accessibility.test.tsx`](../../packages/ui/src/components/accessibility.test.tsx)，覆盖 Spinner、Tabs 和 AlertDialog。公共路由与目录工作流位于 [`apps/web/src/app/web-app.test.tsx`](../../apps/web/src/app/web-app.test.tsx)，覆盖零网络访问、键盘 Tabs、表单状态、临床数据、弹层、Toast 和主题持久化。

代码变更先运行受影响包的 typecheck 与测试。文档或公开投影变更运行 `pnpm doc-sync`。用户可见变更还需从真实 `/components` 入口在桌面和移动视口检查布局、焦点、弹层、Toast 和主题。
