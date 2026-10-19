# 现代专业 UI 与临床可视化设计参考

## 研究范围与结论

本文补充调研视觉与交互设计质量高、可供 ClinMesh 借鉴的产品与开源项目，覆盖五个方向：高密度专业工具产品、shadcn/Tailwind 生态的 dashboard 资产、现代健康科技产品、临床数据可视化开源实现、主题与密度与键盘导航。本文不研究 HIS 业务结构与岗位工作流——该部分见 [HIS UI/UX 一手参考](his-ui-ux-references.md)，两篇研究互不重复。本文也不定义 ClinMesh 当前行为：`docs/research/` 是研究证据目录，界面 token、组件与布局的当前合同以 [UI 设计合同](../ui/design.md) 为准。

证据均来自 2026-10-19 直接核验的一手来源：GitHub 仓库的 License、star 数、最近推送与归档状态经 GitHub API 核验，官方文档与官方设计文章经网页抓取核验。本次调研期间聚合搜索服务不可用，条目来自任务给定名单加逐项直接核验；凡未取得一手界面证据的条目（闭源 SaaS 的登录后界面）一律标注"证据较弱"，不作为模式来源。文中"活跃"指核验日近一年内仍有推送或官方发文，各仓库核验值以当日 API 返回为准。

核心结论：高密度与视觉安静并存有一套可复用手法，且与 ClinMesh"安静密度"合同同向——层级靠表面和边线而非颜色与阴影（Linear 的"结构应被感知而非看见"）；语义色只表达状态且由阈值派生（Grafana 的 thresholds 着色）；趋势以无轴 sparkline 内联进表格行（Grafana sparkline cell、Tremor SparkChart 模式）；高频导航交给键盘命令面板（cmdk）；主题系统用少量语义角色加 emphasis/muted 两档强度（Primer、Radix），全局缩放只进尺寸类 token（Radix Themes scaling 与 ClinMesh 三档字号同构）。主要风险在 License 与维护状态：Origin UI 仓库主体 AGPL-3.0、Sentry 为 FSL、Tremor 维护放缓，复制组件或引入依赖前必须逐项核对。

## 一、高密度专业工具产品

| 产品 | 一手证据 | License | 可借鉴点 | 证据强度 |
| --- | --- | --- | --- | --- |
| Linear | 官方设计文章（2025-2026 持续发文） | 产品闭源，文章公开 | 边框降噪、注意力分层、dashboard 密度准则 | 强（官方一手，2026 活跃） |
| Grafana | [grafana/grafana][grafana-repo]、[Table 面板文档][grafana-table] | AGPL-3.0 | sparkline 单元格、阈值驱动着色、行高三档、列过滤 | 强（代码与文档一手，活跃） |
| Sentry | [getsentry/sentry][sentry-repo]（LICENSE.md） | FSL-1.1-Apache-2.0 | 高密度 issue 流与键盘优先的产品观感 | 中（仓库一手；界面细节本研究未核验到组件级） |

### Linear

官方 [Now 文章列表][linear-now] 在 2025-2026 年持续输出设计一手资料。[改版幕后][linear-refresh]（2026-03）记录了具体决策：默认调色板从冷蓝灰转向"更脆但更低饱和"的暖灰，并对单个 design token 逐个调整 hue/chroma/lightness；侧栏调暗数档、非激活文字做 muted 处理，让主内容区占据视觉优先级；核心原则是 "Structure should be felt not seen"——边框与分隔线曾"悄悄增殖"，改版时对其做圆角化与降对比，减少分隔线数量；另一条是 "Don't compete for attention you haven't earned"——减少图标用量与尺寸、去掉彩色图标底、tab bar 压缩为 icon-only pills、header 动作统一到可预测位置，目标是保留 "rich density of information" 的同时不显压迫。

[Dashboard 最佳实践][linear-dashboards]（2025-10）给出密度准则：高频使用者（每日/每周查看）的 dashboard 应"更密、更可扫读、为速度优化"，低频查看者则需要更多引导；"Fewer dashboards is generally better"，无明确用途的 dashboard 会堆积随机图表并失去信任；用 "consistent, minimal visuals" 降低认知负担。

