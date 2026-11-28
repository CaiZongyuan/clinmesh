import { createHash, randomUUID } from 'node:crypto'
import {
  getSystemMessageText,
  type AssistantMessage,
  type Message,
  type Tool,
  type Usage,
} from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  CompactionEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord,
} from '@earendil-works/pi-durable'
import type {
  ContextEventKind,
  ContextEventSummary,
  ContextItem,
  ContextItemKind,
  ContextKindTokenMap,
  ModelCallDetail,
  ModelCallPurpose,
  ModelCallStatus,
  ModelCallSummary,
  ModelCallUsage,
  ModelCallUsageSource,
  SessionContextResponse,
  ToolDefinitionSource,
} from '@clinmesh/contracts/agent-sessions'

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192
export const MAX_FULL_MODEL_CALLS_PER_SESSION = 100
export const CLINICAL_CONTEXT_MARKER = '【当前临床作用域上下文】'

export interface ContextItemInput {
  kind: ContextItemKind
  content: string
  label?: string
  source?: ToolDefinitionSource
  entryId?: number
}

export type StoredContextItemRef = {
  kind: ContextItemKind
  blobId: string
  tokens: number
  label: string | null
  source: ToolDefinitionSource | null
  entryId: number | null
}

export type StoredModelCallSummary = {
  id: string
  seq: number
  purpose: ModelCallPurpose
  provider: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  startedAt: string
  endedAt: string
  durationMs: number
  ttftMs: number | null
  tokensPerSecond: number | null
  status: ModelCallStatus
  errorMessage: string | null
  usage: {
    promptTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    totalTokens: number
    source: ModelCallUsageSource
  }
  estimate: {
    byKind: {
      INSTRUCTIONS: number
      CLINICAL_CONTEXT: number
      COMPACTED_SUMMARY: number
      TOOL_DEFINITION: number
      USER_MESSAGE: number
      ASSISTANT_MESSAGE: number
      REASONING: number
      TOOL_CALL: number
      TOOL_RESULT: number
    }
    inputTokens: number
    outputTokens: number
    excludedTokens: number
  }
  includedCount: number
  excludedCount: number
  responseToolNames: string[]
  hasDetail: boolean
  assistantEntryId: number | null
}

export type StoredModelCallRecord = {
  summary: StoredModelCallSummary
  includedRefs: StoredContextItemRef[] | null
  excludedRefs: StoredContextItemRef[] | null
  responseRefs: StoredContextItemRef[] | null
}

export type StoredContextEvent = {
  id: string
  kind: ContextEventKind
  createdAt: string
  afterCallSeq: number
  removedCount: number
  reclaimedTokens: number
  summaryTokens: number
  summarizedByModel: boolean
  summaryPreview: string | null
}

export type StoredContextSnapshotsDoc = {
  nextSeq: number
  blobs: Record<string, string>
  calls: StoredModelCallRecord[]
  events: StoredContextEvent[]
}

export function toPublicModelCallSummary(summary: StoredModelCallSummary): ModelCallSummary {
  return {
    id: summary.id,
    seq: summary.seq,
    purpose: summary.purpose,
    provider: summary.provider,
    model: summary.model,
    contextWindow: summary.contextWindow,
    maxOutputTokens: summary.maxOutputTokens,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    durationMs: summary.durationMs,
    ...(summary.ttftMs === null || summary.ttftMs === undefined ? {} : { ttftMs: summary.ttftMs }),
    ...(summary.tokensPerSecond === null || summary.tokensPerSecond === undefined ? {} : { tokensPerSecond: summary.tokensPerSecond }),
    status: summary.status,
    ...(summary.errorMessage === null ? {} : { errorMessage: summary.errorMessage }),
    usage: { ...summary.usage },
    estimate: {
      byKind: { ...summary.estimate.byKind },
      inputTokens: summary.estimate.inputTokens,
      outputTokens: summary.estimate.outputTokens,
      excludedTokens: summary.estimate.excludedTokens,
    },
    includedCount: summary.includedCount,
    excludedCount: summary.excludedCount,
    responseToolNames: [...summary.responseToolNames],
    hasDetail: summary.hasDetail,
    ...(summary.assistantEntryId === null ? {} : { assistantEntryId: summary.assistantEntryId }),
  }
}

