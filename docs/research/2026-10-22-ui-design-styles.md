# UI 设计风格选型研究：全量重构候选方向

研究日期：2026-10-22。用户已确认全部 surface 重构，本文为该决策提供可对比的设计风格选项，覆盖六个方向：临床专业密集型、现代企业级设计体系、极简效率型、AI 原生对话式工作台、医疗行业专属设计体系、视觉趋势类，每类给出视觉特征、设计理念、一手来源与适配度分析。本文不定义 ClinMesh 当前行为，也不构成实施授权；界面 token 与组件的当前合同以 [UI 设计合同](../ui/design.md) 为准。与既有研究分工：[HIS UI/UX 一手参考](his-ui-ux-references.md) 拥有岗位工作流与开源 HIS 模式证据，[现代专业 UI 与临床可视化设计参考](modern-ui-design-references.md) 拥有高密度专业工具与 shadcn 生态资产核验，本文不重复其条目，只在其之上补足"整体风格/设计体系"级别的选型证据。

评估锚点是项目内实际功能：门诊医生、住院、挂号、分诊、收费、药房、检验、管理员、设置九类岗位页面与 DSH 宿主 surface。"方向四"（AI 原生三栏，[规格](../spec/2026-10-19-ai-native-doctor-workspace.md)）是 2026-10-19 已实施的历史决定，在本次全量重构中只作为候选之一，不构成既定基线（用户 2026-10-22 确认）。

核心结论（推断）：六个方向差异主要落在 token 语言（色彩、圆角、密度、字阶）与信息组织方式（对话流 vs 结构化表格），而非 React 技术栈本身；本项目已拥有语义 token 抽象，任何方向的"再定向"成本都主要是重写 token 值与组件视觉细节，而非重写业务组件；真正与项目硬约束冲突的只有"整套运行时组件库"路线（Ant Design v5、Fluent UI React、Material Web Components），它们与单文件产物预算、ShadowRoot 隔离和双 React 版本共存成本高。趋势类（bento、glassmorphism）只适合营销面，不适合作为临床工作台基线。

## 评估锚点与硬约束

以下为适配度评估所依据的项目侧事实，全部来自仓库合同文件：

- 技术栈：shadcn 式复制粘贴组件 + Tailwind + 语义 CSS 变量 token，业务组件只消费语义 token、不写 Tailwind 色阶；token owner 是 `packages/ui/src/styles.css`（[design.md](../ui/design.md)）。
- 双 React 版本：DSH 宿主锁定 React 18.3.1，standalone Web 使用 React 19.2，共享代码只用两版本共有 API（[根 AGENTS.md](../../AGENTS.md)）。
- DSH Surface 经 ShadowRoot portal 挂载，有单文件 lazy-CJS 产物体积预算，宿主拥有侧栏、主题、locale 与 colorScheme 所有权（[医生工作台规格](../spec/2026-10-19-ai-native-doctor-workspace.md) 验收 A6–A8、[Agent 集成合同](../architecture/agent-integration.md)）。
- 中文为主（zh-CN/en-US 双语），提供标准/较大/大三档字号偏好（100% / 112.5% / 125%），全局字距 0，日期金额检验值用等宽数字（[design.md](../ui/design.md)）。
- 九类岗位共享高密度事务底座：处方明细、检验结果、费用账单、队列表格；现行六原则是"安静的密度、表面优先于阴影、动作紧邻对象、渐进展开、工作区连续性、语义色克制"（[design.md](../ui/design.md)）。
- 浅深两主题同等成立，DSH 面随宿主 colorScheme 切换（[design.md](../ui/design.md)）。

适配度评估维度：信息密度需求、医生工作流效率、可访问性、中文排版支持、与 shadcn/Tailwind 技术栈的实现成本、与 DSH 宿主共存、双 React 版本约束。

## 一、临床专业密集型

### 代表：Ant Design（国内中后台惯例）

一手来源为 ant.design 设计规范四个页面，均于 2026-10-22 抓取核验（[设计介绍][ant-introduce-cn]、[设计价值观][ant-values-cn]、[字体][ant-font-cn]、[色彩][ant-colors-cn]）。