对 ClinMesh 的直接价值：密度不是堆更多信息，而是给未赢得注意力的元素降噪——这与 [design.md](../ui/design.md) 的"安静的密度"和"语义色克制"两条原则完全同向，可作为界面评审时的引用基准。

### Grafana

[grafana/grafana][grafana-repo]（AGPL-3.0，77.4k stars，核验日仍活跃）。官方 [Table 面板文档][grafana-table] 核验到：11 种 cell type，含 sparkline、colored background（可整行着色）、gauge、pill、JSON view、data links 等；sparkline 由 "Time series to table transformation" 生成，支持 Hide value、Lines/Bars/Points、线宽、渐变模式与阈值联动（color scheme 设为 "From thresholds (by value)"）；Cell height 提供 Small/Medium/Large 三档；Frozen columns 从左侧冻结；列过滤器支持 Contains 与布尔表达式（如 `$ >= 10 && $ <= 12`）；Cmd/Ctrl+点击实现多列排序。

可借鉴的具体模式：把多次检验的趋势以 sparkline 塞进高密度表格单元格、数值可隐藏、颜色含义由阈值配置派生而非每列手写——这正是检验结果列表需要的组合。License 注意：AGPL-3.0 只作模式参考，不复制代码；Grafana 整体"深色大屏、每面板一图"的观感不属于门诊工作台默认态。

### Sentry

[getsentry/sentry][sentry-repo]（45.6k stars，核验日仍活跃；LICENSE.md 核验为 Functional Source License 1.1、Apache-2.0 future，即 FSL-1.1-Apache-2.0，两年后自动转 Apache-2.0）。其高密度 issue 流、时间排序加状态徽标加行内小趋势图的骨架是社区公认的产品观感，适合作为 ClinMesh"异常中心/接口运维"类页面的观感参照；但本研究未核验到组件级实现，上述界面描述为产品常识级观察，引用时按推断对待。FSL 代码在转换期届满前不满足复制条件，只作模式观察。

## 二、shadcn / Tailwind 生态模板与组件库

| 项目 | 入口 / 仓库 | License | 状态（2026-10 核验） | 可借鉴点 |
| --- | --- | --- | --- | --- |
| shadcn/ui Blocks | [ui.shadcn.com/blocks][shadcn-blocks]、[shadcn-ui/ui][shadcn-ui-repo] | MIT | 125.9k stars，活跃 | dashboard-01 骨架；base/aria/radix 三种底座变体 |
| coss.com/ui（原 Origin UI） | [origin-space/originui][originui-repo] | 仓库 AGPL-3.0；`apps/ui`、`apps/origin` 目录 MIT | 10.7k stars，活跃 | Cal.com 官方设计系统；Base UI + Tailwind 同栈组件 |
| Tweakcn | [jnsahaj/tweakcn][tweakcn-repo] | Apache-2.0 | 10.4k stars，推送至 2026-09 | shadcn CSS 变量主题的可视化比对原型 |
| shadcn-admin | [satnaing/shadcn-admin][shadcn-admin-repo] | MIT | 15.8k stars，推送至 2026-09 | 整套 admin 布局骨架（侧栏分组、设置页、数据表） |
| Tremor | [tremorlabs/tremor][tremor-repo] | Apache-2.0 | 3.7k stars；主仓库最近推送 2025-10，维护放缓 | SparkChart 等行内数据小组件的模式 |

### shadcn/ui Blocks 与 dashboard-01

官方 [Blocks 页][shadcn-blocks] 声明 "Open Source. Free forever"，源码在 [shadcn-ui/ui][shadcn-ui-repo]（MIT）。核验到 dashboard-01 的注册路径为 `apps/v4/registry/bases/{base,aria,radix}/blocks/dashboard-01/`，包含 `data-table.tsx`、`chart-area-interactive.tsx`、`section-cards.tsx`。两个值得注意的事实：一是同一 block 官方提供 Base UI、React Aria、Radix 三种 primitive 底座变体，shadcn 生态已正式支持 Base UI 底座，与 ClinMesh 的技术路线一致；二是 dashboard-01 的 KPI 大卡（大数字加彩色徽标）与渐变填充面积图属于营销级 dashboard 语言，引入时须按 design.md 降级——可取 data-table 与区块组织，不取渐变与大标题卡。

