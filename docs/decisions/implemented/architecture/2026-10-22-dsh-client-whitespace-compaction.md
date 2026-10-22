# Agent Note: DSH 客户端产物空白压缩

Status: implemented

## Problem

上游 Surface builder 输出未压缩的单文件 lazy-CJS。新增收费与住院财务界面后，同一 Bun 1.4.2、同一锁依赖的产物由 4,951,968 增至 5,052,212 字节，超过[现行 5 MB 预算](../testing/2026-10-07-dsh-client-size-budget.md)。增量来自实际界面和合同，没有新增大型第三方依赖；输出包含足够多的空白和普通注释，可以在保留业务与加载合同的条件下降低体积。

## Decision

ClinMesh 在上游 builder 与 artifact verifier 之间运行本地 `Bun.Transpiler`，压缩打印空白和普通注释。显式关闭死代码消除、tree shaking、内联及未使用 import 裁剪，不做标识符压缩，也不再次打包或重命名外部 `require`。许可证注释保留；wrapper 继续由上游生成，verifier 按压缩后的固定前缀校验相同模块 ID、惰性 factory 和 `require` 参数。

当前构建合同由[跨端前端架构](../../../frontend-architecture.md#dsh-web)拥有。Bun 继续固定为 CI 使用的 1.4.2；5,000,000 字节上限、宿主 React、外部模块白名单及 emitted Tool 描述/schema 检查继续生效。

## Alternatives considered

- 提高体积预算：本次增量可以通过去除打印开销容纳，缺少扩大预算的需要。
- 分拆或删减已有 Operation Catalog 与合同：会扩大所有权和漂移校验的变更范围，单纯移除未使用 schema 也不足以覆盖本次超额。
- 二次 `Bun.build`：会重新处理词法绑定并将外部 `require` 改名，增加加载与白名单验证的复杂度。
- 修改上游 builder 或引入完整语法/标识符压缩：本地打印压缩已提供足够余量，无需改变 vendor 或扩大优化范围。

## Consequences

错误栈继续保留函数名，但产物行号因压缩集中，源码调试仍应使用开发入口。构建增加一次本地解析/打印。合成 lazy-loader 回归测试执行压缩前后 factory，验证相同导出值、模板字符串、正则、外部 React 注入和许可证保留；真实构建继续执行 emitted Tool 合同检查。产物加载的 React 18/19 浏览器验证覆盖真实 lazy-CJS，不能仅以源码 fixture 代替。
