---
version: alpha
name: Ankang-Outpatient-OS-design-2
description: A dense outpatient clinical workspace shaped by a reference-led cool white and cool gray system. Neutral application chrome keeps attention on records and decisions; five soft semantic tag families encode allergy, information, warning, success, and AI provenance without turning any of them into a brand color. The consultation surface prioritizes a structured medical record on the left and a restrained AI assistant on the right, with conversation and suggestions presented as mutually exclusive modes.

colors:
  action-blue: "#3987F6"
  action-blue-active: "#2472E4"
  action-dark: "#343544"
  action-dark-strong: "#1D1F1C"
  focus-blue: "#2F72F4"
  ink: "#30313F"
  ink-secondary: "#717280"
  ink-tertiary: "#A0A1AD"
  canvas: "#FFFFFF"
  surface-secondary: "#F7F8FA"
  surface-input: "#FAFBFC"
  shell-border: "#DDE0E6"
  divider: "#E7E8EC"
  divider-strong: "#D6D8DF"
  table-header-ink: "#747A72"
  table-row-divider: "#E7E9E4"
  neutral-chip: "#F1F2F5"
  tag-pink-bg: "#FDF2F8"
  tag-pink: "#E70478"
  tag-blue-bg: "#F0F9FF"
  tag-blue: "#00A4F2"
  tag-orange-bg: "#FFF6ED"
  tag-orange: "#F06100"
  tag-teal-bg: "#F1FDFB"
  tag-teal: "#00968A"
  tag-indigo-bg: "#EEF2FE"
  tag-indigo: "#6E5BF1"
  chart-blue: "#2F72F4"
  chart-orange: "#F06100"
  chart-pink: "#E70478"
  on-action: "#FFFFFF"

dark-colors:
  page: "#090A09"
  canvas: "#10110F"
  surface: "#171816"
  surface-secondary: "#1C1D1A"
  surface-raised: "#191A18"
  surface-deep: "#121311"
  divider: "#2B2D29"
  divider-strong: "#41443E"
  ink: "#F1F3EE"
  ink-secondary: "#A5AAA1"
  ink-tertiary: "#737970"
  tag-pink-bg: "#351527"
  tag-pink: "#FF78B9"
  tag-blue-bg: "#102C39"
  tag-blue: "#5CC8FF"
  tag-orange-bg: "#382214"
  tag-orange: "#FF9A58"
  tag-teal-bg: "#12302D"
  tag-teal: "#4ED4C7"
  tag-indigo-bg: "#252947"
  tag-indigo: "#A99EFF"

typography:
  page-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 20px
    fontWeight: 760
    lineHeight: 1.2
    letterSpacing: 0
  card-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 14px
    fontWeight: 720
    lineHeight: 1.5
    letterSpacing: 0
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-strong:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 12.5px
    fontWeight: 680
    lineHeight: 1.5
    letterSpacing: 0
  compact:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0
  micro:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 9.5px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0
  metric:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 27px
    fontWeight: 760
    lineHeight: 1.2
    letterSpacing: 0
  clinical-value:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0

rounded:
  compact: 5px
  control: 6px
  medium: 7px
  card: 8px
  shell: 10px
  legacy-toast: 12px
  full: 9999px

spacing:
  xxs: 4px
  xs: 5px
  sm: 8px
  md: 10px
  lg: 14px
  xl: 18px
  xxl: 24px
  shell-gutter: 14px

components:
  app-shell:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.shell-border}"
    rounded: "{rounded.shell}"
    margin: "{spacing.shell-gutter}"
  sidebar:
    backgroundColor: "{colors.surface-secondary}"
    textColor: "{colors.ink-secondary}"
    width: 204px
  navigation-item-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  topbar:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.divider}"
    height: 54px
  search-input:
    backgroundColor: "{colors.surface-input}"
    textColor: "{colors.ink}"
    borderColor: "{colors.divider}"
    rounded: "{rounded.control}"
    height: 32px
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.control}"
  button-workflow:
    backgroundColor: "{colors.action-dark}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.control}"
  button-neutral:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.divider-strong}"
    rounded: "{rounded.control}"
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.divider}"
    rounded: "{rounded.card}"
    padding: 17px
  semantic-tag-pink:
    backgroundColor: "{colors.tag-pink-bg}"
    textColor: "{colors.tag-pink}"
    rounded: "{rounded.compact}"
  semantic-tag-blue:
    backgroundColor: "{colors.tag-blue-bg}"
    textColor: "{colors.tag-blue}"
    rounded: "{rounded.compact}"
  semantic-tag-orange:
    backgroundColor: "{colors.tag-orange-bg}"
    textColor: "{colors.tag-orange}"
    rounded: "{rounded.compact}"
  semantic-tag-teal:
    backgroundColor: "{colors.tag-teal-bg}"
    textColor: "{colors.tag-teal}"
    rounded: "{rounded.compact}"
  semantic-tag-indigo:
    backgroundColor: "{colors.tag-indigo-bg}"
    textColor: "{colors.tag-indigo}"
    rounded: "{rounded.compact}"
  data-table-header:
    backgroundColor: "{colors.surface-secondary}"
    textColor: "{colors.table-header-ink}"
    borderColor: "{colors.divider}"
  consultation-record:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  consultation-ai-panel:
    backgroundColor: "{colors.surface-secondary}"
    textColor: "{colors.ink}"
    width: 372px
  toast:
    backgroundColor: "#20221F"
    textColor: "{colors.on-action}"
    rounded: "{rounded.control}"
  consultation-toast:
    backgroundColor: "#212529"
    textColor: "{colors.on-action}"
    rounded: "{rounded.legacy-toast}"