### coss.com/ui（原 Origin UI）

[origin-space/originui][originui-repo] 已更名为 coss.com/ui，定位为 Cal.com 官方设计系统。License 核验结果：仓库默认 AGPL-3.0，README 声明 `apps/origin` 与 `apps/ui` 目录为 MIT；旧 Origin UI 组件以遗留快照保留在 `apps/origin`（Radix 底座，topic 含 tanstack-table），新开发集中在基于 Base UI + Tailwind 的 Particles 组件，正逐步被 cal.com 采用。这是生态中与 ClinMesh 技术栈（Base UI + Tailwind + shadcn 式复制粘贴）最同构的项目，值得持续观察；复制任何文件前必须确认其位于 MIT 目录，避免 AGPL 传染。

### Tweakcn

[jnsahaj/tweakcn][tweakcn-repo]（Apache-2.0，10.4k stars，推送至 2026-09-03；站点 [tweakcn.com][tweakcn-site]）是 shadcn 主题的可视化编辑器，按预设生成 CSS 变量主题。对 ClinMesh 的用途限于工具层面：在调整 `packages/ui/src/styles.css` 的亮/暗 token 时用它做快速比对与原型，值本身仍需人工校准，不直接搬。

### shadcn-admin

[satnaing/shadcn-admin][shadcn-admin-repo]（MIT，15.8k stars，推送至 2026-09-10）提供 Vite + shadcn 的完整 admin 布局。可参考其侧栏分组、设置页与数据表的骨架组织；其行高与字号密度偏松，不满足临床高密度要求，不作为密度基线。

### Tremor

[tremorlabs/tremor][tremor-repo]（Apache-2.0）现已转型为 "Copy & Paste" 的 Tremor Raw（Tailwind + Radix），声明 35+ dashboard 组件；核验到 `src/components/SparkChart/SparkChart.tsx` 及 SparkAreaChart 的 stories 与 spec，这类无轴、单色、低油墨的 sparkline 组件正是为表格行内趋势设计。维护状态需注意：主仓库最近推送为 2025-10-10，核验日已近一年无提交，npm 包 `@tremor/react` 未见弃用声明但活跃度低。结论：按其组件形态自建，不引入 npm 依赖。

## 三、设计观感好的现代医疗/健康科技产品

| 产品 | 一手证据 | License | 状态（2026-10 核验） | 可借鉴点 |
| --- | --- | --- | --- | --- |
| Cal.com | [calcom/cal.com][calcom-repo]（LICENSE 文件头） | MIT（核验日；历史上曾为 AGPL-3.0） | 49.1k stars，活跃 | 预约/日程界面工程；设计系统即 coss.com/ui |
| Medplum（视觉维度） | [medplum/medplum][medplum-repo]、[Provider 演示][medplum-provider]、[Storybook][medplum-storybook] | Apache-2.0 | 2.75k stars，活跃 | PatientSummary 分节折叠摘要、Vitals/Time 组件形态 |
| Canvas Medical | [组织仓库列表][canvas-org]、[docs.canvasmedical.com][canvas-docs] | 组织内多为 MIT/Apache-2.0；核心 EHR 未公开 | 核心闭源 | 仅患者端移动应用与文档；界面模式证据弱 |
| Elation / Healthie / Abridge / OpenEvidence | 仅公开官网 | 闭源 SaaS | 未取得界面证据 | 无（不作为模式来源） |

### Cal.com

