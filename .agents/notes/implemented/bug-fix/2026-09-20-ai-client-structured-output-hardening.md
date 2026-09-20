# Agent Note: AI 客户端结构化输出的验收门、降级记忆与路径日志

Status: implemented

## Problem

`OpenAIChatCompletionsClient.completeJson` 的三级降级（JSON-schema 请求 → 强制 tool call → prompt 内嵌 schema）原本只要求候选内容能通过 `JSON.parse` 即接受。当模型不支持结构化输出时（OpenRouter 免费档经 Novita 路由的 `ling` 系列实测如此），tool call 常返回"可解析但缺必填字段"的 JSON：客户端接受它，服务层 Zod 解析才失败，最终用户只看到笼统的 `*_RESPONSE_INVALID`，而实际有效的 prompt 降级策略被坏的 tool-call 内容永久掩盖。同时链条完全不可观测：不记录哪级成功、哪级为何被拒、返回哪个模型。排查一个"患者档案生成失败"需要手工插桩三级请求才能定位。

## Decision

- **验收门**：`JsonChatCompletionInput` 增加可选 `validate: (value: unknown) => boolean`。候选内容通过围栏剥离与 `JSON.parse` 后必须再通过 `validate` 才被接受，否则视为"该级未返回结构化结果"，继续下一级。5 个调用点（患者人设、检验×2、问诊回复、检验目录富集）全部传入与后续 `parse` 相同的 Zod schema（`safeParse(value).success`）；新增 `completeJson` 调用点必须同样传入，否则会重新引入本缺陷。
- **降级记忆**：客户端实例内按模型记忆"JSON-schema 请求被拒（HTTP 400）"，后续调用直接跳过该级。确定性失败只付一次学费；记忆是进程生命周期的实例状态，不持久化。生产 Server 为单进程，首次生成后每次生成都省掉一个注定失败的请求。
- **路径日志**：`[ai-chat-completions]` 前缀的 `console.warn`/`console.info` 记录 400 记忆、每级内容被拒的原因（非 JSON/schema 验证失败）、最终由哪级产出结果。只记录模型名、路径与原因，不记录请求或响应内容。

## Alternatives considered

用 OpenRouter 模型目录的 `supported_parameters` 做能力发现：实测其目录声称 `inclusionai/ling-3.0-flash-fin` 支持 `structured_outputs`，上游 Novita 实际返回 400——目录元数据与真实路由不一致，可信度不足以取代实证。配置声明模型能力：把生态差异泄漏进部署配置，且同样可能与实际路由漂移。把 (传输方式 × 重试次数) 拆成正交矩阵并加退避：当前只有这一种真实需求，按"新增共享抽象前必须已有两个实际消费者"暂缓。

## Consequences

弱模型环境下生成成功率显著提升（prompt 降级实测可用），失败原因在 Server 日志中直接可见。`completeJson` 从无状态变为携带实例级记忆，测试须各自新建客户端实例避免串扰；同一模型首次调用的延迟不变，之后少一次请求。若未来 OpenRouter 修复目录或上游路由，记忆最多存活到进程重启，会自动重新发现能力。
