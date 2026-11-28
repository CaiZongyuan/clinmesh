import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getSystemMessageText,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai'
import * as anthropicMessagesApi from '@earendil-works/pi-ai/api/anthropic-messages'
import * as googleGenerativeAiApi from '@earendil-works/pi-ai/api/google-generative-ai'
import * as openaiCodexResponsesApi from '@earendil-works/pi-ai/api/openai-codex-responses'
import * as openaiCompletionsApi from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponsesApi from '@earendil-works/pi-ai/api/openai-responses'
import {
  LLM_RUNTIME_HEADERS,
  llmModeSchema,
  llmProviderKindSchema,
  llmReasoningEffortSchema,
  llmThinkingModeSchema,
  type LlmAgentRole,
  type LlmCatalogApi,
  type LlmMode,
  type LlmProviderCatalogResponse,
  type LlmProviderKind,
  type LlmProviderStatusResponse,
  type LlmReasoningEffort,
  type LlmThinkingMode,
  type TestLlmProviderRequest,
  type TestLlmProviderResponse,
} from '@clinmesh/contracts/agent-sessions'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../ai/openai-chat-completions.ts'
import {
  LocalCliProviderStore,
  type LocalCliProviderDiscoveryOptions,
  type ResolvedLocalModelRuntime,
} from './local-cli-providers.ts'

export const INTERNAL_PROVIDER_IDS = {
  mock: 'clinmesh-mock',
  openaiCompatible: 'clinmesh-openai-compatible',
  anthropic: 'clinmesh-anthropic',
  gemini: 'clinmesh-gemini',
  local: 'clinmesh-local-cli',
  injected: 'clinmesh-injected',
} as const

export type InternalProviderId = typeof INTERNAL_PROVIDER_IDS[keyof typeof INTERNAL_PROVIDER_IDS]

export interface ServerDefaultLlmConfig {
  provider: 'openai-compatible'
  baseUrl: string
  apiKey: string
  defaultModel: string
  patientModel?: string | undefined
  timeoutMs: number
}

export interface ParsedLlmHeaders {
  mode?: LlmMode
  provider?: LlmProviderKind
  localProviderId?: string
  baseUrl?: string
  modelId?: string
  apiKey?: string
  reasoningEffort?: LlmReasoningEffort
  thinkingMode?: LlmThinkingMode
}

export interface ResolvedTurnConfig {
  internalProviderId: InternalProviderId
  publicProvider: string
  modelId: string
  thinkingLevel: ModelThinkingLevel
  thinkingMode: LlmThinkingMode
  baseUrl?: string
  apiKey?: string
  localRuntime?: ResolvedLocalModelRuntime
  isMock: boolean
  isInjected: boolean
  role: LlmAgentRole
  /** Optional patient-agent JSON completion invocation when using legacy injected test providers. */
  injectedInvocation?: () => Promise<string>
}

export interface EphemeralTurnBinding {
  token: string
  config: ResolvedTurnConfig
  createdAt: number
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export function defaultBaseUrlForProvider(provider: LlmProviderKind): string {
  switch (provider) {
    case 'openai-compatible':
      return 'https://api.openai.com/v1'
    case 'anthropic':
      return 'https://api.anthropic.com'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'mock':
      return 'mock://clinmesh.local'
  }
}

export function internalProviderIdFor(provider: LlmProviderKind): InternalProviderId {
  switch (provider) {
    case 'openai-compatible':
      return INTERNAL_PROVIDER_IDS.openaiCompatible
    case 'anthropic':
      return INTERNAL_PROVIDER_IDS.anthropic
    case 'gemini':
      return INTERNAL_PROVIDER_IDS.gemini
    case 'mock':
      return INTERNAL_PROVIDER_IDS.mock
  }
}

export function parseLlmHeaders(headers?: Headers | Record<string, string | undefined>): ParsedLlmHeaders {
  if (headers === undefined) return {}
  const read = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      const value = headers.get(name)?.trim()
      return value !== undefined && value.length > 0 ? value : undefined
    }
    const direct = headers[name] ?? headers[name.toLowerCase()]
    const value = direct?.trim()
    return value !== undefined && value.length > 0 ? value : undefined
  }

  const rawMode = read(LLM_RUNTIME_HEADERS.mode)
  const rawProvider = read(LLM_RUNTIME_HEADERS.provider)
  const rawReasoning = read(LLM_RUNTIME_HEADERS.reasoningEffort)
  const rawThinkingMode = read(LLM_RUNTIME_HEADERS.thinkingMode)
  const mode = rawMode === undefined ? undefined : llmModeSchema.safeParse(rawMode).data
  const provider = rawProvider === undefined ? undefined : llmProviderKindSchema.safeParse(rawProvider).data
  const localProviderId = read(LLM_RUNTIME_HEADERS.localProvider)
  const reasoningEffort = rawReasoning === undefined ? undefined : llmReasoningEffortSchema.safeParse(rawReasoning).data
  const thinkingMode = rawThinkingMode === undefined ? undefined : llmThinkingModeSchema.safeParse(rawThinkingMode).data
  const baseUrl = read(LLM_RUNTIME_HEADERS.baseUrl)
  const modelId = read(LLM_RUNTIME_HEADERS.modelId)
  const apiKey = read(LLM_RUNTIME_HEADERS.apiKey)

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(provider === undefined ? {} : { provider }),
    ...(localProviderId === undefined ? {} : { localProviderId }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(thinkingMode === undefined ? {} : { thinkingMode }),
  }
}

/**
 * Scrubs any known transient API keys and common bearer/key patterns from text before
 * it can ever be persisted into SQLite, emitted over SSE, or written to logs.
 */
export function redactLlmSecrets(text: string, knownSecrets: Iterable<string> = []): string {
  let redacted = text
  for (const secret of knownSecrets) {
    if (secret.length >= 4 && redacted.includes(secret)) {
      redacted = redacted.split(secret).join('[REDACTED]')
    }
  }
  redacted = redacted.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
  redacted = redacted.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,})\b/g, '[REDACTED]')
  return redacted
}

