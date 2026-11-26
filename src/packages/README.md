# 深模块

1. `index.ts` 是包的唯一公共入口。应用、CLI 与其他包从这里导入；`lib/` 由本包独占。
2. `tests/` 通过与用户相同的入口验证行为；生产代码不导入测试，测试辅助文件不跨包共享。
3. 依赖单向流动：可选 Clinical Modules → Mini HIS Core → Store / Platform Ports。核心不导入 `mod-*`，Web 与服务器不互相导入，也不允许循环。
4. 组合根选择 `ClinMeshModule`；业务模块通过注册钩子提供路由和操作，不以副作用安装自身。两个运行时共享同一个 Hono 工厂。

| 包 | 职责 |
| --- | --- |
| [platform](platform/index.ts) | 模块契约、注册冲突与运行时健康投影 |
| [store](store/index.ts) | 类型化 Store Repository Port、隔离的规范化事实、Node / DO SQLite 适配器与版本化逻辑快照。参见[使用说明](store/README.md) |
| [data-pack](data-pack/index.ts) | 五层 Hospital Data Pack 编译、事务安装与公开病例投影。参见[使用说明](data-pack/README.md) |
| [ui-kit](ui-kit/index.ts) | 预留统一临床控件与 Theme Tokens 的入口 |

依赖守卫：`pnpm lint:boundaries`。设计依据见 [ADR 0001](../../docs/adr/0001-modular-monolith-and-deep-modules.md)。
