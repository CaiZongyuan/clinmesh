import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog } from '@clinmesh/contracts/his'
import { describe, expect, it } from 'vitest'
import { normalizePrescriptionRecommendation } from '../src/application/doctor-prescription-recommendations.ts'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'

type PrescriptionSuggestion = Extract<DoctorRecommendationSuggestion, { kind: 'prescription' }>
type MedicationCatalog = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications']

const baseline = createHospitalBaseline(syntheticNhsaMedicationProductSnapshot, syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot)
const catalog: MedicationCatalog = baseline.catalog.medications.map(item => ({
  ...item.workflow,
  defaultDoseText: item.defaultDose,
  defaultFrequencyCode: item.defaultFrequency,
  id: item.id,
  nameEn: item.name,
  nameZh: item.name,
  version: 1,
}))

const suggestion: PrescriptionSuggestion = {
  caseEvidenceIds: ['synthetic-case-evidence'],
  catalogItemId: 'medication-acetaminophen',
  courseDays: null,
  doseText: ' 0.5 g ',
  frequencyCode: ' PRN ',
  guidelineEvidenceIds: ['synthetic-guideline-evidence'],
  id: 'synthetic-prescription-suggestion',
  kind: 'prescription',
  label: '模型自行填写的药品名称',
  missingInformation: ['疗程和数量缺少适用依据'],
  opposingInformation: [],
  quantity: null,
  rationale: '合成依据，仅验证目录映射。',
  supportingInformation: ['合成病例资料'],
}

describe('prescription recommendation normalization', () => {
  it('resolves the actual hospital medication while preserving unsupported course and quantity as missing', () => {
    expect(normalizePrescriptionRecommendation(suggestion, catalog)).toEqual({
      ...suggestion,
      doseText: '0.5 g',
      frequencyCode: 'PRN',
      label: '对乙酰氨基酚片',
    })
  })

  it.each([
    { doseText: '1 g' },
    { frequencyCode: 'BID' },
    { courseDays: 5 },
    { quantity: 12 },
  ])('rejects a supplied regimen field outside the current hospital choices: %j', fields => {
    expect(normalizePrescriptionRecommendation({ ...suggestion, ...fields }, catalog)).toBeUndefined()
  })

  it('keeps all missing fields empty instead of using catalog defaults or inventing guideline evidence', () => {
    const normalized = normalizePrescriptionRecommendation({ ...suggestion,
      courseDays: null, doseText: ' ', frequencyCode: null, quantity: null,
    }, catalog)
    expect(normalized).toMatchObject({ courseDays: null, doseText: null, frequencyCode: null, quantity: null })
    expect(normalized?.guidelineEvidenceIds).toEqual(['synthetic-guideline-evidence'])
    expect(normalized?.caseEvidenceIds).toEqual(['synthetic-case-evidence'])
    expect(normalized?.missingInformation).toEqual(['疗程和数量缺少适用依据'])
  })

  it('rejects directory-external medication and medication removed from the current selectable catalog', () => {
    expect(normalizePrescriptionRecommendation({ ...suggestion, catalogItemId: 'medication-oseltamivir' }, catalog)).toBeUndefined()
    expect(normalizePrescriptionRecommendation(suggestion, catalog.filter(item => item.id !== suggestion.catalogItemId))).toBeUndefined()
  })

  it.each([
    { catalogItemId: 'medication-acetaminophen', courseDays: 3, doseText: '0.5 g', frequencyCode: 'PRN', quantity: 6, label: '对乙酰氨基酚片' },
    { catalogItemId: 'medication-metformin', courseDays: 30, doseText: '0.5 g', frequencyCode: 'BID', quantity: 60, label: '盐酸二甲双胍片' },
    { catalogItemId: 'medication-amlodipine', courseDays: 30, doseText: '5 mg', frequencyCode: 'QD', quantity: 30, label: '苯磺酸氨氯地平片' },
  ])('preserves a supplied regimen that fits the actual execution choices for $catalogItemId', fields => {
    expect(normalizePrescriptionRecommendation({ ...suggestion, ...fields }, catalog)).toMatchObject(fields)
  })
})