理念事实：Ant Design 基于「自然」「确定性」「意义感」「生长性」四大设计价值观；「确定性」称"界面是用户与系统交互的媒介，是手段而非目的"，要求设计者"保持克制"与模块化；「意义感」要求"产品设计应充分站在工作视角，促成用户使命的达成"，"让用户持续沉浸在工作的心流中"；定位自述为"蚂蚁集团的企业级产品是一个庞大且复杂的系统，数量多且功能复杂，而且变动和并发频繁"。

视觉特征事实：主字号 14px、行高 22px（"从原先的 12 上升至 14"，依据 50cm 阅读距离与 0.3 阅读角度），字重只用 regular/medium（400/500）加 semibold（600）；中后台数字纵向对比推荐 `font-variant-numeric: tabular-nums`；正文与背景保持 7:1 以上 AAA 对比度，一级文本 `#000000E0`/`#FFFFFFD9`；色彩体系分系统级（120 色基础色板、中性色板、数据可视化色板）与产品级（品牌色/功能色/中性色），品牌主色为拂晓蓝 `#1677ff`，"我们对于色彩的态度是克制的"。

中文排版事实与推断：v5 字体栈为系统字体优先（`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ...`），页面未显式声明 PingFang SC / Microsoft YaHei 等中文字体（事实）；中文字形在中文系统上回落到平台默认中文字体（推断）。字阶与 tabular-nums 规则本身对中文数字混排友好（推断）。

无障碍事实：设计介绍与价值观页面正文均未出现无障碍/可达性内容（核验到的事实）；色彩页要求中性色结合 WCAG 2.0 标准（事实）。组件级 a11y 能力未在本次核验范围（未核实）。

同类参照：国内 HIS 的桌面高密度形态（页签矩阵、紧凑表格、行内动作）在 [OpenHIS 研究](his-ui-ux-references.md) 已有源码级核验；检验高吞吐网格模式见 OpenELIS（同文）。Epic 式高密度界面没有公开一手来源，本文不作为证据（未核实）。

适配度（推断）：信息密度与工作流效率是该体系的最强项——14px 基准、紧凑表格、tabular-nums、功能色纪律与九类岗位的高密度事务底座直接同构，检验、收费、药房等批处理页面受益最大；中文排版是其原生场景，风险最低。但适配本项目有两个硬伤：一是整套运行时组件库（cssinjs 主题与自有组件实现）与 shadcn 复制粘贴模式、单文件产物预算、ShadowRoot 隔离冲突，引入成本与体积风险高；二是其设计介绍页对无障碍的空白与本项目 a11y 合同（可访问名称、焦点 ring、键盘导航）需要靠自检补足。可行采纳方式是"借规范不借库"：把 14px 密度档、tabular-nums、功能色纪律吸收进本项目 token，而不引入 antd 依赖。

## 二、现代企业级设计体系

### IBM Carbon

一手来源为 carbondesignsystem.com 三个页面，2026-10-22 核验（[首页][carbon-home]、[Carbon for AI][carbon-ai]、[排版][carbon-typography]）。

定位与视觉事实："Carbon is IBM's enterprise-ready, open-source design system, shaped by the IBM Design Language"；foundations 覆盖 2x Grid、Color、Icons、Pictograms、Motion、Spacing、Themes、Typography；字体为开源 IBM Plex（Sans/Serif/Mono），建议 Light/Regular/SemiBold；字阶由单一公式生成（`y0=12px` 起，12–92px），并区分"productive type set"（固定标题尺寸）与"expressive"（响应式断点变化）两套——productive/expressive 双态是 Carbon 区分工作界面与营销界面的核心机制；排版页要求"legibility and accessibility as paramount concerns"，正文保持中性色、主色只留给动作。

无障碍与中文事实：站内有无障碍 foundations 分节，Carbon for AI 组件声明经无障碍测试；但首页与排版页均未出现具体 WCAG 条款声明（未核实）；IBM Plex 家族对简体中文的官方支持未在排版页提及（未核实），采用时需自带中文回落。

