# AGENTS.md — Shared packages

这些规则补充根目录 [AGENTS.md](../AGENTS.md)，适用于 `packages/`。

## Dependency direction

```text
contracts <- core <- views
             ^       ^
             |       |
             +--- ui +
```

- `contracts`：跨 wire/runtime 的 Zod schema、DTO、FHIR 辅助类型。不得依赖 React 或平台 API。
- `core`：领域纯函数、状态规则、query key 工厂和无平台 API client。只可依赖 `contracts` 及无平台库。
- `ui`：Web/Desktop 通用视觉 primitives、设计 token 和可访问性模式。不得依赖 `core` 或业务概念。
- `views`：Web/Desktop 共享业务视图，可依赖 `core + ui`；路由、存储、通知和文件选择通过 interface 注入。
- Mobile 只可运行时导入 `contracts` 与 `core` 中明确无 React、DOM、Node 和浏览器依赖的入口。

## Package rules

- 每个包声明自己直接导入的外部依赖；共享版本使用 `pnpm-workspace.yaml` catalog。
- 包导出指向源码，由消费端构建；禁止依赖其他包的构建产物。
- 导出具体入口，避免一个根 barrel 把无关代码带入客户端 bundle。
- 网络与持久化输入使用 Zod 校验；同进程 TypeScript interface 不重复校验。
- 服务端状态由 TanStack Query 管理；Zustand store 只能保存筛选、布局、草稿和临时选择。
- 测试放在包内 `tests/` 或与纯函数同目录的 `*.test.ts`；平台 wiring 在对应 app 测试。
- 新增共享抽象前必须已有两个实际 adapter 或消费者。只有一个消费者时优先保留私有实现。
