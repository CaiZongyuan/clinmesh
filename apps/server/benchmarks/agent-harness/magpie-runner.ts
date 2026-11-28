import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  MemoryStorage,
  ProviderDoc,
  ToolTask,
  type Extension,
  type ToolExecutionResult,
  type ToolHookCall,
} from '@earendil-works/pi-durable'
import type { CodemodeToolDetails } from '@earendil-works/pi-durable/codemode'
import {
  ClinMeshProviderRegistry,
  type ResolvedTurnConfig,
} from '../../src/infrastructure/agents/byok-provider-resolver.ts'
import type {
  ThinkingEffort,
  ToolCallTrace,
  TurnTelemetry,
} from './types.ts'

export const BENCHMARK_PROVIDER_ID = 'pi:magpie'
export const BENCHMARK_MODEL_ID = 'neo-sub2api/gpt-6.1-terra'

let sharedProviders: ClinMeshProviderRegistry | undefined

export function getBenchmarkProviders(): ClinMeshProviderRegistry {
  if (sharedProviders === undefined) {
    sharedProviders = new ClinMeshProviderRegistry({
      localProviders: { enabled: true },
    })
  }
  return sharedProviders
}

export function resolveMagpieConfig(effort: ThinkingEffort): ResolvedTurnConfig {
  const providers = getBenchmarkProviders()
  const config = providers.resolveTurnConfig('assistant', {
    'x-clinmesh-llm-mode': 'local',
    'x-clinmesh-llm-local-provider': BENCHMARK_PROVIDER_ID,
    'x-clinmesh-llm-model': BENCHMARK_MODEL_ID,
    'x-clinmesh-llm-reasoning-effort': effort,
  })
  if (config === null) {
    throw new Error(
      `Unable to resolve local provider ${BENCHMARK_PROVIDER_ID} / ${BENCHMARK_MODEL_ID}. Ensure magpie is running on 127.0.0.1:3425 and ~/.pi/agent/models.json is readable.`,
    )
  }
  return config
}

function estimateMessagesChars(messages: readonly Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length
        else if (part.type === 'thinking') chars += part.thinking.length
        else if (part.type === 'toolCall') chars += part.name.length + JSON.stringify(part.arguments ?? {}).length
      }
    }
    if (m.role === 'system' && m.toolsAdded) {
      chars += JSON.stringify(m.toolsAdded).length
    }
  }
  return chars
}

function extractTextFromAssistant(message: AssistantMessage): { text: string; thinkingChars: number } {
  let text = ''
  let thinkingChars = 0
  for (const part of message.content) {
    if (part.type === 'text') text += (text ? '\n' : '') + part.text
    else if (part.type === 'thinking') thinkingChars += part.thinking.length
  }
  return { text: text.trim(), thinkingChars }
}