function toPublicContextEvent(event: StoredContextEvent): ContextEventSummary {
  return {
    id: event.id,
    kind: event.kind,
    createdAt: event.createdAt,
    afterCallSeq: event.afterCallSeq,
    removedCount: event.removedCount,
    reclaimedTokens: event.reclaimedTokens,
    summaryTokens: event.summaryTokens,
    summarizedByModel: event.summarizedByModel,
    ...(event.summaryPreview === null ? {} : { summaryPreview: event.summaryPreview }),
  }
}

export function createInitialContextSnapshotsDoc(): StoredContextSnapshotsDoc {
  return {
    nextSeq: 0,
    blobs: {},
    calls: [],
    events: [],
  }
}

export function createZeroKindTokenMap(): ContextKindTokenMap {
  return {
    INSTRUCTIONS: 0,
    CLINICAL_CONTEXT: 0,
    COMPACTED_SUMMARY: 0,
    TOOL_DEFINITION: 0,
    USER_MESSAGE: 0,
    ASSISTANT_MESSAGE: 0,
    REASONING: 0,
    TOOL_CALL: 0,
    TOOL_RESULT: 0,
  }
}

/**
 * Deterministic CJK-aware token heuristic (~1.5 CJK chars/token, ~4 Latin chars/token).
 * Used for per-category proportional allocation and fallback estimation when a provider
 * omits usage counts or runs in Mock Mode.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0
  let cjkCount = 0
  let otherCount = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (
      (code >= 0x4E00 && code <= 0x9FFF)
      || (code >= 0x3400 && code <= 0x4DBF)
      || (code >= 0x3000 && code <= 0x303F)
      || (code >= 0xFF00 && code <= 0xFFEF)
    ) {
      cjkCount += 1
    } else {
      otherCount += 1
    }
  }
  return Math.max(1, Math.ceil(cjkCount / 1.5 + otherCount / 4))
}

export function hashBlobContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

function blocksToText(
  content: string | readonly ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[],
): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      const kb = Math.max(1, Math.round((part.data.length * 3) / 4 / 1024))
      return `[image: ${part.mimeType}, ${kb} KB]`
    })
    .join('\n')
}

function segmentSystemPromptText(text: string): ContextItemInput[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  const markerIndex = trimmed.indexOf(CLINICAL_CONTEXT_MARKER)
  if (markerIndex < 0) {
    return [{ kind: 'INSTRUCTIONS', label: 'system-instructions', content: trimmed }]
  }
  const items: ContextItemInput[] = []
  const before = trimmed.slice(0, markerIndex).trim()
  const after = trimmed.slice(markerIndex).trim()
  if (before.length > 0) {
    items.push({ kind: 'INSTRUCTIONS', label: 'system-instructions', content: before })
  }
  if (after.length > 0) {
    items.push({ kind: 'CLINICAL_CONTEXT', label: 'clinical-scope', content: after })
  }
  return items
}

function toolDefinitionItems(tools: readonly Tool[] | undefined): ContextItemInput[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map(tool => ({
    kind: 'TOOL_DEFINITION',
    label: tool.name,
    source: 'BUILTIN',
    content: JSON.stringify(
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
      null,
      2,
    ),
  }))
}

export function extractAssistantItems(
  message: AssistantMessage,
  entryId?: number,
): { items: ContextItemInput[]; toolNames: string[] } {
  const items: ContextItemInput[] = []
  const toolNames: string[] = []
  for (const part of message.content) {
    if (part.type === 'thinking') {
      const thinkingText = part.redacted ? '[redacted thinking]' : part.thinking
      if (thinkingText.trim().length > 0) {
        items.push({
          kind: 'REASONING',
          content: thinkingText,
          ...(entryId === undefined ? {} : { entryId }),
        })
      }
    } else if (part.type === 'toolCall') {
      toolNames.push(part.name)
      items.push({
        kind: 'TOOL_CALL',
        label: part.name,
        content: JSON.stringify(part.arguments ?? {}, null, 2),
        ...(entryId === undefined ? {} : { entryId }),
      })
    } else if (part.type === 'text') {
      if (part.text.trim().length > 0) {
        items.push({
          kind: 'ASSISTANT_MESSAGE',
          content: part.text,
          ...(entryId === undefined ? {} : { entryId }),
        })
      }
    }
  }
  return { items, toolNames }
}

/**
 * Converts the exact `Message[]` array passed to the provider into categorized ContextItems.
 */
