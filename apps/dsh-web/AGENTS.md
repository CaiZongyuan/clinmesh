# AGENTS.md — DSH Web Surface & Bridge

补充根 [AGENTS.md](../../AGENTS.md)，适用于 `apps/dsh-web/`。

- **Client 打包与样式前置**：Surface Client 以 classic lazy-CJS 加载，构建产物严禁残留 `import.meta`（环境分支使用可静态消除的 `process.env.NODE_ENV`）；样式统一从 `src/client/styles-entry.ts` 加载。新工作区单跑测试前先执行 `pnpm --filter @clinmesh/dsh-web build:styles` 生成 `styles.generated.ts`。
- **Tool Broker 上限与 ShadowRoot 作用域**：单次注册上限为 **32 个 Tool**（门诊医生按诊疗栏目、住院按阶段在 `agentToolCatalog` 声明 `sections`），每个 Tool 拼接包装说明后的最终 `description` 不得超过 **512 字符**（否则整份 lease 注册失败）。Surface 渲染在宿主 ShadowRoot 内，元素定位使用当前业务容器 ref，弹层通过 `PortalContainerProvider` 留在 ShadowRoot 内，禁止使用 `document.getElementById`。
- **Host 模块与类型检查**：共享 contracts 相对导入保留 `.ts` 扩展名以兼容原生 Node ESM；Host 模块依赖 `Context.webServer` 等服务时在文件内显式保留 `import type {}` 与 Cordis `inject` 声明；新增辅助模型 `schemaName` 同步更新 `packages/contracts/src/model-bridge.ts` 白名单。本包加载 Bun 类型，浏览器 fixture 替换 `globalThis.fetch` 时须代理原函数静态属性（含 `preconnect`），修改 `.fixture.tsx`/`.browser.test.ts` 后运行 `pnpm --filter @clinmesh/dsh-web typecheck`。
- **产物体积预算**：`lib/client.js` 经本地语法与空白压缩后受测试预算门禁保护（不用二次 `Bun.build` 以免重命名 `require`）；正常功能增长超限时先以 CI 同版本 Bun 核实，再同步调整预算常量与 [语法压缩与体积预算决策](../../docs/decisions/implemented/testing/2026-11-13-dsh-client-syntax-compaction.md)。