适配度（推断）：Carbon 的"productive/expressive 双态"与本项目"工作台安静密度 + 演示面可稍有表现力"的需求高度同构，2x Grid 与数据表传统对检验、收费、住院的密集表格友好；开源、无绑定运行时（token + 复制组件）路线与 shadcn 模式兼容性中上。成本在于其 token 词汇（`*-60` 色阶、2x 间距）需要映射到本项目语义 token；双主题、ShadowRoot 下需要自建映射层（推断）；中文回落策略必须补齐（见上）。

### Microsoft Fluent 2（含 Windows 官方设计文档）

一手来源：Fluent 2 官网首页（[fluent2.microsoft.design][fluent2]）与 Microsoft Learn 的 [Windows 设计原则][win-principles]，2026-10-22 核验；Fluent 2 官网 principles 子页为 404（事实）。

事实：Fluent 2 覆盖 Web（React）/iOS/Android/Windows 四平台，提供 Figma UI kit 与无障碍插件（Focus Order、Color Contrast Checker——"adhering to Web Content Accessibility Guideline standards"）；官网首页无 AI/Copilot 设计指引分节（事实，Copilot 指引未核实）。Windows 11 设计原则为五条：Effortless、Calm（"softer and decluttered; it fades into the background"）、Personal、Familiar、Complete + Coherent；signature experiences 覆盖 Color（"calming foundation"）、Elevation and layering、Iconography（"softer geometry"）、Materials（亚克力等半透明材质）、Geometry（圆角）、Typography（Segoe UI Variable）、Motion。

适配度（推断）：Fluent 的 Calm/cluttered-free 与本项目"安静的密度"同向，Materials/几何语言偏消费与桌面 OS 气质，对临床密度无直接增益；Fluent UI React 是运行时组件库，与单文件产物、ShadowRoot、双 React 约束冲突（成本高，推断）；其设计原则（尤其 Calm、Familiar）与"色彩作为平静底色、仅强调必要项"可作为评审话术吸收，不必引入体系本身。中文回落（Windows 上为系统雅黑链）属于平台默认（推断，未核实页面）。

### Google Material 3

一手来源情况：m3.material.io 为 JS 渲染站点，两次抓取（foundations 与 adaptive-design 子页）均只有页面标题、无正文（事实，正文未核实）；改为核验 Google 官方仓库 [material-components/material-web][material-web] README（2026-10-22）。

事实：`@material/web` 是 Material 3 的 Web 组件实现，"helps build beautiful and accessible web applications"，含 tokens/color/typography 目录与 typescale 类；关键状态是 README 自述 **"MWC is in maintenance mode pending new maintainers"**（等待新维护者，处于维护模式），并建议 Angular 用户改用 Angular Material；Apache-2.0，约 11.4k stars。

适配度（推断）：M3 的动态色（tonal palettes）与本项目"两主题同等成立"方向一致，但其 Web 实现处于维护模式，且 Material 的 Web 组件形态（custom elements）与 shadcn/Tailwind 复制粘贴栈、单文件产物预算整合成本高；M3 官网细则（密度、自适应、中文排版）本次未核实。结论：不作为基线候选；其"语义色由 tonal 系统派生"的思想可参考，落地路径仍是本项目自有 token（推断）。

## 三、极简效率型

### Linear

[现代专业 UI 研究](modern-ui-design-references.md) 已于 2026-10-19 核验 Linear 官方设计文章：核心原则 "Structure should be felt not seen"（边框降噪）与 "Don't compete for attention you haven't earned"（图标与彩色元素克制），暖灰低饱和默认调色板、侧栏调暗、密度准则（高频使用者的界面应"更密、更可扫读、为速度优化"）。这些与本项目现行六原则完全同向（该文已有结论，本文不重复展开）。

### Vercel Geist

一手来源 [vercel.com/geist][geist]（2026-10-22）。事实：Geist 是 "Vercel's design system for building consistent web experiences"，"provides the colors, typography, materials, layout, and React components behind Vercel's products"；色彩是 "a high contrast, accessible color system"；字体 Geist Sans 与 Geist Mono；"grid 是 Vercel 美学的核心"；组件以 `@vercel/geistcn` 包发布；页面未提密度（未核实）。

