# DeepSeek Harness × AG-UI Plugin 设计报告

> 文档类型：技术架构 / 协议适配器设计
> 目标组件：`dsh-plugin-ag-ui`
> 目标：让 DeepSeek Harness（DSH）可以作为 AG-UI Agent Backend，被 React / CopilotKit / 其他 AG-UI Client 直接驱动，并支持前端状态感知、前端 Tool 调用、流式消息、HITL 与持续 Session。

---

# 1. 背景与目标

当前管理系统采用：

- 前端：React + TypeScript
- 后端：Hono + TypeScript
- Agent Runtime：DeepSeek Harness（DSH）

后端业务 API 可以通过 CLI / Tool / Plugin 的形式暴露给 DSH，因此后端能力接入并不复杂。

真正困难的是前端：

- Agent 需要知道用户当前所在页面；
- Agent 需要知道当前页面正在编辑什么；
- Agent 需要知道有哪些前端动作当前可执行；
- Agent 可以帮助用户填写表单；
- Agent 修改的是前端草稿状态，而不是直接提交业务数据；
- 用户仍保留最终确认和提交权；
- Agent 需要与 React 页面形成实时、动态、可控的交互关系。

AG-UI 正好提供了 Agent Backend 与 Frontend 之间的协议层，因此整体方向是：

```text
React / CopilotKit / AG-UI Client
              │
              │ AG-UI Protocol
              ▼
        dsh-plugin-ag-ui
              │
              │ DSH Agent API
              ▼
       DeepSeek Harness
              │
              ├── Backend Tools
              ├── Hono APIs
              ├── CLI Tools
              └── Other DSH Plugins
```

因此，`dsh-plugin-ag-ui` 的定位不是一个普通 Tool Plugin，而是：

> **DeepSeek Harness 的 AG-UI Protocol Gateway / Adapter。**

---

# 2. 核心架构结论

整个设计最关键的结论有三个。

## 2.1 AG-UI Thread 应映射为 DSH Session

推荐关系：

```text
AG-UI Thread
    =
DSH Agent + Session
```

例如：

```text
AG-UI threadId: thread-123
        │
        ▼
ThreadRegistry
        │
        ▼
DSH Session: session-abc
DSH Agent:   session-abc
```

这样可以长期保留：

- 对话历史；
- Agent 状态；
- Tool 环境；
- 页面上下文；
- Session Event Log；
- Agent Memory / Goal / Plugin 状态。

---

## 2.2 AG-UI Run 不等于 DSH Turn

这是整个 Adapter 最容易设计错的地方。

错误理解：

```text
AG-UI Run #1
    =
DSH Turn #1
```

正确理解：

```text
AG-UI Thread
    =
DSH Session

但：

AG-UI Run
    ≠
DSH Turn
```

原因是 AG-UI 的一个 Run 是一个 **Client / HTTP execution boundary**，而 DSH Turn 是 Agent 内部的 **reasoning boundary**。

特别是在 Frontend Tool 场景下，一个 DSH Turn 可能跨越多个 AG-UI Run。

---

## 2.3 Frontend Tool 必须通过 Park / Resume 机制桥接

这是整个插件的核心。

AG-UI Frontend Tool 的标准语义大致是：

```text
Agent 调用 Frontend Tool
        ↓
AG-UI 输出 TOOL_CALL_*
        ↓
当前 AG-UI Run 结束
        ↓
浏览器执行 Tool
        ↓
下一次 Run 带 ToolMessage
        ↓
Agent 继续
```

而 DSH 默认 Tool 生命周期是：

```text
Model
  ↓
tool/call
  ↓
tool.execute()
  ↓
tool/result
  ↓
next model step
```

这两者不是天然一致的。

最合适的适配方式不是提前结束 DSH Turn，而是：

```text
Frontend Tool execute()
        ↓
返回一个尚未 resolve 的 Promise
        ↓
DSH Tool Execution 被 park
        ↓
AG-UI 当前 Run 结束
        ↓
浏览器执行 Tool
        ↓
下一次 Run 携带 ToolMessage
        ↓
Adapter resolve Promise
        ↓
DSH Tool 返回真实结果
        ↓
DSH 自动 append tool/result
        ↓
同一个 DSH Turn 继续
```

因此：

> **Frontend Tool Bridge 是 `dsh-plugin-ag-ui` 最核心的模块。**

---

# 3. 整体系统架构

推荐架构如下：

```text
┌─────────────────────────────────────────────────────┐
│                    React Frontend                   │
│                                                     │
│  Router / Page State                                │
│  Form State / Zustand / TanStack Form               │
│  CopilotKit / AG-UI Client                          │
│  Frontend Actions / HITL                            │
└─────────────────────┬───────────────────────────────┘
                      │
                      │ AG-UI
                      │ RunAgentInput
                      │ SSE Events
                      ▼
┌─────────────────────────────────────────────────────┐
│                Hono Application Backend             │
│                                                     │
│  Auth                                               │
│  Tenant                                             │
│  RBAC                                               │
│  Audit                                              │
│  Proxy / BFF                                        │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│                dsh-plugin-ag-ui                     │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ Gateway                                       │  │
│  │ HTTP / SSE AG-UI Endpoint                    │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ ThreadRegistry                                │  │
│  │ AG-UI Thread ↔ DSH Agent / Session           │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ RunController                                 │  │
│  │ 管理一个 AG-UI Run 的生命周期                 │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ ContextAdapter                                │  │
│  │ AG-UI Context → agent.inject()               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ MessageAdapter                                │  │
│  │ User / Tool Message → DSH                    │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ FrontendToolBridge                            │  │
│  │ AG-UI Client Tool ↔ DSH Scoped Tool          │  │
│  │ Park / Resume                                 │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ EventMapper                                   │  │
│  │ DSH session/event → AG-UI Event              │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│                 DeepSeek Harness                    │
│                                                     │
│  Agent Registry                                     │
│  Session Event Log                                  │
│  Tool Registry                                      │
│  Agent Loop                                         │
│  System Prompt                                      │
│  Model Adapter                                      │
│                                                     │
│  Backend Tools                                      │
│    ├── HIS APIs                                     │
│    ├── CLI Tools                                    │
│    ├── Database                                     │
│    ├── Search                                       │
│    └── Other Plugins                                │
└─────────────────────────────────────────────────────┘
```

