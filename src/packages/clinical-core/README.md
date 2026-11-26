# Mini HIS 工作台

`POST /api/auth/visitor/enter` 接受 `{ "passcode": "…" }`。每次成功都创建独立 Workspace 并签发 24 小时的 HttpOnly、SameSite=Lax Cookie，HTTPS 使用 Secure。`GET /api/auth/session` 返回当前 `workspaceId`、`epoch`、`roleId`、`sessionVersion`。`GET /api/workspace` 返回机构、角色、病例、诊断目录、业务时钟及当前角色可用的操作定义。

写入使用操作定义中的 `method` 和 `path`。请求正文同时包含 `epoch`、`idempotencyKey`、`expectedVersion` 和该操作的业务字段。同一操作、目标、身份和正文可重放原回执。不同请求复用键返回 `409 IDEMPOTENCY_CONFLICT`。遇到 `409 VERSION_CONFLICT` 后重新读取当前状态并核对草稿。

在同一 Epoch 内切换病例会保留每次就诊的本地编辑。其他标签页更新了同一份病历或诊断时，工作台并排展示已保存内容和本地编辑，由临床人员选择保留哪份内容后再保存。病历按医院当地业务日期选择可编辑模板字段，历史修订显示签署时实际保存的字段。

当年龄变化使模板字段退出编辑区时，普通保存保留该字段已存的草稿和本地待提交文字。工作台列出该字段上次签署、当前已存和本地编辑的值。临床人员可明确选择保留更正并签署，或放弃更正并签署。此时 `record.sign` 需要 `expectedDraftVersion` 和 `retiredReview`，后者包含 `decision`（`include` 或 `discard`）及已核对的 `localFields`。签署回执记录处置结果。门禁在事务内按完整草稿与最近一次完整签署事实核对。

| 操作 | 版本前提 | 业务字段 |
| --- | --- | --- |
| `workspace.role`、`visitor.logout` | 会话版本 | 切换岗位使用 `roleId` |
| `workspace.reset`、`workspace.advance-time` | `clockRevision` | 可选 `packId` 或目标 UTC 时间 `to` |
| `capability.issue`、`capability.revoke` | 创建为 0，撤销使用令牌版本 | 创建时指定 `roleId`、`allowedOperations`、`ttlSeconds`（1–3600） |
| `encounter.start` | 创建为 0 | 路径使用固定病例 ID，可选 `language` |
| `consultation.question` | 就诊版本 | `content`、`channel`（`text` 或 `voice`） |
| `record.draft`、`record.sign` | 就诊版本 | 草稿需 `fields` 和 `expectedDraftVersion`，首次草稿版本为 0；签署可附加草稿版本 |
| `diagnosis.draft`、`diagnosis.confirm` | 就诊版本 | 草稿使用 `diagnoses` 数组，每项含 `codeSystem`、`code` 和 `primary` |
| `encounter.complete` | 就诊版本 | 服务端在写事务内重验所有已启用门禁 |

管理员签发令牌时仅首次响应含 `token`。以 `Authorization: Bearer …` 使用。重置会关闭旧 Epoch，旧令牌随之失效。管理员可按 Epoch 查询 `/api/workspace/audit/:id`。`GET /api/his/encounters/:id/debrief` 只在完诊后开放。普通的列表、详情和问诊均使用受控投影。

组合根通过 `ClinMeshModule<OperationCatalog>` 传入模块。同一个模块通过 `registerOperations` 注册 Zod 查询与事务 Command，通过 `completion` 增加完诊条件，通过 `midnight` 处理机构当地的跨日事件，通过 `workbenchTabs` 声明页签。服务端取已装载模块与当前包声明的交集。`registerRoutes` 供带访客门禁的只读 GET 页面使用。业务读写通过 Operation Catalog 获取角色检查、Zod 校验、CAS、回执和审计。工作台的 `App` 接受以页签 ID 为键的 `panels`，组件消费与 UI 相同的受控上下文。

`patient-visit` 的 `appendPatientReply(tx, scope, encounterId, questionId, reply)` 供受信任的 Patient Agent 在已进入的 Store 事务中答复。它核对活动 Epoch、就诊状态和待答问题，实现同一答复重放。正式写入使用业务时间和独立审计时间。午夜钩子按医院当地日期顺序执行，所有钩子完成后提交时钟和事实。外部网络 I/O 应在事务外完成。