适配度（推断）：Geist 是"高对比、少装饰、网格驱动"的开发者工具气质，与队列、异常中心、管理员/设置页的气质匹配；Geist Sans 无中文字形，中文回落必须自定（推断）；作为第三方包引入与单文件产物预算冲突，采纳方式只能是 token/形态参照（如高对比灰阶、8px 网格），与 Linear 同路。

### shadcn/ui 默认风格

一手来源 [ui.shadcn.com][shadcn] 与 [theming 文档][shadcn-theming]（2026-10-22）。事实：定位是 "The Foundation for your Design System"、"Composable, accessible components with thoughtful defaults"、"Build your own component library with code you can customize, extend, and make your own"；主题用 CSS 变量与语义 token（`background/foreground/primary/ring/chart-1..5/sidebar*` 等），"Dark mode works by overriding the same tokens inside a `.dark` selector"，圆角由单一 `--radius` 派生整档；"We use semantic background and foreground pairs"；Tailwind v4 `@theme inline` 映射；官方统计 126k stars。

适配度（推断）：这是本项目的现状栈——语义 token、双主题、复制粘贴所有权模式与 design.md 合同一一对应；"默认风格"其实是"无风格基座"，风格差异完全由 token 值决定，意味着全量重构可以选择任何视觉方向而不更换技术栈。默认观感（8px 圆角档、灰阶、标准密度）偏营销页松散，需按 design.md 的 6/8px 与 13px 合同收紧（推断，现行合同已如此）。

### Radix Themes

一手来源 [radix-ui.com/themes][radix-themes] 与 [Theme 文档][radix-theme-doc]（2026-10-22），scaling 行为另有 2026-10-19 源码级核验（[现代专业 UI 研究](modern-ui-design-references.md)）。事实：定位 "An open source component library optimized for fast development, easy maintenance, and accessibility"、"Just import and go—no configuration required"；Theme 提供 `appearance`（inherit/light/dark）、`accentColor`（默认 indigo）、`grayColor`（auto）、`radius`（none/small/medium/large/full）、`scaling`（90%–110% 五档）主题旋钮；页面无 WAI-ARIA 细节（事实）。

适配度（推断）：Themes 的五档 scaling 与本项目三档字号偏好同构（既有研究已指出），但它是运行时组件库，引入即与复制粘贴所有权和产物预算冲突；有价值的是它的可调维度清单（accent/gray 分离、radius 档、scaling 档）——可作为本项目 token 增强的检查表（例如 accent 与 gray 解耦、radius 单源派生已有）。注意其默认 accent 恰为 indigo，与现行独立 Web 靛紫主色撞色，属巧合而非依据（推断）。

小结（推断）：极简效率型是六个方向里与现栈成本最低、与"安静的密度"合同最兼容的一类；差距只在"视觉记忆点"弱——需要靠 token 定调（如靛紫 accent、柔光反馈）补足产品感，这正是现行"方向四"的做法，也说明该类别与 AI 原生类别可以叠加而非互斥。

## 四、AI 原生对话式工作台

### Carbon for AI（当前最完整的官方 AI 界面指引）

一手来源 [Carbon for AI][carbon-ai]（2026-10-22）。事实："Carbon for AI extends the Carbon Design System with a distinct visual and behavioral identity for AI experiences in IBM products"；核心机制包括：

- AI label（前身 AI slug）："the primary indicator to communicate that AI is present"，并作为解释内容的触发器。
- 可解释性："Transparency of AI presence is key to user trust"；"Integrate explainability into the overall user workflow"，从摘要级解释起步（popover）。
- 人工覆盖与回退：用户改写 AI 内容后组件回到默认变体，并提供 "revert to AI" 按钮。
- 纪律："Don't use the Carbon for AI styling as decoration"——AI 视觉只用于标识 AI 参与，不作为装饰。
- 柔光约束：AI glow "Light spread is limited for readability"，"subtle to ensure accessible contrast with UI content"。
- 工程形态：AI token 并入主主题（"Using the AI tokens does not require a different theme"），含 `@carbon/ai-chat` 包与 React/Web Components storybook。

### Vercel AI Elements（shadcn 生态的 AI 组件）

