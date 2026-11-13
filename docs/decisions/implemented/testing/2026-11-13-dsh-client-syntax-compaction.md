# Agent Note: DSH 单文件产物采用保留名称的语法压缩

Status: implemented

## Problem

院后复诊、统一审方与功能检查接入共享界面和契约后，仅压缩空白的 DSH 单文件客户端达到 5,012,747 字节，超过既有 5 MB 发布预算。继续增加普通临床能力需要减少实际产物体积，同时保留宿主加载边界及依赖函数名称的 Tool descriptor 产物校验。

## Decision

沿用[空白压缩决策](2026-10-22-dsh-client-whitespace-compaction.md)的严格 wrapper 识别及 factory body 边界，使用锁定 Bun 的 `Bun.build` 对已生成的 body 同时压缩空白和语法。该步骤不重新打包依赖，所有模块保持 external；关闭标识符压缩和 tree shaking，外层 lazy-CJS wrapper、宿主 require、module/exports 初始化与返回仍按原字节保留。当前构建合同由[前端架构](../../../frontend-architecture.md)拥有。

编译器可以合并声明、简化表达式等价语法；不依赖其保留任意内部语句形状。最终 verifier 继续从真实产物按名称提取并执行 Tool descriptor，检查描述长度、schema、允许的模块和 5 MB 上限。单元合同核对延迟 require、模板字符串、正则、许可证注释、重复压缩稳定性及未知 wrapper 拒绝；真实 lazy-CJS 浏览器合同覆盖 React 18/19 的宿主加载和业务写入。

## Alternatives considered

- 提高产物上限：不能减少传输及解析体积，也无法保留原预算的回归信号。
- 删除临床功能或复用旧检查类型：会破坏本次已批准的临床及接口合同。
- 标识符压缩、动态 chunk 或修改上游 builder：分别影响按名称校验、当前单文件加载合同和上游维护边界。
- 继续仅压缩空白：已不足以通过实际产物门禁；`Bun.Transpiler` 不能提供所需语法压缩，改用现有 Bun 构建 API 无需新增编译依赖。

## Consequences

本决策替代原空白压缩决策中“仅使用 Transpiler 压缩空白”的限制，其 wrapper 保护、宿主 React 与独立产物验证仍适用。压缩函数改为异步内部构建函数；生产界面及公开 API 不变。Bun 升级或契约增长后，必须继续验证真实产物和双版本宿主行为，不能以源码组件测试替代发布产物验证。
