import { expect, it } from 'vitest'
import { doctorRecommendationGenerationSchema, doctorRecommendationStateSchema } from '../src/doctor-recommendations.ts'

const state = {
  caseId: 'synthetic-case', kind: 'diagnosis', encounterId: 'synthetic-encounter', encounterVersion: '1',
  inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, stale: false,
  items: [], guidelines: [], missingInformation: [],
  caseEvidence: [{ id: 'synthetic-triage', kind: 'presentation', label: '分诊记录', text: '分诊记录体温37℃；患者自述发热时未自行测量。' }],
}
const consideration = {
  id: 'synthetic-fever-consideration', label: '核对发热病程',
  rationale: '分诊体温与患者此前发热感属于不同时间和来源，需要分别记录。',
  supportingInformation: ['患者自述曾有发热感。'], opposingInformation: ['分诊记录体温37℃。'],
  missingInformation: ['补问发热感的起始时间，以评估症状演变。'], caseEvidenceIds: ['synthetic-triage'],
}

it('accepts a read-only consideration grounded in this case without fabricating a guideline', () => {
  expect(doctorRecommendationStateSchema.parse({ ...state, considerations: [consideration],
    notices: [{ category: 'guideline', message: '本轮未检索到可支持具体建议的适用条款。' }],
  })).toMatchObject({ items: [], guidelines: [], considerations: [consideration] })
})

it.each([
  { label: 'an unknown case reference', value: { ...consideration, caseEvidenceIds: ['other-patient-record'] } },
  { label: 'no case evidence', value: { ...consideration, caseEvidenceIds: [] } },
  { label: 'an executable catalog identity', value: { ...consideration, catalogItemId: 'diagnosis-influenza' } },
  { label: 'a fabricated guideline claim', value: { ...consideration, guidelineEvidenceIds: ['invented-guideline'] } },
])('rejects read-only reasoning with $label', ({ value }) => {
  expect(doctorRecommendationStateSchema.safeParse({ ...state, considerations: [value] }).success).toBe(false)
})

it('keeps prescriptions out of unguided reasoning and continues reading legacy states', () => {
  expect(doctorRecommendationStateSchema.safeParse(state).success).toBe(true)
  expect(doctorRecommendationStateSchema.safeParse({ ...state, kind: 'prescription', considerations: [consideration] }).success).toBe(false)
})

it('bounds the combined generated suggestions and read-only considerations', () => {
  const output = { items: [{ ...consideration, kind: 'diagnosis', catalogItemId: 'diagnosis-fever', guidelineEvidenceIds: ['real-guideline'] }],
    considerations: Array.from({ length: 8 }, (_, index) => ({ ...consideration, id: `idea-${index}` })), missingInformation: [] }
  expect(doctorRecommendationGenerationSchema.safeParse(output).success).toBe(false)
})
