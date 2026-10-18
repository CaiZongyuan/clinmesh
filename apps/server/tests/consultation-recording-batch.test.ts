import { expect, it } from 'vitest'
import { consultationHistoryFieldSchema } from '@clinmesh/contracts/his'
import { decodeRecordingCandidates, partitionRecordingCandidates, recordingBatchSchema, recordingModelPayload } from '../src/application/consultation-recording-batch.ts'

const batch = recordingBatchSchema.parse({
  members: [{ id: 'new-source', generation: 1 }],
  baseline: { version: 1, content: Object.fromEntries(consultationHistoryFieldSchema.options.map(field => [field, ''])) },
  sources: [
    { id: 'old-source', kind: 'doctor', messageText: '双肺呼吸音清。', recordedAt: '2026-10-16T00:00:00.000Z' },
    { id: 'new-source', kind: 'doctor', messageText: '心律齐。', recordedAt: '2026-10-16T00:00:03.000Z' },
  ],
  history: [{ id: 'old-addition', field: 'physicalExamination', text: '双肺呼吸音清', quote: '双肺呼吸音清。',
    sourceTurnId: 'old-source', facts: [{ text: '双肺呼吸音清', sources: [{ sourceTurnId: 'old-source', quote: '双肺呼吸音清。' }] }] }],
  manualHistory: [], rejectedFacts: [],
})
const update = { field: 'physicalExamination', relation: 'update', targetAdditionId: 'h0', retainedFactIndexes: [0],
  facts: [{ text: '心律齐', sources: [{ sourceTurnId: 't1', quote: '心律齐。' }] }] }

it('binds short model references to exact saved evidence and preserves unchanged facts', () => {
  const payload = recordingModelPayload(batch)
  expect(payload.currentSourceIds).toEqual(['t1'])
  expect(payload.turns.map(turn => turn.messageText)).toEqual(batch.sources.map(source => source.messageText))
  const decoded = decodeRecordingCandidates({ additions: [update] }, batch)
  expect(decoded.failures).toEqual([])
  expect(decoded.additions[0]).toMatchObject({ targetAdditionId: 'old-addition', facts: [batch.history[0]!.facts[0],
    { text: '心律齐', sources: [{ sourceTurnId: 'new-source', quote: '心律齐。' }] }] })
  expect(partitionRecordingCandidates(decoded.additions, batch).failures).toEqual([])
})

it('isolates a dangling retained fact and rejects its competing replacement as one group', () => {
  const independent = { field: 'assessment', relation: 'addition',
    facts: [{ text: '心律齐', sources: [{ sourceTurnId: 't1', quote: '心律齐。' }] }] }
  const decoded = decodeRecordingCandidates({ additions: [update, { ...update, retainedFactIndexes: [9] }, independent] }, batch)
  expect(decoded.failures).toHaveLength(2)
  expect(decoded.additions).toEqual([{ ...independent,
    facts: [{ text: '心律齐', sources: [{ sourceTurnId: 'new-source', quote: '心律齐。' }] }] }])
  expect(partitionRecordingCandidates(decoded.additions, batch).valid).toHaveLength(1)
})

it('does not turn a fabricated short source reference into valid evidence', () => {
  const decoded = decodeRecordingCandidates({ additions: [{ ...update,
    facts: [{ text: '心律齐', sources: [{ sourceTurnId: 't9', quote: '心律齐。' }] }] }] }, batch)
  expect(partitionRecordingCandidates(decoded.additions, batch)).toMatchObject({ valid: [], failures: [{ reason: 'citation' }] })
})

const independentBatch = recordingBatchSchema.parse({ ...batch,
  members: [...batch.members, { id: 'independent-source', generation: 1 }],
  sources: [...batch.sources, { id: 'independent-source', kind: 'doctor', messageText: '一周后复诊。', recordedAt: '2026-10-16T00:00:04.000Z' }],
})
const independentAddition = { field: 'followUp', relation: 'addition',
  facts: [{ text: '一周后复诊', sources: [{ sourceTurnId: 't2', quote: '一周后复诊。' }] }] }

