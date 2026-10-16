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