一手来源 [elements.ai-sdk.dev][ai-elements]（2026-10-22）。事实："A component library and custom registry built on top of shadcn/ui to help you build AI-native applications faster"；组件覆盖 Conversation、Message、Reasoning、Tool、Sources、Task、Plan、Confirmation、Inline Citation 等；"Built on shadcn/ui conventions. Your existing theme and setup apply automatically"；与 AI SDK 深度集成（streaming、状态、类型）。关键状态：页面顶部声明 **"AI Elements is moving to shadcn/ui. This project will be deprecated at the end of November 2026."**（迁移回 shadcn/ui，2026-11 底弃用独立项目）；页面无无障碍声明（事实）。

适配度（推断）：AI Elements 的组件分类（会话、推理、工具调用、引用、任务）与本项目 Agent 反馈语言（`agent-workspace-glow`、`agent-action-feedback`、`agent-review`）和 DSH 原生助手面对的问题域重合；其 shadcn 底座使复制级引入成本最低（无运行时依赖），2026-11 并入 shadcn/ui 后来源更顺。风险：面向 AI SDK 的流式状态约定需要适配本项目确定性服务数据源（建议栈数据不来自会话，[design.md](../ui/design.md)）；无障碍契约未声明，需按本项目合同自检。

### 项目内既有 AI 原生实践

事实：现行实现已包含一套 AI 原生语言——医生工作台三栏（队列/病例/建议栈）、DSH 面会话列与队列折叠卡片、`--clinmesh-glow` 环绕柔光、建议栈数据来自确定性服务（[规格](../spec/2026-10-19-ai-native-doctor-workspace.md) A1–A9、[design.md](../ui/design.md)）。这些是已验收事实；全量重构可以延续、收敛或替换它（用户 2026-10-22 已确认不作为既定基线）。

chat-first 界面模式（Claude、ChatGPT、Linear 会话面板等）的形态为产品常识级观察，无一手设计文档来源，本文不作为证据（未核实）。

适配度（推断）：AI 原生不是独立于前五类的"视觉皮肤"，而是信息组织方式：它决定"助手会话、建议、解释"是否成为一级布局对象。对本项目的真实取舍在于两个子问题——(1) 布局层面：对话列/建议栈是否在全量重构后仍是一级结构；(2) 语义层面：AI 参与的标识与解释语言采用 Carbon for AI 的模式（AI label + 摘要解释 + 覆盖回退，纪律是不装饰）还是现行 glow 语言。Carbon 的"AI 样式不当装饰用"与本项目"语义色克制"兼容；glow 在两主题与宿主 colorScheme 下的对比度表现需要逐个验证（推断）。

## 五、医疗行业专属设计体系（NHS）

一手来源 [NHS digital service manual — Design system][nhs-ds] 与 [NHS design principles][nhs-principles]（2026-10-22）。

事实：NHS 设计系统的目标是 "Build consistent, accessible NHS services for the public and staff"，提供 styles、components、patterns 及随附代码，内容以 Open Government Licence v3.0 发布；十条设计原则（2023-04 更新，源自 NHS Constitution）包括：Put people at the heart of everything you do（"Design with compassion"）、Design for the outcome、Be inclusive（"NHS services are for everyone"）、Design for context（"Don't just design your part of a service"）、Design for trust（"reliable and secure"）、Test your assumptions、Make, learn, iterate、Do the hard work to make it simple（"Do not push complexity onto the people using what you are designing"）、Make things open、Design to protect the environment。NHS Blue 色值与 Frutiger/health 字体细节不在本次抓取的页面正文（未核实）。

适配度（推断）：NHS 体系面向英国公共医疗服务的内容型页面（单列正文流、大字号、表单式事务），与中国 HIS 的多岗位高密度事务界面结构不同，布局与组件不可直接套用；中文排版完全不覆盖（事实层面其服务对象为英文用户）。它的真实价值是三层：把"无障碍是硬性服务标准而非加分项"作为合同姿态（与本项目 a11y 合同同向）；"Do the hard work to make it simple"与"Design for context"可直接作为九类岗位横切评审的检查问题（异常恢复、跨岗位衔接）；医疗语气的信任表达（可靠、安全、不花哨）与"语义色克制"互相印证。结论：作为原则与验收文化的参照系，不作为视觉基线候选。