it.each([
  { format: 'fact whitespace', duplicate: { ...update, facts: [{ ...update.facts[0]!, text: ' 心律齐 ' }] } },
  { format: 'JSON key order', duplicate: { relation: update.relation, retainedFactIndexes: [0], facts: [
    { sources: [{ quote: '心律齐。', sourceTurnId: 't1' }], text: '心律齐' },
  ], targetAdditionId: 'h0', field: update.field } },
])('records equivalent updates once despite $format', ({ duplicate }) => {
  const decoded = decodeRecordingCandidates({ additions: [update, duplicate, independentAddition] }, independentBatch)
  expect(decoded.failures).toEqual([])
  expect(decoded.additions).toHaveLength(2)
  expect(decoded.additions[0]).toMatchObject({ targetAdditionId: 'old-addition', facts: [batch.history[0]!.facts[0],
    { text: '心律齐', sources: [{ sourceTurnId: 'new-source', quote: '心律齐。' }] }] })
  expect(partitionRecordingCandidates(decoded.additions, independentBatch)).toMatchObject({ failures: [],
    valid: [{ field: 'physicalExamination' }, { field: 'followUp' }] })
})

const overlongText = '咳'.repeat(601)
it.each([
  { invalid: 'overlong-fact', change: { facts: [{ text: overlongText, sources: [{ sourceTurnId: 't1', quote: `${overlongText}。` }] }] }, reason: 'field-limit' },
  { invalid: 'too-many-facts', change: { facts: Array.from({ length: 13 }, () => update.facts[0]!) }, reason: 'field-limit' },
  { invalid: 'too-many-sources', change: { facts: [{ text: '心律齐', sources: Array.from({ length: 13 }, () => update.facts[0]!.sources[0]!) }] }, reason: 'field-limit' },
  { invalid: 'invalid-field', change: { field: 'invalid-field' }, reason: 'target' },
  { invalid: 'invalid-target', change: { targetAdditionId: 42 }, reason: 'target' },
])('isolates a fully cited $invalid without dropping an independent candidate', ({ invalid, change, reason }) => {
  const candidateBatch = recordingBatchSchema.parse({ ...independentBatch,
    sources: independentBatch.sources.map(source => invalid === 'overlong-fact' && source.id === 'new-source'
      ? { ...source, messageText: `${overlongText}。` } : source),
  })
  const decoded = decodeRecordingCandidates({ additions: [
    { ...update, ...change },
    independentAddition,
  ] }, candidateBatch)
  expect(decoded.failures).toEqual([{ id: expect.any(String), sourceIds: ['new-source'], reason }])
  expect(partitionRecordingCandidates(decoded.additions, candidateBatch)).toMatchObject({ failures: [], valid: [{ field: 'followUp' }] })
})

it.each(['dangling-index', 'overlong-fact', 'too-many-facts'])('keeps %s failures within their shared target and actual sources', invalid => {
  const broken = invalid === 'dangling-index' ? { ...update, retainedFactIndexes: [9] }
    : invalid === 'too-many-facts' ? { ...update, facts: Array.from({ length: 13 }, () => update.facts[0]!) }
    : { ...update, facts: [{ ...update.facts[0]!, text: '咳'.repeat(601) }] }
  const decoded = decodeRecordingCandidates({ additions: [update, broken, independentAddition] }, independentBatch)
  expect(decoded.failures).toHaveLength(2)
  expect(decoded.failures.every(failure => failure.sourceIds.length === 1 && failure.sourceIds[0] === 'new-source')).toBe(true)
  expect(partitionRecordingCandidates(decoded.additions, independentBatch)).toMatchObject({ failures: [], valid: [{ field: 'followUp' }] })
})

it.each([{}, { additions: [null] }, { additions: Array.from({ length: 13 }, () => independentAddition) }])(
  'rejects a response without a bounded set of attributable candidates', value => {
    expect(() => decodeRecordingCandidates(value, independentBatch)).toThrow()
  },
)