---

# 4. 插件模块设计

推荐目录：

```text
dsh-plugin-ag-ui/
├── src/
│   ├── index.ts
│   ├── gateway.ts
│   ├── thread-registry.ts
│   ├── run-controller.ts
│   ├── frontend-tool-bridge.ts
│   ├── event-mapper.ts
│   ├── context-adapter.ts
│   ├── message-adapter.ts
│   ├── errors.ts
│   └── types.ts
├── tests/
│   ├── thread-registry.spec.ts
│   ├── frontend-tool-bridge.spec.ts
│   ├── event-mapper.spec.ts
│   └── integration.spec.ts
├── package.json
├── tsconfig.json
└── README.md
```

模块职责：

| 模块 | 职责 |
|---|---|
| `index.ts` | Cordis Plugin 入口 |
| `gateway.ts` | 接收 AG-UI 请求，输出 SSE |
| `thread-registry.ts` | 管理 Thread ↔ Agent/Session |
| `run-controller.ts` | 管理单次 AG-UI Run |
| `frontend-tool-bridge.ts` | 管理前端 Tool 的 Park / Resume |
| `event-mapper.ts` | DSH Event → AG-UI Event |
| `context-adapter.ts` | AG-UI Context → DSH Context |
| `message-adapter.ts` | AG-UI Messages → DSH Input |
| `errors.ts` | Protocol / Runtime Error |
| `types.ts` | 内部类型 |

---

# 5. Plugin Entry

DSH Plugin 应保持非常薄。

示意：

```ts
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"

export const name = "ag-ui"

export const inject = [
  "agents",
  "tools",
  "webServer",
]

export interface Config {
  path: string

  provider?: string
  model?: string

  frontendToolTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  path: z.string().default("/ag-ui"),
  provider: z.string(),
  model: z.string(),
  frontendToolTimeoutMs: z.number().default(300_000),
})

export function apply(
  ctx: Context,
  config: Config,
): void {
  const registry =
    new ThreadRegistry(ctx, config)

  const gateway =
    new AguiGateway({
      ctx,
      config,
      registry,
      contextAdapter:
        new ContextAdapter(),
      toolBridge:
        new FrontendToolBridge(),
      eventMapper:
        new DshEventMapper(),
    })

  ctx.webServer.register({
    kind: "exact",
    path: config.path,
    handler:
      gateway.handle.bind(gateway),
  })
}
```

核心逻辑不应该堆积在 `index.ts`。

---

# 6. 为什么直接使用 DSH WebServer

推荐：

```text
DSH Process

ctx.webServer
├── /...
├── /...
└── /ag-ui
```

而不是插件自己启动：

```text
Express
Hono
Fastify
```

因为 Plugin 本质上应该复用 Harness 自己的 Host Runtime。

建议系统边界：

```text
Browser
   ↓
Hono Main Backend
   ↓
Auth / Tenant / RBAC / Audit
   ↓
DSH /ag-ui
```

即：

- Hono：业务 Backend / BFF / Security Boundary
- DSH Plugin：Agent Protocol Gateway

---

# 7. AG-UI 输入模型

Adapter 主要消费：

```ts
interface RunAgentInput {
  threadId: string
  runId: string
  parentRunId?: string

  state?: unknown

  messages: Message[]
  tools: Tool[]
  context: Context[]

  forwardedProps?: unknown

  resume?: ResumeEntry[]
}
```

其中最重要的是：

```text
threadId
messages
tools
context
```

第一版可以暂时忽略：

```text
state
resume
复杂 forwardedProps
```

---

# 8. ThreadRegistry

## 8.1 目标

负责：

```text
AG-UI Thread
      ↕
DSH Agent / Session
```

建议：

```ts
interface ThreadBinding {
  key: string

  threadId: string

  sessionId: string

  agent: Agent

  principal: Principal

  seenMessages:
    Set<string>

  frontendTools:
    Map<string, FrontendToolRegistration>

  pendingFrontendCalls:
    Map<string, PendingFrontendCall>

  activeRun?:
    RunController
}
```

---

## 8.2 为什么不能直接使用 threadId 作为 SessionId

因为：

```text
threadId
```

由 Client 提供。

如果直接：

```text
threadId = sessionId
```

则存在跨用户 / 跨租户碰撞。

推荐生成：

```text
tenantId
+
userId
+
threadId
        ↓
internal key
        ↓
DSH SessionId
```

例如：