export function buildIncludedItemsFromRequestMessages(messages: readonly Message[]): ContextItemInput[] {
  const items: ContextItemInput[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const fullSystemText = getSystemMessageText(message)
      items.push(...segmentSystemPromptText(fullSystemText))
      items.push(...toolDefinitionItems(message.toolsAdded))
      continue
    }
    if (message.role === 'user') {
      const text = blocksToText(message.content)
      if (text.trim().length > 0) {
        items.push({ kind: 'USER_MESSAGE', content: text })
      }
      continue
    }
    if (message.role === 'assistant') {
      items.push(...extractAssistantItems(message).items)
      continue
    }
    if (message.role === 'toolResult') {
      items.push({
        kind: 'TOOL_RESULT',
        label: message.isError ? `${message.toolName} (error)` : message.toolName,
        content: blocksToText(message.content),
      })
    }
  }
  return items
}

/**
 * Extracts entries that were explicitly omitted from the active context (e.g., retry-omitted replies
 * or compacted summaries) so the Context Browser can explain what was left out.
 */
export function buildExcludedItemsFromEntries(entries: readonly EntryRecord[]): ContextItemInput[] {
  const omittedIds = new Set<number>()
  for (const entry of entries) {
    if (entry.edits === undefined) continue
    for (const edit of entry.edits) {
      if (edit.action === 'omit') omittedIds.add(edit.target)
    }
  }
  if (omittedIds.size === 0) return []

  const excluded: ContextItemInput[] = []
  for (const entry of entries) {
    if (!omittedIds.has(entry.id)) continue
    if (UserEntry.is(entry)) {
      const msg = entry.model?.[0]
      if (msg?.role === 'user') {
        const text = blocksToText(msg.content)
        if (text.trim().length > 0) {
          excluded.push({ kind: 'USER_MESSAGE', content: text, entryId: entry.id })
        }
      }
      continue
    }
    if (AssistantEntry.is(entry)) {
      const msg = entry.model?.[0]
      if (msg?.role === 'assistant') {
        excluded.push(...extractAssistantItems(msg, entry.id).items)
      }
      continue
    }
    if (ToolResultEntry.is(entry)) {
      const msg = entry.model?.[0]
      if (msg?.role === 'toolResult') {
        excluded.push({
          kind: 'TOOL_RESULT',
          label: msg.isError ? `${msg.toolName} (error)` : msg.toolName,
          content: blocksToText(msg.content),
          entryId: entry.id,
        })
      }
      continue
    }
    if (CompactionEntry.is(entry)) {
      const msg = entry.model?.[0]
      if (msg?.role === 'user') {
        const text = blocksToText(msg.content)
        if (text.trim().length > 0) {
          excluded.push({ kind: 'COMPACTED_SUMMARY', content: text, entryId: entry.id })
        }
      }
    }
  }
  return excluded
}

export function resolveModelCallUsage(input: {
  providerUsage?: Usage
  estimatedInputTokens: number
  estimatedOutputTokens: number
  simulated: boolean
}): ModelCallUsage {
  const rawInput = Math.max(0, Math.round(input.providerUsage?.input ?? 0))
  const rawOutput = Math.max(0, Math.round(input.providerUsage?.output ?? 0))
  const cacheRead = Math.max(0, Math.round(input.providerUsage?.cacheRead ?? 0))
  const cacheWrite = Math.max(0, Math.round(input.providerUsage?.cacheWrite ?? 0))
  const rawPrompt = rawInput + cacheRead + cacheWrite

  if (input.simulated) {
    const promptTokens = rawPrompt > 0 ? rawPrompt : input.estimatedInputTokens
    const outputTokens = rawOutput > 0 ? rawOutput : input.estimatedOutputTokens
    return {
      promptTokens,
      inputTokens: rawInput > 0 ? rawInput : promptTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: promptTokens + outputTokens,
      source: 'SIMULATED',
    }
  }

  if (rawPrompt > 0 || rawOutput > 0) {
    const promptTokens = rawPrompt > 0 ? rawPrompt : input.estimatedInputTokens
    const outputTokens = rawOutput > 0 ? rawOutput : input.estimatedOutputTokens
    const source: ModelCallUsageSource = rawPrompt > 0 ? 'PROVIDER' : 'ESTIMATED'
    return {
      promptTokens,
      inputTokens: rawInput > 0 ? rawInput : Math.max(0, promptTokens - cacheRead - cacheWrite),
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: promptTokens + outputTokens,
      source,
    }
  }

  return {
    promptTokens: input.estimatedInputTokens,
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: input.estimatedInputTokens + input.estimatedOutputTokens,
    source: 'ESTIMATED',
  }
}

