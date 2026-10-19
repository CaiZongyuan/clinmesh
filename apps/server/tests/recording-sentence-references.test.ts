import { expect, it } from 'vitest'
import { consultationHistoryFieldSchema } from '@clinmesh/contracts/his'
import { findCompleteStatementQuote } from '@clinmesh/core/document-text'
import { decodeRecordingCandidates, partitionRecordingCandidates, recordingBatchSchema, recordingModelOutputSchema,
  recordingModelRequest, recordingSentenceReferences } from '../src/application/consultation-recording-batch.ts'

const batch = recordingBatchSchema.parse({ citationProtocol: 'sentence-references-v1',
  members: [{ id: 'new-source', generation: 1 }],
  baseline: { version: 1, content: Object.fromEntries(consultationHistoryFieldSchema.options.map(field => [field, ''])) },
  sources: [
    { id: 'old-source', kind: 'patient', messageText: '昨晚发热，最高量到38.5℃。没有胸痛。', recordedAt: '2026-10-16T00:00:00.000Z' },
    { id: 'new-source', kind: 'patient', messageText: '没有胸痛。\r\n 我可能昨晚发烧了，需要检查吗？\n仅饮少量水，这样能抽血吗?\r\n如果还发热，再来检查；尚未测量', recordedAt: '2026-10-16T00:00:03.000Z' },
  ],
  history: [{ id: 'old-addition', field: 'historyOfPresentIllness', text: '自述昨晚发热，最高38.5℃', quote: '昨晚发热，最高量到38.5℃。',
    sourceTurnId: 'old-source', facts: [{ text: '自述昨晚发热，最高38.5℃', sources: [{ sourceTurnId: 'old-source', quote: '昨晚发热，最高量到38.5℃。' }] }] }],
  manualHistory: [], rejectedFacts: [],
})
const references = recordingSentenceReferences(batch)
const addition = { field: 'historyOfPresentIllness', relation: 'addition', facts: [{ text: '否认胸痛', sourceIds: [references[2]!.id] }] }

it('reconstructs exact positions, punctuation, repeated sentences and source identities from the immutable snapshot', () => {
  expect(references.map(item => item.quote)).toEqual(['昨晚发热，最高量到38.5℃。', '没有胸痛。', '没有胸痛。',
    '我可能昨晚发烧了，需要检查吗？', '仅饮少量水，这样能抽血吗?', '如果还发热，再来检查；', '尚未测量'])
  expect(references[1]!.id).not.toBe(references[2]!.id)
  for (const reference of references) {
    const source = batch.sources.find(source => source.id === reference.sourceTurnId)!
    expect(source.messageText.slice(reference.start, reference.end)).toBe(reference.quote)
    expect(findCompleteStatementQuote(source.messageText, reference.quote)).toBeDefined()
  }
  expect(recordingSentenceReferences(recordingBatchSchema.parse(JSON.parse(JSON.stringify(batch))))).toEqual(references)
  const duplicate = recordingBatchSchema.parse({ ...batch, sources: [{ ...batch.sources[0], messageText: '无胸痛。\r\n无胸痛。\n无胸痛。' }] })
  expect(recordingSentenceReferences(duplicate).map(item => [item.start, item.end, item.quote])).toEqual([
    [0, 4, '无胸痛。'], [6, 10, '无胸痛。'], [11, 15, '无胸痛。'],
  ])
})

it.each(['胸痛。？', '胸痛。 ？', '胸痛!?', '胸痛！； ？', '还没吃东西，水喝得很少，能抽血吗？'])('keeps complete question endings intact: %s', messageText => {
  const snapshot = recordingBatchSchema.parse({ ...batch, sources: [{ ...batch.sources[1], messageText }] })
  expect(recordingSentenceReferences(snapshot).map(item => item.quote)).toEqual([messageText])
})

