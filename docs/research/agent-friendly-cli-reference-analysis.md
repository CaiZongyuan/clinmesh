# 面向 Agent 的业务 CLI 参考研究

## 范围与结论

- 状态：未来设计输入，不定义 ClinMesh 当前已实现行为。
- 核验日期：2026 年 8 月 30 日。
- 核验对象：CLI-Anything commit [`810c18b0d1ab9b234bc996c9fd999318523a3ef0`][cli-anything-tree]、lark-cli commit [`4e0a6a988cf32b26219b3425f6dbb7ce8332b292`][lark-tree]、Multica commit [`722bde9d1818dbe5c49e60a8c57a283712646457`][multica-tree]。
- 证据边界：只使用三个仓库的源码、测试和官方仓库文档；CLI-Anything 除生成规范外还核验 Blender、ChromaDB 和 JumpServer harness，避免把方法论要求误写成所有生成物都已满足的事实。

一个后端业务成为 Agent 容易理解且可靠调用的 CLI，不是把 HTTP endpoint 逐个改成子命令。有效的 CLI 需要同时提供三层信息：用业务意图命名的窄操作、可机器读取的精确合同，以及解释“何时用、前置条件、状态副作用和失败后如何恢复”的 affordance。三个参考分别在这三层表现出不同优势：CLI-Anything 擅长从真实后端和数据模型建立操作面与端到端验证，lark-cli 提供最完整的机器合同与统一执行管线，Multica 则把复杂业务副作用和受信 Agent 上下文写进平台 skill 与服务端授权边界。

