import { expect, it, vi } from 'vitest'
import { validateHistorySummaries, verifyHistorySummaries, type HistorySummary, type HistoryTurn } from '../src/application/consultation-history-summary.ts'
import type { JsonChatCompletionInput } from '../src/infrastructure/ai/openai-chat-completions.ts'

const mixedReply = '医生，那我今天到现在还没吃东西，水也就抿了两口，这样抽血行不行啊？'
const patient: HistoryTurn = { id: 'patient-turn', speaker: 'patient', messageText: mixedReply }
const summary = (field: HistorySummary['field'], sourceTurnId: string, quote: string): HistorySummary[] => [{
  field, relation: 'addition', facts: [{ text: '患者自述今日尚未进食，仅饮少量水', sources: [{ sourceTurnId, quote }] }],
}]

it.each(['chiefComplaint', 'historyOfPresentIllness', 'priorMedicalHistory'] as const)(
  'accepts a complete mixed question citation for %s', field => {
    expect(() => validateHistorySummaries(summary(field, patient.id, mixedReply), [patient], [], [])).not.toThrow()
  },
)

it.each([
  [mixedReply, '医生，那我今天到现在还没吃东西，水也就抿了两口'],
  ['胸痛已经三天了吗？', '胸痛已经三天了吗'],
  ['胸痛已经三天?', '胸痛已经三天'],
  ['我没有胸痛，你说的胸痛是怎样的？', '胸痛'],
])('rejects clipping a question into a statement: %s', (messageText, quote) => {
  expect(() => validateHistorySummaries(summary('historyOfPresentIllness', patient.id, quote),
    [{ ...patient, messageText }], [], [])).toThrow()
})

it.each([
  { id: patient.id, speaker: 'doctor', messageText: mixedReply },
  { ...patient, id: 'another-case-or-future-turn' },
  { ...patient, messageText: '患者没有说过引用中的内容。' },
])('rejects an unattributed mixed question citation: $speaker/$id', turn => {
  expect(() => validateHistorySummaries(summary('historyOfPresentIllness', patient.id, mixedReply), [turn], [], [])).toThrow()
})

it.each(['physicalExamination', 'assessment', 'disposition', 'followUp'] as const)(
  'records %s only from saved explicit doctor sources', field => {
    const doctor = { id: 'doctor-supplement', speaker: 'doctor', kind: 'doctor' as const, messageText: '查体右下腹压痛，考虑阑尾炎，安排腹部超声，明日复诊。' }
    expect(() => validateHistorySummaries(summary(field, doctor.id, doctor.messageText), [doctor], [], [])).not.toThrow()
    expect(() => validateHistorySummaries(summary(field, patient.id, mixedReply), [patient], [], [])).toThrow()
  },
)

it.each([false, true])('sends the complete new-evidence scope to the verifier (batch: %s)', async batched => {
  const oldSource = { id: 'old-source', speaker: 'patient', messageText: '以前服用青霉素后出现皮疹。' }
  const newSource = { ...oldSource, id: 'new-supporting-source' }
  const unrelatedSource = { id: 'unrelated-source', speaker: 'patient', messageText: '咳嗽已经两天。' }
  const turns = batched ? [oldSource, newSource, unrelatedSource] : [oldSource, newSource]
  const rejectedFact = { text: '患者自述服用青霉素后出现皮疹',
    sources: [{ sourceTurnId: oldSource.id, quote: oldSource.messageText }] }
  const additions: HistorySummary[] = [{ field: 'allergyHistory', relation: 'addition',
    facts: [{ ...rejectedFact, sources: [{ sourceTurnId: newSource.id, quote: newSource.messageText }] }] }]
  const completeJson = vi.fn(async (_input: JsonChatCompletionInput) => ({ model: 'synthetic', content: JSON.stringify({
    additions: [{ index: 0, faithful: true, complete: true, relationValid: true }],
  }) }))

  await verifyHistorySummaries({ completeJson }, 'synthetic', new AbortController().signal,
    additions, turns, [], [], [{ ...rejectedFact, field: 'allergyHistory' }],
    batched ? [newSource.id, unrelatedSource.id] : undefined)

  expect(completeJson).toHaveBeenCalledTimes(1)
  const request = completeJson.mock.calls[0]![0]
  expect(request.userPayload).toEqual({ additions, turns, history: [], manualHistory: [],
    rejectedFacts: [{ ...rejectedFact, field: 'allergyHistory' }], currentTurnId: turns.at(-1)!.id,
    ...(batched ? { currentSourceIds: [newSource.id, unrelatedSource.id] } : {}) })
  expect(request.systemPrompt).toContain('currentSourceIds 中任一新来源')
  expect(request.systemPrompt).toContain('未提供 currentSourceIds 时，才以 currentTurnId 作为本次新来源')
  expect(request.systemPrompt).not.toContain('只有 currentTurnId 的新来源')
  expect(request.systemPrompt).toContain('旧来源重新摘引或无关新事实的引用不能解除拒绝')
})