[calcom/cal.com][calcom-repo] 的 LICENSE 文件头核验为 MIT License（"Copyright (c) 2020-present Cal.com, Inc."，49.1k stars，核验日仍活跃）。注意该项目历史上长期为 AGPL-3.0，本次以仓库当前 LICENSE 文件为准；后续引用前应重新核验。Cal.com 是预约/日程场景中工程质量与观感俱佳的开源产品，其设计系统即上文 coss.com/ui。可借鉴其日程网格、预约表单流的信息组织与工程实现；其视觉语言偏消费级（大圆角、插画），与 ClinMesh 的冷灰界面气质不同，不搬视觉。

### Medplum（视觉与组件维度）

与 [his-ui-ux-references.md](his-ui-ux-references.md) 分工：该文取 Medplum 的任务、权限、版本与审计模型，本文取其患者摘要与时间线的组件形态。[medplum/medplum][medplum-repo]（Apache-2.0，核验日活跃）的 `@medplum/react` 提供公开演示（[provider.medplum.com][medplum-provider]）与组件 Storybook（[storybook.medplum.com][medplum-storybook]）。源码核验：[PatientSummary][medplum-summary] 将问题列表、过敏、用药、检验、免疫、保险、目标、药房等组织为一屏多节的紧凑摘要，每节用 `CollapsibleSection` 折叠；[VitalsSection 定义][medplum-vitals]显示其由受控 FHIR 查询驱动——按 `Observation` 的 `category: vital-signs` 检索后交给 Vitals 组件渲染；另有 `ResourceTimeline`、`PatientTimeline`、`EncounterTimeline` 等时间线家族渲染资源历史。可借鉴的具体模式：摘要分节、默认折叠、"每节一个受控查询"的数据组织，与 ClinMesh 患者横幅之外的纵向资料页签吻合。

### Canvas Medical（修正后的状态）

[组织仓库列表][canvas-org]核验：github.com/canvas-medical 下 37 个仓库中没有核心 EHR 仓库，[文档站][canvas-docs]是面向开发者的 SDK、FHIR API 与插件文档（含"用 Claude Code 构建插件"章节），不含医生端使用说明。结论：早年"Canvas 开源 EHR"的印象已不成立，EHR 前端闭源，其界面模式证据弱，只作观感定位参考。可见资产中 `mobile-patient-app` 与 `embed` 为 Apache-2.0 的患者端应用，可在未来做患者门户时参考。

### 闭源健康科技产品（证据较弱）

Elation Health、Healthie、Abridge、OpenEvidence 均为闭源 SaaS，产品界面在登录墙后，本次未取得任何一手界面证据；其官网为营销页，最多反映品牌观感。本研究不从中提取组件或布局模式；若后续需要评估，应先取得官方演示环境或公开录像再进入本研究的证据体系。

## 四、临床数据可视化开源实现

| 项目 | 入口 / 仓库 | License | 状态（2026-10 核验） | 对应 ClinMesh 场景 |
| --- | --- | --- | --- | --- |
| RCPCH Digital Growth Charts | [react-component-library][rcpch-react]、[react-client][rcpch-client] | MIT（server 为 AGPL-3.0） | 组件库推送至 2026-10，活跃 | 儿科生长曲线 |
| Medplum Vitals / Timeline | [PatientSummary 源码][medplum-summary] | Apache-2.0 | 活跃 | 患者横幅 vitals、审计时间线 |
| Grafana sparkline cell | [Table 文档][grafana-table] | AGPL-3.0（模式参考） | 文档现行 | 检验结果趋势列 |
| Tremor SparkChart | [SparkChart 源码][tremor-spark] | Apache-2.0 | 维护放缓，按模式自建 | 表格行内趋势 |
| OHIF Viewer | [ohif/viewers][ohif-repo] | MIT | 4.4k stars，活跃 | 放射/病理阅读工作台 |

### RCPCH Digital Growth Charts

英国皇家儿科与儿童健康学院（RCPCH）的数字生长曲线：[rcpch/digital-growth-charts-react-component-library][rcpch-react]（MIT，推送至 2026-10-15）与 [rcpch/digital-growth-charts-react-client][rcpch-client]（MIT，推送至 2026-10-19）活跃维护，配套计算 server 为 AGPL-3.0。这是生长曲线（centile/SDS）这一专科图表中少有的开源、活跃、医疗权威背景的实现。若 ClinMesh 覆盖儿科场景，MIT 组件库可直接评估复用；计算服务是 AGPL 且涉及 API 条款，接口调用与自建需分开评估。

