import { createHash } from 'node:crypto'
import { z } from 'zod'
import { clinicalDocumentDraftContentSchema, consultationHistoryFactSchema, consultationHistoryFieldSchema, consultationHistorySummarySchema,
  consultationHistorySourceSchema, consultationRecordingSourceSchema } from '@clinmesh/contracts/his'
import { historySentenceSummaryPrompt, historySummaryPrompt, RecordingSourceError, validateHistorySummaries, type HistorySummary } from './consultation-history-summary.ts'
import { recordingSentences } from './consultation-recording-sentences.ts'

const targetSchema = z.object({ id: z.string(), field: consultationHistoryFieldSchema, text: z.string() })
export const recordingBatchSchema = z.object({
  citationProtocol: z.literal('sentence-references-v1').optional(),
  members: z.array(z.object({ id: z.string(), generation: z.number().int().positive() })).min(1).max(8),
  sources: z.array(consultationRecordingSourceSchema),
  baseline: z.object({ version: z.number().int().nonnegative(), content: clinicalDocumentDraftContentSchema }),
  history: z.array(targetSchema.extend({ facts: z.array(consultationHistoryFactSchema), quote: z.string(), sourceTurnId: z.string() })),
  manualHistory: z.array(targetSchema.extend({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })),
  rejectedFacts: z.array(consultationHistoryFactSchema.extend({ field: consultationHistoryFieldSchema })),
})
export type RecordingBatch = z.infer<typeof recordingBatchSchema>
export const recordingContentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const recordingTurns = (batch: RecordingBatch) => batch.sources.map(source => ({
  id: source.id, speaker: source.kind, kind: source.kind, messageText: source.messageText,
}))

// The model can retain exact facts from its immutable target instead of generating
// their text and evidence again. The public/persisted contract remains fully expanded.
const recordingCandidateSchema = consultationHistorySummarySchema.safeExtend({
  facts: z.array(consultationHistoryFactSchema).max(12),
  retainedFactIndexes: z.array(z.number().int().nonnegative()).max(12).optional(),
})
export const recordingOutputSchema = z.object({ additions: z.array(recordingCandidateSchema).max(12) }).strict()
const sentenceCandidateSchema = z.object({ ...recordingCandidateSchema.shape, facts: z.array(z.object({
  text: consultationHistoryFactSchema.shape.text,
  sourceIds: z.array(z.string().min(1).max(64)).min(1).max(12),
}).strict()).max(12) }).strict()
const sentenceOutputSchema = z.object({ additions: z.array(sentenceCandidateSchema).max(12) }).strict()

// Keep complete citations and a bounded envelope at the transport boundary;
// candidate content is validated separately so a bad sibling can be isolated.
export const recordingResponseSchema = z.object({ additions: z.array(z.object({
  targetAdditionId: z.unknown().optional(),
  facts: z.array(z.object({ sources: z.array(consultationHistorySourceSchema).min(1) }).passthrough()),
}).passthrough()).max(12) }).strict()
const sentenceResponseSchema = z.object({ additions: z.array(z.object({
  targetAdditionId: z.unknown().optional(),
  facts: z.array(z.object({ sourceIds: z.array(z.string()).min(1) }).passthrough()),
}).passthrough()).max(12) }).strict()

export const recordingModelOutputSchema = (batch: RecordingBatch) => batch.citationProtocol === undefined
  ? recordingOutputSchema : sentenceOutputSchema
export const recordingModelResponseSchema = (batch: RecordingBatch) => batch.citationProtocol === undefined
  ? recordingResponseSchema : sentenceResponseSchema

// Rebuild only from the persisted immutable batch. The versioned protocol fixes
// the splitting algorithm; the hash prevents references crossing snapshots.
export const recordingSentenceReferences = (batch: RecordingBatch) => recordingSentences(batch.sources, recordingContentHash(batch).slice(0, 16))

