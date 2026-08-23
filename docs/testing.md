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

HTTP、FHIR、SQLite、文件持久卷、Electron IPC、浏览器存储和移动安全存储属于 adapter。测试通过公开 interface 驱动真实 adapter，mock 只停在网络、时钟或平台进程等昂贵/非确定输入。

Server route 测试必须解析响应 schema。SQLite 正确性 Spike 使用真实临时数据库文件验证事务回滚、外键、WAL 写竞争、幂等竞争、expected-version 条件写、outbox 重启恢复、备份还原和 Epoch reset。

### Application composition

共享业务视图在 `packages/views` 测试；Web 路由和平台 wiring 在 `apps/web` 测试。Desktop 或 Mobile 进入实际开发后在对应 app 增加平台证据。一个产品行为只有一个完整矩阵归属，其他层保留 wiring、可访问性和真实入口验证，不重复纯函数矩阵。

Mobile 只共享产品语义，不共享 DOM 测试。移动测试覆盖 Expo Router wiring、AppState/NetInfo、SecureStore、QueryClient 和原生交互。

### End-to-end

E2E 从真实入口执行，并从外部观察结果：重新读取资源、数据库投影、页面或审计事件，不以 Agent 自己声称成功作为断言。

核心 golden scenario 见[系统架构](architecture.md#144-场景测试)。每次运行固定 app build、schema、IG、Scenario 和 policy 版本；未来 Agent tool schema 进入范围后再固定其版本。

## 测试设计

每个新增或修改的测试必须对应一个目标回归，并能在该回归出现时失败。先选择拥有行为语义的最低层级，再为上层保留 wiring、平台集成、可访问性和长用户旅程；上层不重复下层的完整输入矩阵。

- 通过公开 interface 驱动行为，断言可观察结果、拒绝路径或不变量，不复述实现步骤。
- 只在网络、时钟、平台进程、真实支付或其他昂贵、非确定边界使用 mock；同进程 owner 尽量使用真实实现。
- 一个测试覆盖一个清晰行为分支。只有共享 setup 能显著降低理解成本时才合并场景。
- Coverage 用于发现未执行路径，不代替场景正确性；不得降低 threshold、缩窄 source scope 或使用空测试通过选项隐藏缺口。
- 只被无生产消费者 API 使用的测试不是保留该 API 的理由。删除或收窄行为前先确认是否存在公开 contract 或 Agent Note。
- 浏览器层只证明浏览器、平台载体和长用户旅程；资源语义、Command 状态机和错误矩阵由更低层 owner 证明。

## 可观察测试证据

写测试或运行检查前，Agent 向用户说明：

- 要证明的验收行为及目标回归。
- 测试文件、测试层级和关键断言。
- 为什么选择这些测试，以及为什么不需要更宽的集合。

运行时说明实际命令。长命令开始后持续提供简短阶段状态，不用无边界日志或内部推理代替进度。已经通过且未被后续修改失效的检查不因 commit、review 或 push 重复执行。

完成后报告每条实际命令的结果和耗时，列出新增或修改的测试用例，并明确未运行的检查及原因。失败证据保留原始命令、失败测试和关键错误；环境差异必须被验证，不能靠推测归因。

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

跨包 interface、workspace 配置、构建、文档投影或发布 workflow 变化运行 `pnpm check`。只有 Mobile 文件、共享给 Mobile 的 contract/core 入口或 Expo 配置变化时才运行 `pnpm check:mobile`。

## 测试数据

- 只使用合成患者、机构、临床、医保和支付数据。
- Fixture 的稳定 logical id 使用预分配 ID 或确定性 UUID。
- 真实提交时间、request ID、lease 和 duration 不进入 canonical state hash。
- 测试自行创建和清理 workspace/epoch；旧 callback 不得写入新 epoch。
- 敏感字段不出现在 snapshot、异常信息和 CI artifact。

## 用户界面验证

首期用户界面修改在 Web 真实入口验证。布局需要覆盖长中文文本、窄宽度、缩放和空/错误/加载状态。用户可见的 Web PR 使用 `agent-browser` 走真实应用入口，并由 `record-browser-gif` 生成绑定精确 commit 的验收 GIF；GIF 不替代自动回归测试。Desktop 进入实际开发后再增加真实 renderer 证据。

录制只使用合成医院场景和隔离的 workspace、epoch 与客户端状态。画面不得包含真实患者信息、医保或支付凭证、平台密钥、无关浏览器标签或通知。

Mobile 功能先列出与 Web/Desktop 必须一致的语义，再验证移动端允许不同的导航和控件。运行 `pnpm check:mobile` 和相关移动测试，并报告真实设备或模拟器证据缺口；不能用一张 Web 截图证明移动端正确。