```ts
const bindingKey =
  `${tenantId}:${userId}:${threadId}`

const sessionId =
  hash(bindingKey)
```

其中：

```text
tenantId
userId
```

必须来自可信认证层，而不是：

```text
context
forwardedProps
request body
```

---

# 9. 创建 DSH Agent

第一次收到新 Thread：

```ts
const handle =
  await ctx.agents.create({
    sessionId,

    agentOptions: {
      provider: config.provider,
      model: config.model,
    },

    setup(agentCtx) {
      // agent scoped setup
    },
  })

binding.agent =
  handle.agent
```

推荐所有 Frontend Tools 都注册到：

```text
agent.ctx
```

而不是：

```text
global ctx
```

原因：

- 每个页面暴露的能力不同；
- 每个用户能力不同；
- 每个 Thread 的 Tool Set 不同；
- Agent-local Tool 不应污染整个 Harness。

---

# 10. ContextAdapter

## 10.1 目标

React 页面将当前 UI Context 传给 Agent。

例如：

```json
[
  {
    "description": "Current HIS page",
    "value": "{\"page\":\"consultation\",\"patientId\":\"P001\",\"visitId\":\"V001\",\"draftVersion\":17}"
  }
]
```

Adapter 转换为：

```text
agent.inject()
```

---

## 10.2 推荐模型

```ts
function injectContext(
  agent: Agent,
  contexts: AguiContext[],
) {
  if (contexts.length === 0)
    return

  const sections =
    contexts.map((item) => ({
      name: item.description,
      text: item.value,
    }))

  const text =
    sections
      .map(
        ({ name, text }) =>
          `## ${name}\n${text}`
      )
      .join("\n\n")

  agent.inject(
    createUserMessage({
      content: [
        {
          type: "text",
          text,
        },
      ],

      source: {
        kind: "plugin",
        plugin: "ag-ui",
        form: "snapshot",
        sections,
      },
    })
  )
}
```

---

# 11. 为什么必须 `inject()` 后再 `followup()`

DSH 中：

```text
agent.inject()
```

只表示：

> 把 Context 放入下一个 Step。

它不会主动启动 Agent。

而：

```text
agent.followup()
```

才会唤醒 Agent。

因此顺序应该是：

```ts
injectContext(
  agent,
  input.context
)

agent.followup(
  userMessage
)
```

而不是反过来。

否则当前请求可能来不及看到最新页面 Context。

---

# 12. MessageAdapter

## 12.1 不可以把整个 messages 全量重新送给 DSH

AG-UI 每个 Run 可能携带：

```text
完整 conversation history
```

而 DSH 自己已经通过 Session Event Log 管理历史。

错误：

```ts
for (
  const message
  of input.messages
) {
  agent.followup(...)
}
```

这样会重复写历史。

---

## 12.2 使用 Message ID 去重

```ts
seenMessages:
  Set<string>
```

筛选：

```ts
const newMessages =
  input.messages.filter(
    message =>
      !binding
        .seenMessages
        .has(message.id)
  )
```

处理成功后：

```ts
binding
  .seenMessages
  .add(message.id)
```

---

## 12.3 第一版建议的约束

普通用户 Run：

```text
最多消费一个新的 UserMessage
```

Frontend Tool Resume Run：

```text
消费一个或多个 ToolMessage
```

不要第一版支持大量复杂 message reconciliation。

---

# 13. Frontend Tool 的本质

例如当前问诊页面暴露：

```text
his_patch_consultation_draft
his_focus_consultation_field
his_open_lab_panel
```

这些 Tool 不在 DSH Server 执行。

它们真正执行在：

```text
React Browser
```

因此它们是：

> Client-owned Tool Execution

AG-UI Client 每次 Run 都可以动态传入当前页面可用的 tools。

---

# 14. Frontend Tool → DSH Scoped Tool

例如：

```ts
function registerFrontendTool(
  agent: Agent,
  tool: AguiTool,
  bridge: FrontendToolBridge,
) {
  return agent.ctx.tools.register({
    name:
      tool.name,

    description:
      tool.description,

    parameters:
      tool.parameters,

    output: {
      schema: {
        type: "string",
      },

      render:
        (_args, value) => [
          {
            type: "text",
            text: value,
          },
        ],
    },

    async execute(
      args,
      exec,
    ) {
      return bridge.execute({
        agent,
        tool,
        args,
        exec,
      })
    },
  })
}
```

---

# 15. Frontend Tool Set 必须动态同步

例如：

用户在：

```text
PatientListPage
```

前端送：

```text
his_open_patient
his_filter_patient
```

进入：

```text
ConsultationPage
```

前端变成：

```text
his_patch_consultation_draft
his_focus_consultation_field
his_open_lab_panel
```

因此 Agent 的 Tool Set 应跟随页面变化。

---

# 16. Tool Diff，而不是全部重新注册

维护：

```ts
interface FrontendToolRegistration {
  fingerprint: string
  dispose: () => void
}
```

每个 Run：

```text
old tools
    vs
new tools
```

执行：

```text
unchanged
→ ignore

new
→ register

removed
→ dispose

changed
→ dispose + register
```

Fingerprint：

```ts
sha256(
  JSON.stringify({
    name:
      tool.name,

    description:
      tool.description,

    parameters:
      tool.parameters,
  })
)
```

---

# 17. Backend Tool 与 Frontend Tool 必须隔离

推荐能力环境：

```text
DSH Agent Tool Environment

