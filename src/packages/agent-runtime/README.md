# Patient Agent 与 Clinician Assistant

工作台顶栏的「模型设置」支持 OpenAI-compatible Chat Completions、Anthropic Messages 和 Gemini。选择 Provider、填写 API Key、设定默认模型，再按需要覆写 Patient Agent 和 Clinician Assistant 的模型 ID 与思考强度。两个连接测试使用各自的配置。浏览器将设置保存在 `clinmesh.providers.v1` localStorage。启用 Mock Mode 会在顶栏显示标识，患者按合成病例档案应答。

## 服务端配置

Node 环境变量和 Worker 绑定使用同名配置。`CLINMESH_LLM_PROVIDER` 可取 `openai`、`anthropic` 或 `gemini`。`CLINMESH_LLM_API_KEY` 提供自托管凭据，`CLINMESH_LLM_MODEL` 指定默认模型。`CLINMESH_LLM_PATIENT_MODEL`、`CLINMESH_LLM_CLINICIAN_MODEL` 及对应的 `CLINMESH_LLM_PATIENT_EFFORT`、`CLINMESH_LLM_CLINICIAN_EFFORT` 可独立覆写。思考强度取 `off`、`minimal`、`low`、`medium` 或 `high`，默认为 `off`，以模型实际支持范围为准。

`CLINMESH_LLM_BASE_URL` 可指定自托管端点。`CLINMESH_LLM_ALLOWED_BASE_URLS` 接受逗号分隔的额外完整 Base URL，包括路径。公开自定义端点使用 HTTPS，本机模型可使用明确配置的回环 HTTP 地址。OpenAI-compatible 的 Base URL 通常以 `/v1` 结尾。选择「服务端默认」并只填写个人密钥时，沿用自托管端点及当前 Agent 的模型。浏览器在 HTTPS 或回环 HTTP 页面上发送同源凭据。另选 Provider 或端点时使用该请求自己的密钥。

## 问诊与恢复

负责医生通过 Operation Catalog 的 `consultation.question` 提交问题。回执含 `turnId`、`sessionId`、`attempt` 与就诊版本。`consultation.stop` 和 `consultation.retry` 携带同一问题的 `questionId`、`attempt` 和当前就诊版本。`consultation.reply-state` 返回最近问题的状态。

`GET /api/agents/sessions/:id/events?questionId=…` 返回 SSE。每个事件携带问题 ID、尝试号和状态。`progress` 事件在实际收到模型片段或开始校验时发送，包含当前阶段、生成次数和已接收片段数。`text` 事件发送通过出口校验的完整答复，终态为 `done`、`failed` 或 `stopped`。重连时发送最后收到的 `Last-Event-ID`，同一在途任务可被多个连接订阅。各浏览器标签页按 Workspace 和 Epoch 记住当前就诊。刷新后携带原 Provider 设置续接 Pi 检查点，也可停止后用新配置重试。模型请求中途崩溃可能重发上游请求，Consultation 以问题 ID 幂等追加患者轮次。

`POST /api/agents/providers/test` 的 JSON 为 `{ "role": "patient" }` 或 `{ "role": "clinician" }`。模型请求使用 `X-ClinMesh-LLM-Provider`、`X-ClinMesh-LLM-Base-Url`、`X-ClinMesh-LLM-Api-Key`、`X-ClinMesh-LLM-Model`、`X-ClinMesh-LLM-Reasoning`。`X-ClinMesh-LLM-Mock: 1` 显式选择脚本。错误使用稳定错误码并提供 `#model-settings` 入口。

`openDurableAgentSession` 在打开 Store 提供的 Pi 命名空间前核验 Workspace、Epoch 与 Agent 角色。患者的每次真实调用使用当前病例的 Patient Persona、Prior History 和截至问题的 Consultation。医生在对话中明确告知的事实随对应轮次进入模型输入。出口与数据包编译器共用诊断识别规则，按编码体系匹配最长的已注册编码，并核验双语名称及别名。首个不安全答案触发一次附加纠错请求，再次命中时使用安全口语回复。缺少回复正文时报告 `LLM_PROVIDER_EMPTY_REPLY`，医生可在问诊区调整设置并重试原问题。Pi、SSE 和 Consultation 只接收经校验的文本。`agent_model_calls` 在请求开始和结束处记录模型标识、状态、用量与耗时。

## 医生工作台

以病例的责任医生岗位打开活动就诊，点击右侧「医生助手」后即可选择、新建、重命名、分叉或删除会话。每次输入使用医生模型设置。助手的 `ui_snapshot`、`ui_query`、`ui_act` 经同源 WebSocket 到达当前就诊视图，与 WebMCP 共用 ui-sdk 权限检查。聚焦和手改过的字段会显示可采纳或忽略的建议。正式签发与代问会显示一次性的人工确认条。

每个 Encounter 有独立的医生 Pi 命名空间。会话列表和最近一次请求绑定保存在 Pi 文档中。分叉使用 Pi 原生会话历史。浏览器通过 `POST /api/assistant/turn` 的请求头传递模型配置，通过 `/api/assistant/bridge` 接收流式回复与浏览器工具请求。重连收据仅含当前会话、浏览器客户端与请求标识，服务端可用持久化的原请求续接。相同请求的重放返回已有结果。

「环境辅助模式」初始关闭。启用时先检查模型配置，再把新的终态问诊和已签发报告按约 1.2 秒合并，投递给当前医生会话。语音转写产生的终态问诊也走相同入口。关闭开关、切换会话或离开当前就诊会清除待发送的观察。

## 双智能体评测

具有诊疗或工作区管理能力的访客可显式调用 `POST /api/eval/runs`。传入 `packId`、`caseId`、`maxTurns`（1–32）、`clinicianModel`、`patientModel`。沿用模型请求头，显式演示使用 `X-ClinMesh-LLM-Mock: 1`。例如使用 `global-general`、`g01`、12 轮、`scripted-clinician` 与 `scripted-patient` 可重放社区获得性肺炎教学评测。

每次评测创建独立 Workspace 和活动 Epoch，两位 Agent 通过真实问诊、报告、诊断、用药、病历和完诊入口工作。返回值包含所用数据包版本、作用域、模型、医生及患者轮数、用时、用量和操作轨迹。正式完诊后返回与病例真值对照的命中与缺项，运行未完诊时 `hits` 为 `null`。本包中 CAP 胸片属于影像目录，常规检验只覆盖已启用的血常规。