export function classifyLlmError(message: string): { code: string; message: string } {
  const lower = message.toLowerCase()
  if (lower.includes('llm_provider_unconfigured') || lower.includes('unconfigured') || lower.includes('api key')) {
    if (lower.includes('401') || lower.includes('403') || lower.includes('invalid') || lower.includes('unauthorized') || lower.includes('incorrect')) {
      return { code: 'LLM_AUTH_FAILED', message }
    }
    return { code: 'LLM_PROVIDER_UNCONFIGURED', message }
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return { code: 'LLM_AUTH_FAILED', message }
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota')) {
    return { code: 'LLM_RATE_LIMITED', message }
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return { code: 'LLM_TIMEOUT', message }
  }
  return { code: 'LLM_REQUEST_FAILED', message }
}

interface DynamicModelOverrides {
  api?: Api
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  thinkingMode?: LlmThinkingMode
  supportsAdaptiveThinking?: boolean
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
  headers?: Record<string, string>
}

function resolveAnthropicCompat(
  baseCompat: Record<string, unknown> | undefined,
  thinkingMode: LlmThinkingMode | undefined,
  supportsAdaptiveThinking: boolean | undefined,
): Record<string, unknown> | undefined {
  const next = baseCompat ? { ...baseCompat } : {}
  if (thinkingMode === 'adaptive') {
    next.forceAdaptiveThinking = true
  } else if (thinkingMode === 'budget') {
    next.forceAdaptiveThinking = false
  } else if (next.forceAdaptiveThinking === undefined && supportsAdaptiveThinking === true) {
    next.forceAdaptiveThinking = true
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function buildDynamicModel(
  provider: InternalProviderId,
  modelId: string,
  overrides: DynamicModelOverrides = {},
): Model<Api> {
  const api: Api = overrides.api
    ?? (provider === INTERNAL_PROVIDER_IDS.anthropic
      ? 'anthropic-messages'
      : provider === INTERNAL_PROVIDER_IDS.gemini
        ? 'google-generative-ai'
        : provider === INTERNAL_PROVIDER_IDS.openaiCompatible
          ? 'openai-completions'
          : provider)
  const resolvedBaseUrl = overrides.baseUrl
    ?? (api === 'anthropic-messages'
      ? 'https://api.anthropic.com'
      : api === 'google-generative-ai'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : api === 'openai-codex-responses'
          ? 'https://chatgpt.com/backend-api'
          : api === 'openai-completions' || api === 'openai-responses'
            ? 'https://api.openai.com/v1'
            : 'mock://clinmesh.local')
  const compat = api === 'anthropic-messages'
    ? resolveAnthropicCompat(overrides.compat, overrides.thinkingMode, overrides.supportsAdaptiveThinking)
    : overrides.compat
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: resolvedBaseUrl,
    reasoning: overrides.reasoning ?? true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 128_000,
    maxTokens: overrides.maxTokens ?? 8_192,
    ...(compat === undefined ? {} : { compat: compat as NonNullable<Model<Api>['compat']> }),
    ...(overrides.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: overrides.thinkingLevelMap as NonNullable<Model<Api>['thinkingLevelMap']> }),
    ...(overrides.headers === undefined ? {} : { headers: overrides.headers }),
  }
}

function streamApiForLocal(api: Exclude<LlmCatalogApi, 'mock'>): {
  streamSimple: (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream
} {
  switch (api) {
    case 'anthropic-messages':
      return anthropicMessagesApi
    case 'google-generative-ai':
      return googleGenerativeAiApi
    case 'openai-responses':
      return openaiResponsesApi
    case 'openai-codex-responses':
      return openaiCodexResponsesApi
    case 'openai-completions':
      return openaiCompletionsApi
  }
}

function extractLastUserText(context: TranscriptContext): string {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i]
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n')
  }
  return ''
}

function hasToolResultInLatestTurn(context: TranscriptContext): boolean {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i]
    if (message?.role === 'toolResult') return true
    if (message?.role === 'user') return false
  }
  return false
}

function systemPromptContains(context: TranscriptContext, needle: string): boolean {
  return context.messages.some(message => (
    message.role === 'system' && getSystemMessageText(message).includes(needle)
  ))
}

function extractLatestDoctorQuestion(userPayloadText: string): string {
  try {
    const parsed = JSON.parse(userPayloadText) as { dialogue?: Array<{ speaker?: string; text?: string }> }
    if (Array.isArray(parsed.dialogue)) {
      const lastDoctor = parsed.dialogue.findLast(turn => turn.speaker === 'doctor')
      if (typeof lastDoctor?.text === 'string' && lastDoctor.text.trim().length > 0) {
        return lastDoctor.text.trim()
      }
    }
  } catch {
    // Fall back to raw user text if payload is not JSON.
  }
  return userPayloadText
}

