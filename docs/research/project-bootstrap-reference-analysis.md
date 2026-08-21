# ClinMesh 项目初始化参考分析

## 研究范围与结论

本文基于两个本地第一方源码仓库：DeepSeek Harness（下称 DSH，`/home/caii/agents/deepseek-harness`）和 Multica（`references/multica`）。目标不是复制成熟项目，而是识别可迁移的工程机制、必须剥离的产品专属内容，以及适合 ClinMesh 空项目的最小起点。

核心结论：ClinMesh 应复用 DSH 的“规则分层、文档单一来源、显式发布清单、生成投影可丢弃、关键约束脚本化”思想，以及 Multica 的“pnpm/Turbo monorepo、Web 与 desktop 共用 headless 业务层和业务视图、mobile 仅共享稳定协议与纯逻辑”边界；不应复制 DSH 的 Agent runtime、Cordis、会话/工具/SDK 专属规则和全量文档门禁，也不应在空项目阶段预建 Multica 已经因产品规模而形成的大量领域包、桌面多标签协调器或 mobile 实时缓存镜像。

## 一、DSH：Agent 工程约束及文档基础设施

### 1. AGENTS 层级是一套就近收窄的规则树

DSH 根 `AGENTS.md` 只放每次工作都需进入上下文的长期命令、仓库地图、通用约束和验证入口，并把专门规则下放到子树。实际层级包括根、`packages/AGENTS.md`、`packages/web/AGENTS.md`、`scripts/AGENTS.md`、`docs/AGENTS.md`、`website/AGENTS.md`、`.agents/notes/AGENTS.md` 等（DSH：`AGENTS.md`，尤其 “Repository layout”“Conventions”“Type safety and documentation”；`docs/AGENTS.md` 的 “The tier taxonomy”）。

这不是简单重复：`docs/AGENTS.md` 明确要求根规则只保留一至三行 standing orders，子树规则不得复述根规则；详细机制放到其所有者文档并链接。根 `AGENTS.md` 还说明根、`packages/`、`examples/` 的 `CLAUDE.md` 是 `AGENTS.md` 符号链接，应编辑真实文件（DSH：`AGENTS.md` 的 “Editing these instructions”）。

**应复用机制**：ClinMesh 先有简短根 `AGENTS.md`，只有真正出现独特错误模式或工具链差异时才在 `apps/mobile/`、`docs/` 等子树新增局部规则。规则需要单一归属并用相对链接引用，不在多个层级复制。

**不应复制**：DSH 根文件中 “everything is a plugin”、Cordis effect/event、Service Definition/Provider/Consumer、model-visible logging、session format、Typert、agent-loop、E2B、sandbox、SDK 双投影、模型 snapshot 等均是 DSH 产品与架构专属约束（DSH：`AGENTS.md` 的 “Conventions”）。ClinMesh 初始化时应全部删除，而不是改名保留。

### 2. Skills 是可调用工作流，不是产品规范存放处

DSH 把技能放在 `.agents/skills/<name>/SKILL.md`。`docs/AGENTS.md` 把它定义为“可复用工作流和专门决策标准”，并明确产品/runtime contract 应留在文档或源码。现有例子包括 `dsh-doc-standards`、`dsh-doc-site-sync`、`dsh-prose-standard`、`dsh-pre-push-checks`、`dsh-code-review`、`dsh-archive-agent-notes`（DSH：`.agents/skills/**/SKILL.md`；`docs/AGENTS.md` 的 tier 表）。

Skill 文件通过 YAML frontmatter 的 `name`、`description` 声明触发条件；`dsh-doc-site-sync` 再链接规则所有者和源码，而不复制所有规范。其可执行性还由 `verify-skill-invocation-metadata` 纳入 `doc-sync`（DSH：`.agents/skills/dsh-doc-site-sync/SKILL.md`；`package.json` 脚本；`scripts/run-gates.ts` 的 `docSyncLeafGates`）。