ClinMesh 已有设计把 `HisOperationCatalog` 定为 operation 合同 owner，并规定从同一 catalog 派生 human CLI、HTTP 和 Cordis adapter；临床 Agent 不通过 shell 启动 CLI。该设计及其字段、handler ownership 和工具边界由[嵌入式 HIS 助手融合研究](./embedded-his-assistant-integration.md#his-operation-catalog-与-dsh-cordis-装配)拥有。本文只说明 CLI adapter 应从参考中吸收什么、拒绝什么，以及首个测试 CLI 如何分阶段验收。

## 对照结论

| 维度 | CLI-Anything | lark-cli | Multica | ClinMesh 取舍 |
| --- | --- | --- | --- | --- |
| 命令建模 | 从源码识别 backend、数据模型和 GUI command/undo，再按 project/core/import-export/config/session 分组；推荐 REPL 与 one-shot 并存 | 同一 domain 下提供高层 `+shortcut`、元数据生成的 typed API command 和 raw API escape hatch | 手写 `issue/project/agent/...` 业务命令；命令直接组装各自 HTTP path/body | 从 catalog 生成稳定层级命令，但只暴露已批准的 query/draft/preview/command；不提供 raw method/path/body |
| Schema 与 help | Click 自动 help；skill generator 只抽取 group、command、docstring，不抽取 flag 或 I/O/error schema | `schema`、typed flags、shell completion、risk、affordance 和 skill 互相补充 | Cobra help 很具体，built-in skills 补充状态副作用；没有统一 schema catalog | `his schema <operationId>` 必须输出 catalog 原始合同；help 只做局部投影，skill 不复制 schema |
| 输入输出 | 人类输出与 `--json` 双模式；样例常直接输出业务对象 | 成功 stdout 统一 envelope，错误 stderr 统一 envelope；支持 JSON、NDJSON、table、CSV、`--jq` 和 batch partial failure | 命令各自选择 table/JSON，JSON 形状通常直通 endpoint；默认格式不完全一致 | JSON 默认且 envelope 固定；table 仅显式请求；单个临床 Command 不产生隐式 partial success |
| 错误与退出码 | 样例多为 `{"error", "type"}`，`type` 可来自 Python exception class，常统一 exit 1 | 闭集 category/subtype、hint、param、retryable、log id 与稳定 category→exit 映射 | 稳定的粗粒度 exit tier 和友好文本，但默认错误不是机器 JSON | 闭集 error code + 粗粒度 exit；`definitely_not_sent` 与 `ambiguous` 必须分开 |
| 状态与上下文 | REPL 内存状态、项目 JSON、undo/redo；文件锁只保护写入 | profile/workspace 配置、user/bot identity、strict mode 和 scope preflight | human profile 与 daemon task context 分离；task token 在服务端覆盖 Agent/Task/Workspace headers | CLI 参数不能授予 actor/workspace/epoch/role；服务端重新绑定受信上下文，目标 Patient/Encounter 仍需授权校验 |
| 幂等与安全 | 规范要求“where possible”；Blender `--dry-run` 只禁止 auto-save，锁不提供 CAS | risk 分级、high-risk `--yes`、真实 request dry-run、路径校验；幂等 token 仍是少数命令的业务字段 | task-scoped token、workdir 文件边界和副作用专用 flag 较强；没有统一 CLI idempotency/expected-version 合同 | 所有写操作必须显式 idempotency key、expected version 和 receipt；临床复核不能降级成 `--yes` |
| 可发现性 | CLI-Hub、生成 SKILL、REPL banner | 根 help quickstart、domain help、schema、affordance、skills、completion、错误 suggestion | 每个 Agent 自动获得 built-in skills；skill 有 source map，并用测试钉住业务语义 | catalog list/schema 是机器发现源；skill 只负责意图路由、业务前置和反例 |
| 测试 | unit、native file、真实 backend、installed subprocess 与产物语义验证 | unit、dry-run E2E、live E2E、error/schema/stream/path contract 和 lint gate | Cobra/HTTP tests、上下文隔离 tests、built-in skill 与真实 parser/业务合同的 eval | projection conformance + subprocess + synthetic Scenario HTTP + 幂等/竞态/ambiguous/security 矩阵 |

## CLI-Anything：先找到真实业务内核，再建立操作面

### 可迁移机制

[HARNESS][cli-anything-harness]要求先识别 backend engine、GUI action 到 API 的映射、持久数据模型、既有 CLI 和 command/undo system，然后才设计命令树。它进一步要求先实现 `info/list/status` 等探针，再实现 mutation，并让 export/render 调用真实软件而不是在 wrapper 中重写业务内核。对 ClinMesh 的直接启示是：CLI adapter 必须调用现有 Query/Command owner，不能复制门诊状态机；首个命令应先让 Agent 读取当前 context、资源版本和允许操作，再开放 draft 或 preview。

CLI-Anything 推荐按业务域分组，并同时支持 one-shot 与 REPL；其 [Blender CLI][cli-anything-blender-cli]实际把 scene、object、material、render、preview 和 session 组织成命令组，mutation 前保存 snapshot，one-shot 完成后 auto-save。[Blender backend][cli-anything-blender-backend]确实调用 `blender --background --python`，检查进程退出和输出文件存在后才返回 artifact metadata；[真实 E2E][cli-anything-blender-e2e]又通过 installed command 和 Blender backend 验证最终文件，而不只测试 Python 内部函数。这种“业务 handler/真实 backend + CLI subprocess + 可观察最终状态”的闭环值得采用。

[JumpServer skill][cli-anything-jumpserver-skill]展示了生成目录之外仍需人工补足的业务知识：它按资产、用户、权限、账号、session 和审计组织典型工作流，列出 destructive action 的 `--force`/`--dry-run`，并明确输出格式和退出码。这说明 skill 最有价值的部分不是重复 flags，而是解释多个命令如何组成真实任务、哪些动作改变安全状态。

### 不足与排除

[skill generator][cli-anything-skill-generator]只通过 Python AST 读取 Click group/command decorator 和函数 docstring，再生成通用 project/REPL/export 示例；它没有读取 option 类型、required/enum、输入 schema、输出 schema、错误 schema、风险或幂等合同。因此它适合生成覆盖清单和初始导航，不足以成为 ClinMesh operation contract owner。JumpServer 的丰富 skill 是手写增强，不是 generator 自动得到的 schema-first 结果。

CLI-Anything 的统一规范也没有形成统一 wire contract。[Blender CLI][cli-anything-blender-cli]在 JSON 模式把业务对象直接写 stdout，失败时输出 `error` 和可能来自 Python exception class 的 `type`，然后统一 exit 1；[ChromaDB collection commands][cli-anything-chromadb-collections]同样在 stdout 输出成功对象或 `{"error": ...}`，没有稳定 `ok`、operation、context、retryable 或 receipt 字段。[JumpServer skill][cli-anything-jumpserver-skill]只区分 success、CLI error、usage error 和 interrupt。这些形状足够普通自动化，不足以表达临床写入的 stale context、permission changed、version conflict 或 ambiguous outcome。

[Blender session][cli-anything-blender-session]的文件锁在 truncate/write 周围避免并发写坏 JSON，但两个进程仍可先读取同一旧版本再依次覆盖，无法替代 expected version/CAS。其 `--dry-run` 只是执行命令后禁止 auto-save，并不等于服务端生成一份无副作用 Command Preview；CLI-Anything 的[通用 guide][cli-anything-dry-run]也明确这样定义。ClinMesh 不采用 stateful REPL、项目文件作为权威状态、仅锁写入或“执行但不保存”的 dry-run 语义。

CLI-Anything 的测试方法是上限而非所有 harness 的自动保证。[HARNESS testing][cli-anything-testing]要求真实 backend 和 installed subprocess，但 [ChromaDB E2E][cli-anything-chromadb-e2e]在本地 server 不可达时跳过整个套件。ClinMesh 的 gate 必须从 catalog 风险与 adapter 类型生成必跑矩阵，不能只依赖生成规范或测试数量。

## lark-cli：机器合同、业务 shortcut 与恢复提示分层

### 三层命令模型

[root help][lark-root]明确给出使用优先级：先选面向任务的 `+shortcut`，没有合适 shortcut 时使用元数据生成的 service/resource/method command，再以 raw API 作为平台覆盖逃生口。[Shortcut declaration][lark-shortcut-types]把 flags、identity、scope、risk、validation、dry-run 和 execute 声明在一个结构中；[shortcut runner][lark-shortcut-runner]统一执行 identity → config → scope → input → validation → dry-run → confirmation → execute。另一方面，[service command builder][lark-service-command]从 API metadata 生成 typed flags、body/raw JSON fallback、pagination、format、risk 和 identity policy。

这套分层解决两个不同问题：shortcut 给 Agent 一个成功率高的业务意图，typed API command 保留长尾覆盖，raw API 保留平台紧急逃生。ClinMesh 只吸收前两层的思想：常用业务流使用意图命令，长尾仍必须是 catalog 中显式注册的 operation；医疗边界不允许 raw URL、任意 HTTP method/body、FHIR Bundle 或通用 `execute`。

### Progressive disclosure

[schema command][lark-schema]不需要认证即可从同一 API catalog 输出参数、类型、scope，并用同一 catalog 提供 completion；错误会返回候选项和修复 hint。[Affordance format][lark-affordance]给 schema 和 help 叠加 `use when`、`avoid when`、prerequisites、tips、examples 与关联 skill，同时要求不复述 schema 已表达的字段。[Task skill][lark-task-skill]再负责自然语言意图消歧、跨 domain 边界和多步工作流。三者分别回答“有哪些精确字段”“什么时候用”“如何完成任务”，避免把所有信息塞进一个巨大 help 或 skill。

ClinMesh 应采用同样的 progressive disclosure：`his catalog list` 用于发现 operation，`his schema` 返回精确合同，命令 `--help` 只显示局部参数和风险，skill 只保留医院业务语义、前置状态、禁止路径和恢复策略。schema、help 与 tool schema 都从 `HisOperationCatalog` 投影；skill 不手抄字段表。

### Wire、错误和执行安全

[success envelope][lark-output-envelope]固定 `ok/identity/dry_run/data/meta` 并只把业务 data 放到 stdout；[error contract][lark-error-contract]把错误定义为闭集 category + wire-stable subtype，区分 message、hint、param、retryable 和 upstream log id，错误 JSON 写 stderr，exit code 由 category 统一映射。[root dispatcher][lark-root]还区分 typed error、stdout 已含完整结果的 predicate、batch partial failure 和 Cobra usage error。[service tests][lark-service-tests]直接验证 dry-run envelope、路径注入拒绝、stdin 冲突、分页流错误不污染 NDJSON 等机器合同。

[shortcut runner][lark-shortcut-runner]把每个命令标记为 read/write/high-risk-write，高风险写要求 `--yes`，`--dry-run` 返回真实 method/URL/params/body 预览；scope 在执行前检查。[Workspace 和 strict mode][lark-workspace]把 agent workspace 配置与 local profile 隔离，并可把可见命令树裁剪到单一 identity。可迁移的不是 Lark 的 user/bot 结构，而是统一执行管线、fail-closed identity、机器可恢复错误和“传入但无法遵守的 flag 必须报错”。

lark-cli 仍没有适用于 ClinMesh 的通用写入可靠性。[Whiteboard update][lark-idempotency]显式传递 upstream `client_token`，[Base workflow create][lark-workflow-idempotency]要求调用者提供唯一 `client_token`，但 idempotency 不是所有 write command 的统一框架字段；`--yes` 也只是本地确认信号。ClinMesh 必须把 idempotency、expected version、review grant 和 receipt 作为每个写 operation 的 catalog 合同，不能依赖某个 endpoint 恰好支持 token，也不能用 `--yes` 代替临床复核。

## Multica：把复杂副作用写进 skill，把 Agent 身份绑定在服务端

### 业务命令与 skill

[Multica root][multica-main]和 [issue command][multica-issue-cli]使用 Cobra 手工注册命令与 flags；每个 RunE 自行解析输入、解析人类可读 ID、构造 HTTP path/body 和选择 table/JSON 输出。它不是 schema-first catalog，但这种手写方式可以把高价值业务语义直接暴露出来，例如 `issue status`、`--no-start`、stage barrier、comment bounded reads，以及禁止外部工作目录文件的说明。

Multica 把 flags 无法完整表达的副作用放进 built-in skills。[working-on-issues skill][multica-working-skill]解释 PR link 与 close intent、status transition 如何触发 Agent、`todo` 与 `backlog` 对任务启动的差异、何时必须带 `--no-start`，并提供 incorrect/correct 对照。[built-in loader][multica-builtin-skills]把这些 skill 编译进服务端并给每个 Agent 追加；[skill contract tests][multica-builtin-skill-tests]限制 description/body 大小、验证严格 YAML，并把 skill 中的关键断言与真实 parser 或业务代码联动。相比只从 command docstring 生成目录，这种 source map + executable eval 更能防止 Agent 指引漂移。

ClinMesh 可吸收的机制是：skill 记录状态副作用、跨命令次序、禁止动作和反例；每条非显然业务断言链接 owner 源码或文档，并用 contract test 验证。它不能成为 schema 或业务状态机的第二 owner。

### 受信上下文

[CLI context resolver][multica-cli-context]在 daemon-managed task 中要求 `mat_` task token，不回退到人类 profile；Workspace 和 token 必须来自 daemon 注入环境，human-only local command 被拒绝。[API client][multica-api-client]虽然发送 Workspace、Agent 和 Task headers，但[服务端 auth middleware][multica-auth]根据 task token 中绑定的 user/agent/task/workspace 覆盖客户端值，并先删除客户端伪造的 actor source。这是三个参考里最接近 ClinMesh “模型参数不能切换受信 context”要求的实现。

ClinMesh 应保留这个方向但使用自身 IdentityService、Workspace/Epoch、Practitioner Role、Patient/Encounter capability 和 ReviewGrant。CLI 可以接受目标资源标识作为业务输入，但不能通过 `--actor`、`--role`、`--workspace` 或 `--epoch` 自我授予权限；服务端必须重新解析并在响应中回显实际使用的 context reference。

### 不统一之处

[Multica output helper][multica-output]只提供 direct JSON/table writer；不同命令的 JSON 是 endpoint object、array 或局部 wrapper，默认 output 也因命令而异。[error layer][multica-errors]提供稳定的 network/auth/not-found/validation exit tier和友好本地化文本，但默认 stderr 不是机器 JSON，也没有稳定 subtype、param、retryable、receipt 或 ambiguous 字段。它适合人类 CLI 和平台 Agent 在 skill 指导下使用，不足以直接成为 ClinMesh 临床 adapter wire。

[issue create][multica-issue-create]会在创建前读取并校验全部附件，降低“创建成功后附件失败导致整条命令重试”的风险；但创建后的附件失败只写 stderr warning 并 exit 0，避免重复 issue，却没有统一 partial-success envelope 或 receipt lookup。这个局部策略揭示了真实问题：Agent 会因不确定结果重试。ClinMesh 的解决方案应是原子 Command、持久 receipt 和 explicit ambiguous reconciliation，而不是针对每个命令选择 warning/exit 0。

## ClinMesh CLI adapter 建议

### 设计原则

1. `HisOperationCatalog` 是 command name、mode、schema、risk、context、idempotency 和 owner 的唯一来源；CLI 注册、HTTP route binding、help/schema 和 contract tests 都检查同一个 definition，不从 Cobra/Click 声明反向推导业务合同。
2. 命令以医院任务和状态转换命名，不以数据库表或通用 CRUD 命名。查询、draft mutation、preview 和 final command 是不同 mode，不能用一个 `update --dry-run/--yes` 混合。
3. 先读后写是可执行合同。每个 mutation help 和 error 指向最窄的 context/status/schema 查询；unknown command/flag/enum 返回机器候选，不依赖 message 文本让 Agent 猜。
4. JSON 是默认输出，table 只通过 `--output table` 显式选择。stdout 只承载成功或完整 batch result，stderr 只承载结构化错误、warning 和 progress；TTY spinner 不进入 pipe。
5. context authority 在服务端。CLI profile 只选择 endpoint 和 credential；Actor、Workspace/Epoch、Practitioner Role 和 grant 从认证状态重算。目标 Patient/Encounter 标识不等于授权，response 回显实际 context ref 与版本。
6. 所有 write operation 要求 idempotency key；修改既有资源还要求 expected version 或绑定 preview version。human/test CLI 可以显式接收并复用 key，Agent adapter 必须从受信调用上下文派生且不把它暴露为模型参数。CLI 不对“可能已发送”自动重试；`ambiguous` 只能通过 receipt/ActionTrace/canonical state 对账。
7. 临床最终提交要求 server-side one-shot ReviewGrant。`--yes` 可以用于本地非临床运维确认，但不能替代医生复核、签署责任或 permission re-check。
8. 不提供 raw URL、任意 method/path/body、SQL、FHIR Bundle、任意 JSON Patch 或通用 command executor。复杂输入通过 `--input @file` 或 stdin 进入已知 schema，路径和大小受限，secret 不出现在 argv。

### 最小命令树

以下命令名是 catalog projection 的验收草案，不声明当前已经实现；正式 operationId 和层级仍由 `HisOperationCatalog` owner 决定。

```text
his catalog list [--mode query|draft|preview|command] [--output json]
his schema <operation-id> [--output json]
his context show [--output json]

his patient summary get [--patient-id <id>] [--output json]
his diagnosis catalog search --query <text> [--limit <n>] [--output json]

his encounter diagnosis draft-set --input @diagnosis.json --expected-version <v> --idempotency-key <key>
his encounter lab-order preview --input @lab-order.json --expected-version <v> --idempotency-key <key>

his command submit --preview-id <id> --review-grant <one-shot-ref> --idempotency-key <key>
his command receipt get --request-id <id> [--output json]
```

`command submit` 不是任意 operation executor：它只能提交服务端已生成且绑定 operation、input hash、resource versions、Actor context 和短期 ReviewGrant 的 preview。若首版 CLI 只用于 catalog/query/draft/preview 测试，应暂不注册该命令。

### JSON 合同

成功 envelope 建议保持所有 operation 一致，query 可省略 `receipt`，但不能改变顶层含义：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "operation": {
    "id": "outpatient.diagnosis.draft.set",
    "version": 1,
    "mode": "draft"
  },
  "context": {
    "workspaceId": "...",
    "epoch": "...",
    "actorRole": "outpatient-doctor",
    "patientId": "...",
    "encounterId": "..."
  },
  "data": {},
  "receipt": {
    "requestId": "...",
    "status": "committed",
    "auditId": "...",
    "actionTraceId": "..."
  }
}
```

错误 envelope 写 stderr，message 可改写，调用者只按稳定 `type/code` 和声明的扩展字段分支：

```json
{
  "ok": false,
  "schemaVersion": 1,
  "operationId": "outpatient.diagnosis.draft.set",
  "error": {
    "type": "conflict",
    "code": "version_conflict",
    "message": "diagnosis draft changed since it was read",
    "hint": "read the current draft and create a new preview",
    "param": "expectedVersion",
    "retryable": false,
    "outcome": "definitely_not_sent"
  },
  "correlationId": "..."
}
```

若请求可能已到达服务端，`error.outcome` 必须为 `ambiguous`，并返回可供 `command receipt get` 查询的 `requestId` 或 correlation reference；不能提示直接重试。顶层字段沿用 ClinMesh 现有 camelCase wire 约定，不为 CLI 另造一套命名风格。

### 退出码

退出码保持粗粒度，精确分支仍读 `error.type/code`：

| Exit | 类别 | 自动动作 |
| --- | --- | --- |
| `0` | 成功 | 读取 stdout envelope |
| `1` | 已知业务/API 拒绝 | 读取 code/hint，不盲重试 |
| `2` | 参数或 schema validation | 修正 `param` 后重试 |
| `3` | authentication/authorization/context | 重新认证或请求用户切换受信 context |
| `4` | transport 且可证明未发送 | 仅在 retry policy 允许时用同一 idempotency key 重试 |
| `5` | stale/version conflict | 重新读取状态并重新 preview，不重放旧 input |
| `6` | policy/review required | 停止并取得真实 ReviewGrant；不能自动追加 `--yes` |
| `7` | ambiguous outcome | 查询 receipt/ActionTrace/canonical state，禁止立即重发 |
| `8` | internal/protocol | 停止自动操作，带 correlation id 报告 |

### 分阶段验收

| 阶段 | 命令范围 | 必须通过的验收 |
| --- | --- | --- |
| 0：Catalog projection | `catalog list`、`schema`、`context show` | 每个公开 operation 恰有一个 handler owner；CLI/help/HTTP schema hash 与 catalog 一致；unknown path/flag/enum 返回候选；CLI 不出现未实现 capability |
| 1：只读纵向切片 | patient summary、diagnosis catalog search | installed subprocess 通过真实 HTTP adapter读取合成 Scenario；stdout 只含 JSON；认证、Workspace/Epoch、role、Patient/Encounter 越界逐项 fail closed；分页和空结果 shape 固定 |
| 2：Draft 与 preview | diagnosis draft-set、lab-order preview | nested input schema、safe file/stdin、expected version、同 idempotency key replay、stale draft/resource/context、permission changed、preview 无最终业务副作用全部有测试 |
| 3：受复核 Command | preview-bound submit、receipt get | one-shot ReviewGrant、input hash/version binding、成功 receipt replay、并发幂等竞争、审计/ActionTrace 原子性、definitely-not-sent/ambiguous 分流和 crash 后 reconciliation 全部通过；没有 `--yes` 绕过路径 |
| 4：可发现性与 skill | domain skill、affordance、source-map eval | skill 只写意图/前置/副作用/反例并链接 schema owner；skill 命令示例真实存在；业务状态副作用由测试关联 owner；description 与正文有预算 |

每个行为切片至少包含 catalog conformance、CLI parser unit、installed subprocess、HTTP adapter 和服务端 Command/Query contract 五类证据。涉及最终 artifact 或投影时还要验证业务可观察结果，不能把 exit 0 或 JSON 可解析当成业务成功的充分条件。

## 不应照搬

- 不照搬 CLI-Anything 的 stateful REPL、项目 JSON 权威状态、undo/redo 或“执行但不保存”的 dry-run；医院状态由服务端持久化与 CommandExecutor 拥有。
- 不照搬 lark-cli 的 raw API escape hatch、任意未声明 `--params/--data` passthrough 或 `--yes` 高风险确认；开放平台覆盖目标与临床最小权限目标不同。
- 不照搬 Multica 手写 command/path/body 的多处映射，也不以 skill/source-map 人工同步代替 catalog projection；它们适合记录业务解释，不适合拥有 schema。
- 不让产品内临床 Agent 通过 shell 调 CLI。CLI 是 human/test adapter 和合同探针；Cordis tool adapter 仍直接调用 typed client，并保留 DSH callId、capability、deadline、取消和 receipt 关联。
- 不把“JSON 输出”“非零 exit”或“有 E2E test”当作 Agent-safe 的充分条件。受信 context、幂等、expected version、ambiguous outcome、审计和 server-side review 都必须同时成立。

## 固定源码

### CLI-Anything

- [源码树][cli-anything-tree]
- [生成方法与架构规范][cli-anything-harness]
- [skill generator][cli-anything-skill-generator]
- [auto-save 与 dry-run guide][cli-anything-dry-run]
- [Blender CLI][cli-anything-blender-cli]
- [Blender session 和文件锁][cli-anything-blender-session]
- [Blender 真实 backend][cli-anything-blender-backend]
- [Blender installed CLI/真实 backend E2E][cli-anything-blender-e2e]
- [ChromaDB commands][cli-anything-chromadb-collections]
- [ChromaDB E2E][cli-anything-chromadb-e2e]
- [JumpServer 手写 skill][cli-anything-jumpserver-skill]

### lark-cli

- [源码树][lark-tree]
- [root quickstart、错误 dispatch 与 suggestions][lark-root]
- [declarative Shortcut][lark-shortcut-types]
- [Shortcut 执行管线][lark-shortcut-runner]
- [元数据生成 service command][lark-service-command]
- [schema command][lark-schema]
- [affordance 格式][lark-affordance]
- [Task domain skill][lark-task-skill]
- [success envelope][lark-output-envelope]
- [error contract 与 exit codes][lark-error-contract]
- [workspace 与 strict mode][lark-workspace]
- [service contract tests][lark-service-tests]
- [Whiteboard idempotency token][lark-idempotency]
- [Base workflow client token][lark-workflow-idempotency]

### Multica

- [源码树][multica-tree]
- [root command 与 help][multica-main]
- [手写 issue command][multica-issue-cli]
- [issue create 的 prevalidation 与 partial success][multica-issue-create]
- [CLI JSON/table output helper][multica-output]
- [CLI error 与 exit code][multica-errors]
- [CLI task context resolution][multica-cli-context]
- [API client context headers][multica-api-client]
- [服务端 task token context overwrite][multica-auth]
- [built-in skill loader][multica-builtin-skills]
- [working-on-issues skill][multica-working-skill]
- [built-in skill contract tests][multica-builtin-skill-tests]

[cli-anything-tree]: https://github.com/HKUDS/CLI-Anything/tree/810c18b0d1ab9b234bc996c9fd999318523a3ef0
[cli-anything-harness]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/cli-anything-plugin/HARNESS.md#L10-L74
[cli-anything-testing]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/cli-anything-plugin/HARNESS.md#L406-L545
[cli-anything-skill-generator]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/cli-anything-plugin/skill_generator.py#L248-L374
[cli-anything-dry-run]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/cli-anything-plugin/guides/auto-save-dry-run.md#L1-L80
[cli-anything-blender-cli]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/blender/agent-harness/cli_anything/blender/blender_cli.py#L39-L228
[cli-anything-blender-session]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/blender/agent-harness/cli_anything/blender/core/session.py#L10-L155
[cli-anything-blender-backend]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/blender/agent-harness/cli_anything/blender/utils/blender_backend.py#L14-L128
[cli-anything-blender-e2e]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/blender/agent-harness/cli_anything/blender/tests/test_full_e2e.py#L591-L684
[cli-anything-chromadb-collections]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/chromadb/agent-harness/cli_anything/chromadb/core/collections.py#L9-L117
[cli-anything-chromadb-e2e]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/chromadb/agent-harness/cli_anything/chromadb/tests/test_full_e2e.py#L44-L204
[cli-anything-jumpserver-skill]: https://github.com/HKUDS/CLI-Anything/blob/810c18b0d1ab9b234bc996c9fd999318523a3ef0/skills/cli-anything-jumpserver/SKILL.md#L13-L350
[lark-tree]: https://github.com/larksuite/cli/tree/4e0a6a988cf32b26219b3425f6dbb7ce8332b292
[lark-root]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/cmd/root.go#L31-L304
[lark-shortcut-types]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/shortcuts/common/types.go#L18-L89
[lark-shortcut-runner]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/shortcuts/common/runner.go#L841-L1013
[lark-service-command]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/cmd/service/service.go#L188-L453
[lark-schema]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/cmd/schema/schema.go#L22-L143
[lark-affordance]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/affordance/README.md#L1-L66
[lark-task-skill]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/skills/lark-task/SKILL.md#L11-L168
[lark-output-envelope]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/internal/output/envelope.go#L6-L35
[lark-error-contract]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/errs/ERROR_CONTRACT.md#L11-L147
[lark-workspace]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/internal/core/workspace.go#L14-L93
[lark-service-tests]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/cmd/service/service_test.go#L204-L426
[lark-idempotency]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/shortcuts/whiteboard/whiteboard_update.go#L40-L130
[lark-workflow-idempotency]: https://github.com/larksuite/cli/blob/4e0a6a988cf32b26219b3425f6dbb7ce8332b292/shortcuts/base/workflow_create.go#L16-L95
[multica-tree]: https://github.com/multica-ai/multica/tree/722bde9d1818dbe5c49e60a8c57a283712646457
[multica-main]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/cmd/multica/main.go#L20-L114
[multica-issue-cli]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/cmd/multica/cmd_issue.go#L166-L609
[multica-issue-create]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/cmd/multica/cmd_issue.go#L1109-L1265
[multica-output]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/cli/output.go#L11-L26
[multica-errors]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/cli/errors.go#L368-L548
[multica-cli-context]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/cmd/multica/cmd_agent.go#L248-L507
[multica-api-client]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/cli/client.go#L46-L215
[multica-auth]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/middleware/auth.go#L51-L115
[multica-builtin-skills]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/service/builtin_skills.go#L10-L71
[multica-working-skill]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/service/builtin_skills/multica-working-on-issues/SKILL.md#L19-L320
[multica-builtin-skill-tests]: https://github.com/multica-ai/multica/blob/722bde9d1818dbe5c49e60a8c57a283712646457/server/internal/service/builtin_skills_test.go#L11-L180