function storeItemRefs(
  blobs: Record<string, string>,
  items: readonly ContextItemInput[],
): StoredContextItemRef[] {
  return items.map((item) => {
    const blobId = hashBlobContent(item.content)
    if (blobs[blobId] === undefined) {
      blobs[blobId] = item.content
    }
    return {
      kind: item.kind,
      blobId,
      tokens: estimateTextTokens(item.content),
      label: item.label ?? null,
      source: item.source ?? null,
      entryId: item.entryId ?? null,
    }
  })
}

function pruneOldFullDetails(doc: StoredContextSnapshotsDoc): void {
  const retainedFromIndex = Math.max(0, doc.calls.length - MAX_FULL_MODEL_CALLS_PER_SESSION)
  let prunedAny = false
  for (let i = 0; i < retainedFromIndex; i += 1) {
    const rec = doc.calls[i]
    if (rec !== undefined && rec.summary.hasDetail) {
      rec.summary.hasDetail = false
      rec.includedRefs = null
      rec.excludedRefs = null
      rec.responseRefs = null
      prunedAny = true
    }
  }
  if (!prunedAny) return

  const activeBlobs = new Set<string>()
  for (const rec of doc.calls) {
    for (const ref of rec.includedRefs ?? []) activeBlobs.add(ref.blobId)
    for (const ref of rec.excludedRefs ?? []) activeBlobs.add(ref.blobId)
    for (const ref of rec.responseRefs ?? []) activeBlobs.add(ref.blobId)
  }
  for (const blobId of Object.keys(doc.blobs)) {
    if (!activeBlobs.has(blobId)) {
      delete doc.blobs[blobId]
    }
  }
}

export interface AppendModelCallSnapshotInput {
  purpose: ModelCallPurpose
  provider: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  startedAt: string
  endedAt: string
  durationMs: number
  ttftMs: number | null
  tokensPerSecond: number | null
  status: ModelCallStatus
  errorMessage?: string
  providerUsage?: Usage
  simulated: boolean
  included: readonly ContextItemInput[]
  excluded: readonly ContextItemInput[]
  response: readonly ContextItemInput[]
  responseToolNames: readonly string[]
  assistantEntryId?: number | null
}