function defaultMockAssistantMessage(
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  model: Model<string>,
): AssistantMessage {
  const userText = extractLastUserText(context).trim()
  const isPatientAgent = systemPromptContains(context, '扮演患者本人')
  if (isPatientAgent) {
    const doctorQuestion = extractLatestDoctorQuestion(userText)
    const reply = doctorQuestion.includes('多久') || doctorQuestion.includes('什么时候')
      ? '大概从昨天晚上开始的，一直不太舒服，今天觉得更明显了。'
      : doctorQuestion.includes('药') || doctorQuestion.includes('过敏')
        ? '平时没怎么乱吃药，也没发现对什么药过敏，医生您帮我看看吧。'
        : doctorQuestion.includes('诊断') || doctorQuestion.includes('什么病')
          ? '我不懂这些医学名词，医生您说我这是怎么回事呀？'
          : '就是觉得不太舒服，说话也有点没力气，具体什么原因我也说不清楚。'
    return fauxAssistantMessage([fauxText(JSON.stringify({ reply }))])
  }

  const isCompactionRequest = systemPromptContains(context, 'summariz')
    || systemPromptContains(context, 'compaction')
    || /summariz|compact|压缩|摘要汇总/i.test(userText) && systemPromptContains(context, 'summary')
  if (isCompactionRequest) {
    return fauxAssistantMessage([
      fauxText([
        '## 临床对话压缩摘要（Mock 模式）',
        '- 已保留核心主诉、医生可见生命体征与已讨论的临床鉴别要点。',
        '- 后续轮次可继续围绕当前病例问诊、检验检查与用药安全核查展开。',
      ].join('\n')),
    ])
  }

  const isSideChat = systemPromptContains(context, '侧边追问')
  if (isSideChat) {
    return fauxAssistantMessage([
      fauxThinking('在独立侧边追问上下文中快速回应医生针对选中片段的疑问，不污染主会话。'),
      fauxText([
        '### 侧边追问解答（Mock 模式）',
        '',
        `针对你的追问「${userText.slice(0, 100)}」：`,
        '- 建议结合患者基线血压、肾功能与过敏史核对适应证与剂量调整边界。',
        '- 如需把结论带回主诊讨论，可点击下方「插入主对话」。',
      ].join('\n')),
    ])
  }

  const hasToolResult = hasToolResultInLatestTurn(context)
  const systemTools = context.messages
    .flatMap(m => (m.role === 'system' && m.toolsAdded ? m.toolsAdded : []))
    .map(t => t.name)
  const canCallSummaryTool = systemTools.includes('read_visible_case_summary')
  const canCallLabTool = systemTools.includes('read_lab_results')
  const canCallImagingTool = systemTools.includes('read_imaging_reports')
  const canCallMedTool = systemTools.includes('read_medication_orders')
  const canCallVitalTool = systemTools.includes('read_vital_trends')

  if (!hasToolResult && canCallLabTool && /(检验|化验|血常规|生化|lab result)/i.test(userText)) {
    return fauxAssistantMessage([
      fauxThinking('先读取医生可见的检验申请与报告结果，核对异常指标。'),
      fauxToolCall('read_lab_results', {}),
    ], { stopReason: 'toolUse' })
  }
  if (!hasToolResult && canCallImagingTool && /(影像|放射|CT|超声|心电图|病理|imaging|ecg)/i.test(userText)) {
    return fauxAssistantMessage([
      fauxThinking('先读取医生可见的影像、功能检查与病理文本报告。'),
      fauxToolCall('read_imaging_reports', {}),
    ], { stopReason: 'toolUse' })
  }
  if (!hasToolResult && canCallMedTool && /(处方|用药|药物|过敏|medication|prescription)/i.test(userText)) {
    return fauxAssistantMessage([
      fauxThinking('先核对当前可见处方医嘱、诊断与过敏史。'),
      fauxToolCall('read_medication_orders', {}),
    ], { stopReason: 'toolUse' })
  }
  if (!hasToolResult && canCallVitalTool && /(生命体征|体征趋势|问诊记录|vital)/i.test(userText)) {
    return fauxAssistantMessage([
      fauxThinking('先读取分诊生命体征与门诊问诊对话记录。'),
      fauxToolCall('read_vital_trends', {}),
    ], { stopReason: 'toolUse' })
  }
  if (!hasToolResult && canCallSummaryTool && /(病例摘要|总结|摘要|summary|check case|tool)/i.test(userText)) {
    return fauxAssistantMessage([
      fauxThinking('先读取当前接诊的医生可见病例摘要（不含任何隐藏真值），再整理结构化临床建议。'),
      fauxToolCall('read_visible_case_summary', {}),
    ], { stopReason: 'toolUse' })
  }

  const thinkingNote = options?.reasoning
    ? `分析当前临床助手问题（推理强度：${options.reasoning}，模型：${model.id}），仅基于医生可见工作区上下文组织结构化回复。`
    : `梳理当前临床问题与可见接诊上下文（模型：${model.id}），准备分点回答。`

  if (hasToolResult) {
    const toolResult = context.messages.findLast(m => m.role === 'toolResult')
    const toolText = toolResult?.role === 'toolResult'
      ? toolResult.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map(c => c.text).join('\n')
      : ''
    return fauxAssistantMessage([
      fauxThinking('已获取当前病例的医生可见摘要，正在汇总主诉、关键检查与下一步问诊建议。'),
      fauxText([
        '### 当前病例摘要（Mock 模式）',
        '',
        toolText.length > 0 ? toolText : '- 当前未绑定具体门诊病例，以下为通用临床思路。',
        '',
        '#### 建议关注点',
        '- 核对主诉、起病时间与伴随症状',
        '- 结合既往史与过敏史评估用药及检查风险',
        '- 必要时通过门诊问诊继续向患者核实细节',
      ].join('\n')),
    ])
  }

  return fauxAssistantMessage([
    fauxThinking(thinkingNote),
    fauxText([
      '### 临床助手回复（Mock 模式）',
      '',
      `已收到你的问题：**${userText.slice(0, 120) || '请提供临床协助'}**`,
      '',
      '- **问诊要点**：可继续核实症状持续时间、诱因、缓解因素与既往用药史。',
      '- **排查思路**：结合当前可见体征与检验/检查结果综合评估，避免过早锚定单一诊断。',
      '- **安全提醒**：处方与处置前请确认过敏史及基础生命体征。',
    ].join('\n')),
  ])
}

export interface CustomMockResponder {
  (context: TranscriptContext, options: SimpleStreamOptions | undefined, model: Model<string>): AssistantMessage | Promise<AssistantMessage>
}

/**
 * Owns dynamic BYOK header resolution, ephemeral in-memory secret binding, explicit Mock Mode
 * (via pi-ai fauxProvider), legacy injected test provider adaptation, and pi-ai Models dispatch.
 *
 * Security invariant: browser-supplied API keys are kept ONLY in `#ephemeralByProviderSession`
 * for the duration of an active turn and are NEVER persisted into SQLite or emitted to logs.
 */
export class ClinMeshProviderRegistry {
  readonly #serverDefault: ServerDefaultLlmConfig | undefined
  readonly #injectedChatCompletions: JsonChatCompletionsProvider | undefined
  readonly #localProviders: LocalCliProviderStore
  readonly #ephemeralBySession = new Map<string, EphemeralTurnBinding>()
  readonly #ephemeralSecrets = new Set<string>()
  readonly #localModelMetaById = new Map<string, DynamicModelOverrides>()
  readonly #lastTtftBySession = new Map<string, number>()
  readonly #faux: ReturnType<typeof fauxProvider>
  readonly #baseModels: Models
  readonly models: Models
  #customMockResponder: CustomMockResponder | undefined

