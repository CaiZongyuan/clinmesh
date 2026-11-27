# 深模块

1. `index.ts` 是包的唯一公共入口。应用、CLI 与其他包从这里导入；`lib/` 由本包独占。
2. `tests/` 通过与用户相同的入口验证行为；生产代码不导入测试，测试辅助文件不跨包共享。
3. 依赖单向流动：可选 Clinical Modules → Mini HIS Core → Store / Platform Ports。核心不导入 `mod-*`，Web 与服务器不互相导入，也不允许循环。
4. 组合根选择 `ClinMeshModule`；业务模块通过注册钩子提供路由和操作，不以副作用安装自身。两个运行时共享同一个 Hono 工厂。

| 包 | 职责 |
| --- | --- |
| [platform](platform/index.ts) | Visitor Gate、单角色 Capability Token、Operation Catalog、Command 事务、Virtual Time 和模块契约 |
| [patient-visit](patient-visit/index.ts) | 固定病例开诊、患者身份与分诊快照、顺序问诊和单待答回复 |
| [clinical-core](clinical-core/index.ts) | 模板病历、多编码诊断、不可变修订、完诊门禁与复盘。参见[核心契约](clinical-core/README.md) |
| [mod-lab](mod-lab/index.ts) | 检验、ECG 与 TTE 的确定性报告、版本修订和医生已阅。参见[工作台操作与接口](mod-lab/README.md) |
| [store](store/index.ts) | 类型化 Store Repository Port、隔离的规范化事实、Node / DO SQLite 适配器与版本化逻辑快照。参见[使用说明](store/README.md) |
| [data-pack](data-pack/index.ts) | 五层 Hospital Data Pack 编译、事务安装与公开病例投影。参见[使用说明](data-pack/README.md) |
| [ui-kit](ui-kit/index.ts) | 统一临床控件、布局、Theme Tokens，以及带人工审批的 UI Agent 与 WebMCP 桥接 |
| [agent-runtime](agent-runtime/README.md) | 按 Workspace、Epoch 和 Agent 角色打开 Pi 会话，执行 Patient Agent，保护请求凭据与问诊出口 |
| [agent-protocol](agent-protocol/index.ts) | 浏览器和服务端共享的 Provider、问诊状态、回执与 SSE 事件契约 |
| [mod-billing](mod-billing/README.md) | 通用收费员账本、原路退款、住院首次冻结结算和临床资金放行端口 |
| [mod-drg-cn](mod-drg-cn/README.md) | 数据包声明的合成参保方案、年度累计和住院 DRG 支付参考 |

依赖守卫：`pnpm lint:boundaries`。设计依据见 [ADR 0001](../../docs/adr/0001-modular-monolith-and-deep-modules.md)。
