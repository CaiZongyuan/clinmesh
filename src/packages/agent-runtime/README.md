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

每个 Encounter 有独立的医生 Pi 命名空间。会话列表和请求回执保存在 Pi 文档中。分叉使用 Pi 原生会话历史。浏览器通过 `POST /api/assistant/turn` 的请求头传递模型配置，通过 `/api/assistant/bridge` 接收流式回复与浏览器工具请求。服务端确认受理前，浏览器在当前页签的 `sessionStorage` 暂存原指令、请求标识和模型配置指纹，重连会按原身份重发。收到受理通知后，浏览器清除暂存的指令，服务端依据持久化输入恢复。生成期间宿主重启会继续同一次请求，人工停止和模型失败保留各自的终态回执。

界面动作中断时，助手面板列出已提交命令的正式幂等回执。临床人员可对照记录核对界面结果，点击「我已核对结果」后继续使用界面工具。

`POST /api/assistant/stop` 使用当前就诊绑定、会话、`clientId` 与原 `requestId`。成功响应表示该请求的停止回执已落盘，对应的 Pi submission 已结束。同一会话随后可接收新指令。

「环境辅助模式」初始关闭。启用时核对模型配置，记下当前问诊序号及已启用检验、影像和病理模块签发的报告版本。每次轮询收集全部新完成的医患轮次和报告版本，按约 1.2 秒合并后投递至当前医生会话。语音转写产生的终态问诊也走相同入口。关闭开关、切换会话或离开当前就诊会清除待发送的观察。浏览器按 Workspace、Epoch、Encounter 在 `sessionStorage` 保留手改的字段标识，刷新后仍可采纳或忽略建议。

## 双智能体评测

具有诊疗或工作区管理能力的访客可显式调用 `POST /api/eval/runs`。传入 `packId`、`caseId`、`maxTurns`（1–32）、`clinicianModel`、`patientModel`。沿用模型请求头，显式演示使用 `X-ClinMesh-LLM-Mock: 1`。例如使用 `global-general`、`g01`、12 轮、`scripted-clinician` 与 `scripted-patient` 可重放社区获得性肺炎教学评测。

每次评测创建独立 Workspace 和活动 Epoch。Workers 将该 Workspace 路由到由 `runId` 命名的 SQLite Durable Object，Node 在当前数据库旁的 `.evaluations/` 目录为每次运行建立独立 SQLite 文件。发起工作区的审计事件保存运行引用。发起访客可在宿主重启后使用 `GET /api/eval/runs/:runId` 读取报告。

医生可调用当前数据包和岗位已获准的查询，选择实际开单项目，并在收到签发回执后阅读指定版本的报告，再决定是否确认已阅。`diagnostic-teaching` 的 `teaching-01` 支持影像与既往手术关联病理会诊。每条操作轨迹含岗位、输入、可见输出或错误码。报告汇总用量、耗时和安全红线，并在正式完诊后对照真值记录命中与缺项。尚未完诊时 `hits` 为 `null`。