---

## Overview

`design-2` 是一套面向门诊医生的高信息密度工作界面，覆盖三个相互衔接的页面：今日总览、患者病历与问诊工作台。它不使用营销式大标题或装饰性视觉，而把患者、指标、病历字段和医生决策放在首要位置。页面采用冷白主画布、冷灰侧栏和细灰分隔线，视觉层级主要由区域位置、间距和边界建立。

当前视觉重构由指定参考图 `references/cGStTYNPwPDD6cVNZ8AON96eXQ.avif` 驱动。参考图中舒缓的低饱和标签系统被转译为五组语义色，但没有把其中任何一组提升为品牌色。品牌标记、导航、页框和工作流主按钮保持中性；尤其不使用亮黄或荧光黄作为 Logo、按钮或装饰色。

样式采用逐层覆盖：`index.html` 内嵌共享基型，`patient.html` 与 `consult.html` 先加载 `tokens.css` 再叠加各自内联结构样式，三个页面最后都加载 `refine.css`。最终覆盖层负责当前视觉语言、暗色态和响应式规则。因此后续实现与验收应以浏览器计算结果及 `refine.css` 为准，而不是以内联 CSS 中仍可见的旧色值或旧圆角为准。

**Key Characteristics:**

- 冷白内容画布与冷灰辅助区域，背景不偏暖，不使用米色或泛黄底色。
- Logo 是透明底深灰图形，品牌区没有独占的高饱和色。
- 五组低饱和语义标签分别承担风险、信息、警示、完成和 AI 来源；颜色只服务含义。
- 卡片以 1px 边线和 8px 圆角为主，默认无投影，避免仪表盘变成漂浮卡片墙。
- 13px 基础字号与 11px 左右的标签字号支持临床场景的快速扫描。
- 问诊工作台将病历作为左侧主任务，将 AI 作为右侧 372px 辅助区。
- AI 的“对话”与“建议”互斥显示，不把消息、生成进度与三张建议卡堆在同一条滚动流中。
- 桌面端保留多列工作效率，移动端优先在完整病历与完整 AI 视图之间切换。
- 暗色态不是简单反相，而是重新映射画布、浮层、边线、文字与五组标签色。

## Colors

> **实现来源：** `refine.css` 的 `:root` 与 `body.theme-dark`。`tokens.css` 中的旧紫色、暖色背景和大圆角变量仅是前置基型，已被最终覆盖层替换。

### Shell & Neutral Surfaces