## 六、视觉趋势类（趋势参考，不建议作为基线）

### bento grid

事实：bentogrids.com 是该趋势的汇总画廊，页面仅标题无正文（2026-10-22 抓取，[bentogrids][bentogrids]），其定义（大小不一卡片拼贴、源自 Apple 营销页语言）属产品常识级观察，未取得一手文字来源（未核实）。

### glassmorphism / 半透明材质

事实：Nielsen Norman Group 的 glassmorphism 评述文章被当前网络策略拦截，未能核验（未核实）；Apple HIG Materials 页三次抓取均网络中断（未核实）。可用的权威锚点是 WCAG 2.1 SC 1.4.3（[Understanding 文档][wcag-contrast]，2026-10-22 核验）：正文对比至少 4.5:1、大字号至少 3:1，大字号定义为 18pt（约 24px）或 14pt bold（约 18.5px），CJK 字体取等效尺寸；"e.g., 4.499:1 would not meet the 4.5:1 threshold"（无四舍五入）；该标准的意图是让低视力用户无需辅助技术即可阅读。

风险与适配度（推断）：半透明/模糊材质的文本背景不可控，叠加本项目两主题与 DSH 宿主 colorScheme 所有权后，每个叠放层都要按 WCAG 阈值逐一验证，维护面大；`backdrop-filter` 在 ShadowRoot 与大表面积下的渲染开销对高密度表格界面是负资产（推断）；bento 拼贴的信息组织以展示优先，会降低检验/收费/队列等事务页的扫读密度。结论：这两类语言只适合登录页、演示门面、营销与发布物等非事务面；进入工作台必须降级为"表面 + 边线"语言，与现行"表面优先于阴影"合同一致。Carbon for AI 的 glow 约束（柔光必须受可读性限制）可作为任何"AI 感柔光"元素的官方先例参照。

## 风格对比表

| 方向 | 视觉特征摘要 | 信息密度 | 工作流效率 | 可访问性 | 中文排版 | shadcn/Tailwind 实现成本 | DSH 共存 | 双 React 约束 | 总体适配（推断） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 临床专业密集型（Ant Design 规范） | 14px 密度档、紧凑表格、tabular-nums、拂晓蓝功能色 | 高 | 高（事务型） | 规范页未提 a11y；色彩页引 WCAG 2.0 | 原生场景，风险最低 | 借规范不借库：低；引运行时库：高（冲突） | 引库冲突；token 吸收无冲突 | 引库增加运行时包袱 | 高（以 token 吸收方式） |
| IBM Carbon | IBM Plex、2x Grid、productive/expressive 双态、克制用色 | 高 | 高 | 有专门 foundations 与 AI a11y 声明 | Plex 中文支持未核实，需回落 | 中（token 词汇映射） | 无运行时则中；引组件库则高 | 取决于是否引运行时 | 中高 |
| Microsoft Fluent 2 / Windows | Calm、materials/半透明、圆角几何、Segoe UI Variable | 中 | 中 | a11y 插件与 Windows a11y 文档完备 | 平台默认中文回落（推断） | 高（运行时库冲突） | 高成本 | 引库冲突 | 低中（原则可借） |
| Google Material 3 | 动态 tonal 色、大圆角、typescale | 中 | 中 | 有 a11y 主张（web README）；官网细则未核实 | 未核实 | 高（维护模式的 web 组件） | 高成本 | 组件形态风险 | 低（思想可借） |
| 极简效率型（Linear/Geist/shadcn/Radix） | 高对比灰阶、边框降噪、少装饰、8px 网格 | 中高（可调） | 高（键盘/速度导向） | shadcn 声明 accessible；底座（Base UI/Radix）承载 a11y | 无中文字形，回落自定（推断） | 最低（现栈本身） | 最好（token 级共存） | 无新运行时 | 最高（可叠加 accent 定调） |
| AI 原生对话式（Carbon for AI / AI Elements） | AI 标识、解释弹层、覆盖回退、会话/建议布局对象 | 布局对象新增，密度依赖底座 | 视 AI 参与深度 | Carbon 明确约束；AI Elements 无 a11y 声明 | 随底座 | shadcn 底座复制级成本低 | 需随宿主主题验证 glow/对比 | 复制组件无运行时 | 高（与极简效率型叠加） |
| 医疗专属（NHS） | 内容流、单列、服务语气 | 低（面向内容页） | 中（事务表单弱于 HIS） | 服务级硬标准 | 不覆盖英文以外 | 原则可借，组件不适用 | 无冲突（不引入） | 无影响 | 原则参照，非视觉候选 |
| 趋势类（bento/glassmorphism） | 卡片拼贴、半透明模糊 | 低（展示优先） | 低（事务面负资产） | 与 WCAG 4.5:1 阈值冲突风险高（事实阈值+推断） | 不针对中文 | 低成本但低收益 | 模糊层与 ShadowRoot 叠加需逐层验证 | 无影响 | 仅限营销/登录/演示门面 |