### Medplum Vitals / Timeline（可视化维度）

见第三节。可复用的模式：生命体征分组展示由 `category: vital-signs` 查询驱动、资源历史由 Timeline 家族统一渲染，颜色与布局不侵入数据层。ClinMesh 患者横幅中的生命体征区与审计时间线可对照其信息组织，不复制其 Mantine 底座样式。

### Grafana sparkline cell 与 Tremor SparkChart（模式与实现）

两者合并为一条路径：产品模式取 Grafana——"Time series to table transformation 生成趋势数据 + sparkline 单元格 + 阈值驱动渐变 + Hide value"，把一个指标的历史多次结果压进表格一行；实现参照 Tremor [SparkChart][tremor-spark] 的形态——无坐标轴、单色、低油墨、可嵌入任意行高。ClinMesh 落地时用项目自有图表能力或最小自绘 SVG 实现，并让颜色一律由阈值 token 派生。

### OHIF Viewer

[ohif/viewers][ohif-repo]（MIT，4.4k stars，活跃）。源码核验到 StudyList 相关组件：`platform/ui/src/components/StudyListTable/`、`StudyListFilter/`、`useStudyListQuery` 与 `studyListFilterContract`，加上视口上的 overlay 信息组织，构成"左检查列表 + 过滤契约 + 右阅读区"的读片工作台。ClinMesh 已有放射检查阅读与病理切片会诊 loop，OHIF 是该场景 License 友好（MIT）且生产级的结构参照。

## 五、主题、密度与键盘导航

| 项目 | 入口 / 仓库 | License | 状态（2026-10 核验） | 可借鉴点 |
| --- | --- | --- | --- | --- |
| GitHub Primer | [primer/react][primer-react]、[primer/primitives][primer-primitives]、[Color 文档][primer-color] | MIT | 活跃 | functional 变量体系、emphasis/muted 两档、data-viz 色阶、多 color mode |
| Radix Colors + Themes | [radix-ui/colors][radix-colors]、[radix-ui/themes][radix-themes]、[scaling 源码][radix-scaling] | MIT | Themes 活跃；Colors 推送至 2025-12 | 12 阶色阶亮暗映射；scaling 只进尺寸类 token |
| cmdk | [pacocoursey/cmdk][cmdk-repo] | MIT | 13k stars | ⌘K 命令面板的无样式基础实现 |
| TanStack Table | [TanStack/table][tanstack-repo] | MIT | 28.5k stars，活跃 | headless 高密度表格行为 |
| Base UI | [mui/base-ui][baseui-repo] | MIT | 11.2k stars，活跃 | ClinMesh 现用底座；键盘与焦点管理 |

### GitHub Primer

[primer/react][primer-react]（MIT，3.9k stars，活跃）与 token 仓库 [primer/primitives][primer-primitives]（MIT，活跃）。[Color 文档][primer-color]核验到的体系：functional 变量按 `--fgColor-*`、`--bgColor-*`、`--borderColor-*`、`--shadow-*` 分组；语义角色含 accent、attention、danger、success、done、severe、open、closed 等；背景与边框区分 `-emphasis`（强调）与 `-muted`（柔和）两档强度；`success` 与 `open`、`danger` 与 `closed` 互为别名同值；另有 16 个色相的 `data-<hue>` 数据可视化专用 token；color mode 含 dark_dimmed 等多主题（在 primitives 的 Storybook 中维护）。可借鉴：emphasis/muted 两档直接对应 ClinMesh"选中/强调 vs 辅助"的分层；图表用独立色阶、不占用 success/warning/destructive 语义色的做法值得吸收；注意 Primer 用 attention 而非 warning，命名映射到 ClinMesh token 时不能照抄。

