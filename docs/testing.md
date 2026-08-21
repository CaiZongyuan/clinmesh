# 测试策略

本文定义 ClinMesh 的测试层级和检查归属。命令以根目录 `package.json` 为准。

## 层级

### Unit

`pnpm test` 通过 Turborepo 运行各包测试。Unit test 覆盖：

- Zod schema、FHIR reference 和错误分类。
- 状态转换、金额/定点数量、权限和场景纯函数。
- Query key、cache updater 和无平台 API client。
- 文档投影的 link rewriting 和路径安全。

测试应覆盖边界、拒绝路径和不变量，不以行覆盖率数字代替行为断言。

### Adapter

HTTP、FHIR、D1、R2、Electron IPC、浏览器存储和移动安全存储属于 adapter。测试通过公开 interface 驱动真实 adapter，mock 只停在网络、时钟或平台进程等昂贵/非确定输入。

Server route 测试必须解析响应 schema。D1 正确性 Spike 在真实 preview 数据库验证 batch rollback、条件写、复合 FK、幂等竞争、approval 单次消费、outbox lease 和 epoch reset。

### Application composition

共享业务视图在 `packages/views` 测试；Web/Desktop 路由和平台 wiring 在对应 app 测试。一个产品行为只有一个完整矩阵归属，其他层保留 wiring、可访问性和真实入口验证，不重复纯函数矩阵。

Mobile 只共享产品语义，不共享 DOM 测试。移动测试覆盖 Expo Router wiring、AppState/NetInfo、SecureStore、QueryClient 和原生交互。

### End-to-end

E2E 从真实入口执行，并从外部观察结果：重新读取资源、数据库投影、页面或审计事件，不以 Agent 自己声称成功作为断言。

核心 golden scenarios 见[系统架构](architecture.md#144-场景测试)。每个场景固定 app build、schema、IG、scenario、policy 和 tool schema 版本。

## 检查命令

```sh
pnpm typecheck          # Web/Desktop/Server/Docs/shared packages
pnpm check:mobile       # Expo typecheck + dependency compatibility
pnpm lint
pnpm test
pnpm doc-sync
pnpm check              # 非 Mobile 主检查集合
```

开发期间先运行目标包检查，例如：

```sh
pnpm --filter @clinmesh/core test
pnpm --filter @clinmesh/server typecheck
pnpm docs:check
```

跨包 interface、workspace 配置、构建、文档投影或发布 workflow 变化运行 `pnpm check`，并单独运行 `pnpm check:mobile`。

## 测试数据

- 只使用合成患者、机构、临床、医保和支付数据。
- Fixture 的稳定 logical id 使用预分配 ID 或确定性 UUID。
- 真实提交时间、request ID、lease 和 duration 不进入 canonical state hash。
- 测试自行创建和清理 workspace/epoch；旧 callback 不得写入新 epoch。
- 敏感字段不出现在 snapshot、异常信息和 CI artifact。

## 用户界面验证

共享视图修改同时在 Web 和 Desktop 真实 renderer 验证。布局需要覆盖长中文文本、窄宽度、缩放和空/错误/加载状态。

Mobile 功能先列出与 Web/Desktop 必须一致的语义，再验证移动端允许不同的导航和控件。不能用一张 Web 截图证明移动端正确。