export function recordingModelPayload(batch: RecordingBatch) {
  const sentences = batch.citationProtocol === undefined ? undefined : recordingSentenceReferences(batch)
  const sourceId = (id: string) => `t${batch.sources.findIndex(source => source.id === id)}`
  const facts = (items: RecordingBatch['rejectedFacts']) => items.map(fact => ({ ...fact,
    sources: fact.sources.map(source => ({ ...source, sourceTurnId: sourceId(source.sourceTurnId) })),
  }))
  return {
    turns: recordingTurns(batch).map(turn => ({ ...turn, id: sourceId(turn.id),
      ...(sentences === undefined ? {} : { sentences: sentences.filter(sentence => sentence.sourceTurnId === turn.id)
        .map(sentence => ({ id: sentence.id, text: sentence.quote })) }),
    })),
    currentSourceIds: batch.members.map(member => sourceId(member.id)),
    history: batch.history.map((item, index) => ({ id: `h${index}`, field: item.field,
      ...(item.facts.length === 0 ? { text: item.text } : {}), quote: item.quote,
      facts: item.facts.map(fact => ({ text: fact.text, sources: fact.sources.map(source => ({ sourceTurnId: sourceId(source.sourceTurnId) })) })),
    })),
    rejectedFacts: facts(batch.rejectedFacts),
    ...(batch.manualHistory.length === 0 ? {} : { manualHistory: batch.manualHistory.map((item, index) => ({
      id: `m${index}`, field: item.field, text: item.text,
    })) }),
  }
}

export function recordingModelRequest(batch: RecordingBatch) {
  return { schemaName: 'consultation_history_summary',
    jsonSchema: z.toJSONSchema(recordingModelOutputSchema(batch)) as Record<string, unknown>,
    systemPrompt: `${batch.citationProtocol === undefined ? historySummaryPrompt : historySentenceSummaryPrompt}\n只处理 currentSourceIds 的新来源，其余 turns 是相邻上下文和原始证据。语义核对在保存后独立执行。\nupdate/correction/conflict 中保持不变的目标事实使用 retainedFactIndexes（目标 facts 的从零开始的下标）原样保留，不在 facts 重述；facts 只输出新增或更正的事实。保留事实在前、新事实在后，总数最多12；目标已满时将独立新事实写为 addition。${batch.citationProtocol === undefined ? '旧事实来源通过 sources 的 sourceTurnId 从 turns 恢复' : '旧事实的 sources.sourceTurnId 只用于查找原始 turns；新增或更正事实只用该轮 sentences 中的编号引用证据'}，不能凭空添加或遗漏有效事实。`,
    userPayload: recordingModelPayload(batch) }
}

function decodeSentenceCandidates(value: unknown, batch: RecordingBatch) {
  const sentences = new Map(recordingSentenceReferences(batch).map(sentence => [sentence.id, sentence]))
  return sentenceResponseSchema.parse(value).additions.map(candidate => {
    const parsed = sentenceCandidateSchema.safeParse(candidate)
    const normalized = parsed.success ? parsed.data : candidate
    const facts = normalized.facts.map(({ sourceIds, ...fact }) => ({ ...fact,
      sources: sourceIds.flatMap(id => {
        const sentence = sentences.get(id)
        return sentence === undefined ? [] : [{ sourceTurnId: sentence.sourceTurnId, quote: sentence.quote }]
      }),
    }))
    let referenceError: 'citation' | 'field-limit' | 'target' | undefined
    if (!parsed.success) referenceError = parsed.error.issues.some(issue => issue.code === 'too_big' && issue.path[0] === 'facts') ? 'field-limit' : 'target'
    else if (normalized.facts.some(fact => new Set(fact.sourceIds).size !== fact.sourceIds.length
      || fact.sourceIds.some(id => !sentences.has(id)))) referenceError = 'citation'
    return { candidate: { ...normalized, facts }, referenceError,
      // Include raw ids so different invalid references never deduplicate.
      identity: recordingContentHash(normalized) }
  })
}