## 开放问题（供决策，非本文结论）

1. 基线路线：在 shadcn 语义 token 之上做"方向重定调"（改 token 值与组件细节，保留九类岗位骨架），还是为某类岗位换整套信息组织？前者成本最低且不违反已验收合同；后者需要重新走需求确认。
2. 密度档位：是否把"14px 密度档"（Ant Design 基准）与现行 13px 基准合并出正式紧凑档，用于检验、收费、药房等批处理页面？现行合同 13px/1.5 是全岗位统一档（[design.md](../ui/design.md)）。
3. AI 呈现语言：采用 Carbon for AI 的模式集（AI label、摘要解释弹层、覆盖回退、"不当装饰用"纪律），还是延续现行 glow 语言，或两者组合（glow 限标识、解释走弹层）？glow 在双主题与宿主 colorScheme 下的对比度需逐个实测。
4. AI 组件资产：是否引入 shadcn/ui 即将收编的 AI Elements 组件（复制级、无运行时），还是按本项目 `agent-*` 反馈合同自建？后者维护成本高但与确定性服务数据源与 DSH 原生助手边界更贴。
5. 视觉记忆点来源：产品感（区别于"后台工具"）从哪里来——accent 定调（如靛紫）、柔光反馈、字体档，还是演示门面单独设计（bento 仅限该层）？
6. 中文与数字排版：是否采纳 tabular-nums 之外更明确的中文排版合同（字阶档数、字重只用 400/500/600、数字字体策略），并把三档字号偏好与密度档解耦？

## 2026-10-23 增补：ui-ux-pro-max 本地库校验

本机 2026-10-23 加装 ui-ux-pro-max skill（本地 CSV 库：styles/colors/typography/products 等，离线检索，无网络请求）。当日以其检索脚本对候选方向做交叉核验；证据范围仅限该库内置数据，不构成外部一手来源。事实均来自库返回条目，推断已标注。

- 库的医疗画像面向 C 端健康/患者场景：以 "healthcare clinical workstation professional dashboard" 生成设计系统时，推荐落在 Neumorphism（Best For 标注 health/wellness、minimal interaction UIs，a11y 风险 high）与 Hero+Testimonials 落地页模式，与临床专业工作台的高密度事务需求错位，不直接采纳。
- 库内医疗配色两套可作浅色收敛档的语义色基座：Healthcare App（青 `#0891B2` + 健康绿 `#059669`，"Calm cyan + health green"）与 Patient Portal / Health Records（临床蓝 `#0284C7` + 绿 + 警示红）。
- 本地原型页（docs/ui/references/2026-10-22-ui-direction-comparison.html，不进版本库）第二轴的四个风格极中三个有库内同源风格：暗色驾驶舱 ↔ dark-mode-oled（深黑 `#000000`/`#121212`、霓虹点缀克制、文字对比要求 7:1+、辉光最小化）；新粗野 ↔ brutalism（2–4px 可见描边、0 圆角、无过渡、700+ 字重，原型为其收敛 lite 版）；柔和消费级 ↔ claymorphism（16–24px 圆角、3–4px 厚描边、双层阴影，库内别名即 "Claymorphism (for patients)"）与 neumorphism。暖纸编辑部在库内无对应风格（检索 editorial serif 仅命中 minimalism-and-swiss-style），选它无库内规则兜底，排版纪律需自建（推断）。
- 字体对：Dashboard Data（Fira Code + Fira Sans）支撑"数据用等宽、标签用无衬线"的分工；Legal Professional（EB Garamond + Lato）对应编辑部路线的权威衬线气质；Atkinson Hyperlegible 为医疗可读性优先选项，仅覆盖拉丁字符，中文仍回落系统字体（推断）。
- 库的反模式清单含 "AI purple/pink gradients"（医疗场景避免项）：AI 靛紫作为全产品视觉基座被库标记为避免；作为窄域 AI 动作标识（Carbon for AI 式纪律）不受此条约束（推断）。
- 库默认图标库为 Phosphor；本项目按仓库规则沿用 lucide-react，不因 skill 更换图标体系。