function previewJson(value: unknown, maxChars = 240): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (raw === undefined) return ''
  return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}…`
}

export interface RunHarnessConversationInput {
  readonly effort: ThinkingEffort
  readonly extensions: readonly Extension[]
  readonly instructions: string
  readonly userPrompt: string
  readonly maxTurns?: number
  readonly timeoutMs?: number
}

export interface RunHarnessConversationOutput {
  readonly status: 'ok' | 'error' | 'turn_limit'
  readonly errorMessage?: string
  readonly wallDurationMs: number
  readonly finalAnswer: string
  readonly turns: TurnTelemetry[]
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCacheReadTokens: number
  readonly totalCacheWriteTokens: number
  readonly totalTokens: number
  readonly turn1InputTokens: number
  readonly cacheHitRatePct: number
  readonly toolCallCount: number
  readonly nestedCodemodeCallCount: number
  readonly toolErrorCount: number
  readonly avgTtftMs: number | null
  readonly firstTurnTtftMs: number | null
}

export async function runPiDurableAgentTurn(
  input: RunHarnessConversationInput,
): Promise<RunHarnessConversationOutput> {
  const providers = getBenchmarkProviders()
  const resolved = resolveMagpieConfig(input.effort)
  const storage = new MemoryStorage()
  const registry = createRegistry()

  const turns: TurnTelemetry[] = []
  let activeTurnStartMs = Date.now()
  let activeTurnPromptChars = 0
  let activeTurnOfferedTools = 0
  let currentTurnIndex = 0
  const toolStartByCallId = new Map<string, number>()
  const toolTracesByTurn = new Map<number, ToolCallTrace[]>()
  let lastErrorMessage: string | undefined

  const telemetryExtension = defineExtension({
    name: 'benchmark.telemetry',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          currentTurnIndex += 1
          activeTurnStartMs = Date.now()
          activeTurnPromptChars = estimateMessagesChars(request.messages)
          const conv = await harness.conversation(api.conversationId, context)
          const resolvedAgent = conv ? await conv.agent(context) : undefined
          activeTurnOfferedTools = resolvedAgent?.tools.length ?? 0
          return undefined
        },
        afterResponse: async (message, api, context) => {
          const endedAt = Date.now()
          const providerDoc = await api.snapshot(ProviderDoc, api.conversationId, context)
          const ttftMs = providerDoc?.sessionId ? providers.consumeLastTtftMs(providerDoc.sessionId) : null
          const { text, thinkingChars } = extractTextFromAssistant(message)
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            lastErrorMessage = providers.redact(message.errorMessage ?? `Model stopped with ${message.stopReason}`)
          }
          const usage = message.usage
          const turnObj: TurnTelemetry = {
            turnIndex: currentTurnIndex,
            durationMs: Math.max(1, endedAt - activeTurnStartMs),
            ttftMs,
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead ?? 0,
            cacheWriteTokens: usage.cacheWrite ?? 0,
            totalTokens: usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)),
            offeredToolCount: activeTurnOfferedTools,
            promptCharsEstimate: activeTurnPromptChars,
            thinkingChars,
            textChars: text.length,
            stopReason: message.stopReason,
            toolCalls: [],
          }
          turns.push(turnObj)
          toolTracesByTurn.set(currentTurnIndex, turnObj.toolCalls)
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call: ToolHookCall) => {
          if (call.parent === undefined) {
            toolStartByCallId.set(call.id, Date.now())
          }
          return undefined
        },
        afterTool: async (call: ToolHookCall, result: ToolExecutionResult) => {
          if (call.parent !== undefined) return undefined
          const startedAt = toolStartByCallId.get(call.id) ?? Date.now()
          const durationMs = Math.max(0, Date.now() - startedAt)
          toolStartByCallId.delete(call.id)

          let outputText = ''
          if (Array.isArray(result.output)) {
            outputText = result.output
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text)
              .join('\n')
          } else if (result.structuredOutput !== undefined) {
            outputText = JSON.stringify(result.structuredOutput)
          }

          let nestedCalls: ToolCallTrace['nestedCalls']
          if (call.name === 'codemode' && result.details && typeof result.details === 'object' && 'calls' in result.details) {
            const cmDetails = result.details as CodemodeToolDetails
            if (Array.isArray(cmDetails.calls)) {
              nestedCalls = cmDetails.calls.map(c => ({
                name: c.name,
                status: c.status,
                ...(c.durationMs === undefined ? {} : { durationMs: c.durationMs }),
                argsPreview: providers.redact(previewJson(c.args, 140)),
                ...(c.error === undefined ? {} : { error: providers.redact(c.error) }),
              }))
            }
          }

          const trace: ToolCallTrace = {
            callId: call.id,
            name: call.name,
            argsPreview: providers.redact(previewJson(call.arguments, 220)),
            durationMs,
            isError: result.isError === true,
            outputChars: outputText.length,
            outputPreview: providers.redact(previewJson(outputText, 240)),
            ...(nestedCalls ? { nestedCalls } : {}),
          }
          const bucket = toolTracesByTurn.get(currentTurnIndex)
          if (bucket) bucket.push(trace)
          return undefined
        },
      }),
    ],
  })

  registry.install(telemetryExtension)
  for (const ext of input.extensions) {
    registry.install(ext)
  }

  const harness = await Harness.open(
    storage,
    {
      models: () => providers.models,
      registry,
      settings: {
        extensions: [telemetryExtension, ...input.extensions],
        stream: {
          timeoutMs: input.timeoutMs ?? 90_000,
          maxRetries: 0, // Strict check-benchmark & AGENTS.md: never silently retry failed live calls
        },
        retry: {
          enabled: false,
          maxRetries: 0,
          baseDelayMs: 500,
        },
        compaction: { enabled: false },
        toolExecution: 'parallel',
      },
      onReport: () => {
        // Captured via turn/run diagnostics
      },
    },
    BACKGROUND_CONTEXT,
  )
  harness.resume()

  const wallStart = Date.now()
  let providerSessionId: string | undefined
  let bindingToken: string | undefined

  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          model: { provider: resolved.internalProviderId, modelId: resolved.modelId },
          thinkingLevel: resolved.thinkingLevel,
          extensions: [telemetryExtension, ...input.extensions],
          instructions: input.instructions,
          maxTurns: input.maxTurns ?? 12,
        },
        init: async (tx, conversationId) => {
          await tx.doc(ProviderDoc, conversationId)
        },
      },
      BACKGROUND_CONTEXT,
    )

    providerSessionId = await conversation.commit(async (tx) => {
      const doc = await tx.doc(ProviderDoc, conversation.id)
      return doc.sessionId
    }, BACKGROUND_CONTEXT)
    bindingToken = providers.bindTurn(providerSessionId, resolved)

    const submission = await conversation.submit(
      {
        type: 'input',
        requestId: `bench-${randomUUID()}`,
        content: input.userPrompt,
      },
      BACKGROUND_CONTEXT,
    )

    const settled = await submission.wait(BACKGROUND_CONTEXT)
    const wallDurationMs = Math.max(1, Date.now() - wallStart)
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)
    const ctxView = await conversation.context(BACKGROUND_CONTEXT)

    let finalAnswer = ''
    for (let i = ctxView.messages.length - 1; i >= 0; i -= 1) {
      const msg = ctxView.messages[i]
      if (msg?.role === 'assistant') {
        const extracted = extractTextFromAssistant(msg)
        if (extracted.text.length > 0) {
          finalAnswer = providers.redact(extracted.text)
          break
        }
      }
    }

    const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0)
    const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0)
    const totalCacheReadTokens = turns.reduce((s, t) => s + t.cacheReadTokens, 0)
    const totalCacheWriteTokens = turns.reduce((s, t) => s + t.cacheWriteTokens, 0)
    const totalTokens = turns.reduce((s, t) => s + t.totalTokens, 0)
    const turn1InputTokens = (turns[0]?.inputTokens ?? 0) + (turns[0]?.cacheReadTokens ?? 0)
    const promptDenom = totalInputTokens + totalCacheReadTokens
    const cacheHitRatePct = promptDenom > 0 ? Number(((totalCacheReadTokens / promptDenom) * 100).toFixed(1)) : 0

    let toolCallCount = 0
    let nestedCodemodeCallCount = 0
    let toolErrorCount = 0
    for (const t of turns) {
      for (const tc of t.toolCalls) {
        toolCallCount += 1
        if (tc.isError) toolErrorCount += 1
        if (tc.nestedCalls) {
          nestedCodemodeCallCount += tc.nestedCalls.length
          for (const nc of tc.nestedCalls) {
            if (nc.status === 'error') toolErrorCount += 1
          }
        }
      }
    }

    const ttftValues = turns.map(t => t.ttftMs).filter((v): v is number => v !== null)
    const avgTtftMs = ttftValues.length > 0
      ? Math.round(ttftValues.reduce((s, v) => s + v, 0) / ttftValues.length)
      : null
    const firstTurnTtftMs = turns[0]?.ttftMs ?? null

    let status: 'ok' | 'error' | 'turn_limit' = 'ok'
    let errorMessage = lastErrorMessage
    if (settled.status === 'unanswered') {
      const reason = live?.runFailure?.reason ?? settled.reason
      if (reason === 'turn_limit') {
        status = 'turn_limit'
        errorMessage = `Reached maxTurns (${input.maxTurns ?? 12})`
      } else {
        status = 'error'
        errorMessage = errorMessage ?? `Run settled unanswered (${String(reason ?? 'unknown')})`
      }
    } else if (lastErrorMessage !== undefined && finalAnswer.length === 0) {
      status = 'error'
    }

    return {
      status,
      ...(errorMessage ? { errorMessage } : {}),
      wallDurationMs,
      finalAnswer,
      turns,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalTokens,
      turn1InputTokens,
      cacheHitRatePct,
      toolCallCount,
      nestedCodemodeCallCount,
      toolErrorCount,
      avgTtftMs,
      firstTurnTtftMs,
    }
  } finally {
    if (providerSessionId && bindingToken) {
      providers.releaseTurn(providerSessionId, bindingToken)
    }
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined)
  }
}