Global / Backend Tools
├── his_get_patient
├── his_get_labs
├── his_get_medications
├── search_guideline
└── query_database

Agent-local Frontend Tools
├── his_patch_consultation_draft
├── his_focus_field
└── his_open_panel
```

Backend Tools 不应该由：

```text
RunAgentInput.tools
```

传递。

`RunAgentInput.tools` 只表示：

> 当前 Client 提供给 Agent 的能力。

---

# 18. Tool Name Collision

这是安全边界。

如果 Backend 已经存在：

```text
his_update_patient
```

Browser 不允许注册同名 Frontend Tool。

否则 Agent-scoped Tool 可能 shadow global tool。

因此必须：

```ts
if (
  backendToolExists(
    tool.name
  )
) {
  throw new Error(
    "FRONTEND_TOOL_NAME_COLLISION"
  )
}
```

更推荐名称约定：

```text
ui_*
```

例如：

```text
ui_patch_consultation_draft
ui_focus_field
ui_open_panel
```

进一步减少冲突概率。

---

# 19. FrontendToolBridge

## 19.1 PendingFrontendCall

```ts
interface PendingFrontendCall {
  callId: string

  toolName: string

  args: unknown

  resolve:
    (value: string) => void

  reject:
    (error: Error) => void

  createdAt: number
}
```

---

## 19.2 execute()

```ts
class FrontendToolBridge {

  async execute({
    binding,
    tool,
    args,
    exec,
  }): Promise<string> {

    const deferred =
      Promise.withResolvers<string>()

    const pending: PendingFrontendCall = {
      callId:
        exec.callId,

      toolName:
        tool.name,

      args,

      resolve:
        deferred.resolve,

      reject:
        deferred.reject,

      createdAt:
        Date.now(),
    }

    binding
      .pendingFrontendCalls
      .set(
        exec.callId,
        pending,
      )

    binding
      .activeRun
      ?.handoffToFrontend(
        exec.callId
      )

    const onAbort = () => {
      pending.reject(
        new Error(
          "Frontend tool aborted"
        )
      )
    }

    exec.signal.addEventListener(
      "abort",
      onAbort,
      { once: true },
    )

    try {
      return await deferred.promise
    } finally {
      exec.signal.removeEventListener(
        "abort",
        onAbort
      )

      binding
        .pendingFrontendCalls
        .delete(
          exec.callId
        )
    }
  }
}
```

这就是整个 Adapter 的核心。

---

# 20. Parked DSH Turn

执行到：

```ts
await deferred.promise
```

时：

```text
DSH Agent
=
running
```

但：

```text
Tool Execution
=
waiting for browser
```

与此同时：

```text
AG-UI Run #1
=
可以结束
```

因此：

> DSH execution lifecycle 和 HTTP lifecycle 必须解耦。

这就是 `RunController` 存在的原因。

---

# 21. 完整 Frontend Tool 流程

```text
┌────────────────────────────────────────────┐
│                AG-UI Run #1               │
└───────────────────┬────────────────────────┘
                    │
                    ▼
               RUN_STARTED
                    │
                    ▼
               agent.followup()
                    │
                    ▼
┌────────────────────────────────────────────┐
│                 DSH Turn                  │
│                                            │
│ Model                                      │
│   │                                        │
│   └── ui_patch_form()                      │
│              │                             │
│              ▼                             │
│       FrontendToolBridge                   │
│              │                             │
│              ▼                             │
│        await Promise                       │
│              │                             │
│          [ PARKED ]                        │
└──────────────┼─────────────────────────────┘
               │
               ▼
        TOOL_CALL_START
        TOOL_CALL_ARGS
        TOOL_CALL_END
        RUN_FINISHED
               │
               ▼
┌────────────────────────────────────────────┐
│                 Browser                   │
│                                            │
│ Zustand / React State                      │
│ patch form                                 │
│ rerender                                   │
│                                            │
│ return tool result                         │
└───────────────────┬────────────────────────┘
                    │
                    ▼
             AG-UI Run #2
                    │
                    ▼
              ToolMessage
                    │
                    ▼
        pending.resolve(...)
                    │
                    ▼
┌────────────────────────────────────────────┐
│             SAME DSH Turn                 │
│                                            │
│ Tool Promise resolves                      │
│        │                                   │
│        ▼                                   │
│ tool/result                                │
│        │                                   │
│        ▼                                   │
│ next model step                            │
│        │                                   │
│        ▼                                   │
│ "已经帮你填写，请确认后提交。"               │
└───────────────────┬────────────────────────┘
                    │
                    ▼
             agent.whenIdle()
                    │
                    ▼
               RUN_FINISHED
```

---

# 22. 为什么不推荐提前结束 DSH Turn

DSH 可以支持 Tool Result 结束 Turn 的机制，但 Frontend Tool 不推荐这样做。

如果：

```text
tool/call
   ↓
fake pending tool/result
   ↓
turn end
```

Browser 后续返回：

```text
real tool result
```

DSH Session Log 中就失去了：

```text
tool/call
  ↕
tool/result
```

的真实关联。

而 Parked Promise 保留：

```text
tool/call
   ↓
Browser
   ↓
真实 Tool Result
   ↓
