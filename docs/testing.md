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

Agent CLI 使用六个互补 seam：Catalog test 拥有 operation/route/schema/Skill 分类，Identity HTTP test 拥有 Grant hash、岗位、allowlist 与失效矩阵，CLI process test 拥有 argv/stdin/stdout/stderr/exit，HIS 场景测试拥有业务状态机，Skill test 把示例交给真实命令 parser，ambiguous test 在响应丢失后通过公开 receipt 观察唯一 Effect。上层不复制 Server 已有 Command 输入矩阵。

### Application composition

共享业务视图在 `packages/views` 测试；Web 路由和平台 wiring 在 `apps/web` 测试。Desktop 或 Mobile 进入实际开发后在对应 app 增加平台证据。一个产品行为只有一个完整矩阵归属，其他层保留 wiring、可访问性和真实入口验证，不重复纯函数矩阵。

Mobile 只共享产品语义，不共享 DOM 测试。移动测试覆盖 Expo Router wiring、AppState/NetInfo、SecureStore、QueryClient 和原生交互。

### End-to-end

E2E 从真实入口执行，并从外部观察结果：重新读取资源、数据库投影、页面或审计事件，不以 Agent 自己声称成功作为断言。

CLI E2E 先构建真实 bin，再启动 Node listener 与 file-backed SQLite，并从独立 `clinmesh` 子进程执行 human login 和 Agent operation。主场景从生成 Synthetic Case 与 Brief 的受控 setup 开始，由不同单岗位 Grant 依次完成挂号、分诊、问诊、检查与报告确认、诊断、处方、病历签署、完诊、药品支付、处方审核和发药。响应丢失场景必须先证明 Server 已提交，再用原 operation ID/idempotency key 查询 receipt，并通过正式 query 证明 Effect 没有重复。

核心病例轨迹见[系统架构](architecture.md#144-场景测试)。每次运行固定 app build、数据库 schema、Operation Catalog hash、Workspace policy version、Synthea commit、localization profile、生成参数与 Case Revision；未来实际发布 IG 时再把对应版本加入固定输入。

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
pnpm --filter @clinmesh/cli test
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
- 常规测试只使用 fake Synthea 和 fake Chat Completions provider，必须在没有模型 API key、没有外网和没有付费调用时通过。真实 provider 只进入显式 live smoke。

## 用户界面验证

首期用户界面修改在 Web 真实入口验证。布局需要覆盖长中文文本、窄宽度、缩放和空/错误/加载状态。用户可见的 Web PR 使用 `agent-browser` 走真实应用入口并录制绑定精确 commit 的原生 WebM；成片使用 3–4 倍速、步骤字幕和真实点击高亮，在临床文字仍可读的前提下压缩体积。WebM 不替代自动回归测试。Desktop 进入实际开发后再增加真实 renderer 证据。

录制只使用合成医院场景和隔离的 workspace、epoch 与客户端状态。画面不得包含真实患者信息、医保或支付凭证、平台密钥、无关浏览器标签或通知。

Mobile 功能先列出与 Web/Desktop 必须一致的语义，再验证移动端允许不同的导航和控件。运行 `pnpm check:mobile` 和相关移动测试，并报告真实设备或模拟器证据缺口；不能用一张 Web 截图证明移动端正确。

## 性能合同

短性能门禁属于 `pnpm check`。它在隔离的 file-backed SQLite 上运行 Reference Release 导入、独立 Reference SQLite 的疾病/药品/检验全文搜索、本院服务目录 HTTP 查询、普通与重 Command、测试专用 Trace 对照和内置 Scenario install/reset。门禁只 gate statement/query/write、rows written、数据库增长、Trace rows/bytes、错误和索引计划。Trace bytes 是 `action_trace` 全部持久化 TEXT 字段的 UTF-8 字节数，不代表 SQLite page allocation。P50/P95/P99、transaction time 和吞吐始终进入结果，但不作为跨机器 PR hard gate。SQLite 当前不提供可靠 rows-read，因此结果 schema 明确不声明该指标。

```sh
pnpm perf:ci
pnpm perf:trajectory
pnpm perf:saturation
pnpm perf:full-import -- --manifest /absolute/path/to/release.json
```

`trajectory` 使用共享 application interfaces 从内置虚拟患者完成问诊、检验、诊断、处方、文书和完诊；Synthetic Case generation、历史、Brief、direct start、Investigation snapshot 与新 Epoch no-AI replay 由下述 Server HTTP 集成合同覆盖。`saturation` 以独立 Worker/SQLite sandbox 覆盖 1、5、10、25 actors，并报告 load runner 自身的 busy/retry；`full-import` 只读取调用者已合法取得的 manifest 和 artifact。所有 profile 只使用合成运行状态，不提供关闭 Audit Event 或 Action Trace 的运行开关。详细取舍见 [SQLite 性能工作负载与稳定门禁分离](../.agents/notes/implemented/testing/2026-08-28-sqlite-performance-contract.md)。

## 合成病例合同

- Transformation 测试覆盖 Index Encounter 合格性、确定性最后选择、new-problem/follow-up/preventive 推断、时间与引用闭包、Visible Source History 投影，以及当前隐藏资源泄漏阻断。
- Server HTTP 集成测试提交 generation request，等待异步任务并通过公开管理员 API观察 Profile、Case、provenance 与有界 translation warning；同时证明缺译保留来源 display 而结构错误仍失败、最多十次 Index Case 重试、失败不留部分资产、来源历史可分页/查看详情且猜测隐藏引用仍不可读取。
- Brief 测试覆盖异步状态、严格 schema、诊断泄漏拒绝、成功 revision 不可变、失败不覆盖成功、显式选择和无活动 Brief 禁止开始。客户端不能覆盖 provider URL、model、header、key 或 body，日志和 DTO 不含凭证。
- Direct start 测试证明一个 Case 正常流程只能开始一次，并原子创建本院 R5 Patient、Registration、Encounter 和 Queue Task；来源 R4 历史与全局 Reference rows 不得写入本院 R5/operational store。
- 医生目录测试覆盖 Dialog 打开即分页、两字符显式搜索、无自动选中、药品产品区分、诊断多条草稿与二次确认、处方空初始状态，以及检验项目选择后再保存/开立；Reference 失败时继续覆盖本院常用 fallback。
- Investigation 测试分别覆盖同 LOINC 隐藏 Observation 命中、fake provider 生成、schema/单位/范围拒绝、`generation-failed` 重试和首个成功 snapshot 冻结，不允许正常 fallback。
- Reset/replay 测试在新 Epoch 重新物化同一 Case Revision，复用 Brief、Case Truth 与 Investigation Result Snapshot，断言 provider 调用计数不增加、旧 callback 不能写入新 Epoch。
- Docker smoke 使用固定 Synthea commit、全部模块模式、中国 profile/localization provenance、非 root、只读文件系统和有界资源，从真实 HTTP 入口完成多患者 generation，并验证全部 Bundle 成功以及 translation warning 按 ordinal 关联，再继续覆盖 history、Brief、direct start、诊断、检查与 LIS 结果。
- OpenAI-compatible live smoke 是开发者显式运行的单个合成 Brief 检查，读取本机启动配置，不进入 `pnpm test`、`pnpm check` 或 CI，且不输出 prompt、响应正文、API key 或 provider header。
