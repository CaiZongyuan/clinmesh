# DSH 集成排障

处理 DSH Page Context/Tool、Surface 产物、Profile 配置或模型桥日志时查阅；包级硬约束见 [`apps/dsh-web/AGENTS.md`](../../apps/dsh-web/AGENTS.md)，架构与操作合同见 [`docs/architecture/agent-integration.md`](../architecture/agent-integration.md) 与 [`docs/agent-capabilities.md`](../agent-capabilities.md)。其他主题见[工程记忆入口](memory.md)。

## Page Context、Tool 与调用身份

- **工具缺失或 `active Page Context binding` 报错**：先同时核对后端 Page Context 的 `allowedOperationIds`、前端 action `enabled` 条件，以及真实 `request/header` 与 `tool/call` 中的 `contextId`、`scopeKey`、`pageRevision`（`pageRevision` 为序列化字符串，禁止二次包装数组；生成期间页面更新导致的失配属版本竞态而非模型漏填）。还要核对拼接后的 Tool 描述是否超过 512 字符（lazy-CJS 缩进多行模板会放大长度，须用真实产物检查 lease）。
- **交接超时（`CLINMESH_HANDOFF_TIMEOUT`）与缓存依赖**：禁用态 TanStack Query 在冷缓存时 `isPending` 仍为真，Agent 页面加载态必须只看首次实际请求的 `isLoading`；React 缓存的 action 配置须完整声明依赖的 mutation 状态；连续回合交接回归须在同一用户回合检查下一条模型请求的实际 schema，切换栏目后在 `act` 外等待新 Tool 注册，提案工具在 `act` 内等 `awaiting-human-review` 后再由人工点击观察正式 Command。
- **表单读取与恢复回归**：页面 Tool 读表单应取控件解析后的生效值（覆盖草稿与目录默认补齐）；恢复回归须同时覆盖医生无 `const` 纯查询 schema 与非医生带 `const` schema（含目录损坏仍保留来源限制、业务参数无效等负例）；原生合成模型替身还须覆盖宿主的单句医生委托意图识别（否则报 `CLINMESH_DELEGATION_UNCONFIRMED`）。

## Surface 渲染、产物与 Profile 排障

- **“服务返回了无法识别的数据”**：Server `tsx watch` 已切新合同而 `apps/dsh-web/lib/client.js` 仍是旧构建时，`.strict()` schema 会拒绝新增响应字段——执行 `pnpm --filter @clinmesh/dsh-web build` 并重载宿主核对新 revision。若该提示伴随 `/clinmesh-api/auth/context` 返回空 `404`（而 Server 健康正常），检查隔离 Profile 的 `cordis.patch.yml`：宿主保存模型设置可能用仅含 `generationModel` 的配置覆盖 `clinmesh-dsh-web` 连接项，备份后补回引用 `CLINMESH_DSH_BRIDGE_SECRET` 与 `CLINMESH_DSH_UPSTREAM_ORIGIN` 环境变量的配置（禁写密钥字面量）。
- **`agentPresets` 不可用或缺少“医院工作台”入口**：`agentPresets` 不可用时用 `dsh web --dump-config`（脱敏查看）对照当前包 `AgentPresetRegistry.Config` 补齐被 patch 覆盖掉的 `default` 字段（Typert 无参 RPC 仍须传 `payload: { args: {} }`）。无“医院工作台”入口时看宿主终端 `failed to import`，用 `node --input-type=module -e "await import('./apps/dsh-web/lib/index.js')"` 检查原生 ESM `.ts` 扩展名；报 `dsh-react-surface/client` 未进模块表时，先确认宿主清空了残留 `NODE_PATH`，并在新 worktree 的 `vendor/dsh-react-surface` 按锁执行 `bun install --frozen-lockfile && bun run build:runtime`。
- **端口、多 worktree 隔离与启动引导**：`EADDRINUSE` 时清理验证宿主及其守护子进程并释放端口，卸载旧插件须连同 bundle/lock/patch 一并清理；多 worktree 需要独立验证 Surface 时停止宿主并复制独立 Profile，直接调锁定宿主 CLI 显式传 `DSH_HOME`（避开 `dshvm exec` 按槽真实路径回指旧目录）；启动 URL 中的临时访问 token 严禁打入日志，首次无模型 Profile 的 GUI 验收按真实可见按钮走完启动引导弹框。
- **桥接升级核验**：候选锁若残留镜像 `resolved` 地址，在隔离空目录显式指定官方 registry 重建锁并校验 tarball integrity；检查 `dsh-ag-ui` 时用 `pnpm -r --workspace-concurrency=1 --include-workspace-root check` 同步覆盖 `dsh-ag-ui-adapter`；Cordis `ctx.remote` 须解包 `{ ok, value | error }`，`SnapshotStore` 订阅回调保持实例 `this` 绑定，JSONL 持久化恢复测试以 `flush()` 为屏障，临时测试插件也须声明非空 `name` 与 `version`。

## 模型桥与诊断日志

- **流式异常、压缩竞态与权限错误分类**：DSH SDK 会将普通流异常归一化为 `finish:error/UNKNOWN`，断流未知结算回归必须经真实 `LlmAdapter` 注入；截止时间附近报 `UND_ERR_SOCKET` 时在真实 DSH WebServer gzip 路径复现 `writableEnded` 延迟导致的重复写响应；模型流按 `finish.reason` 分类，单模型 `403`（含余额不足被宿主映射为 `MODEL_AUTH_FAILED`）用同路由最小合成请求核对上游错误码，不直接判整组密钥失效。原生实模验收的净化环境若走代理，须显式传 `NODE_USE_ENV_PROXY=1` 并保留 loopback `NO_PROXY`。
- **多帧 Zstandard 会话日志读取**：`session.v4.jsonl.zstd` 含连续多段 Zstandard frames，Node `zstdDecompressSync` 单次可能只解出首帧——须按 `{ info: true }` 的 `engine.bytesWritten` 循环推进拼齐全部帧后再解析 JSONL，诊断输出脱敏不打印凭据或完整病历。