tool/result
```

这样对：

- Replay
- Audit
- HITL
- Error Recovery
- Tool Trace
- Session Persistence

都更加合理。

---

# 23. ToolMessage Resume

浏览器执行完：

```text
ui_patch_consultation_draft
```

返回：

```json
{
  "success": true,
  "version": 18
}
```

下一次 AG-UI Run：

```json
{
  "role": "tool",
  "toolCallId": "call-123",
  "content": "{\"success\":true,\"version\":18}"
}
```

Gateway：

```ts
const pending =
  binding
    .pendingFrontendCalls
    .get(
      message.toolCallId
    )

if (!pending) {
  // stale / unknown tool result
  return
}

if (message.error) {
  pending.reject(
    new Error(
      message.error
    )
  )
} else {
  pending.resolve(
    message.content
  )
}
```

---

# 24. 一个非常重要的顺序

Run #2 到达后：

```text
1. attach RunController
2. sync frontend tools
3. inject latest context
4. resolve ToolMessage
```

必须是这个顺序。

不能：

```text
resolve ToolMessage
        ↓
DSH 继续生成
        ↓
才 attach SSE
```

否则可能漏掉：

```text
tool/result
step/start
assistant/chunk
```

正确：

```ts
binding.activeRun =
  controller

syncFrontendTools(...)

injectContext(...)

resolveFrontendToolResults(...)
```

---

# 25. RunController

建议：

```ts
class RunController {
  readonly runId: string

  private closed = false

  private intentionalClose =
    false

  emit(
    event: BaseEvent
  ) {
    if (this.closed)
      return

    this.res.write(
      this.encoder.encode(
        event
      )
    )
  }

  finish() {
    if (this.closed)
      return

    this.emit({
      type:
        EventType.RUN_FINISHED,

      threadId:
        this.threadId,

      runId:
        this.runId,
    })

    this.intentionalClose =
      true

    this.closed =
      true

    this.res.end()
  }

  handoffToFrontend(
    toolCallId: string
  ) {
    this.finish()
  }
}
```

---

# 26. 为什么 Thread 状态不能只有 idle / running

Frontend Tool 时会出现：

```text
AG-UI Transport:
idle

DSH Agent:
running

Frontend Tool:
waiting
```

因此推荐分层：

```ts
interface ThreadBinding {
  agent: Agent

  transport: {
    activeRun?:
      RunController
  }

  frontend: {
    pendingCalls:
      Map<string, PendingFrontendCall>
  }
}
```

不要把：

```text
AG-UI Run 状态
```

和：

```text
DSH Agent 状态
```

混成一个字段。

---

# 27. EventMapper

DSH 主要事件：

```text
turn/start
step/start
assistant/chunk
assistant/message
tool/call
tool/result
step/end
turn/end
```

AG-UI 主要事件：

```text
RUN_STARTED
STEP_STARTED
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT
TEXT_MESSAGE_END
TOOL_CALL_START
TOOL_CALL_ARGS
TOOL_CALL_END
TOOL_CALL_RESULT
STEP_FINISHED
RUN_FINISHED
RUN_ERROR
```

---

# 28. 推荐映射

| DSH / Adapter | AG-UI |
|---|---|
| HTTP Run 开始 | `RUN_STARTED` |
| `step/start` | `STEP_STARTED` |
| `assistant/chunk:text-delta` | `TEXT_MESSAGE_CONTENT` |
| 首个 text delta | `TEXT_MESSAGE_START` |
| `assistant/message` | `TEXT_MESSAGE_END` |
| `tool/call` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` |
| backend `tool/result` | `TOOL_CALL_RESULT` |
| `step/end` | `STEP_FINISHED` |
| `agent.whenIdle()` | `RUN_FINISHED` |
| Agent / Protocol Failure | `RUN_ERROR` |

不要：

```text
DSH turn/start
=
AG-UI RUN_STARTED
```

因为两者不是同一层级。

---

# 29. Text Streaming State Machine

需要保存：

```ts
interface StepProjection {
  messageId: string
  textStarted: boolean
}
```

示意：

```ts
case "assistant/chunk": {
  const chunk =
    event.data.chunk

  if (
    chunk.type !==
    "text-delta"
  ) {
    return
  }

  const state =
    getStepProjection(
      event.data.turn,
      event.data.step,
    )

  if (!state.textStarted) {
    state.textStarted =
      true

    sink.emit({
      type:
        EventType.TEXT_MESSAGE_START,

      messageId:
        state.messageId,

      role:
        "assistant",
    })
  }

  sink.emit({
    type:
      EventType.TEXT_MESSAGE_CONTENT,

    messageId:
      state.messageId,

    delta:
      chunk.text,
  })

  break
}
```

Assistant message 完成：

```ts
case "assistant/message": {
  if (
    state.textStarted
  ) {
    sink.emit({
      type:
        EventType.TEXT_MESSAGE_END,

      messageId:
        state.messageId,
    })
  }

  break
}
```

---

# 30. Tool Streaming 第一版不要复杂化

第一版不需要消费：

```text
tool-call-delta
```

可以等 DSH 完整 `tool/call` 后一次性发：

```ts
emit({
  type:
    TOOL_CALL_START,

  toolCallId:
    callId,

  toolCallName:
    name,
})

emit({
  type:
    TOOL_CALL_ARGS,

  toolCallId:
    callId,

  delta:
    arguments,
})

emit({
  type:
    TOOL_CALL_END,

  toolCallId:
    callId,
})
```

V2 再做真正的 Tool Args Streaming。

---

# 31. Backend Tool Result 与 Frontend Tool Result