it('decodes multi-sentence, multi-turn evidence and retains unchanged facts without regeneration', () => {
  const output = { additions: [{ ...addition, relation: 'update', targetAdditionId: 'h0', retainedFactIndexes: [0],
    facts: [{ text: '持续否认胸痛', sourceIds: [references[1]!.id, references[2]!.id] }] }] }
  const decoded = decodeRecordingCandidates(output, batch)
  expect(decoded).toMatchObject({ failures: [], additions: [{ targetAdditionId: 'old-addition', facts: [batch.history[0]!.facts[0],
    { text: '持续否认胸痛', sources: [{ sourceTurnId: 'old-source', quote: '没有胸痛。' }, { sourceTurnId: 'new-source', quote: '没有胸痛。' }] }] }] })
  expect(partitionRecordingCandidates(decoded.additions, batch).failures).toEqual([])
  const schema = JSON.stringify(recordingModelOutputSchema(batch))
  expect(schema).toContain('sourceIds')
  expect(schema).not.toContain('sourceTurnId')
  expect(schema).not.toContain('quote')
  expect(decodeRecordingCandidates({ additions: [] }, batch)).toEqual({ additions: [], failures: [] })
})

it('records equivalent updates once when they cite repeated sentences within the same source', () => {
  const snapshot = recordingBatchSchema.parse({ ...batch,
    sources: batch.sources.map(source => source.id === 'new-source' ? { ...source, messageText: '没有胸痛。没有胸痛。' } : source),
  })
  const repeated = recordingSentenceReferences(snapshot).filter(sentence => sentence.sourceTurnId === 'new-source')
  const decoded = decodeRecordingCandidates({ additions: repeated.map(sentence => ({ ...addition,
    relation: 'update', targetAdditionId: 'h0', retainedFactIndexes: [0],
    facts: [{ text: '否认胸痛', sourceIds: [sentence.id] }],
  })) }, snapshot)
  expect(decoded).toMatchObject({ failures: [], additions: [{ targetAdditionId: 'old-addition',
    facts: [batch.history[0]!.facts[0], { text: '否认胸痛', sources: [{ sourceTurnId: 'new-source', quote: '没有胸痛。' }] }],
  }] })
  expect(decoded.additions).toHaveLength(1)
  expect(partitionRecordingCandidates(decoded.additions, snapshot)).toMatchObject({ failures: [], valid: decoded.additions })
})

it('keeps replacements citing identical text from different sources distinct', () => {
  const decoded = decodeRecordingCandidates({ additions: [references[1]!, references[2]!].map(sentence => ({ ...addition,
    relation: 'update', targetAdditionId: 'h0', retainedFactIndexes: [0],
    facts: [{ text: '否认胸痛', sourceIds: [sentence.id] }],
  })) }, batch)
  expect(decoded.additions).toEqual([])
  expect(decoded.failures.map(item => item.reason)).toEqual(['target', 'target'])
})

it('keeps different invalid references attributable after decoding and accepts an independent candidate', () => {
  const decoded = decodeRecordingCandidates({ additions: [addition, ...['unknown-a', 'unknown-b'].map(id => ({ ...addition,
    facts: [{ text: '错误引用', sourceIds: [id] }],
  }))] }, batch)
  expect(decoded.failures).toMatchObject([
    { reason: 'citation', sourceIds: ['new-source'] }, { reason: 'citation', sourceIds: ['new-source'] },
  ])
  expect(partitionRecordingCandidates(decoded.additions, batch)).toMatchObject({ failures: [], valid: [{ field: 'historyOfPresentIllness' }] })
})

it.each(['unknown', 'duplicate', 'different-generation', 'different-source', 'raw-source-id'])(
  'isolates a %s reference without accepting guessed evidence', invalid => {
    const changed = recordingBatchSchema.parse({ ...batch, members: [{ id: 'new-source', generation: 2 }],
      ...(invalid === 'different-source' ? { sources: batch.sources.map(source => ({ ...source, id: `other-${source.id}` })) } : {}) })
    const sourceIds = invalid === 'duplicate' ? [references[2]!.id, references[2]!.id]
      : invalid.startsWith('different') ? [recordingSentenceReferences(changed)[2]!.id]
      : [invalid === 'raw-source-id' ? 'new-source' : 's-unknown']
    const decoded = decodeRecordingCandidates({ additions: [addition, { ...addition, facts: [{ text: '错误引用', sourceIds }] }] }, batch)
    expect(decoded.failures).toMatchObject([{ reason: 'citation', sourceIds: ['new-source'] }])
    expect(partitionRecordingCandidates(decoded.additions, batch).valid).toHaveLength(1)
  },
)