- **Canvas** (`{colors.canvas}`，#FFFFFF)：页面主体、内容区、顶栏、记录工作区和常规卡片的主背景。白色是占比最高的颜色。
- **Secondary Surface** (`{colors.surface-secondary}`，#F7F8FA)：侧边导航、AI 滚动区、表头和次级状态区。它提供轻微层级，但不与主内容争夺注意力。
- **Input Surface** (`{colors.surface-input}`，#FAFBFC)：搜索框等输入型控件的默认底色。聚焦后回到纯白。
- **Shell Border** (`{colors.shell-border}`，#DDE0E6)：桌面应用外框的专用灰，比业务模块分隔线稍明确。
- **Divider** (`{colors.divider}`，#E7E8EC)：卡片、表头、顶栏、侧栏和工作台分区的主要 1px 边线。
- **Divider Strong** (`{colors.divider-strong}`，#D6D8DF)：次级按钮边框和需要更明确触控边界的控件。
- **Table Header Ink** (`{colors.table-header-ink}`，#747A72)：密排表头的专用低对比文字。
- **Table Row Divider** (`{colors.table-row-divider}`，#E7E9E4)：表格正文行之间的专用细线。
- **Neutral Chip** (`{colors.neutral-chip}`，#F1F2F5)：普通计数、历史来源、停用状态和无风险灰标签。

页面最外层在桌面端保留 14px 白色页边距，应用框由 1px `#DDE0E6` 边线与 10px 圆角包裹。这个框只定义应用边界，不制造悬浮感。

### Text

- **Ink** (`{colors.ink}`，#30313F)：标题、关键数值、正文和默认图标。
- **Ink Secondary** (`{colors.ink-secondary}`，#717280)：导航默认态、说明文本、控件标签与次要信息。
- **Ink Tertiary** (`{colors.ink-tertiary}`，#A0A1AD)：时间、元数据、来源、占位符和微型说明。
- **On Action** (`{colors.on-action}`，#FFFFFF)：蓝色或深灰实心按钮上的文字与图标。

文字层级依靠明度和字重共同区分。不要通过额外颜色区分普通标题、字段名或导航层级。

### Actions

- **Action Blue** (`{colors.action-blue}`，#3987F6)：跨页面的明确跳转与常规主操作，如“继续接诊”“前往问诊工作台”。
- **Action Blue Active** (`{colors.action-blue-active}`，#2472E4)：蓝色按钮的悬停反馈。
- **Workflow Dark** (`{colors.action-dark}`，#343544)：问诊页内更接近临床确认的操作，如采纳、发送和签名。深灰紫只表达动作优先级，不构成品牌色。
- **Topbar Dark** (`{colors.action-dark-strong}`，#1D1F1C)：顶栏“新建”按钮。
- **Focus Blue** (`{colors.focus-blue}`，#2F72F4)：键盘焦点与输入聚焦外环，通常以透明度降低后的 2px outline 使用。

### Five Semantic Tag Families

五组语义色直接取自参考图的标签观感。所有标签均为浅底配清晰前景色，圆角收敛到 5px，而不是夸张的胶囊形。

| Family | Background | Foreground | Primary Meaning | Examples |
|---|---:|---:|---|---|
| Pink | `{colors.tag-pink-bg}` #FDF2F8 | `{colors.tag-pink}` #E70478 | 过敏、危急值、强风险 | 青霉素过敏、急查、过敏拦截 |
| Blue | `{colors.tag-blue-bg}` #F0F9FF | `{colors.tag-blue}` #00A4F2 | 常规信息、诊断、进行中 | 高血压、常规检查、AI 同步信息 |
| Orange | `{colors.tag-orange-bg}` #FFF6ED | `{colors.tag-orange}` #F06100 | 偏高、待处理、需关注 | 血钾偏高、方案生成中、待补充 |
| Teal | `{colors.tag-teal-bg}` #F1FDFB | `{colors.tag-teal}` #00968A | 正常、通过、已完成 | 在诊、审查通过、正常结果 |
| Indigo | `{colors.tag-indigo-bg}` #EEF2FE | `{colors.tag-indigo}` #6E5BF1 | AI、智能来源、协诊身份 | AI 草稿、智能摘要、建议计数 |

语义色可以出现在标签、小型图标底、头像占位和状态提示中，但不能扩散到 Logo、大面积页面背景或所有按钮。图表可以使用蓝、橙、粉作为数据系列编码，这与品牌强调色是两套职责。

### Data Visualization

- **Chart Blue** (`{colors.chart-blue}`，#2F72F4)：主要趋势、收入和普通门诊系列。
- **Chart Orange** (`{colors.chart-orange}`，#F06100)：次要趋势、药品成本和偏高指标。
- **Chart Pink** (`{colors.chart-pink}`，#E70478)：急诊或高风险占比。

收入图中的透明面积渐变用于表达数据面积，不是页面装饰渐变。图表之外不新增渐变背景。

### Dark Appearance

暗色态以 `body.theme-dark` 启用，页面最外背景为 `{dark-colors.page}` (#090A09)，应用画布为 `{dark-colors.canvas}` (#10110F)。常规卡片使用 #191A18，AI 会话滚动区与病历工作区的深层区域使用 #121311，侧栏和顶栏使用 #151614。

五组语义标签在暗色态下分别映射为亮粉、亮蓝、亮橙、亮青和亮靛前景，并搭配低明度同色背景。它们维持原语义，不直接复用日间浅底。主题选择写入 `localStorage` 的 `ankang-theme`，刷新后继续生效。

### Brand Gradient

**没有品牌渐变，也没有亮黄色品牌色。** Logo 为透明背景上的中性深灰心电线图标；医生与用户头像采用靛青浅底而不是黄色。底层 Token、页面内联样式与最终覆盖层中的头像和 AI 标记都已使用纯色语义底，不依赖样式覆盖来隐藏旧黄色渐变。

## Typography

### Font Family

- **UI / Body:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif`。
- **Chinese first-class rendering:** macOS/iOS 使用系统字族，Windows 与其他平台回落到 Segoe UI、PingFang SC、HarmonyOS Sans SC 或 Microsoft YaHei。
- **Numeric alignment:** 表格、时钟、日期与临床数值使用 `font-variant-numeric: tabular-nums`，便于纵向比较。
- **Tracking:** `body, body *` 强制 `letter-spacing: 0`。本系统不随视口缩放字距，也不使用负字距。

### Hierarchy

| Token | Size | Weight | Line Height | Use |
|---|---:|---:|---:|---|
| `{typography.page-title}` | 20px | 760 | 1.2 | 今日总览、患者病历等页面标题 |
| `{typography.card-title}` | 14px | 720 | 1.5 | 卡片标题、关键分组标题 |
| `{typography.body}` | 13px | 400 | 1.5 | 默认界面正文 |
| `{typography.body-strong}` | 12.5px | 680 | 1.5 | 导航激活态、患者名、关键标签 |
| `{typography.compact}` | 11.5px | 400 | 1.6 | 病历描述、表格、会话气泡 |
| `{typography.label}` | 11px | 600 | 1.5 | 字段名、筛选、按钮和状态标签 |
| `{typography.micro}` | 9.5px | 500 | 1.5 | 时间、来源、模型版本和微型说明 |
| `{typography.metric}` | 27px | 760 | 1.2 | 首页 KPI 数值 |
| `{typography.clinical-value}` | 17px | 700 | 1.3 | 体温、血压、心率与血氧 |

### Principles

- **密度服务扫描。** 页面不依赖大号标题制造层级，主要操作内容集中在 9.5px 至 14px 之间。
- **数值高于标签。** KPI 和生命体征比说明文字大 5px 以上，并使用更高字重。
- **病历正文保持可读行距。** 现病史、智能摘要与会话气泡使用约 1.6 至 1.7 行高，即使字号紧凑也不挤压阅读。
- **字重数量受控。** 正文 400，交互/标签 600 左右，标题 700 左右；极高字重只用于页面标题和大型指标。
- **所有字距为零。** 不使用大写英文式宽字距作为装饰；侧栏小标题也由字号、位置与颜色构建层级。

## Layout

### Application Shell

桌面端 `.app` 是带 14px 外边距的横向 Flex 容器，最小高度为 `calc(100vh - 28px)`。左侧 `.sidebar` 固定 204px，主区 `.main` 自适应占据剩余空间。侧栏使用冷灰背景，内容主区与顶栏保持纯白。

侧栏在页面内粘性定位，桌面高度为 `calc(100vh - 28px)`。品牌位于顶部，工作导航居中，设置、夜间模式或当前医生信息靠底部。当前导航项是白底细边线状态，不使用彩色左轨或大面积品牌填充。

顶栏高度 54px，包含 390px 上限语义的搜索区域、深色“新建”按钮、通知/设置图标和医生身份。顶栏粘在主内容顶部，用 1px 底边线维持上下文。

### Spacing System

- **Tight control spacing:** 4px、5px、8px，用于标签、图标和紧凑控件内部。
- **Local grouping:** 10px、14px，用于表格单元格、卡片内容和同一业务组。
- **Content rhythm:** 18px、24px，用于工作区内边距、页面主区和主要模块之间。
- **Shell gutter:** 14px，用于桌面应用外框。
- **Dashboard content:** 默认 `20px 24px 32px`，网格间距 14px。
- **Card padding:** 默认 17px；问诊内部字段单元通常为 12px 至 13px。

### Dashboard Grid

首页采用 12 列网格。四个 KPI 卡片在完整桌面端均分一行；当前患者占 8 列，候诊分布占 4 列；收入图占 8 列，排班/报告栈占 4 列；候诊列表占满 12 列。

当前患者卡内部是约 1.55:1 的两列。左侧放患者身份、标签、生命体征与 7 日血压趋势，右侧放接诊医生、时段、主诉和“继续接诊”。这一区域使用内部边线而不是嵌套卡片。

### Patient Record Grid

患者页同样使用 12 列网格。患者头卡占满一行；就诊时间线、近期检验和用药记录各占左侧 8 列并纵向排列；基本信息、过敏与诊断、智能患者摘要位于右侧 4 列。右列在视觉上是并列业务模块，不把卡片嵌入另一张卡片。

时间线用日期列、轨道列和正文列组成。检验与用药使用密排表格，趋势图作为检验模块的内部补充。右列智能摘要最终为纯白卡片，靛青只保留在 AI 标记中。

### Consultation Workspace

问诊页在桌面端锁定为视口工作台，外框高度为 `calc(100vh - 28px)`，页面本身不滚动。其内容结构如下：

```text
Application shell
├── Global sidebar · 204px
└── Main
    ├── Patient tab bar · 46px
    └── Work
        ├── Clinical record workspace · flexible primary area
        └── AI consultation panel · 372px secondary area
```

病历主区 `.ws` 顺序为 1，占据剩余宽度；AI 区 `.chat` 顺序为 2，固定 372px，并由左边线与主区分隔。虽然 HTML 中 AI 节点先出现，最终视觉顺序由 `order` 明确反转。

左侧病历区包含患者过敏/医保横条、病历/医嘱标签页、可滚动内容和固定底部提交栏。四项生命体征被整合为一条连续边框带；病历字段被整合为一个 2 列结构化网格，字段之间共享边线。医嘱页用处方表和检查申请区表达，不把每个字段拆成独立浮动卡片。

右侧 AI 区由白色标题栏、白色模式栏、冷灰滚动区与白色输入区组成。它是辅助面板而不是第二个主工作台。

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | 无阴影，纯白或冷灰面 | 页面主体、侧栏、顶栏、病历区、默认卡片 |
| Hairline | 1px `{colors.divider}` | 卡片、表格、工作区分栏、生命体征和字段网格 |
| Strong control edge | 1px `{colors.divider-strong}` | 次级按钮与需要明确边界的控件 |
| Focus ring | 2px 半透明 `{colors.focus-blue}`，offset 2px | 键盘焦点；搜索框额外使用 3px 低透明聚焦环 |
| Overlay | `0 14px 36px rgba(20,22,19,.16)` | 快捷菜单与通知弹层 |
| Toast | `0 10px 28px rgba(20,22,19,.22)` | 临时操作反馈 |

**Depth principle:** 常驻业务区不使用阴影。层级通过白/灰表面切换、边线与固定位置表达。投影只用于脱离文档流的菜单和 Toast，让用户知道它们是临时覆盖层。

首页 KPI 的右下角细小柱线纹样属于数据提示，不承担装饰背景角色。页面不使用光斑、渐变球或大面积色块制造氛围。

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---:|---|
| `{rounded.compact}` | 5px | 标签、模式计数、微型按钮、检查图标 |
| `{rounded.control}` | 6px | 导航项、搜索框、主要按钮、输入按钮、Toast |
| `{rounded.medium}` | 7px | AI 卡片、生命体征带、结构化字段区、方形头像 |
| `{rounded.card}` | 8px | 页面级卡片、弹层 |
| `{rounded.shell}` | 10px | 桌面应用外框 |
| `{rounded.legacy-toast}` | 12px | 问诊页内联 Toast 的现存旧规格 |
| `{rounded.full}` | 9999px / 50% | 开关圆点、状态点、环图；仅在几何含义需要时使用 |

### Geometry Principles

- 页面级卡片不超过 8px 圆角，保持工具感和信息密度。
- 文本标签默认使用 5px 小圆角，不把所有状态做成大胶囊。
- 用户与患者头像主要使用 6px 至 8px 方圆角，减少消费级社交产品感。
- 只有开关圆点、通知点、环图和步骤节点保留圆形几何。
- 工作区中的生命体征和病历字段共享外轮廓，内部单元不重复圆角。

## Components

### Application Navigation

**`app-shell`**：桌面端 14px 外边距、1px 边线、10px 圆角的应用边界。小手机和问诊页窄屏状态下移除外边距、边线和圆角，转为全屏工具。

**`sidebar`**：204px 冷灰固定导航。品牌 Logo 是 30px 透明容器中的 17px 深灰心电线图标。当前项使用白底与 1px 内描边，计数使用中性灰小矩形。1180px 以下缩为 68px 图标栏，760px 以下缩为 56px；问诊页 900px 以下完全隐藏。

**`topbar`**：54px 白色粘性顶栏。搜索框在页面内筛选患者数据；“新建”按钮打开三项快捷菜单；通知图标打开待处理通知浮层。弹层可通过点击页面、调整窗口尺寸或 Escape 关闭。

### Buttons & Controls

**`button-primary`**：蓝底白字，6px 圆角，无阴影，最小高度 36px。用于跨页面主路径和普通确认动作。悬停切换为 `{colors.action-blue-active}`。

**`button-workflow`**：深灰紫底白字，5px 至 6px 圆角。用于问诊内“采纳写入”“发送”“签名提交”等高责任动作。它与语义靛青标签不同，不能被用于 AI 身份装饰。

**`button-neutral`**：白底、强分隔线边框和深色文字。用于调整、暂存、导出、发消息与次级输入方式。

**`filter`**：5px 圆角小型筛选项。默认白底细边线；选中态使用 #343544 深底白字。点击或 Enter/Space 会更新候诊表过滤结果。

**`theme-switch`**：位于侧栏底部。支持点击、Enter 和 Space；同步 `aria-pressed`，并把状态保存到本地存储。

### Semantic Tags

**`semantic-tag-pink`**：强风险或明确禁忌。不要用于普通错误装饰，也不要同时与橙色表达同一风险等级。

**`semantic-tag-blue`**：信息、常规项目和临床诊断。它不是主按钮蓝，浅底与亮青蓝前景用于快速定位信息。

**`semantic-tag-orange`**：待处理、偏高或需要医生注意，但尚不等于危急禁忌。

**`semantic-tag-teal`**：正常、通过、已完成、在诊等正向状态。

**`semantic-tag-indigo`**：AI 生成、智能摘要、协诊身份与建议数量。仅用于标记来源，不用于 Logo 或整个页面底色。

### Cards & Data

**`card`**：白底、1px 冷灰边线、8px 圆角、17px 内边距、无阴影。只用于真正的业务模块，如指标、病历时间线、检验或报告，不用于把整个页面分区再次包成卡片。

**`metric-card`**：首页四项 KPI。图标使用对应的浅语义底，数值为 27px/760，辅助趋势与说明降到 10.5px。卡片自身仍保持白色，不用整张高饱和色底。

**`data-table`**：表头使用 `{colors.surface-secondary}`，10.5px 次要文字；正文 11.5px 至 12px，行高由 8px 至 10px 单元格内边距控制。表格使用等宽数字特性，悬停行只增加极浅灰底。

**`patient-summary`**：患者身份、风险标签、连续生命体征带、趋势图和当前接诊信息。身份头像为蓝色浅底方圆角；过敏以粉色、诊断以蓝色表达。

**`timeline`**：患者页左侧的纵向就诊历史。当前节点使用 Action Blue 实心点和浅蓝外环，已完成状态使用青色标签，危急记录使用粉色标签。

**`patient-ai-summary`**：白色卡片加靛青 AI 标记，正文与引用信息仍保持中性。风险建议在橙色浅底块中呈现。

### Consultation Record

**`consultation-record`**：问诊页左侧主任务区。背景保持纯白，内容从患者风险横条、病历/医嘱模式、结构化正文到底部提交操作按纵向排列。

**`vitals-strip`**：四个生命体征共享 1px 外边框与内部竖线，7px 外圆角。桌面端 4 列，移动端 2×2。警示数值仅把数值本身切换为橙色。

**`clinical-field-grid`**：主诉、现病史、查体、诊断和既往史组合成一个连续 2 列网格。AI 草稿、历史档案和待补充分别使用靛青、灰、橙来源标签。既往史跨两列；查体待补充区提供语音或键盘入口。

**`order-pane`**：处方与检查申请页。处方以密排表格显示药品、规格、用法、数量和备注；过敏审查、相互作用与医保结果使用青/橙标签。检查项目按急查、常规、择期区分。

**`workspace-footer`**：固定 54px 底栏。左侧暂存，右侧显示剩余交付数和签名按钮。签名按钮在三项 AI 交付全部采纳前保持禁用。

### AI Consultation Panel

**`consultation-ai-panel`**：桌面端右侧 372px 辅助栏，冷灰内容背景，左侧以 1px 边线和病历区分隔。1180px 以下缩到 350px。

**`chat-modebar`**：白色 39px 模式栏，包含“对话”和“建议”。选中态只使用深色文字与 2px 底线；“建议”旁的靛青计数从 3 随采纳进度递减。

**`conversation-mode`**：显示就诊前摘要、医生与 AI 消息、协诊进度和底部输入器。风险摘要用粉色，AI 头像用靛青，医生消息用深色气泡。

**`suggestion-mode`**：隐藏摘要、消息、进度和输入器，仅显示病历草稿、处方建议和检查建议三张交付卡。这样医生处理建议时不会在长对话中寻找操作入口。

**`delivery-card`**：白底细边线、7px 圆角，无常驻阴影。每张卡包含来源图标、待处理状态、结构化建议、采纳和调整。调整面板允许编辑文本、点击快捷 Chip 追加要求、取消或确认。

**`adoption-feedback`**：采纳后卡片变为已写入状态，操作区隐藏，建议计数与底栏剩余数同步递减；当前可见目标分区触发两次短脉冲，页面底部显示 Toast。三项完成后协诊状态切换为“交付完成 · 待签名”，签名按钮解锁。

**`chat-composer`**：白色固定输入区，包含语音、附件入口、文本框、发送按钮与归档提示。点击发送或按 Command/Ctrl + Enter 添加医生消息，并在 900ms 后追加一条 AI 确认回复。

### Popovers & Feedback

**`quick-menu`**：点击“新建”后出现，包含新建患者档案、新增预约和发起检查申请。当前原型只以 Toast 确认入口已打开。

**`notice-menu`**：通知按钮弹出三条待处理通知，采用与快捷菜单一致的 210px 浮层语法。

**`toast`**：深色小矩形，固定在视口底部中央。共享 `.ui-toast` 使用 #20221F、6px 圆角并带 `role=status`；问诊页内联 `.toast` 使用 #212529、12px 圆角，用于采纳、调整与签名反馈。

## Do's and Don'ts

### Do

- 使用纯白作为主工作画布，使用 `{colors.surface-secondary}` 作为侧栏、表头和 AI 辅助区。
- 让 Logo、应用框架和主导航保持中性；品牌识别来自名称、结构和心电线图形。
- 严格按照五组标签色的含义分配状态，先判断语义再选择颜色。
- 用 1px 边线、共享容器和间距构建层级；常驻卡片默认无阴影。
- 把问诊病历保留为最宽的主区，把 AI 放在右侧固定宽度辅助区。
- 保持“对话”和“建议”互斥；切换模式时滚动位置回到顶部。
- 把生命体征做成一条连续带，把病历字段做成共享边界的结构化表单。
- 保证数值使用 tabular numerals，让血压、金额、日期和列表编号易于纵向比较。
- 在窄屏问诊页用明确的视图切换按钮，在完整病历和完整 AI 面板之间切换。
- 为键盘焦点保留可见蓝色轮廓，并尊重 `prefers-reduced-motion`。

### Don't

- 不要为 Logo、头像、按钮或装饰重新引入亮黄、荧光黄或黄绿色。
- 不要把粉、蓝、橙、青、靛中的任意一种扩张成大面积品牌底色。
- 不要把 AI 建议、聊天消息、生成进度和输入器同时堆进一条无限滚动流。
- 不要在问诊侧栏重新嵌入完整候诊名单；当前设计只保留导航入口和底部医生身份。
- 不要把每个生命体征或每个病历字段做成互相分离的漂浮卡片。
- 不要在页面级卡片上添加阴影、超大圆角或装饰性渐变。
- 不要使用暖灰、米白或奶油色替代冷白/冷灰背景体系。
- 不要用颜色替代文字标签；风险、来源和进度都必须保留明确文案。
- 不要让 AI 的靛青身份色覆盖医生的最终确认动作；签名和采纳使用中性深色动作语法。

## Responsive Behavior

### Breakpoints

| Breakpoint | Width | Key Changes |
|---|---:|---|
| Compact desktop | ≤ 1180px | 侧栏从 204px 缩为 68px 图标栏；导航文字隐藏；AI 面板从 372px 缩为 350px |
| Patient/dashboard reflow | ≤ 980px | KPI 变为 2 列；首页主模块占满 12 列；患者页左右列改为纵向，右侧三模块临时排成 3 列 |
| Consultation mobile | ≤ 900px | 问诊页移除外框并隐藏侧栏；默认只显示病历；按钮切换到全屏 AI；生命体征 2×2，字段单列 |
| General mobile | ≤ 760px | 基础字号降至 12px；侧栏 56px；顶栏 50px；页面内边距缩小；患者与首页模块进一步单列 |
| Small phone | ≤ 480px | 应用移除外边距、边线和圆角；侧栏贴满视口；搜索框收为 32px 图标按钮 |

### Dashboard Collapsing Strategy

- 四个 KPI 从 4 列变为 2 列。
- 当前患者与收入图在 980px 以下占满 12 列。
- 候诊分布和右侧业务栈在 760px 以下占满 12 列。
- 当前患者内部双列在 760px 以下变为单列；生命体征重排为 2×2。
- 表格保留约 850px 最小内容宽度并横向滚动，避免压缩列文字。

### Patient Record Collapsing Strategy

- 980px 以下，时间线、检验、用药和右侧信息区全部占满 12 列。
- 右侧三个业务模块先以 3 列并排，760px 以下再变为单列。
- 患者头卡允许换行，操作按钮占满下一行并换行排列。
- 检验和用药表保留约 610px 内容宽度，通过模块内部横向滚动保证字段完整。

### Consultation Collapsing Strategy

- 900px 是问诊工作台的结构性断点。侧栏隐藏，桌面双栏不再挤压为两条窄列。
- 默认显示病历主区；顶部对话图标切换 `show-mobile-chat` 后，AI 面板占据全部可用宽度，病历区隐藏。
- 切换按钮同步 `aria-pressed`、`aria-label` 和 `title`，使当前视图含义可被辅助技术读取。
- 病历生命体征从 4 列变为 2×2；病历字段从 2 列变为单列；底栏隐藏自动暂存和剩余提示，只保留操作按钮。
- AI 消息气泡最大宽度使用 `min(560px, calc(100vw - 80px))`，避免超出手机视口。

### Touch & Motion

当前紧凑型桌面控件多为 30px 至 36px 高，适合鼠标密集操作；移动问诊切换按钮为 30px。后续面向纯触屏部署时，应评估将主要触控目标提升到至少 44px，而不改变桌面密度。

`prefers-reduced-motion: reduce` 会把动画与过渡压缩到 0.01ms，并关闭平滑滚动。普通状态下仅保留菜单进入、Toast 上移、写入脉冲和协诊步骤环等短反馈。

## Interaction Model

### Shared Interactions

1. 搜索输入实时过滤首页候诊表；若候诊队列存在，也同步过滤队列项目。
2. 状态筛选支持鼠标、Enter 与 Space，并与搜索关键词组合生效。
3. “新建”打开快捷菜单；通知图标打开通知列表；页面点击、窗口调整或 Escape 关闭当前弹层。
4. “导出”把候诊表转换为带 BOM 的 CSV 并触发下载。
5. 患者页“发消息”显示确认 Toast；“导出病历”生成周建国病历摘要文本文件。
6. 夜间模式写入 `ankang-theme`，刷新后恢复，并更新页面 `color-scheme`。

### Consultation Workflow

```text
Conversation
  -> review summary and messages
  -> switch to Suggestions
  -> optionally adjust a proposal
  -> adopt each proposal into its target pane
  -> suggestion count reaches 0
  -> signature unlocks
  -> sign and submit
```

病历与医嘱标签页只切换主工作区内容。AI 对话与建议标签页只切换右侧辅助区内容，两套标签互不替代。采纳建议时，只对当前可见的目标病历/医嘱区域触发视觉脉冲；数据原型不自动替换具体字段文本。

## Iteration Guide

1. 修改颜色时先更新 `refine.css` 的有效 Token，再同步本文件；不要只改 `tokens.css` 的旧基型值。
2. 新增状态前，先判断能否归入粉、蓝、橙、青、靛或中性灰，避免创建第六种随意标签色。
3. 新增问诊功能时，先判断它属于医生病历主任务还是 AI 辅助任务，再决定放入 `.ws` 或 `.chat`。
4. 新增 AI 内容时，选择“对话”或“建议”其中一个模式，不在两个模式重复同一大块内容。
5. 新增病历字段时延续共享边框网格；只有处方、检查等独立业务集合才使用 `rx-card`。
6. 页面级圆角限定在 5px、6px、7px、8px 和 10px 这组标尺内；不要引入 12px 以上消费级大圆角。
7. 常驻组件禁止投影。只有 Popover、菜单和 Toast 可以使用明确浮层阴影。
8. 每次工作台布局变更至少检查 1440px、1180px、900px、760px 和 480px 五个宽度。
9. 每次修改 AI 采纳流程都验证建议计数、剩余提示、状态文案、签名门控和当前 Pane 脉冲。
10. 每次修改主题变量都验证日间与暗色下五组标签的对比度和语义一致性。

## Known Gaps

- 当前为前端静态原型，没有真实患者、处方、检查、消息或签名后端；刷新会重置问诊采纳和签名状态。
- 建议“调整”只修改交付卡内的 textarea；确认调整不会把文本写入目标病历字段。
- “采纳写入”更新卡片状态、计数和视觉反馈，但不会持久化或逐字段合并数据。
- 病历/医嘱标签、AI 模式标签之外的患者标签页和“接诊下一位”目前是静态示意。
- 问诊侧栏中的候诊列表仍保留在 HTML 中，但最终 CSS 将标题和列表隐藏；其点击示意逻辑当前不可见。
- 一部分导航项、设置图标、语音、附件、筛选下拉和卡片链接尚无完整业务行为。
- 问诊页内联 Toast 未设置 `role=status`；共享 Toast 已设置。工作区标签仍以可点击 `div` 实现，键盘和 ARIA Tab 语义需要后续补齐。
- 共享 `.ui-toast` 与问诊页内联 `.toast` 的圆角、阴影和无障碍属性尚未统一。
- 紧凑控件的触控高度普遍低于 44px，当前优先桌面临床密度，尚未完成纯触屏可用性验收。
- 图表是静态 SVG，不支持数据点提示、图例筛选或实时数据更新。
- 搜索和筛选只操作已存在的 DOM 行，不包含空结果提示、服务端查询、分页或错误态。
- 表单验证、网络失败、并发编辑、处方审查失败、签名失败和权限不足等异常状态尚未实现。
- 暗色态已覆盖主要组件，但尚未完成逐组件的正式无障碍对比度审计。