## Backend Tool

```text
DSH
 ↓
tool/call
 ↓
TOOL_CALL_*
 ↓
Server executes
 ↓
tool/result
 ↓
TOOL_CALL_RESULT
```

正常向 Client 投影：

```text
TOOL_CALL_RESULT
```

---

## Frontend Tool

```text
DSH
 ↓
tool/call
 ↓
TOOL_CALL_*
 ↓
Browser executes
 ↓
ToolMessage
 ↓
DSH tool/result
```

这里建议：

```text
不要再次向 Client 发 TOOL_CALL_RESULT
```

否则 Client 可能重复收到自己刚生成的结果。

因此 ThreadBinding 应记录：

```ts
frontendCallIds:
  Set<string>
```

EventMapper：

```ts
if (
  binding
    .isFrontendToolCall(
      callId
    )
) {
  return
}
```

---

# 32. Run 生命周期

推荐：

```ts
async function run(
  input: RunAgentInput,
  controller: RunController,
) {
  const binding =
    await threads.getOrCreate(
      principal,
      input.threadId,
    )

  binding.activeRun =
    controller

  controller.emit({
    type:
      EventType.RUN_STARTED,

    threadId:
      input.threadId,

    runId:
      input.runId,
  })

  syncFrontendTools(
    binding,
    input.tools,
  )

  injectContext(
    binding.agent,
    input.context,
  )

  const resolvedTools =
    resolveToolMessages(
      binding,
      input.messages,
    )

  if (!resolvedTools) {
    const userMessage =
      findNewUserMessage(
        binding,
        input.messages,
      )

    if (userMessage) {
      binding.agent.followup(
        toDshUserMessage(
          userMessage
        )
      )
    }
  }

  await controller
    .waitUntilBoundary()

  binding.activeRun =
    undefined
}
```

---

# 33. AG-UI Run 的两个正常结束条件

## 33.1 DSH Agent 完成

```text
agent.whenIdle()
      ↓
RUN_FINISHED
```

---

## 33.2 Frontend Tool Handoff

```text
Frontend Tool execute()
      ↓
pending call created
      ↓
handoffToFrontend()
      ↓
RUN_FINISHED
      ↓
HTTP close
```

但 DSH Agent 仍然：

```text
running
```

并等待：

```text
ToolMessage
```

---

# 34. HITL

HITL 不需要特殊 runtime。

普通 Frontend Tool：

```text
Agent
 ↓
Frontend Tool
 ↓
Browser action
 ↓
return
```

HITL：

```text
Agent
 ↓
Frontend Tool
 ↓
Browser dialog
 ↓
Human confirmation
 ↓
return
```

对于 Adapter，两者完全一样。

例如：

```text
ui_confirm_medication_change
ui_approve_patient_update
ui_confirm_submit_order
ui_request_doctor_signature
```

因此：

> HITL 本质上可以统一建模为需要用户参与的 Client-owned Tool。

---

# 35. State 第一版建议忽略

AG-UI 存在：

```text
state
STATE_SNAPSHOT
STATE_DELTA
```

但第一版不用急着接。

当前需求可以完整表达为：

```text
Context
+
Frontend Tools
+
Backend Tools
```

即：

```text
Context
→ Agent 看见页面状态

Frontend Tools
→ Agent 操作 React 草稿

Backend Tools
→ Agent 查询 / 操作业务 Backend
```

这样已经能覆盖核心产品需求。

---

# 36. Cancellation

Frontend Tool 可能等待很久。

因此必须监听：

```ts
exec.signal
```

示意：

```ts
const onAbort = () => {
  pending.reject(
    new Error(
      "Frontend tool cancelled"
    )
  )

  binding
    .pendingFrontendCalls
    .delete(callId)
}

exec.signal.addEventListener(
  "abort",
  onAbort,
  { once: true },
)
```

---

# 37. Frontend Tool Timeout

必须加 TTL。

例如：

```text
5 min
```

否则：

```text
浏览器关闭
 ↓
Tool 永远 pending
 ↓
DSH Agent 永远 running
```

推荐：

```ts
const timer =
  setTimeout(() => {
    pending.reject(
      new Error(
        "FRONTEND_TOOL_TIMEOUT"
      )
    )

    agent.cancel({
      kind:
        "hook",

      reason:
        "AG-UI frontend tool timeout",
    })
  }, timeoutMs)
```

---

# 38. Browser Disconnect

必须区分：

## 正常 Handoff

Adapter 主动：

```text
RUN_FINISHED
res.end()
```

此时：

```text
不要 cancel DSH
```

因为 Agent 仍然在等 Browser Tool Result。

---

## 异常 Disconnect

例如：

```text
网络中断
页面刷新
浏览器崩溃
socket unexpectedly closed
```

如果当前不是 Frontend Tool Handoff，则可以：

```text
agent.cancel()
```

因此：

```ts
intentionalClose:
  boolean
```

非常重要。

---

# 39. 并发控制

第一版建议：

```text
一个 Thread 同时最多一个 active AG-UI Run
```

如果第二个普通 Run 在第一个 Run 还 active 时到达：

```text
RUN_ERROR
code = RUN_IN_PROGRESS
```

但 Frontend Tool 场景例外：

```text
Run #1 已经正常 handoff 并关闭
```

因此 Run #2 可以继续。

---

# 40. Reasoning 第一版暂不适配