  constructor(options: {
    serverDefault?: ServerDefaultLlmConfig
    injectedChatCompletions?: JsonChatCompletionsProvider
    mockTokensPerSecond?: number
    mockResponder?: CustomMockResponder
    localProviders?: LocalCliProviderDiscoveryOptions
  } = {}) {
    this.#serverDefault = options.serverDefault
    this.#injectedChatCompletions = options.injectedChatCompletions
    this.#customMockResponder = options.mockResponder
    this.#localProviders = new LocalCliProviderStore(options.localProviders ?? { enabled: false })

    this.#faux = fauxProvider({
      provider: INTERNAL_PROVIDER_IDS.mock,
      api: INTERNAL_PROVIDER_IDS.mock,
      tokensPerSecond: options.mockTokensPerSecond ?? 800,
      models: [{ id: 'mock-clinmesh-v1', name: 'ClinMesh Mock', reasoning: true }],
    })

    const mutable = createModels()
    mutable.setProvider(this.#createMockProvider())
    mutable.setProvider(this.#createLiveProvider(INTERNAL_PROVIDER_IDS.openaiCompatible, 'openai-compatible', openaiCompletionsApi))
    mutable.setProvider(this.#createLiveProvider(INTERNAL_PROVIDER_IDS.anthropic, 'anthropic', anthropicMessagesApi))
    mutable.setProvider(this.#createLiveProvider(INTERNAL_PROVIDER_IDS.gemini, 'gemini', googleGenerativeAiApi))
    mutable.setProvider(this.#createLocalCliProvider())
    mutable.setProvider(this.#createInjectedProvider())
    this.#baseModels = mutable

    const localMetaMap = this.#localModelMetaById
    // Proxy Models so getModel() accepts arbitrary user-entered or local CLI model IDs on our dynamic providers.
    this.models = new Proxy(mutable, {
      get(target, prop, receiver) {
        if (prop === 'getModel') {
          return (provider: string, id: string): Model<Api> | undefined => {
            if ((Object.values(INTERNAL_PROVIDER_IDS) as string[]).includes(provider) && id.trim().length > 0) {
              const overrides = provider === INTERNAL_PROVIDER_IDS.local ? localMetaMap.get(id) : undefined
              return buildDynamicModel(provider as InternalProviderId, id, overrides)
            }
            return target.getModel(provider, id)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  setMockResponder(responder: CustomMockResponder | undefined): void {
    this.#customMockResponder = responder
  }

  get serverDefaultStatus(): LlmProviderStatusResponse {
    if (this.#serverDefault === undefined) {
      return {
        serverDefaultConfigured: false,
        serverDefaultProvider: null,
        serverDefaultModel: null,
      }
    }
    return {
      serverDefaultConfigured: true,
      serverDefaultProvider: this.#serverDefault.provider,
      serverDefaultModel: this.#serverDefault.defaultModel,
    }
  }

  getCatalog(options: { force?: boolean } = {}): LlmProviderCatalogResponse {
    const scan = this.#localProviders.scan(options)
    return {
      discoveryEnabled: this.#localProviders.enabled,
      scannedAt: scan.scannedAt,
      serverDefault: this.serverDefaultStatus,
      localProviders: scan.providers,
    }
  }

  get hasInjectedChatCompletions(): boolean {
    return this.#injectedChatCompletions !== undefined
  }

  resolveTurnConfig(
    role: LlmAgentRole,
    headers?: Headers | Record<string, string | undefined>,
    options: {
      injectedInvocation?: () => Promise<string>
      defaultModelOverride?: string
    } = {},
  ): ResolvedTurnConfig | null {
    const parsed = parseLlmHeaders(headers)
    const thinkingLevel: ModelThinkingLevel = parsed.reasoningEffort ?? 'off'
    const thinkingMode: LlmThinkingMode = parsed.thinkingMode ?? 'auto'

    if (parsed.mode === 'mock' || parsed.provider === 'mock') {
      return {
        internalProviderId: INTERNAL_PROVIDER_IDS.mock,
        publicProvider: 'mock',
        modelId: parsed.modelId ?? 'mock-clinmesh-v1',
        thinkingLevel,
        thinkingMode,
        isMock: true,
        isInjected: false,
        role,
      }
    }

    if (parsed.mode === 'local' && parsed.localProviderId !== undefined) {
      const runtime = this.#localProviders.resolveModelRuntime(parsed.localProviderId, parsed.modelId)
      if (runtime === null) return null
      const hasAuth = runtime.apiKey !== undefined
        || (runtime.headers !== undefined && Object.keys(runtime.headers).some(k => {
          const lower = k.toLowerCase()
          return lower === 'authorization' || lower === 'x-api-key'
        }))
      if (!hasAuth) return null
      return {
        internalProviderId: INTERNAL_PROVIDER_IDS.local,
        publicProvider: runtime.providerId,
        modelId: runtime.model.id,
        thinkingLevel,
        thinkingMode,
        baseUrl: runtime.baseUrl,
        ...(runtime.apiKey === undefined ? {} : { apiKey: runtime.apiKey }),
        localRuntime: runtime,
        isMock: false,
        isInjected: false,
        role,
      }
    }

    if (parsed.apiKey !== undefined) {
      const publicProvider: Exclude<LlmProviderKind, 'mock'> = parsed.provider ?? 'openai-compatible'
      const modelId = parsed.modelId ?? (
        publicProvider === 'anthropic'
          ? 'claude-sonnet-4-5'
          : publicProvider === 'gemini'
            ? 'gemini-2.5-flash'
            : 'gpt-4.1-mini'
      )
      return {
        internalProviderId: internalProviderIdFor(publicProvider),
        publicProvider,
        modelId,
        thinkingLevel,
        thinkingMode,
        baseUrl: parsed.baseUrl ?? defaultBaseUrlForProvider(publicProvider),
        apiKey: parsed.apiKey,
        isMock: false,
        isInjected: false,
        role,
      }
    }

    if (options.injectedInvocation !== undefined) {
      return {
        internalProviderId: INTERNAL_PROVIDER_IDS.injected,
        publicProvider: 'openai-compatible',
        modelId: parsed.modelId ?? options.defaultModelOverride ?? 'injected-consultation-model',
        thinkingLevel,
        thinkingMode,
        isMock: false,
        isInjected: true,
        role,
        injectedInvocation: options.injectedInvocation,
      }
    }

    if (this.#serverDefault !== undefined) {
      const publicProvider = parsed.provider ?? this.#serverDefault.provider
      if (publicProvider === this.#serverDefault.provider) {
        return {
          internalProviderId: internalProviderIdFor(publicProvider),
          publicProvider,
          modelId: parsed.modelId
            ?? (role === 'patient' ? this.#serverDefault.patientModel : undefined)
            ?? options.defaultModelOverride
            ?? this.#serverDefault.defaultModel,
          thinkingLevel,
          thinkingMode,
          baseUrl: parsed.baseUrl ?? this.#serverDefault.baseUrl,
          apiKey: this.#serverDefault.apiKey,
          isMock: false,
          isInjected: false,
          role,
        }
      }
    }

    return null
  }

  bindTurn(providerSessionId: string, config: ResolvedTurnConfig): string {
    const token = `${providerSessionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    if (config.apiKey !== undefined && config.apiKey.length >= 4) {
      this.#ephemeralSecrets.add(config.apiKey)
    }
    if (config.localRuntime !== undefined) {
      for (const secret of config.localRuntime.secrets) {
        if (secret.length >= 4) this.#ephemeralSecrets.add(secret)
      }
      this.#localModelMetaById.set(config.modelId, {
        api: config.localRuntime.api,
        baseUrl: config.localRuntime.baseUrl,
        contextWindow: config.localRuntime.model.contextWindow,
        maxTokens: config.localRuntime.model.maxTokens,
        reasoning: config.localRuntime.model.reasoning,
        thinkingMode: config.thinkingMode,
        supportsAdaptiveThinking: config.localRuntime.model.supportsAdaptiveThinking,
        ...(config.localRuntime.compat === undefined ? {} : { compat: config.localRuntime.compat }),
        ...(config.localRuntime.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: config.localRuntime.thinkingLevelMap }),
      })
    }
    this.#ephemeralBySession.set(providerSessionId, {
      token,
      config,
      createdAt: Date.now(),
    })
    return token
  }

  releaseTurn(providerSessionId: string, token: string): void {
    const current = this.#ephemeralBySession.get(providerSessionId)
    if (current !== undefined && current.token === token) {
      this.#ephemeralBySession.delete(providerSessionId)
    }
  }

  redact(text: string): string {
    const secrets = new Set<string>(this.#ephemeralSecrets)
    if (this.#serverDefault?.apiKey) secrets.add(this.#serverDefault.apiKey)
    return redactLlmSecrets(text, secrets)
  }

  async testConnection(
    request: TestLlmProviderRequest,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<TestLlmProviderResponse> {
    const startedAt = Date.now()
    const parsedHeaders = parseLlmHeaders(headers)
    const thinkingMode: LlmThinkingMode = request.thinkingMode ?? parsedHeaders.thinkingMode ?? 'auto'
    const effectiveMode: LlmMode = request.mode === 'mock' || request.provider === 'mock'
      ? 'mock'
      : request.mode === 'local'
        ? 'local'
        : 'live'

    if (effectiveMode === 'mock') {
      const model = buildDynamicModel(INTERNAL_PROVIDER_IDS.mock, request.modelId || 'mock-clinmesh-v1')
      const message = await this.#baseModels.completeSimple(model, {
        systemPrompt: 'Connection check',
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
      }, signal === undefined ? undefined : { signal })
      const preview = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join(' ')
        .slice(0, 80)
      return {
        ok: true,
        provider: 'mock',
        modelId: model.id,
        latencyMs: Math.max(0, Date.now() - startedAt),
        replyPreview: preview || 'OK (Mock Mode)',
        message: 'Mock 模式连接正常（确定性模拟响应已就绪）。',
      }
    }

    if (effectiveMode === 'local') {
      const localProviderId = request.localProviderId ?? parsedHeaders.localProviderId
      if (!localProviderId) {
        return {
          ok: false,
          provider: 'local',
          modelId: request.modelId,
          latencyMs: 0,
          errorCode: 'LLM_PROVIDER_UNCONFIGURED',
          message: '未指定本地 CLI 服务商（pi / claude / codex）。',
        }
      }
      const runtime = this.#localProviders.resolveModelRuntime(localProviderId, request.modelId)
      if (runtime === null || (runtime.apiKey === undefined && !runtime.headers)) {
        return {
          ok: false,
          provider: localProviderId,
          modelId: request.modelId,
          latencyMs: 0,
          errorCode: 'LLM_PROVIDER_UNCONFIGURED',
          message: `未找到可用的本地 CLI 凭证（${localProviderId}），请检查本机 ~/.pi、~/.claude 或 ~/.codex 配置。`,
        }
      }
      const probeSessionId = `probe-local:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const config: ResolvedTurnConfig = {
        internalProviderId: INTERNAL_PROVIDER_IDS.local,
        publicProvider: runtime.providerId,
        modelId: runtime.model.id,
        thinkingLevel: request.reasoningEffort ?? 'off',
        thinkingMode,
        baseUrl: runtime.baseUrl,
        ...(runtime.apiKey === undefined ? {} : { apiKey: runtime.apiKey }),
        localRuntime: runtime,
        isMock: false,
        isInjected: false,
        role: 'assistant',
      }
      const token = this.bindTurn(probeSessionId, config)
      const timeoutSignal = signal === undefined
        ? AbortSignal.timeout(15_000)
        : AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      try {
        const model = buildDynamicModel(INTERNAL_PROVIDER_IDS.local, config.modelId, {
          api: runtime.api,
          baseUrl: runtime.baseUrl,
          contextWindow: runtime.model.contextWindow,
          maxTokens: runtime.model.maxTokens,
          reasoning: runtime.model.reasoning,
          thinkingMode,
          supportsAdaptiveThinking: runtime.model.supportsAdaptiveThinking,
          ...(runtime.compat === undefined ? {} : { compat: runtime.compat }),
          ...(runtime.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: runtime.thinkingLevelMap }),
        })
        const message = await this.#baseModels.completeSimple(model, {
          systemPrompt: 'You are a connectivity test endpoint. Reply briefly with OK.',
          messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
        }, {
          maxTokens: 16,
          sessionId: probeSessionId,
          signal: timeoutSignal,
          ...(config.thinkingLevel === 'off' ? {} : { reasoning: config.thinkingLevel }),
        })
        const latencyMs = Math.max(0, Date.now() - startedAt)
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          const safeError = redactLlmSecrets(message.errorMessage ?? '连接测试失败', runtime.secrets)
          const classified = classifyLlmError(safeError)
          return {
            ok: false,
            provider: runtime.providerId,
            modelId: config.modelId,
            latencyMs,
            errorCode: classified.code,
            message: classified.message,
          }
        }
        const preview = message.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map(part => part.text)
          .join(' ')
          .trim()
          .slice(0, 80)
        return {
          ok: true,
          provider: runtime.providerId,
          modelId: config.modelId,
          latencyMs,
          replyPreview: preview || 'OK',
          message: `本地 ${runtime.providerDisplayName} 连接测试成功。`,
        }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error)
        const safeError = redactLlmSecrets(rawMessage, runtime.secrets)
        const classified = classifyLlmError(safeError)
        return {
          ok: false,
          provider: runtime.providerId,
          modelId: config.modelId,
          latencyMs: Math.max(0, Date.now() - startedAt),
          errorCode: classified.code,
          message: classified.message,
        }
      } finally {
        this.releaseTurn(probeSessionId, token)
      }
    }

    const liveProvider: Exclude<LlmProviderKind, 'mock'> = request.provider === 'anthropic' || request.provider === 'gemini'
      ? request.provider
      : 'openai-compatible'
    const apiKey = parsedHeaders.apiKey ?? (
      liveProvider === this.#serverDefault?.provider ? this.#serverDefault.apiKey : undefined
    )
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return {
        ok: false,
        provider: liveProvider,
        modelId: request.modelId,
        latencyMs: 0,
        errorCode: 'LLM_PROVIDER_UNCONFIGURED',
        message: '未配置 API Key，请填写密钥、选择本地 CLI 服务商或显式开启演示 / Mock 模式。',
      }
    }

    const baseUrl = request.baseUrl?.trim() || (
      liveProvider === this.#serverDefault?.provider ? this.#serverDefault.baseUrl : defaultBaseUrlForProvider(liveProvider)
    )
    const probeSessionId = `probe:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const config: ResolvedTurnConfig = {
      internalProviderId: internalProviderIdFor(liveProvider),
      publicProvider: liveProvider,
      modelId: request.modelId,
      thinkingLevel: request.reasoningEffort ?? 'off',
      thinkingMode,
      baseUrl,
      apiKey,
      isMock: false,
      isInjected: false,
      role: 'assistant',
    }
    const token = this.bindTurn(probeSessionId, config)
    const timeoutSignal = signal === undefined
      ? AbortSignal.timeout(15_000)
      : AbortSignal.any([signal, AbortSignal.timeout(15_000)])

    try {
      const model = buildDynamicModel(config.internalProviderId, config.modelId, {
        baseUrl,
        thinkingMode,
        supportsAdaptiveThinking: liveProvider === 'anthropic',
      })
      const message = await this.#baseModels.completeSimple(model, {
        systemPrompt: 'You are a connectivity test endpoint. Reply briefly with OK.',
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      }, {
        maxTokens: 16,
        sessionId: probeSessionId,
        signal: timeoutSignal,
        ...(config.thinkingLevel === 'off' ? {} : { reasoning: config.thinkingLevel }),
      })
      const latencyMs = Math.max(0, Date.now() - startedAt)
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        const safeError = redactLlmSecrets(message.errorMessage ?? '连接测试失败', [apiKey])
        const classified = classifyLlmError(safeError)
        return {
          ok: false,
          provider: liveProvider,
          modelId: request.modelId,
          latencyMs,
          errorCode: classified.code,
          message: classified.message,
        }
      }
      const preview = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join(' ')
        .trim()
        .slice(0, 80)
      return {
        ok: true,
        provider: liveProvider,
        modelId: request.modelId,
        latencyMs,
        replyPreview: preview || 'OK',
        message: '模型接口连接测试成功。',
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const safeError = redactLlmSecrets(rawMessage, [apiKey])
      const classified = classifyLlmError(safeError)
      return {
        ok: false,
        provider: liveProvider,
        modelId: request.modelId,
        latencyMs: Math.max(0, Date.now() - startedAt),
        errorCode: classified.code,
        message: classified.message,
      }
    } finally {
      this.releaseTurn(probeSessionId, token)
    }
  }

  consumeLastTtftMs(providerSessionId: string): number | null {
    const value = this.#lastTtftBySession.get(providerSessionId)
    if (value === undefined) return null
    this.#lastTtftBySession.delete(providerSessionId)
    return value
  }

  async runEphemeralCompletion(
    config: ResolvedTurnConfig,
    input: {
      systemPrompt: string
      messages: Array<{ role: 'user' | 'assistant'; text: string }>
    },
    signal?: AbortSignal,
  ): Promise<{
    answer: string
    thinking?: string
    model: string
    provider: string
    durationMs: number
    ttftMs?: number
  }> {
    const startedAt = Date.now()
    const ephemeralSessionId = `side:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const token = this.bindTurn(ephemeralSessionId, config)
    const timeoutSignal = signal === undefined
      ? AbortSignal.timeout(45_000)
      : AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    try {
      const overrides: DynamicModelOverrides = config.localRuntime !== undefined
        ? {
            api: config.localRuntime.api,
            baseUrl: config.localRuntime.baseUrl,
            contextWindow: config.localRuntime.model.contextWindow,
            maxTokens: config.localRuntime.model.maxTokens,
            reasoning: config.localRuntime.model.reasoning,
            thinkingMode: config.thinkingMode,
            supportsAdaptiveThinking: config.localRuntime.model.supportsAdaptiveThinking,
            ...(config.localRuntime.compat === undefined ? {} : { compat: config.localRuntime.compat }),
            ...(config.localRuntime.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: config.localRuntime.thinkingLevelMap }),
          }
        : {
            ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
            thinkingMode: config.thinkingMode,
            supportsAdaptiveThinking: config.publicProvider === 'anthropic',
          }
      const model = buildDynamicModel(config.internalProviderId, config.modelId, overrides)
      const now = Date.now()
      const stream = this.#baseModels.streamSimple(model, {
        systemPrompt: input.systemPrompt,
        messages: input.messages.map((turn, idx) => (
          turn.role === 'user'
            ? { role: 'user' as const, content: turn.text, timestamp: now + idx }
            : {
                role: 'assistant' as const,
                content: [{ type: 'text' as const, text: turn.text }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: ZERO_USAGE,
                stopReason: 'stop' as const,
                timestamp: now + idx,
              }
        )),
      }, {
        sessionId: ephemeralSessionId,
        signal: timeoutSignal,
        ...(config.thinkingLevel === 'off' ? {} : { reasoning: config.thinkingLevel }),
      })

      let firstDeltaMs: number | undefined
      let finalMessage: AssistantMessage | undefined
      for await (const event of stream) {
        if (firstDeltaMs === undefined && (event.type === 'text_delta' || event.type === 'thinking_delta')) {
          firstDeltaMs = Math.max(0, Date.now() - startedAt)
        }
        if (event.type === 'done') finalMessage = event.message
        if (event.type === 'error') finalMessage = event.error
      }
      const durationMs = Math.max(0, Date.now() - startedAt)
      if (finalMessage === undefined || finalMessage.stopReason === 'error' || finalMessage.stopReason === 'aborted') {
        const safeErr = this.redact(finalMessage?.errorMessage ?? '侧边追问请求失败')
        throw new Error(safeErr)
      }
      const answer = finalMessage.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join('\n')
        .trim()
      const thinking = finalMessage.content
        .filter((part): part is { type: 'thinking'; thinking: string } => part.type === 'thinking')
        .map(part => part.thinking)
        .join('\n')
        .trim()
      return {
        answer,
        ...(thinking.length > 0 ? { thinking } : {}),
        model: finalMessage.model || config.modelId,
        provider: config.publicProvider,
        durationMs,
        ...(firstDeltaMs === undefined ? {} : { ttftMs: firstDeltaMs }),
      }
    } finally {
      this.releaseTurn(ephemeralSessionId, token)
    }
  }

  #createMockProvider() {
    return createProvider({
      id: INTERNAL_PROVIDER_IDS.mock,
      name: 'ClinMesh Mock',
      auth: {
        apiKey: {
          name: 'Mock Mode',
          resolve: async () => ({ auth: { apiKey: 'mock' }, source: 'clinmesh-mock' }),
        },
      },
      models: [buildDynamicModel(INTERNAL_PROVIDER_IDS.mock, 'mock-clinmesh-v1')],
      api: {
        stream: (model, context, options) => this.#streamMock(model, context, options as SimpleStreamOptions),
        streamSimple: (model, context, options) => this.#streamMock(model, context, options),
      },
    })
  }

  #streamMock(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    this.#faux.setResponses([
      async (ctx, opts, _state, fauxModel) => {
        if (this.#customMockResponder !== undefined) {
          return this.#customMockResponder(ctx, opts, fauxModel)
        }
        return defaultMockAssistantMessage(ctx, opts, fauxModel)
      },
    ])
    return this.#wrapRedactedStream(
      this.#faux.provider.streamSimple(model, context, options),
      [],
      options?.sessionId,
    )
  }

  #createLiveProvider(
    providerId: InternalProviderId,
    publicKind: Exclude<LlmProviderKind, 'mock'>,
    apiModule: {
      streamSimple: (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream
    },
  ) {
    const dispatch = (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const binding = options?.sessionId === undefined ? undefined : this.#ephemeralBySession.get(options.sessionId)
      const resolvedApiKey = binding?.config.apiKey
        ?? (this.#serverDefault?.provider === publicKind ? this.#serverDefault.apiKey : undefined)
      const resolvedBaseUrl = binding?.config.baseUrl
        ?? (this.#serverDefault?.provider === publicKind ? this.#serverDefault.baseUrl : defaultBaseUrlForProvider(publicKind))

      if (resolvedApiKey === undefined || resolvedApiKey.trim().length === 0) {
        return this.#immediateErrorStream(
          model,
          'LLM_PROVIDER_UNCONFIGURED: 未配置模型 API Key，请前往“设置 -> 模型与服务商”配置密钥或开启 Mock 模式。',
        )
      }

      const concreteModel = buildDynamicModel(providerId, model.id, {
        baseUrl: resolvedBaseUrl,
        ...(binding?.config.thinkingMode === undefined ? {} : { thinkingMode: binding.config.thinkingMode }),
        supportsAdaptiveThinking: publicKind === 'anthropic',
      })
      const upstream = apiModule.streamSimple(concreteModel, context, {
        ...options,
        apiKey: resolvedApiKey,
        timeoutMs: options?.timeoutMs ?? this.#serverDefault?.timeoutMs ?? 60_000,
      })
      return this.#wrapRedactedStream(upstream, [resolvedApiKey], options?.sessionId)
    }

    return createProvider({
      id: providerId,
      name: `ClinMesh ${publicKind}`,
      auth: {
        apiKey: {
          name: `ClinMesh ${publicKind} BYOK`,
          resolve: async () => ({ auth: { apiKey: 'ephemeral-byok' }, source: 'clinmesh-byok' }),
        },
      },
      models: [buildDynamicModel(providerId, 'default')],
      api: {
        stream: (model, context, options) => dispatch(model, context, options as SimpleStreamOptions),
        streamSimple: dispatch,
      },
    })
  }

  #createLocalCliProvider() {
    const dispatch = (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const binding = options?.sessionId === undefined ? undefined : this.#ephemeralBySession.get(options.sessionId)
      const runtime = binding?.config.localRuntime
      if (runtime === undefined) {
        return this.#immediateErrorStream(
          model,
          'LLM_PROVIDER_UNCONFIGURED: 本地 CLI 服务商未绑定当前请求，请在模型选择器中重新选择模型。',
        )
      }

      const concreteModel = buildDynamicModel(INTERNAL_PROVIDER_IDS.local, model.id, {
        api: runtime.api,
        baseUrl: runtime.baseUrl,
        contextWindow: runtime.model.contextWindow,
        maxTokens: runtime.model.maxTokens,
        reasoning: runtime.model.reasoning,
        thinkingMode: binding?.config.thinkingMode ?? 'auto',
        supportsAdaptiveThinking: runtime.model.supportsAdaptiveThinking,
        ...(runtime.compat === undefined ? {} : { compat: runtime.compat }),
        ...(runtime.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: runtime.thinkingLevelMap }),
        ...(runtime.headers === undefined ? {} : { headers: runtime.headers }),
      })

      const requestHeaders: Record<string, string | null> = {
        ...runtime.headers,
        ...options?.headers,
      }
      let effectiveApiKey: string | undefined = runtime.apiKey
      if (runtime.useBearerHeader && runtime.apiKey !== undefined) {
        requestHeaders.Authorization = `Bearer ${runtime.apiKey}`
        if (runtime.api === 'anthropic-messages') {
          // Anthropic SDK sends x-api-key when apiKey is set; omit apiKey so Bearer gateway auth is clean.
          effectiveApiKey = undefined
        }
      }

      const apiModule = streamApiForLocal(runtime.api)
      const streamOptions: SimpleStreamOptions = {
        ...options,
        ...(effectiveApiKey === undefined ? {} : { apiKey: effectiveApiKey }),
        ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
        timeoutMs: options?.timeoutMs ?? this.#serverDefault?.timeoutMs ?? 60_000,
      }
      // Remove apiKey explicitly when using Bearer-only Anthropic gateway auth.
      if (effectiveApiKey === undefined && 'apiKey' in streamOptions) {
        delete streamOptions.apiKey
      }

      const upstream = apiModule.streamSimple(concreteModel, context, streamOptions)
      return this.#wrapRedactedStream(upstream, runtime.secrets, options?.sessionId)
    }

    return createProvider({
      id: INTERNAL_PROVIDER_IDS.local,
      name: 'ClinMesh Local CLI Providers',
      auth: {
        apiKey: {
          name: 'Local CLI Provider',
          resolve: async () => ({ auth: { apiKey: 'ephemeral-local-cli' }, source: 'clinmesh-local-cli' }),
        },
      },
      models: [buildDynamicModel(INTERNAL_PROVIDER_IDS.local, 'default')],
      api: {
        stream: (model, context, options) => dispatch(model, context, options as SimpleStreamOptions),
        streamSimple: dispatch,
      },
    })
  }

  #createInjectedProvider() {
    const dispatch = (
      model: Model<Api>,
      _context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const binding = options?.sessionId === undefined ? undefined : this.#ephemeralBySession.get(options.sessionId)
      const invocation = binding?.config.injectedInvocation
      if (invocation === undefined) {
        return this.#immediateErrorStream(
          model,
          'LLM_PROVIDER_UNCONFIGURED: Injected patient dialogue provider is not bound for this session.',
        )
      }
      const stream = createAssistantMessageEventStream()
      void (async () => {
        const abortSignal = options?.signal
        const emitAborted = () => {
          const errorMessage: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: ZERO_USAGE,
            stopReason: 'aborted',
            errorMessage: 'Request aborted',
            timestamp: Date.now(),
          }
          stream.push({ type: 'error', reason: 'aborted', error: errorMessage })
          stream.end(errorMessage)
        }
        if (abortSignal?.aborted) {
          emitAborted()
          return
        }
        let settled = false
        const onAbort = () => {
          if (settled) return
          settled = true
          emitAborted()
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        try {
          const text = await invocation()
          if (settled) return
          settled = true
          const partial: AssistantMessage = {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: ZERO_USAGE,
            stopReason: 'stop',
            timestamp: Date.now(),
          }
          stream.push({ type: 'start', partial: { ...partial, content: [] } })
          stream.push({ type: 'text_start', contentIndex: 0, partial })
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial })
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial })
          stream.push({ type: 'done', reason: 'stop', message: partial })
          stream.end(partial)
        } catch (error) {
          if (settled) return
          settled = true
          const messageText = error instanceof Error ? error.message : String(error)
          const errorMessage: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: ZERO_USAGE,
            stopReason: abortSignal?.aborted ? 'aborted' : 'error',
            errorMessage: this.redact(messageText),
            timestamp: Date.now(),
          }
          stream.push({
            type: 'error',
            reason: abortSignal?.aborted ? 'aborted' : 'error',
            error: errorMessage,
          })
          stream.end(errorMessage)
        } finally {
          abortSignal?.removeEventListener('abort', onAbort)
        }
      })()
      return stream
    }

    return createProvider({
      id: INTERNAL_PROVIDER_IDS.injected,
      name: 'ClinMesh Injected Provider',
      auth: {
        apiKey: {
          name: 'Injected Provider',
          resolve: async () => ({ auth: { apiKey: 'injected' }, source: 'clinmesh-injected' }),
        },
      },
      models: [buildDynamicModel(INTERNAL_PROVIDER_IDS.injected, 'injected-consultation-model')],
      api: {
        stream: (model, context, options) => dispatch(model, context, options as SimpleStreamOptions),
        streamSimple: dispatch,
      },
    })
  }

  #immediateErrorStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream()
    const errorMsg: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: 'error',
      errorMessage: this.redact(errorMessage),
      timestamp: Date.now(),
    }
    queueMicrotask(() => {
      stream.push({ type: 'error', reason: 'error', error: errorMsg })
      stream.end(errorMsg)
    })
    return stream
  }

  #wrapRedactedStream(
    upstream: AssistantMessageEventStream,
    secrets: readonly string[],
    sessionId?: string,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream()
    const startedAt = Date.now()
    let recordedTtft = false
    void (async () => {
      try {
        for await (const event of upstream) {
          if (
            !recordedTtft
            && sessionId !== undefined
            && (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta')
          ) {
            recordedTtft = true
            this.#lastTtftBySession.set(sessionId, Math.max(0, Date.now() - startedAt))
          }
          if (event.type === 'error') {
            const sanitized: AssistantMessage = {
              ...event.error,
              ...(event.error.errorMessage === undefined
                ? {}
                : { errorMessage: redactLlmSecrets(event.error.errorMessage, secrets) }),
            }
            stream.push({ type: 'error', reason: event.reason, error: sanitized })
            stream.end(sanitized)
            return
          }
          if (event.type === 'done') {
            stream.push(event)
            stream.end(event.message)
            return
          }
          stream.push(event)
        }
      } catch (error) {
        const safeText = redactLlmSecrets(error instanceof Error ? error.message : String(error), secrets)
        const fallback: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider: INTERNAL_PROVIDER_IDS.openaiCompatible,
          model: 'unknown',
          usage: ZERO_USAGE,
          stopReason: 'error',
          errorMessage: safeText,
          timestamp: Date.now(),
        }
        stream.push({ type: 'error', reason: 'error', error: fallback })
        stream.end(fallback)
      }
    })()
    return stream
  }
}

export type { JsonChatCompletionInput, JsonChatCompletionsProvider }
