import { expect, it } from 'vitest'
import { validateHistorySummaries, type HistorySummary, type HistoryTurn } from '../src/application/consultation-history-summary.ts'

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
