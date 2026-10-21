import { expect, it } from 'vitest'
import { doctorRecommendationGenerationSchema, doctorRecommendationRecoverySchema, doctorRecommendationStateSchema, confirmDoctorPreparationRequestSchema } from '../src/doctor-recommendations.ts'

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

it('allows manual confirmation without a preparation proof and requires both proof fields for any agent selection', () => {
  const manual = { kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }
  const request = { expectedVersions: { 'Encounter/synthetic-encounter': '1' }, input: {
    expectedDraftVersion: 1, resolveExistingDraft: true, selections: [manual],
  } }
  expect(confirmDoctorPreparationRequestSchema.safeParse(request).success).toBe(true)
  const selections = [manual, { ...manual, source: 'agent', suggestionId: 'prepared-diagnosis', catalogItemId: 'diagnosis-hypertension', role: 'secondary' }]
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input, selections } }).success).toBe(false)
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input, selections, generation: 1 } }).success).toBe(false)
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input, selections, inputFingerprint: 'a'.repeat(64) } }).success).toBe(false)
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input, selections, generation: 1, inputFingerprint: 'a'.repeat(64) } }).success).toBe(true)
  expect(confirmDoctorPreparationRequestSchema.safeParse({ ...request, input: { ...request.input, resolveExistingDraft: 'true' } }).success).toBe(false)
})

it('preserves the selected Reference medication product for the shared manual editor', () => {
  const referenceProduct = { approvalNumber: '合成批准文号', brandName: null, code: 'SYNTHETIC-MED', dosageForm: '片剂',
    genericName: '合成药品', id: 'reference-medication', manufacturer: '合成药厂', packageDescription: '30片/盒',
    sourceLocator: 'synthetic:medications[0]', status: 'active', strength: '5mg', system: 'https://example.org/synthetic-medications', version: '1' }
  const request = { expectedVersions: { 'Encounter/synthetic-encounter': '1' }, input: {
    expectedDraftVersion: 0, selections: [{ kind: 'prescription', source: 'manual', catalogItemId: referenceProduct.id,
      doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30, referenceProduct }],
  } }
  expect(confirmDoctorPreparationRequestSchema.parse(request).input.selections[0]).toHaveProperty('referenceProduct', referenceProduct)
})

it('accepts a maximal execution recovery covering all five stages at their batch limits', () => {
  const unit = (stage: string, batchId: string) => ({ stage, batchId, status: 'succeeded', requestCount: 1 })
  const units = [
    ...Array.from({ length: 8 }, (_, index) => unit('history-selection', String(index + 1))),
    unit('history-consolidation', '1'),
    ...Array.from({ length: 8 }, (_, index) => unit('catalog-selection', String(index + 1))),
    unit('generation', '1'),
    ...Array.from({ length: 8 }, (_, index) => unit('verification', String(index + 1))),
  ]
  expect(units).toHaveLength(26)
  expect(doctorRecommendationRecoverySchema.parse({
    status: 'completed', requestCount: 26, extraRequestCount: 0,
    maxRequestsPerUnit: 3, maxExtraRequests: 4, canContinue: false, units,
  })).toMatchObject({ status: 'completed' })
})