export function appendModelCallSnapshot(
  doc: StoredContextSnapshotsDoc,
  input: AppendModelCallSnapshotInput,
): ModelCallSummary {
  const seq = doc.nextSeq + 1
  doc.nextSeq = seq

  const includedRefs = storeItemRefs(doc.blobs, input.included)
  const excludedRefs = storeItemRefs(doc.blobs, input.excluded)
  const responseRefs = storeItemRefs(doc.blobs, input.response)

  const byKind = createZeroKindTokenMap()
  let estimatedInputTokens = 0
  for (const ref of includedRefs) {
    byKind[ref.kind] += ref.tokens
    estimatedInputTokens += ref.tokens
  }
  let estimatedOutputTokens = 0
  for (const ref of responseRefs) {
    estimatedOutputTokens += ref.tokens
  }
  let estimatedExcludedTokens = 0
  for (const ref of excludedRefs) {
    estimatedExcludedTokens += ref.tokens
  }

  const usage = resolveModelCallUsage({
    ...(input.providerUsage === undefined ? {} : { providerUsage: input.providerUsage }),
    estimatedInputTokens,
    estimatedOutputTokens,
    simulated: input.simulated,
  })

  const durationMs = Math.max(0, Math.round(input.durationMs))
  const computedTps = input.tokensPerSecond !== null
    ? input.tokensPerSecond
    : (durationMs > 0 && usage.outputTokens > 0
        ? Math.round((usage.outputTokens / (durationMs / 1000)) * 10) / 10
        : null)

  const storedSummary: StoredModelCallSummary = {
    id: `mcall-${randomUUID()}`,
    seq,
    purpose: input.purpose,
    provider: input.provider,
    model: input.model,
    contextWindow: Math.max(1, Math.round(input.contextWindow)),
    maxOutputTokens: Math.max(1, Math.round(input.maxOutputTokens)),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs,
    ttftMs: input.ttftMs === null ? null : Math.max(0, Math.round(input.ttftMs)),
    tokensPerSecond: computedTps,
    status: input.status,
    errorMessage: input.errorMessage !== undefined && input.errorMessage.length > 0 ? input.errorMessage : null,
    usage,
    estimate: {
      byKind,
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      excludedTokens: estimatedExcludedTokens,
    },
    includedCount: includedRefs.length,
    excludedCount: excludedRefs.length,
    responseToolNames: [...input.responseToolNames],
    hasDetail: true,
    assistantEntryId: input.assistantEntryId ?? null,
  }

  doc.calls.push({
    summary: storedSummary,
    includedRefs,
    excludedRefs,
    responseRefs,
  })
  pruneOldFullDetails(doc)
  return toPublicModelCallSummary(storedSummary)
}

export function appendContextEvent(
  doc: StoredContextSnapshotsDoc,
  input: {
    kind: ContextEventKind
    removedCount: number
    reclaimedTokens: number
    summaryTokens: number
    summarizedByModel: boolean
    summaryPreview?: string
  },
): ContextEventSummary {
  const storedEvent: StoredContextEvent = {
    id: `cevt-${randomUUID()}`,
    kind: input.kind,
    createdAt: new Date().toISOString(),
    afterCallSeq: doc.nextSeq,
    removedCount: Math.max(0, Math.round(input.removedCount)),
    reclaimedTokens: Math.max(0, Math.round(input.reclaimedTokens)),
    summaryTokens: Math.max(0, Math.round(input.summaryTokens)),
    summarizedByModel: input.summarizedByModel,
    summaryPreview: input.summaryPreview !== undefined && input.summaryPreview.length > 0
      ? input.summaryPreview.slice(0, 240)
      : null,
  }
  doc.events.push(storedEvent)
  return toPublicContextEvent(storedEvent)
}

function hydrateRefs(
  blobs: Readonly<Record<string, string>>,
  refs: readonly StoredContextItemRef[] | null | undefined,
): ContextItem[] {
  if (refs === undefined || refs === null) return []
  return refs.map(ref => ({
    kind: ref.kind,
    blobId: ref.blobId,
    content: blobs[ref.blobId] ?? '',
    tokens: ref.tokens,
    ...(ref.label === null ? {} : { label: ref.label }),
    ...(ref.source === null ? {} : { source: ref.source }),
    ...(ref.entryId === null ? {} : { entryId: ref.entryId }),
  }))
}

export function hydrateModelCallDetail(
  doc: StoredContextSnapshotsDoc | undefined,
  callId: string,
): ModelCallDetail | null {
  if (doc === undefined) return null
  const record = doc.calls.find(item => item.summary.id === callId)
  if (record === undefined) return null
  return {
    ...toPublicModelCallSummary(record.summary),
    included: hydrateRefs(doc.blobs, record.includedRefs),
    excluded: hydrateRefs(doc.blobs, record.excludedRefs),
    response: hydrateRefs(doc.blobs, record.responseRefs),
  }
}

export function summarizeSessionContext(
  sessionId: string,
  doc: StoredContextSnapshotsDoc | undefined,
): SessionContextResponse {
  const calls = doc?.calls.map(item => toPublicModelCallSummary(item.summary)) ?? []
  const events = doc?.events.map(toPublicContextEvent) ?? []
  const latestCall = calls.length > 0 ? calls[calls.length - 1]! : null
  return {
    sessionId,
    defaultContextWindow: latestCall?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    modelCalls: calls,
    contextEvents: events,
    latestCall,
  }
}