### Radix Colors 与 Radix Themes

[radix-ui/colors][radix-colors]（MIT，12 阶色阶、亮暗自动映射）是"每色一阶、语义由使用处定义"的路线。[radix-ui/themes][radix-themes]（MIT，活跃）核验到 [scaling prop 源码][radix-scaling]：取值为 `'90%'` 至 `'110%'` 五档，注释明确 scaling 是 spacing、font sizes、line heights 等值的乘数——即全局缩放只进尺寸类 token、组件几何随之联动。这与 ClinMesh 三档字号偏好（100% / 112.5% / 125%）同构；ClinMesh 选择"字号比例只进语义字体 token、图标控件间距几何不变"是更保守的合同，两者差异在 [design.md](../ui/design.md) 已定，维持现状即可，本条作为该决策的外部佐证。

### cmdk

[pacocoursey/cmdk][cmdk-repo]（MIT，13k stars）是 Linear、Vercel 系产品普遍采用的 ⌘K 命令面板的无样式基础实现。对 ClinMesh 的用途：全局命令面板承载"跳患者、跳病例、切岗位"的高频跳转，配合 [his-ui-ux-references.md](his-ui-ux-references.md) 的岗位工作台使用；引入时作为侧栏之外的补充入口，不新增第二套导航层级，并遵守 design.md 的焦点与键盘合同。

### TanStack Table

[TanStack/table][tanstack-repo]（MIT，28.5k stars，活跃）是 headless 表格事实标准：排序、筛选、列固定、列可见性、行选择与 shadcn data-table 组合是该生态最成熟的路径。对 ClinMesh 的价值：表格行为与渲染分离，行高、字号、密度全部由 ClinMesh CSS token 控制，避免行为库自带视觉；[shadcn-ui/ui][shadcn-ui-repo] 的 dashboard-01 data-table 即此组合的官方示例。组合 ClinMesh 表格 primitive 时注意保留方向键移动与可见焦点的现有合同。

### Base UI（生态佐证）

[mui/base-ui][baseui-repo]（MIT，11.2k stars，核验日仍活跃）是 ClinMesh 现用 primitive 底座，键盘导航、焦点管理与无障碍由组件层保证。结合第二节的事实——shadcn v4 官方 blocks 已提供 base 底座变体——ClinMesh 的底座选择处于生态主干上，后续可直接消化该生态的表格与命令面板资产。

## 对 ClinMesh 的适配建议

值得吸收（按优先级）：

1. 边框降噪与注意力分层：采纳 Linear "Structure should be felt not seen" 与 "Don't compete for attention you haven't earned" 作为界面评审基准，落地动作是减少 1px 边线数量、降低边框对表面色的对比、非激活元素一律 muted，而不是加粗边框或加重阴影。与 design.md "表面优先于阴影"一致，无合同冲突。
2. 检验趋势内联：检验结果列表中为有历史值的指标增加 sparkline 列（Grafana sparkline cell 模式 + Tremor SparkChart 形态），数值可隐藏、颜色由阈值派生；只对趋势有意义的结果类目启用，避免为装饰而加图。
3. 阈值驱动语义色：把 success/warning/destructive 的触发条件集中在配置与 token 层（Grafana "From thresholds" 的做法），页面组件不写死颜色判断；这与 design.md "业务组件只消费语义 token" 直接互补。
4. 患者摘要分节折叠：Medplum PatientSummary 的"节 + 折叠 + 每节一个受控查询"组织方式，适用于患者横幅之外的纵向资料页签；分节默认收起、异常节可默认展开。
5. ⌘K 命令面板：以 cmdk 为基础的全局跳转入口，承载患者、病例与岗位切换；作为补充入口设计，遵守 Dialog/焦点合同。
6. 主题体系强化：参考 Primer 的 emphasis/muted 两档与独立 data-viz 色阶，在 `packages/ui` token 中为图表准备不占用语义色的色阶；Tweakcn 仅作 token 比对工具。
7. 专科图表复用：儿科场景出现时优先评估 RCPCH 生长曲线 MIT 组件库；放射与病理阅读 loop 评审时以 OHIF 的 StudyList 结构为 MIT 友照。

