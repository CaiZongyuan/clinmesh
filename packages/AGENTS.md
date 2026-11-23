# AGENTS.md — Shared packages

补充根 [AGENTS.md](../AGENTS.md)，适用于 `packages/`。

## Dependency direction

```text
contracts <- core <- views
             ^       ^
             |       |
             +--- ui +
```

- `contracts`：跨 wire/runtime 的 Zod schema、Operation/Tool Catalog、DTO 与 FHIR 辅助类型；禁依赖 React 或任何平台 API，禁止把变量命名为 `window`（触发边界静态扫描）。
- `core`：领域纯函数、状态规则、query key 工厂与无平台 API client；只可依赖 `contracts` 及无平台库。
- `ui`：Web/Desktop 视觉 primitives、token 与无障碍模式；不依赖 `core` 或医院业务概念。
- `views`：Web/Desktop 共享业务视图（`core + ui`）；路由、存储、通知与文件选择由 interface 注入。

## Package rules

- 每个包声明直接导入的外部依赖，共享版本走 `pnpm-workspace.yaml` catalog；导出源码子路径入口（避免根 barrel 放大客户端 bundle），禁止依赖其他包的构建产物。
- 测试放在包内 `tests/` 或同目录 `*.test.ts`；新增共享抽象前须至少存在两个真实消费者，单一消费者优先保留包内私有实现。
