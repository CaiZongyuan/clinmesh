# Agent Note: DSH 客户端单文件体积预算（5.5 MB）与受限 Terser 语法压缩合同

Status: implemented

## Problem

DSH Surface 客户端 `apps/dsh-web/lib/client.js` 是将共享 Web 应用、临床工作台及第三方依赖（含 OpenSeadragon 阅片引擎与 `ai-motion`）打入同一文件的 lazy-CJS 产物，不允许动态拆包，且 `verify-artifact.ts` 必须通过 TypeScript AST 从最终发射产物中按精确函数／变量名提取 `buildSurfaceAgentTools` 等辅助函数并在独立 VM 沙箱中执行 Tool 描述与 schema 校验。锁定的上游 Surface builder 默认不压缩代码；随着共享收费医保、住院手术减负、心肾专病内核与医嘱二次查对要素陆续合入，仅靠空白压缩已突破 5 MB，而在启用受限语法压缩后体积也达到约 5.00 MB，若开启标识符混淆（`mangle`）或顶层控制流折叠会破坏按名提取与匿名函数 `.name` 可观察语义，若彻底移除体积门禁则会失去对误打入私有 React 或重型依赖的自动拦截。

## Decision

在锁定 Bun `1.4.2` 构建链上结合受限 Terser 语法／空白压缩与 `5,500,000` 字节（5.5 MB）构建预算门禁，详细跨端构建约束见[前端架构](../../../frontend-architecture.md)：

1. **精确 Wrapper 识别与受限 Terser 5.50.0 语法压缩**：`apps/dsh-web/src/compact-client.ts` 在上游 Surface builder 生成产物后、执行 `verify-artifact.ts` 之前运行。先用 TypeScript AST 与精确前后缀核验单个 ClinMesh lazy-CJS wrapper（外层 `window.__ModuleLoader__.load`、宿主 `require`、`module`/`exports` 初始化与末尾返回原样保留，包装格式不符立即失败拒绝，绝不猜测新结构）；随后显式调用锁定同版本的 `terser@5.50.0` 仅对 factory 内部代码执行局部等价缩写（关闭 `defaults` 与 `toplevel`，仅启用 `booleans`、`join_vars`、`properties`、`sequences`、`comparisons`、`if_return`、`arrows`、`computed_props`、`unused`、`collapse_vars`、`passes: 2` 及输出 `shorthand`；强制 `mangle: false`、`keep_fnames: true`、`keep_classnames: true`、对齐 `ES2023` 并保留 UTF-8 与内联开源许可证注释），严禁启用顶层声明消除、条件控制流折叠、跨函数内联或 tree shaking。
2. **5.5 MB 单文件体积门禁与沙箱可观察合同**：`apps/dsh-web/src/verify-artifact.ts` 将客户端体积硬门禁设定为 `clientFile.size <= 5_500_000` 字节（提供约 500 KB 正常业务演进余量，拦截异常依赖膨胀），并同时对压缩后的最终产物强制校验：无 ESM `import`、无 `import.meta`、无私有打包的 `react.production.min`、`require` 严格限于五个宿主白名单模块，以及按原名提取 `buildSurfaceAgentTools` 与四个辅助函数在独立 `node:vm` 中成功执行长度与 schema 投影校验。

## Alternatives considered

- **开启 Terser 标识符混淆（`mangle`）、顶层折叠或改用 esbuild 全量语法优化**：混淆与顶层消除会破坏 `verify-artifact.ts` 按函数名提取沙箱校验；实测 esbuild 条件折叠还会将 `const x = true ? function() {} : function() {}` 的匿名 `.name` 改写为 `'x'`，开启名称修补又会抵消体积收益。
- **保留早期 4.1 MB／5.0 MB 门禁并靠删减临床界面提示文案凑字节，或直接取消体积门禁**：5.0 MB 并非 DSH 宿主的物理加载上限，为凑阈值删减可读文案损害可维护性；完全取消门禁则无法在编译期捕获重型依赖误引入。
- **修改上游 Surface submodule 源码或改为多文件动态 chunk 加载**：破坏上游锁复现边界并违背宿主单文件 lazy-CJS 插件加载协议。

## Consequences

`apps/dsh-web/lib/client.js` 在完整保留延迟 `require`、求值与异常 `finally` 顺序、函数／类可观察名称及 VM 工具提取合同的前提下显著缩减冗余语法与空白字节，并保有可持续的体积余量。升级 Terser、Bun 或上游 Surface builder 时必须同步运行压缩器语义回归、产物门禁与 React 18/19 ShadowRoot 真实产物注入测试。
