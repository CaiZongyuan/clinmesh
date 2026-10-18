import { expect, it } from 'vitest'
import { doctorRecommendationGenerationSchema, doctorRecommendationStateSchema, confirmDoctorPreparationRequestSchema } from '../src/doctor-recommendations.ts'

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


it('reads persisted diagnoses without an invented role while requiring model proposals to include one', () => {
  const guideline = { id: 'synthetic-guideline', title: '合成指南', publisher: '合成机构', documentType: 'guideline',
    version: '1', url: 'https://example.org/synthetic-guideline', locator: '第1段', scope: '合成病例验证',
    text: '合成条款正文。', sourceHash: 'b'.repeat(64) }
  const item = { ...consideration, kind: 'diagnosis', catalogItemId: 'diagnosis-fever', guidelineEvidenceIds: [guideline.id] }
  const legacy = doctorRecommendationStateSchema.parse({ ...state, guidelines: [guideline], items: [item] })
  expect(legacy.items[0]).not.toHaveProperty('role')
  expect(doctorRecommendationGenerationSchema.safeParse({ items: [item], missingInformation: [] }).success).toBe(false)
  expect(doctorRecommendationGenerationSchema.safeParse({ items: [{ ...item, role: 'secondary' }], missingInformation: [] }).success).toBe(true)
})

it('accepts explicit manual selection without pretending that it has an agent proof', () => {
  const request = { expectedVersions: { 'Encounter/synthetic-encounter': '1' }, input: {
    generation: 2, inputFingerprint: 'a'.repeat(64), expectedDraftVersion: 0,
    selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }],
  } }
  expect(confirmDoctorPreparationRequestSchema.safeParse(request).success).toBe(true)
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input,
    selections: [{ ...request.input.selections[0], suggestionId: 'old-agent-item' }],
  } }).success).toBe(false)
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input,
    selections: [{ ...request.input.selections[0], source: 'agent' }],
  } }).success).toBe(false)
})