export function decodeRecordingCandidates(value: unknown, batch: RecordingBatch) {
  const additions: HistorySummary[] = []
  const failures: ReturnType<typeof partitionRecordingCandidates>['failures'] = []
  const wireCandidates = batch.citationProtocol === undefined
    ? recordingResponseSchema.parse(value).additions.map(candidate => ({ candidate, referenceError: undefined, identity: undefined }))
    : decodeSentenceCandidates(value, batch)
  const parsedCandidates = wireCandidates.map(({ candidate, referenceError, identity }) => {
    const parsed = recordingCandidateSchema.safeParse(candidate)
    return { candidate: parsed.success ? parsed.data : candidate, parsed, referenceError, identity }
  })
  const candidates = [...new Map(parsedCandidates.map(item => [item.identity ?? recordingContentHash(item.candidate), item])).values()]
  const targets = new Map<string, string>([...batch.history.map((item, index) => [`h${index}`, item.id] as const),
    ...batch.manualHistory.map((item, index) => [`m${index}`, item.id] as const)])
  const resolveTarget = (value: unknown) => typeof value === 'string' ? targets.get(value) ?? value : undefined
  const sourceIds = new Map(batch.sources.map((source, index) => [`t${index}`, source.id]))
  for (const [index, { candidate, parsed, referenceError }] of candidates.entries()) {
    const targetId = resolveTarget(candidate.targetAdditionId)
    const citedIds = new Set(candidate.facts.flatMap(fact => fact.sources.map(source => sourceIds.get(source.sourceTurnId) ?? source.sourceTurnId)))
    const members = batch.members.filter(member => citedIds.has(member.id)).map(member => member.id)
    const fail = (reason: 'citation' | 'target' | 'field-limit') => failures.push({ id: recordingContentHash([index, candidate]),
      sourceIds: members.length === 0 ? batch.members.map(member => member.id) : members, reason })
    const competing = targetId !== undefined && candidates.some((other, otherIndex) => otherIndex !== index
      && resolveTarget(other.candidate.targetAdditionId) === targetId)
    if (competing) { fail('target'); continue }
    if (referenceError !== undefined) { fail(referenceError); continue }
    if (!parsed.success) {
      fail(parsed.error.issues.some(issue => issue.code === 'too_big' && issue.path[0] === 'facts') ? 'field-limit' : 'target')
      continue
    }
    const { retainedFactIndexes = [], ...addition } = parsed.data
    const target = batch.history.find(item => item.id === targetId)
    const retained = retainedFactIndexes.map(index => target?.facts[index])
    const expanded = consultationHistorySummarySchema.safeParse({ ...addition,
      ...(targetId === undefined ? {} : { targetAdditionId: targetId }),
      facts: [...retained, ...addition.facts.map(fact => ({ ...fact, sources: fact.sources.map(source => ({ ...source,
        sourceTurnId: sourceIds.get(source.sourceTurnId) ?? source.sourceTurnId,
      })) }))],
    })
    if (!expanded.success || new Set(retainedFactIndexes).size !== retainedFactIndexes.length) fail('target')
    else additions.push(expanded.data)
  }
  return { additions, failures }
}

// Invalid siblings sharing a replacement target form one failure group. A caller
// never partially accepts two competing replacements of the same fragment.
export function partitionRecordingCandidates(additions: HistorySummary[], batch: RecordingBatch) {
  additions = [...new Map(additions.map(addition => [recordingContentHash(addition), addition])).values()]
  const failures: Array<{ id: string; sourceIds: string[]; reason: 'citation' | 'target' | 'field-limit' }> = []
  const valid: HistorySummary[] = []
  for (const [index, addition] of additions.entries()) {
    try {
      if (addition.targetAdditionId !== undefined && additions.some((other, otherIndex) => otherIndex !== index
        && other.targetAdditionId === addition.targetAdditionId)) {
        throw new RecordingSourceError(['additions', index], 'Competing replacements require an atomic candidate', { reason: 'target' })
      }
      validateHistorySummaries([addition], recordingTurns(batch), batch.history, batch.manualHistory)
      valid.push(addition)
    } catch (error) {
      if (!(error instanceof RecordingSourceError)) throw error
      const ids = addition.facts.flatMap(fact => fact.sources.map(source => source.sourceTurnId))
      const sourceIds = batch.members.filter(member => ids.includes(member.id)).map(member => member.id)
      failures.push({ id: recordingContentHash([index, addition]),
        sourceIds: sourceIds.length === 0 ? batch.members.map(member => member.id) : sourceIds,
        reason: error.diagnostic.reason === 'target' ? 'target' : error.diagnostic.reason === 'field-limit' ? 'field-limit' : 'citation' })
    }
  }
  return { valid, failures }
}