DSH 可能输出：

```text
reasoning-delta
```

AG-UI 也有：

```text
REASONING_START
REASONING_MESSAGE_START
REASONING_MESSAGE_CONTENT
REASONING_MESSAGE_END
REASONING_END
```

但第一版可以完全忽略。

只实现：

```text
Text
Tools
Run lifecycle
```

先把整体链路打通。

---

# 41. MVP 范围

第一版建议严格限制在：

1. `POST /ag-ui`
2. SSE
3. `threadId → DSH Agent`
4. 一个 Thread 一个 DSH Session
5. UserMessage → `agent.followup()`
6. Context → `agent.inject()`
7. `RunAgentInput.tools → agent.ctx.tools`
8. Frontend Tool Park / Resume
9. ToolMessage → pending Promise resolve
10. `assistant/chunk → TEXT_MESSAGE_*`
11. `tool/call → TOOL_CALL_*`
12. Backend `tool/result → TOOL_CALL_RESULT`
13. `agent.whenIdle() → RUN_FINISHED`
14. `RUN_ERROR`
15. Tool timeout
16. Agent cancellation
17. single-run-per-thread
18. Tool collision protection

第一版不要做：

```text
STATE_DELTA
STATE_SNAPSHOT
Reasoning streaming
复杂 Resume API
多 Client 同 Thread
Crash recovery of pending frontend tools
Protobuf 优化
复杂 message reconciliation
长期持久化 ThreadRegistry
```

---

# 42. 第一阶段技术验证

最重要的技术 Spike 不是 CopilotKit UI。

而是验证：

> DSH Tool 可以 await 一个跨 HTTP Request 才 resolve 的 Promise，并且同一个 DSH Turn 能继续运行。

---

## Test Run #1

```http
POST /ag-ui
```

发送：

```json
{
  "threadId": "t1",
  "runId": "r1",
  "messages": [
    {
      "id": "u1",
      "role": "user",
      "content": "把姓名改成 Rick"
    }
  ],
  "tools": [
    {
      "name": "ui_set_name",
      "description": "Update the current form name",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": ["name"]
      }
    }
  ],
  "context": [],
  "state": {},
  "forwardedProps": {}
}
```

预期：

```text
RUN_STARTED
TEXT...
TOOL_CALL_START
TOOL_CALL_ARGS
TOOL_CALL_END
RUN_FINISHED
```

同时：

```text
DSH Agent
=
still running
```

---

## Test Run #2

发送：

```json
{
  "threadId": "t1",
  "runId": "r2",
  "messages": [
    {
      "id": "tool-result-1",
      "role": "tool",
      "toolCallId": "call-xxx",
      "content": "{\"success\":true}"
    }
  ],
  "tools": [],
  "context": [],
  "state": {},
  "forwardedProps": {}
}
```

预期：

```text
pending Promise resolves
        ↓
DSH tool/result
        ↓
same DSH Turn
        ↓
next model step
        ↓
TEXT_MESSAGE_*
        ↓
RUN_FINISHED
```

只要这个测试跑通，整个架构最重要的不确定性就消除了。

---

# 43. 测试策略

## Unit Tests

### ThreadRegistry

验证：

```text
same principal + same thread
→ same agent

different principal + same thread
→ different agent
```

---

### FrontendToolBridge

验证：

```text
execute()
→ pending created

resolve ToolMessage
→ execute returns

abort
→ execute rejects

timeout
→ agent cancelled
```

---

### ContextAdapter

验证：

```text
Context
→ UserMessage
→ source.plugin = ag-ui
→ form = snapshot
```

---

### EventMapper

验证：

```text
assistant/chunk
→ TEXT_MESSAGE_START
→ TEXT_MESSAGE_CONTENT

assistant/message
→ TEXT_MESSAGE_END
```

---

## Integration Test

至少覆盖：

```text
User
 ↓
DSH
 ↓
Backend Tool
 ↓
Frontend Tool
 ↓
Run Handoff
 ↓
ToolMessage
 ↓
same DSH Turn
 ↓
Assistant
```

---

# 44. 推荐错误码

```text
INVALID_AGUI_INPUT
THREAD_NOT_FOUND
RUN_IN_PROGRESS
UNKNOWN_TOOL_RESULT
STALE_TOOL_RESULT
FRONTEND_TOOL_TIMEOUT
FRONTEND_TOOL_ABORTED
FRONTEND_TOOL_NAME_COLLISION
AGENT_NOT_AVAILABLE
AGENT_EXECUTION_ERROR
CLIENT_DISCONNECTED
```

AG-UI Client 应收到：

```text
RUN_ERROR
```

而 Internal Error 保留：

```text
logger
trace
audit
```

不要把敏感 Server Stack 直接发送到 Client。

---

# 45. 医疗 / HIS 场景下的权限原则

Agent 应被设计成：

```text
Draft-aware
Permission-aware
Human-confirmed
Auditable
```

关键原则：

## 45.1 Agent 默认操作 Draft

例如：

```text
ui_patch_consultation_draft
```

而不是：

```text
submit_medical_record
```

---

## 45.2 最终提交仍由人执行

流程：

```text
Agent patch draft
       ↓
React UI 更新
       ↓
医生查看
       ↓
医生点击提交
```

这非常适合医疗场景。

---

## 45.3 Backend 写操作与 UI 写操作必须区分

例如：

