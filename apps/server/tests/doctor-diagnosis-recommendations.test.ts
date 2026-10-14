import type { ReferenceConcept } from '@clinmesh/contracts/reference-data'
import { describe, expect, it } from 'vitest'
import { normalizeDoctorDiagnosisRecommendation } from '../src/application/doctor-diagnosis-recommendations.ts'

const suggestion = {
  id: 'recommendation-fever',
  kind: 'diagnosis' as const,
  catalogItemId: 'diagnosis-fever',
  label: '模型自造的诊断名称',
  rationale: '需要核对当前症状。',
  supportingInformation: ['本次记录体温升高。'],
  opposingInformation: [],
  missingInformation: ['待核实病程。'],
  guidelineEvidenceIds: ['synthetic-fever-guideline'],
  caseEvidenceIds: ['synthetic-triage-evidence'],
}

const reference: ReferenceConcept = {
  id: 'nhc-icd10-I10', code: 'I10', display: '原发性高血压', domain: 'diagnosis',
  sourceLocator: 'synthetic:nhc-icd10:2022:I10', status: 'active',
  system: 'http://hl7.org/fhir/sid/icd-10', version: '2022',
}

describe('doctor diagnosis recommendation directory resolution', () => {
  it('uses the real local diagnosis label and coding instead of model-supplied metadata', () => {
    expect(normalizeDoctorDiagnosisRecommendation(suggestion, {
      local: [{
        id: 'diagnosis-fever', code: 'R50.9', nameZh: '发热，未特指', nameEn: 'Fever, unspecified',
        system: 'http://hl7.org/fhir/sid/icd-10', version: 1,
      }],
      reference: [],
    })).toEqual({
      ...suggestion,
      label: '发热，未特指',
      referenceConcept: {
        id: 'diagnosis-fever', code: 'R50.9', display: '发热，未特指',
        system: 'http://hl7.org/fhir/sid/icd-10', version: '1',
        sourceLocator: 'operational:diagnosis_catalog',
      },
    })
  })

  it('resolves an active reference diagnosis outside the local common catalog', () => {
    const input = { ...suggestion, catalogItemId: 'nhc-icd10-I10' }
    expect(normalizeDoctorDiagnosisRecommendation(input, {
      local: [],
      reference: [reference],
    })).toEqual({
      ...input,
      label: '原发性高血压',
      referenceConcept: {
        id: 'nhc-icd10-I10', code: 'I10', display: '原发性高血压',
        sourceLocator: 'synthetic:nhc-icd10:2022:I10',
        system: 'http://hl7.org/fhir/sid/icd-10', version: '2022',
      },
    })
  })

  it('does not resolve an unknown diagnosis', () => {
    expect(normalizeDoctorDiagnosisRecommendation({ ...suggestion, catalogItemId: 'unknown-diagnosis' }, {
      local: [], reference: [reference],
    })).toBeUndefined()
  })

  it('does not resolve an inactive reference diagnosis', () => {
    expect(normalizeDoctorDiagnosisRecommendation({ ...suggestion, catalogItemId: reference.id }, {
      local: [], reference: [{ ...reference, status: 'inactive' }],
    })).toBeUndefined()
  })

  it('does not resolve a reference item from another clinical domain', () => {
    expect(normalizeDoctorDiagnosisRecommendation({ ...suggestion, catalogItemId: reference.id }, {
      local: [], reference: [{ ...reference, domain: 'medication' }],
    })).toBeUndefined()
  })

  it.each(['id', 'code', 'system', 'version'] as const)('rejects a model coding snapshot with a mismatched %s', field => {
    expect(normalizeDoctorDiagnosisRecommendation({
      ...suggestion,
      catalogItemId: reference.id,
      referenceConcept: {
        id: 'nhc-icd10-I10', code: 'I10', display: '原发性高血压',
        sourceLocator: 'synthetic:nhc-icd10:2022:I10',
        system: 'http://hl7.org/fhir/sid/icd-10', version: '2022',
        [field]: 'model-fabricated-coding',
      },
    }, { local: [], reference: [reference] })).toBeUndefined()
  })
})
