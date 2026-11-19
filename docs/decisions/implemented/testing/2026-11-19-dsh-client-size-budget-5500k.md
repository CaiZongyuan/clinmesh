# Agent Note: DSH 客户端产物体积预算上调至 5.5 MB

Status: implemented

## Problem

在专病临床内核与病例包集成（[#464](https://github.com/CaiZongyuan/clinmesh/issues/464)）以及处方与住院医嘱二次查对要素补齐（[#511](https://github.com/CaiZongyuan/clinmesh/issues/511)）后，`apps/dsh-web/lib/client.js` 在锁定 Bun `1.4.2` 与既有[受限语法压缩](2026-11-13-dsh-client-syntax-compaction.md)下的实际体积达到 `5,002,271` 字节，超出[既有 5,000,000 字节门禁](2026-10-07-dsh-client-size-budget.md)。该体积预算是项目为尽早发现异常依赖打包而设立的构建门禁，并非 DSH 宿主的加载上限；继续固守 5,000,000 字节会迫使常规业务功能为凑字节数而牺牲代码可读性或冒改名破坏 Tool descriptor 提取的风险。

## Decision

将 `apps/dsh-web/src/verify-artifact.ts` 中的单文件客户端体积预算调整为 `5,500,000` 字节（5.5 MB），仅在 `clientFile.size > 5_500_000` 时报错。本决策取代 [5 MB 预算决策](2026-10-07-dsh-client-size-budget.md)中的字节数上限；Bun `1.4.2` 编译器版本、Terser 受限语法压缩配置（保留 `mangle: false`、`keep_fnames`、`keep_classnames`）、lazy-CJS wrapper、宿主 React 外置、模块 `require` 白名单以及 Tool descriptor 沙箱提取校验全部保持不变。

## Alternatives considered

- 开启 Terser 标识符混淆（`mangle`）或顶层控制流折叠：会改变函数/类可观察名称或顶层声明结构，扩大 `verify-artifact.ts` 按名称提取 `buildSurfaceAgentTools` 等辅助函数的脆弱性。
- 为迁就 5,000,000 字节删减前端可读文案或压缩共享合同摘要：无法提供可持续的功能增长余量，且降低临床界面与合同的可维护性。
- 移除构建体积门禁：失去对误打入私有运行时或重型第三方依赖的自动拦截能力。

## Consequences

当前 `5,002,271` 字节产物获得约 500 KB 的正常演进余量，同时继续拦截异常依赖膨胀。后续新增前端依赖或大型模块时仍以 `pnpm --filter @clinmesh/dsh-web build` 的实际压缩后字节数及 React 18/19 ShadowRoot 浏览器合同为准。