```text
get_patient
→ Backend Tool

patch_current_form_draft
→ Frontend Tool

submit_record
→ Backend privileged operation / HITL
```

---

# 46. 推荐的前端 Tool 类型

## Navigation

```text
ui_open_patient
ui_open_lab_panel
ui_navigate
```

## Form State

```text
ui_patch_form
ui_set_field
ui_clear_field
ui_focus_field
```

## User Interaction

```text
ui_confirm_action
ui_request_review
ui_request_signature
```

## Presentation

```text
ui_open_modal
ui_show_panel
ui_scroll_to
```

原则：

> Tool 应描述语义动作，而不是 DOM 操作。

推荐：

```text
ui_patch_consultation_draft
```

不推荐：

```text
click_button_17
set_input_by_css_selector
```

---

# 47. 页面 Context 推荐格式

不要只传：

```text
URL
```

推荐传结构化 Context。

例如：

```json
{
  "page": {
    "route": "/patients/:patientId/consultation",
    "pageType": "consultation"
  },

  "patient": {
    "id": "P001"
  },

  "visit": {
    "id": "V123"
  },

  "draft": {
    "version": 17,
    "dirty": true,
    "fields": {
      "chiefComplaint": "...",
      "historyOfPresentIllness": "..."
    }
  },

  "permissions": {
    "canEdit": true,
    "canSubmit": false
  }
}
```

然后：

```text
JSON.stringify(...)
```

作为 AG-UI Context value。

---

# 48. Version / Optimistic Concurrency

Frontend Tool 强烈建议带：

```text
expectedVersion
```

例如：

```json
{
  "name": "ui_patch_consultation_draft",

  "parameters": {
    "type": "object",

    "properties": {
      "expectedVersion": {
        "type": "integer"
      },

      "patch": {
        "type": "object"
      }
    },

    "required": [
      "expectedVersion",
      "patch"
    ]
  }
}
```

Browser：

```text
current version = 17
```

Agent：

```text
expectedVersion = 17
```

如果期间医生自己改了：

```text
version = 18
```

Frontend Tool 返回：

```json
{
  "success": false,
  "error": "VERSION_CONFLICT",
  "currentVersion": 18
}
```

Agent 再根据新的 Context 重试。

这样可以避免：

> Agent 覆盖用户刚刚手工输入的内容。

---

# 49. 长期演进

## V1

```text
Text
Context
Frontend Tools
Backend Tools
Park / Resume
```

## V2

加入：

```text
Reasoning Event
Streaming Tool Args
Better Error Recovery
Persistent Thread Mapping
```

## V3

加入：

```text
AG-UI Shared State
STATE_DELTA
STATE_SNAPSHOT
Interrupt / Resume
Advanced HITL
```

## V4

可能加入：

```text
A2UI
Generative UI
JSON Render
Agent-generated panels
```

此时 AG-UI 仍然是底层 Transport。

---

# 50. 最终推荐架构

整体职责最终应稳定为：

```text
React
│
├── Page Context
├── Draft State
├── Frontend Tools
└── HITL
        │
        ▼
     AG-UI
        │
        ▼
dsh-plugin-ag-ui
│
├── Thread Registry
├── Run Lifecycle
├── Context Adapter
├── Frontend Tool Bridge
└── Event Mapper
        │
        ▼
DeepSeek Harness
│
├── Agent Loop
├── Session Log
├── Backend Tools
├── Model
└── Plugins
        │
        ▼
Hono / Hospital Backend
```

---

# 51. 核心设计原则总结

整个方案最重要的原则可以浓缩为以下几点：

1. **AG-UI Thread = DSH Session。**
2. **AG-UI Run ≠ DSH Turn。**
3. **Frontend Tool 是 Client-owned capability。**
4. **Frontend Tool 应通过 async Promise Park DSH Tool Execution。**
5. **Browser Tool Result 应 resolve 原 Tool Promise，而不是制造新的逻辑 Turn。**
6. **Frontend Tool 必须注册在 Agent Scope。**
7. **Frontend Tool Set 应动态跟随当前 React 页面。**
8. **Backend Tools 永远由 DSH 自己管理。**
9. **Context 用于告诉 Agent 当前 UI 状态。**
10. **Frontend Tools 用于让 Agent 操作 UI 状态。**
11. **Backend Tools 用于让 Agent 操作业务系统。**
12. **用户最终提交继续由 UI 和权限系统控制。**
13. **DSH Session Log 保持唯一 Agent History Source of Truth。**
14. **AG-UI HTTP 生命周期与 DSH Agent 生命周期必须解耦。**
15. **第一版首先验证 Park / Resume，而不是做复杂 UI。**

---

# 52. 一句话定义

`dsh-plugin-ag-ui` 最准确的定义是：

> **一个把 AG-UI 的 Thread、Run、Context、Frontend Tools 与 Streaming Events，映射到 DeepSeek Harness 的 Agent、Session、Scoped Tools、Injected Context 和 Session Event Log 的协议网关。**

而整个方案真正的关键创新点是：

```text
AG-UI Frontend Tool
        ↓
DSH Scoped Async Tool
        ↓
Park Promise
        ↓
跨 AG-UI Run
        ↓
ToolMessage
        ↓
Resolve Promise
        ↓
同一 DSH Turn 继续
```

这使得 React 前端第一次可以真正成为 DeepSeek Harness 可感知、可操作、但仍由用户控制最终提交的 Agent Runtime Environment。