应拒绝或谨慎（与 design.md"安静密度"合同或 License 边界冲突）：

1. shadcn dashboard-01 的 KPI 大卡与渐变面积图属于营销 dashboard 语言，与"无装饰渐变""无超大仪表盘标题"冲突；只取 data-table 骨架与区块组织。
2. shadcn-admin 密度偏松，不作为密度基线，仅参考布局骨架。
3. coss.com/ui（原 Origin UI）仓库主体为 AGPL-3.0：只可复制 `apps/ui`、`apps/origin` MIT 目录内的文件，复制前逐文件确认归属，否则有传染性风险。
4. Sentry 为 FSL-1.1-Apache-2.0：转换期届满前代码不满足复制条件，只作异常中心页面的模式观察。
5. Grafana 为 AGPL-3.0，且其深色大屏观感不属于门诊默认态：只取表格内联趋势与阈值着色两个模式，不复制代码与整体视觉。
6. Tremor 不引入 npm 依赖：主仓库近一年无推送，SparkChart 按形态自建。
7. Cal.com 视觉偏消费级（大圆角、插画），不搬视觉，只参考其开源工程与设计系统组织。
8. 无一手界面证据的闭源产品（Abridge、OpenEvidence、Elation Health、Healthie、Canvas 核心 EHR）不作为模式来源；后续评估须先取得官方演示或录像证据。

## 来源

以上条目的 License、star 数与活跃度均于 2026-10-19 经 GitHub API 核验；文档与文章经当日网页抓取核验。固定链接如下。

[linear-now]: https://linear.app/now
[linear-refresh]: https://linear.app/now/behind-the-latest-design-refresh
[linear-dashboards]: https://linear.app/now/dashboards-best-practices
[grafana-repo]: https://github.com/grafana/grafana
[grafana-table]: https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/table/
[sentry-repo]: https://github.com/getsentry/sentry
[shadcn-blocks]: https://ui.shadcn.com/blocks
[shadcn-ui-repo]: https://github.com/shadcn-ui/ui
[originui-repo]: https://github.com/origin-space/originui
[tweakcn-repo]: https://github.com/jnsahaj/tweakcn
[tweakcn-site]: https://tweakcn.com
[shadcn-admin-repo]: https://github.com/satnaing/shadcn-admin
[tremor-repo]: https://github.com/tremorlabs/tremor
[tremor-spark]: https://github.com/tremorlabs/tremor/blob/main/src/components/SparkChart/SparkChart.tsx
[calcom-repo]: https://github.com/calcom/cal.com
[medplum-repo]: https://github.com/medplum/medplum
[medplum-provider]: https://provider.medplum.com/
[medplum-storybook]: https://storybook.medplum.com/
[medplum-summary]: https://github.com/medplum/medplum/tree/main/packages/react/src/PatientSummary
[medplum-vitals]: https://github.com/medplum/medplum/blob/main/packages/react/src/PatientSummary/sectionConfigs.tsx
[canvas-org]: https://github.com/orgs/canvas-medical/repositories
[canvas-docs]: https://docs.canvasmedical.com
[rcpch-react]: https://github.com/rcpch/digital-growth-charts-react-component-library
[rcpch-client]: https://github.com/rcpch/digital-growth-charts-react-client
[ohif-repo]: https://github.com/ohif/viewers
[primer-react]: https://github.com/primer/react
[primer-primitives]: https://github.com/primer/primitives
[primer-color]: https://primer.style/foundations/color
[radix-colors]: https://github.com/radix-ui/colors
[radix-themes]: https://github.com/radix-ui/themes
[radix-scaling]: https://github.com/radix-ui/themes/blob/main/packages/radix-ui-themes/src/components/theme.props.tsx
[cmdk-repo]: https://github.com/pacocoursey/cmdk
[tanstack-repo]: https://github.com/TanStack/table
[baseui-repo]: https://github.com/mui/base-ui
