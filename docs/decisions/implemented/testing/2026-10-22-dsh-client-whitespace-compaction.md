# Agent Note: DSH 客户端压缩空白并保留产物语义校验

Status: implemented

## Problem

共享收费与医保界面使单文件 DSH 客户端超过既有 5,000,000 字节预算。锁定的 Surface builder 没有暴露压缩选项，而产物校验需要保留 lazy-CJS wrapper、宿主 require 以及按名称提取的 Tool descriptor 函数，不能直接启用标识符压缩。

## Decision

ClinMesh 在应用自己的构建链中，先运行锁定的 Surface builder，再由 `apps/dsh-web/src/compact-client.ts` 压缩 factory 内的 bundle，最后完整执行原 `verify-artifact.ts`。压缩器用 TypeScript AST 和精确的前后缀识别当前单个 ClinMesh lazy-CJS wrapper；不匹配时拒绝处理，不猜测新的包装格式。外层 wrapper、module/exports 初始化与最终返回保持原样。

压缩使用锁定 Bun 的 `Bun.Transpiler`，只开启 `minifyWhitespace`，显式关闭 dead code elimination、inline 和 tree shaking，不启用标识符改名。输入是 builder 已生成的本地代码，不执行产物、不拉取外部代码。5 MB 门禁、允许的外部模块、宿主 React 约束及从真实产物提取执行的 descriptor 长度和 schema 校验继续生效。

## Alternatives considered

- 放宽预算：不能减少实际传输与解析体积，且会掩盖依赖异常。
- 修改 vendor 或引入另一压缩依赖：扩大共享构建工具的维护范围；当前锁定 Bun 已有足够的空白压缩能力。
- 仅删除模块来源注释：余量过小，且基于文本删除可能破坏模板字符串。
- 标识符压缩或动态拆包：前者破坏按名称提取的 descriptor 校验，后者不符合当前单文件加载合同。

## Consequences

空白压缩与预算检查职责独立，预算仍由[原决策](2026-10-07-dsh-client-size-budget.md)拥有。构建器升级后若 wrapper 改变，须显式核对压缩边界，不能绕过拒绝。Bun 将空白压缩标为 experimental，因此除实际产物的原有校验外，保留真实 Bun 的延迟 require、字符串及正则语义、重复压缩稳定性和不匹配包装拒绝测试；编译器版本变化时继续运行这些合同。真实产物浏览器合同把最终 lazy-CJS 文件注入宿主 React 18/19，验证住院收款预览、确认和 ShadowRoot 中的真实界面。
