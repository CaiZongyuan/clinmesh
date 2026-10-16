import { createHash } from 'node:crypto'
import { z } from 'zod'
import { clinicalDocumentDraftContentSchema, consultationHistoryFactSchema, consultationHistoryFieldSchema, consultationHistorySummarySchema,
  consultationRecordingSourceSchema } from '@clinmesh/contracts/his'
import { RecordingSourceError, validateHistorySummaries, type HistorySummary } from './consultation-history-summary.ts'

const targetSchema = z.object({ id: z.string(), field: consultationHistoryFieldSchema, text: z.string() })
export const recordingBatchSchema = z.object({
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
export const recordingOutputSchema = z.object({ additions: z.array(consultationHistorySummarySchema.safeExtend({
  facts: z.array(consultationHistoryFactSchema).max(12),
  retainedFactIndexes: z.array(z.number().int().nonnegative()).max(12).optional(),
})).max(12) }).strict()

export function recordingModelPayload(batch: RecordingBatch) {
  const sourceId = (id: string) => `t${batch.sources.findIndex(source => source.id === id)}`
  const facts = (items: RecordingBatch['rejectedFacts']) => items.map(fact => ({ ...fact,
    sources: fact.sources.map(source => ({ ...source, sourceTurnId: sourceId(source.sourceTurnId) })),
  }))
  return {
    turns: recordingTurns(batch).map(turn => ({ ...turn, id: sourceId(turn.id) })),
    currentSourceIds: batch.members.map(member => sourceId(member.id)),
    history: batch.history.map((item, index) => ({ id: `h${index}`, field: item.field, text: item.text, quote: item.quote,
      facts: item.facts.map(fact => ({ text: fact.text, sources: fact.sources.map(source => ({ sourceTurnId: sourceId(source.sourceTurnId) })) })),
    })),
    rejectedFacts: facts(batch.rejectedFacts),
    ...(batch.manualHistory.length === 0 ? {} : { manualHistory: batch.manualHistory.map((item, index) => ({
      id: `m${index}`, field: item.field, text: item.text,
    })) }),
  }
}

export function decodeRecordingCandidates(value: unknown, batch: RecordingBatch) {
  const additions: HistorySummary[] = []
  const failures: ReturnType<typeof partitionRecordingCandidates>['failures'] = []
  const candidates = [...new Map(recordingOutputSchema.parse(value).additions.map(item => [recordingContentHash(item), item])).values()]
  const targets = new Map<string, string>([...batch.history.map((item, index) => [`h${index}`, item.id] as const),
    ...batch.manualHistory.map((item, index) => [`m${index}`, item.id] as const)])
  for (const [index, candidate] of candidates.entries()) {
    const { retainedFactIndexes = [], ...addition } = candidate
    const targetId = addition.targetAdditionId === undefined ? undefined : targets.get(addition.targetAdditionId) ?? addition.targetAdditionId
    const target = batch.history.find(item => item.id === targetId)
    const retained = retainedFactIndexes.map(index => target?.facts[index])
    const expanded = consultationHistorySummarySchema.safeParse({ ...addition,
      ...(targetId === undefined ? {} : { targetAdditionId: targetId }),
      facts: [...retained, ...addition.facts.map(fact => ({ ...fact, sources: fact.sources.map(source => ({ ...source,
        sourceTurnId: batch.sources.find((_, index) => `t${index}` === source.sourceTurnId)?.id ?? source.sourceTurnId,
      })) }))],
    })
    const competing = targetId !== undefined && candidates.some((other, otherIndex) => otherIndex !== index
      && (targets.get(other.targetAdditionId ?? '') ?? other.targetAdditionId) === targetId)
    if (!expanded.success || competing || new Set(retainedFactIndexes).size !== retainedFactIndexes.length) {
      failures.push({ id: recordingContentHash([index, candidate]), sourceIds: batch.members.map(member => member.id), reason: 'target' })
    } else additions.push(expanded.data)
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