**应复用机制**：只在一个过程会反复执行、包含多步检查、且通用 `AGENTS.md` 无法简洁表达时新增 skill。Skill 应是“何时调用、读哪些权威来源、执行什么、如何验证”，不能成为业务规则的唯一归档。

**最小目标**：空项目阶段不预建 DSH 的技能全集。最多保留一个初始化/验证 skill；待出现真实流程后再增加 docs sync、release 或 mobile parity 等技能。

### 3. Agent Notes 是有生命周期和分类的决策记录

DSH 的 Agent Notes 路径编码两个维度：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`。生命周期是 `proposed`、`implemented`、`rejected`；分类是闭集 `feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`（DSH：`.agents/notes/README.md` 的 “Layout and naming”“Classification”）。

格式也随生命周期变化：提案包含 Problem/Proposal/Alternatives/Acceptance criteria/Risks；已实现记录改写成当前时态的 Problem/Decision/Alternatives/Consequences。每条 note 有英文、中文和 `.i18n.yaml` 配对；已归档 note 进入冻结树，专用脚本验证 triplet 和内容 seal（DSH：`.agents/notes/README.md` 的 “The file format”“Archiving and deletion”；`.agents/notes/AGENTS.md`）。`verify-agent-note-classification`、`verify-agent-note-format`、`verify-archived-agent-notes` 均在文档总门禁中执行（DSH：`scripts/run-gates.ts::docSyncLeafGates`）。

**应复用机制**：保留“重要决策写 ADR/decision note、记录被放弃方案与后果、路径或元数据表达状态、当前权威与历史归档分开”的思想。

**暂不复用的复杂度**：空 ClinMesh 不需要强制每个非平凡改动都产出三文件双语 note，也不需要 proposed/implemented/rejected/archived 全生命周期、冻结哈希 manifest、自动 supersession。最小做法可先采用 `docs/decisions/YYYY-MM-DD-topic.md`，固定 `Status/Context/Decision/Alternatives/Consequences`；当决策量和多人并发实际增长后再引入状态目录和验证器。

### 4. 文档分类先确定“归属和用途”，再决定形式

DSH 要求人类文档先分 tutorial 或 reference：tutorial 是按先决知识排序、通向结果的路径；reference 是按范围查询当前行为。事实只在一个 tier 有完整解释，其他位置链接其所有者（DSH：`docs/AGENTS.md` 的 “Document structure”“The tier taxonomy”）。

其分类很细：

- 根/子树 `AGENTS.md`：长期工作指令。
- `architecture.md`：系统组成、核心流程和扩展点地图。
- `subsystems/`：子系统类型与语义参考。
- Agent Notes：决策理由、替代方案、后果。
- `postmortem/`：事故叙事。
- `cookbook/`：编号步骤和验证的操作教程。
- `user/`：对外产品指南。
- package README：包级契约、配置、语义、限制和扩展点。
- generated catalogs：生成器拥有的穷举参考，禁止手改英文源。

此外，`verify-doc-budgets`、`verify-md-wrap`、`verify-md-links`、`doc-typecheck`、`verify-type-equiv` 等把写作规则机械化（DSH：`docs/AGENTS.md`；`scripts/doc-budgets.manifest.json`；根 `package.json`）。

**应复用机制**：ClinMesh 至少区分 `docs/architecture/`、`docs/guides/`、`docs/reference/`、`docs/decisions/`、`docs/research/`；README 只描述包本身。把研究记录与权威架构文档分开，防止本文件以后被误当成现状契约。

**最小目标**：先做链接检查和站点 build；暂不复制字数预算、TypeScript 文档代码等价、生成 catalog、Mermaid、JSDoc 完整性等门禁。只有相应内容类型出现后再启用对应检查。

### 5. 双语 pairing 的本质是同权、同目录、可验证的一致性确认

DSH 规定每对文档由同目录三文件组成：`foo.md`、`foo.zh.md`、`foo.i18n.yaml`。两种语言同等权威；sidecar 记录双方最后一次确认一致时的 Git blob hash。结构签名要求标题层级、列表类型与数量、表格维度、链接目标、代码块顺序与内容对应（DSH：`docs/i18n/README.md` 的 “The pairing contract”“The gate”）。

`verify-translation-pairing` 检查完整性、hash、语言切换链接及结构；`--write <pair>` 只在人工/Agent 确认语义一致后重录 hash。`scripts/translation-pairing.manifest.json` 是排除清单，而非逐页 rollout 清单。归档 Agent Notes 不参与动态 pairing gate，由专用冻结验证器负责（DSH：`docs/i18n/README.md`；`scripts/translation-pairing.manifest.json`）。

**应复用机制**：如果 ClinMesh 确认维护中英文，应采用同目录 sibling pairing，并明确两种语言的权威关系、术语表、同步责任和自动检查；不要再复制一套 locale 内容树。

**空项目决策建议**：不要默认启用“三文件 + blob snapshot refs + merge driver”。先决定是否真的需要全部工程文档双语。若当前只需中文，保持中文单源；若只对外用户文档双语，只把该目录纳入 pairing scope。不要为了“未来可能国际化”立即把所有研究、ADR、Agent 指令翻译一遍。

### 6. `website/docs.ts` 是发布 allowlist 和信息架构 manifest

DSH 的 `website/` 不拥有文档正文，只拥有 VitePress 配置、展示资源和发布 manifest；`website/AGENTS.md` 明令禁止在此创建 locale/route/API Markdown 树，生成内容只进入忽略的 `.generated/`。

`website/docs.ts` 的关键符号是：

- `DocsPage`：`locale`、`contentLocale`、`source`、`route`、`label`、`sidebar`、`section`、`order`、可选 `outline/sourceAliases`。
- `pairedPages()`：由英文 `foo.md` 派生中文 `foo.zh.md`，映射根中文路由和 `/en/` 路由，并登记 counterpart aliases。
- `mirroredPages()`：某语言缺失时允许两条 locale 路由投影同一源。
- `docsPages`：显式公开页面 allowlist。
- `sectionSpec()`、`orderedPages()`、`landingLink()`、`routeLink()`：统一 sidebar 排序和导航落点。

这种显式 manifest 把“仓库存在文档”与“对外发布文档”分开，避免把 postmortem、Agent 指令或内部决策意外发布（DSH：`website/docs.ts`；`.agents/skills/dsh-doc-site-sync/SKILL.md`）。

**应复用机制**：当 ClinMesh 文档站需要从多个源码目录发布、需要双语或内部/外部隔离时，采用类型化显式 manifest，而不是靠目录全量扫描。

**最小目标**：如果初期只有少量对外文档，可先使用小型 `docs.ts`，字段只保留 `source/route/title/section/order`；没有双语时不引入 locale abstraction。

### 7. `project-doc-site.ts` 把 canonical Markdown 投影成一次性站点源

`projectDocs()` 每次删除并重建 `website/.generated`，逐个读取 `docsPages`，验证 route 唯一与 source 存在，调用 `rewriteMarkdown()`，加入 `editSource`/`outline` frontmatter，再写到目标 route（DSH：`scripts/project-doc-site.ts::projectDocs`、`addProjectionFrontmatter`）。

`rewriteMarkdown()` 使用 `mdast-util-from-markdown` 与 GFM 扩展解析 AST，只替换 link/image/definition 的 destination token而不重新序列化整篇 Markdown：

- manifest 内目标变为同 locale 的站点相对路由；语言切换链接跨 locale。
- manifest 外但存在的仓库目标变为固定 ref 的 GitHub blob/tree 链接，可识别 `:line`。
- 本地图片复制到生成树；`publishableImage()` 通过 realpath 和 regular-file 检查阻止仓库外路径/符号链接泄露。
- 缺失相对目标立即失败。
- `withoutRepositoryChrome()` 移除源码页专用语言切换行和 badge；首页只投影 frontmatter。

`.vitepress/config.ts` 在加载时执行 `projectDocs()`，设置 `srcDir: '.generated'`、`cacheDir: '.cache'`、`outDir: '.dist'`；开发服务器用 `docsSourceFiles()` 监听 canonical Markdown 和引用图片并重新投影（DSH：`website/.vitepress/config.ts::watchCanonicalDocs`）。

**应复用机制**：canonical docs 与站点派生物严格分离，派生物可删除重建；投影必须 fail loud；链接变换应使用 Markdown AST 而非正则全文替换；发布图片要验证真实路径仍在仓库内。

**不应直接复制**：GitHub URL、默认 `master`、`DOCS_REPOSITORY_REF`、DSH badge、中文根路由/英文 `/en/`、首页重定向、43 个 subsystem 断言和 DeepSeek 品牌展示均须删除或重做。

### 8. VitePress 构建与验证形成逐层证据

DSH 的站点包脚本为 `vitepress dev/build/preview`。根脚本：

- `docs:dev`：启动站点。
- `docs:build`：VitePress build 后运行 `verify-doc-site-fragments`。
- `docs:build:mpa`：CI 的 MPA build 变体，再做 fragment 检查。
- `docs:check`：先运行 `project-doc-site.spec.ts` 和 `verify-doc-site-fragments.spec.ts`，再做生产 build。
- `doc-sync`：通过 `scripts/run-gates.ts` 执行完整文档门禁图。

`project-doc-site.spec.ts` 验证 website 下无正文副本、路径逃逸图片被拒绝、route/locale 对称、链接重写、缺失目标失败、sidebar section/order 无冲突、导航落点存在等。`docSyncLeafGates()` 再并行组合生成目录 freshness、Markdown 链接、Agent Note、翻译 pairing、预算、站点投影测试和 VitePress build；站点 build 单独保持为一个 gate，因为它会重写共享 `.generated`（DSH：根 `package.json`；`scripts/project-doc-site.spec.ts`；`scripts/run-gates.ts::docSyncLeafGates`）。

**ClinMesh 最小验证**：第一阶段只需 `docs:build` 作为 VitePress 和 dead-link 证据，加一个 manifest/source/route 唯一性测试；若使用投影，再加“不得提交 `.generated`、缺失源/链接失败、图片不得逃逸仓库”的测试。不要复制 DSH 全量 `doc-sync`，否则空项目会先维护门禁而不是产品。

## 二、Multica：跨 Web、desktop、mobile 的 monorepo 与共享边界

### 1. 工作区和任务编排

`references/multica/pnpm-workspace.yaml` 只纳入 `apps/*` 与 `packages/*`，并用 `catalog:` 统一 React、TanStack Query、Zod、Zustand、TypeScript、Vitest 等共享版本。根 `package.json` 固定 Node `>=22` 和 pnpm，使用 Turbo 暴露 `dev:web`、`dev:desktop`、`dev:mobile`、`build`、`typecheck`、`test`、`lint`。

`turbo.json` 让 `build/typecheck` 依赖上游同名任务；`test` 通过无副作用的 `cache-inputs` 任务把依赖包源码 hash 纳入缓存，避免 `views/ui` 变化后消费应用错误复用旧测试结果。mobile 被根 `build/typecheck/test/lint` 显式排除，独立运行与发布（Multica：根 `package.json`；`turbo.json`；`apps/mobile/CLAUDE.md` 的 “Build & release”）。

**应复用机制**：采用 pnpm workspace、catalog 和 Turbo；任务缓存必须覆盖上游源码；各 workspace 直接声明自身外部依赖。

**最小目标**：先建立 `apps/web` 和必要共享包。desktop/mobile 未进入近期里程碑时不要创建空壳应用；但在包边界上预留平台适配接口，避免 Web API渗入共享业务层。

### 2. 共享依赖方向：`views -> core + ui`

Multica 的根约束把三层定义清楚：

- `@multica/core`：headless 业务逻辑、API client/schema、TanStack Query queries/mutations、Zustand store、权限、纯转换和 realtime updater。禁止 `react-dom`、`localStorage`、`process.env` 和 UI 库；存储通过 `StorageAdapter` 等平台接口注入。
- `@multica/ui`：Base UI/shadcn 原子组件、Markdown、通用 hooks、设计 token 与 base CSS；禁止依赖 `@multica/core` 和业务逻辑。
- `@multica/views`：共享业务页面/组件，依赖 `core + ui`；禁止 `next/*`、`react-router-dom` 和自有 store。

共享包通过 `package.json#exports` 直接导出原始 `.ts/.tsx`，由消费应用编译；`core` 与 `ui` 独立，只有 `views` 组合两者（Multica：`CLAUDE.md` 的 “Project Shape”“Package Boundaries”；`packages/core/package.json`、`packages/ui/package.json`、`packages/views/package.json`）。

状态归属同样明确：TanStack Query 管服务端状态；Zustand 只管客户端/视图状态。Workspace-scoped query key 包含 `wsId`，WebSocket 更新 Query cache 而非把服务端数据镜像进 Zustand（Multica：根 `CLAUDE.md` 的 “State Rules”）。

**应复用机制**：ClinMesh 的共享层按“协议/纯逻辑与服务端状态”“无业务原子 UI”“组合业务视图”分开，并用 lint/import-boundary 检查锁住依赖方向。

**避免过早抽象**：空项目不应照抄 `core` 当前上百个 export。只为第一个真实垂直功能建立窄入口；没有第二个消费端之前，`views` 层可推迟，防止为假想 desktop 提取空泛抽象。

### 3. Web 是平台薄壳

`@multica/web` 使用 Next.js App Router，并在 `next.config.ts#transpilePackages` 显式编译 `@multica/core`、`@multica/ui`、`@multica/views`。大量 route 文件直接 re-export 或薄包装共享页面，例如 issues/inbox/chat/settings 页面来自 `@multica/views`（Multica：`apps/web/package.json`；`apps/web/next.config.ts`；`apps/web/app/[workspaceSlug]/(dashboard)/**/page.tsx`）。

Next 专属能力集中在 `apps/web/platform/`。`WebNavigationProvider` 把 `useRouter/usePathname/useSearchParams` 实现成共享 `NavigationAdapter`，共享 views 只调用 `useNavigation()`/`AppLink`（Multica：`apps/web/platform/navigation.tsx`；`packages/views/navigation/index.ts`）。

**应复用机制**：路由、cookie、环境变量、SSR/浏览器 API 留在 app/platform；共享业务视图通过 provider/adapter/props 接收平台能力。应用 route 应尽量是装配层。

### 4. Desktop 复用业务视图，但平台行为由 Electron 壳负责

`@multica/desktop` 使用 Electron、electron-vite、React Router、electron-builder。renderer routes 直接消费 `@multica/views` 的 issues、projects、inbox、chat、settings 等页面；平台差异通过 wrapper、props/slot 或 provider 注入，而不是复制页面（Multica：`apps/desktop/package.json`；`apps/desktop/src/renderer/src/routes.tsx`）。

`DesktopNavigationProvider` 实现同一 `NavigationAdapter`，但 `push/replace/back/openInNewTab` 被翻译成桌面 tab session、workspace 切换、WindowOverlay 和虚拟 history；共享 views 不知道 React Router 或 Electron（Multica：`apps/desktop/src/renderer/src/platform/navigation.tsx::DesktopNavigationProvider`）。

**应复用机制**：desktop 与 Web 确认拥有同一交互和信息结构时共享 `views`；Electron main/preload/IPC、更新、多窗口、拖拽区和 desktop tab 模型留在 app 内。

**空项目必须删除/暂缓**：Multica 的 `WindowOverlay`、多 tab coordinator、daemon、CLI bundle、updater、多窗口、workspace 自愈等是成熟桌面产品机制，不应进入 ClinMesh 初始模板。先用单窗口 renderer + 最小 preload allowlist。

### 5. Mobile 是语义共享、实现独立

`@multica/mobile` 是 Expo Router + React Native + NativeWind 的独立客户端。它不导入 `@multica/ui` 或 `@multica/views`；主要从 `@multica/core/types/*` 做 type import，并复用纯函数、Zod schema、权限和数据转换。Metro 监听整个 monorepo、配置根/应用 `node_modules` 与 pnpm symlink，以解析这些允许的共享入口（Multica：`apps/mobile/package.json`；`apps/mobile/metro.config.js`；`apps/mobile/CLAUDE.md` 的 “What mobile may import”）。

Mobile 自己拥有 UI、导航、QueryClient、API client、query keys、mutations、Zustand stores、WebSocket subscription、主题和发布节奏。其原因不仅是 DOM 与 RN UI 不兼容，还包括 AppState/NetInfo、蜂窝网络成本、缓存 shape、per-screen subscription 和 Expo/React 版本约束不同（Multica：`apps/mobile/CLAUDE.md` 的 “Realtime / WebSocket strategy”“Data layer helpers”“Build & release”）。

但产品语义必须一致：计数/可见性、权限、枚举转换、实体 identity。`deduplicateInboxItems` 的移动端镜像事故说明：mobile 可以重写实现，却必须先找出 Web/core 在 API response 到 JSX 之间的预处理；能抽成真正纯函数时再共享单一实现（Multica：`apps/mobile/CLAUDE.md` 的 “Behavioral parity”）。

**应复用机制**：共享 types/schema/permissions/纯函数，不共享 DOM UI、浏览器存储、QueryClient 或绑定 Web cache key 的 updater；以 parity checklist 验证语义而不是追求代码复用率。

**最小目标**：若 mobile 是首期范围，建立独立 Expo app 和最小 `packages/contracts`/`packages/core` 纯入口；否则不创建 mobile 空壳。不要先复制 mobile 的完整网络、realtime、formSheet 和 release 体系。

## 三、ClinMesh 初始化取舍矩阵

| 主题 | 应复用机制 | 必须删除/不要复制 | 空项目最小目标 |
| --- | --- | --- | --- |
| Agent 规则 | 根规则 + 必要子树规则；单一归属、链接细节 | DSH Cordis/agent-loop/session/tool/SDK 专属条款 | 简短根 `AGENTS.md`；出现真实差异再加局部文件 |
| Skills | 可重复多步流程封装；链接权威规范 | DSH 全套产品/PR/翻译 skill | 0–1 个当前确有使用场景的 skill |
| 决策记录 | Context/Decision/Alternatives/Consequences | 强制每改动三语义文件、冻结 archive、supersession 全套 | 单目录轻量 ADR，按需加状态验证 |
| 文档分类 | tutorial/reference 分离；architecture/guide/reference/research/decision 分家 | DSH subsystem/Cordis catalogs 和产品目录 | 小型信息架构 + 相对链接 |
| 双语 | 同目录配对、同权、术语与一致性 gate | 默认全库双语、blob snapshot refs/merge driver | 先确认 scope；无真实需求则单语 |
| 文档站 | canonical docs、显式 allowlist、可丢弃投影 | DeepSeek 品牌、路由、GitHub URL、DSH 页面清单 | VitePress build + 小 manifest；必要时再做 projector |
| Monorepo | pnpm catalog、Turbo task graph、显式 package exports | Multica 大量领域包和成熟缓存技巧 | `apps/*` + 少量 `packages/*`，只支持当前里程碑 |
| Web/desktop | `core/ui/views` 与 NavigationAdapter；平台薄壳 | desktop 多标签、daemon/updater/多窗口初始即上 | 先 Web；desktop 有计划时做最小壳和适配器 |
| Mobile | 共享合同、schema、权限、纯函数；语义 parity | 共享 DOM UI、Web store/QueryClient/updater | 独立 Expo；仅在首期需要时创建 |
| 验证 | 约束可执行、失败明确、按风险逐步加 | DSH 全量 `doc-sync` 和 Multica 全套 CI 一次搬入 | format/lint/typecheck/test/build；docs build；基础边界检查 |

## 四、推荐的最小项目形态

以下是目标结构，不表示应在一次初始化中创建所有目录；以首个真实产品切片为准：

```text
apps/
  web/                 # Next.js 平台装配与 routes
  desktop/             # 仅在近期需要 desktop 时创建
  mobile/              # 仅在近期需要 mobile 时创建，独立 RN 实现
packages/
  contracts/           # API schema、事件/实体类型，无 React
  core/                # 纯业务规则；必要时含 headless Query hooks
  ui/                  # 无业务原子组件与 tokens
  views/               # 仅在 Web + desktop 确有共享页面时创建
docs/
  architecture/
  decisions/
  guides/
  reference/
  research/
website/                # 仅在文档站需要投影/独立配置时创建
```

依赖方向建议为：`contracts <- core <- views`，`ui <- views`；app 可依赖需要的共享包。`contracts` 不依赖 React；`ui` 不依赖 `core`；`views` 不依赖 Next、React Router、Electron；mobile 默认只依赖 `contracts` 和 `core` 中明确标记为 RN-safe 的纯入口。

根脚本第一阶段建议只有：

```text
dev:web
build
typecheck
lint
test
docs:build        # 仅已有文档站时
check             # 组合以上稳定检查，不先塞入所有未来门禁
```

首批自动边界检查的价值高于大量生成器：禁止 `ui -> core`，禁止 `views -> next/*|react-router-dom|electron`，禁止 `contracts -> react`，并检查 workspace 直接依赖声明。若 desktop/mobile 尚不存在，检查仍只覆盖已存在 package，不要求空壳。

## 五、分阶段决策建议

### 阶段 0：确认产品面与平台范围

先回答 Web 是否唯一首发端、desktop/mobile 是否为近期承诺、文档是否对外、哪些文档必须双语。没有这些答案，不应初始化 desktop/mobile、双语 pairing 或文档 projector。

### 阶段 1：最小可运行垂直切片

建立 pnpm workspace、catalog、Turbo 基础任务，以及 `apps/web`。围绕一个 ClinMesh 真实用例创建最小 `contracts/core/ui`；只有共享页面有第二个真实消费者时再提取 `views`。配置 format/lint/typecheck/test/build 和基础 import-boundary 检查。

### 阶段 2：第二平台与共享边界

引入 desktop 时，用 `NavigationAdapter`/provider 隔离路由和平台 API，验证一个完整业务页面可由 Web/desktop 共用。引入 mobile 时，锁定允许 import 的纯入口，建立行为 parity 清单和 mobile 独立验证任务；不以共享 JSX 为目标。

### 阶段 3：文档发布与决策治理

当 canonical docs 已有稳定分类且确实需要站点时，再引入 VitePress manifest/projector。先实现 source/route 唯一、缺失目标失败、生成树忽略、build dead-link；需要双语时再扩展 `locale/contentLocale/pairedPages` 和 pairing gate。Agent Notes/ADR 的生命周期与归档机制等到决策数量造成检索或权威混淆后再增强。

## 六、初始化验收标准

ClinMesh 的“最小目标”应以以下可观察结果判定，而不是以复制参考仓库的目录数量判定：

1. 一个命令可安装并运行首个应用，Node/pnpm 版本明确。
2. 一个根级 check 可验证当前存在的 workspace，Turbo 缓存不会忽略上游源码变化。
3. 共享包依赖方向由脚本或 lint 强制，不依赖约定记忆。
4. 平台 API 不进入纯业务层；Web route 是薄装配层。
5. 文档事实有明确归属，研究记录不冒充当前架构权威。
6. 若有文档站，正文只有一份 canonical source，生成目录可删除重建且不提交。
7. 若有双语，scope、同权关系和同步验证明确；若无双语需求，不制造维护负担。
8. 若有 mobile，产品语义 parity 有测试/清单，mobile 工具链不会阻塞无关 Web/desktop 检查。

最终建议是“复制约束背后的原因，不复制成熟仓库的结果形态”：DSH 提供治理与可验证文档投影的上限，Multica 提供跨端共享边界的成熟实例；ClinMesh 初始实现应只取能保护当前首个产品切片的那一小部分。
