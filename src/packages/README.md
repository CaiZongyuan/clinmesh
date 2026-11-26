# 深模块

1. `index.ts` 是包的唯一公共入口。应用、CLI 与其他包从这里导入；`lib/` 由本包独占。
2. `tests/` 通过与用户相同的入口验证行为；生产代码不导入测试，测试辅助文件不跨包共享。
3. 依赖单向流动：可选 Clinical Modules → Mini HIS Core → Store / Platform Ports。核心不导入 `mod-*`，Web 与服务器不互相导入，也不允许循环。
4. 组合根选择 `ClinMeshModule`；业务模块通过注册钩子提供路由和操作，不以副作用安装自身。两个运行时共享同一个 Hono 工厂。

| 包 | 职责 |
| --- | --- |
| [platform](platform/index.ts) | 模块契约、注册冲突与运行时健康投影 |
| [store](store/index.ts) | 类型化 Store Repository Port、隔离的规范化事实、Node / DO SQLite 适配器与版本化逻辑快照。参见[使用说明](store/README.md) |
| [data-pack](data-pack/index.ts) | 预留声明式 Hospital Data Pack 边界，不携带地区目录 |
| [ui-kit](ui-kit/index.ts) | 统一临床控件、布局、Theme Tokens，以及带人工审批的 UI Agent 与 WebMCP 桥接 |

依赖守卫：`pnpm lint:boundaries`。设计依据见 [ADR 0001](../../docs/adr/0001-modular-monolith-and-deep-modules.md)。