it('preserves atomic replacement conflicts even when one candidate has an unknown reference', () => {
  const update = { ...addition, relation: 'update', targetAdditionId: 'h0', retainedFactIndexes: [0] }
  const decoded = decodeRecordingCandidates({ additions: [update, { ...update, facts: [{ text: '错误引用', sourceIds: ['unknown'] }] }] }, batch)
  expect(decoded.additions).toEqual([])
  expect(decoded.failures.map(item => item.reason)).toEqual(['target', 'target'])
})

it('keeps role and field authorization after decoding valid sentence references', () => {
  const decoded = decodeRecordingCandidates({ additions: [{ ...addition, field: 'physicalExamination' }] }, batch)
  expect(decoded.failures).toEqual([])
  expect(partitionRecordingCandidates(decoded.additions, batch)).toMatchObject({ valid: [], failures: [{ reason: 'citation' }] })
})

it('fails oversized evidence and reference capacity without truncating the original sentences', () => {
  const snapshot = recordingBatchSchema.parse({ ...batch, sources: [{ ...batch.sources[1], messageText: `${'合'.repeat(2_001)}。` }] })
  const sentence = recordingSentenceReferences(snapshot)[0]!
  expect(sentence.quote).toHaveLength(2_002)
  const tooLong = decodeRecordingCandidates({ additions: [{ ...addition, facts: [{ text: '超长来源', sourceIds: [sentence.id] }] }] }, snapshot)
  expect(tooLong).toMatchObject({ additions: [], failures: [{ reason: 'field-limit' }] })
  const tooMany = decodeRecordingCandidates({ additions: [{ ...addition, facts: [{ text: '来源超限', sourceIds: Array.from({ length: 13 }, () => references[2]!.id) }] }] }, batch)
  expect(tooMany.additions).toEqual([])
  expect(tooMany.failures).toMatchObject([{ reason: 'field-limit' }])
})

it('keeps legacy snapshot and receipt citations readable under their original protocol', () => {
  const { citationProtocol: _protocol, ...legacy } = batch
  const input = { additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [{ text: '否认胸痛',
    sources: [{ sourceTurnId: 't1', quote: '没有胸痛。' }] }] }] }
  expect(decodeRecordingCandidates(input, recordingBatchSchema.parse(legacy))).toMatchObject({ failures: [], additions: [{ facts: [{
    sources: [{ sourceTurnId: 'new-source', quote: '没有胸痛。' }],
  }] }] })
  expect(recordingModelRequest(legacy).systemPrompt).toContain('逐字完整句子 quote')
  expect(() => decodeRecordingCandidates(input, batch)).toThrow()
})

it('measures serialized input and response bytes for a fixed synthetic multi-turn fixture', () => {
  const { citationProtocol: _protocol, ...legacy } = batch
  const oldResponse = { additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [{
    text: '自述可能昨晚发热，仅饮少量水', sources: [3, 4].map(index => ({ sourceTurnId: 't1', quote: references[index]!.quote })),
  }] }] }
  const newResponse = { additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [{
    text: '自述可能昨晚发热，仅饮少量水', sourceIds: [references[3]!.id, references[4]!.id],
  }] }] }
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
  const metrics = { oldInput: bytes(recordingModelRequest(legacy)), newInput: bytes(recordingModelRequest(batch)),
    oldOutput: bytes(oldResponse), newOutput: bytes(newResponse) }
  expect(metrics.newOutput).toBeLessThan(metrics.oldOutput)
  expect(decodeRecordingCandidates(newResponse, batch).additions).toEqual(decodeRecordingCandidates(oldResponse, legacy).additions)
  console.info('recording sentence-reference fixture bytes', metrics)
})