## 证据范围与未核实项

核验方式：2026-10-22 以 WebFetch 直读官方页面，逐条记录抓取结果；GitHub 仓库事实以当日页面内容为准。本机已有研究（2026-10-19 核验）经交叉引用复用，未重复抓取。2026-10-23 增补节来自 ui-ux-pro-max 本地库离线检索，范围见该节。

抓取失败或内容不足的来源，均已在上文如实标注，未据此编造结论：

- m3.material.io（foundations 与 adaptive-design 子页）为 JS 渲染，正文不可读；Material 3 细则以 material-web README 为准。
- NN/g glassmorphism 文章被网络策略拦截（域名验证失败）；Apple HIG Materials 页三次连接中断。
- fluent2.microsoft.design 的 principles 子页 404；官网首页未含视觉语言细则，Fluent 2 细节改以 Microsoft Learn Windows 设计文档佐证。
- ant.design 的 global-style-cn 页面 404，改用 font-cn 与 colors-cn。
- bentogrids.com 仅有画廊标题，无定义正文。
- 未核实项汇总：Carbon WCAG 具体条款与 IBM Plex 简体中文支持；Fluent 2 组件库在 ShadowRoot/双 React 下的实际表现；M3 官网细则（密度、自适应、中文）；NHS Blue 色值与字体细节；Geist/Linear 密度细则（后者以既有研究 2026-10-19 核验为准）；bento grid 的一手定义；Epic 式界面（无公开一手来源）。

本文引用的既有仓库研究：[HIS UI/UX 一手参考](his-ui-ux-references.md)（OpenHIS/OpenELIS 高密度模式）、[现代专业 UI 与临床可视化设计参考](modern-ui-design-references.md)（Linear 文章、Radix scaling、shadcn 生态 License 核验）。

## 来源

[ant-introduce-cn]: https://ant.design/docs/spec/introduce-cn
[ant-values-cn]: https://ant.design/docs/spec/values-cn
[ant-font-cn]: https://ant.design/docs/spec/font-cn
[ant-colors-cn]: https://ant.design/docs/spec/colors-cn
[carbon-home]: https://www.carbondesignsystem.com/
[carbon-ai]: https://www.carbondesignsystem.com/building-blocks/foundations/carbon-for-ai
[carbon-typography]: https://www.carbondesignsystem.com/guidelines/typography/overview
[fluent2]: https://fluent2.microsoft.design/
[win-principles]: https://learn.microsoft.com/en-us/windows/apps/design/design-principles
[material-web]: https://github.com/material-components/material-web
[geist]: https://vercel.com/geist
[shadcn]: https://ui.shadcn.com/
[shadcn-theming]: https://ui.shadcn.com/docs/theming
[radix-themes]: https://www.radix-ui.com/themes
[radix-theme-doc]: https://www.radix-ui.com/themes/docs/components/theme
[ai-elements]: https://elements.ai-sdk.dev/overview
[nhs-ds]: https://service-manual.nhs.uk/design-system
[nhs-principles]: https://service-manual.nhs.uk/design-system/design-principles
[wcag-contrast]: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
[bentogrids]: https://bentogrids.com/
