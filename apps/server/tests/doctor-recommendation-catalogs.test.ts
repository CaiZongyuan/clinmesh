import { expect, it } from 'vitest'
import { projectRecommendationCatalogs, type DoctorRecommendationCatalogs } from '../src/application/doctor-recommendation-catalogs.ts'
import { normalizeDoctorDiagnosisRecommendation } from '../src/application/doctor-diagnosis-recommendations.ts'

it('projects complete diagnosis identities for the model while retaining the original provenance for normalization', () => {
  const catalogs: DoctorRecommendationCatalogs = {
    diagnoses: {
      local: [{
        id: 'local-fever', code: 'R50.9', nameZh: '发热，未特指', nameEn: 'Fever, unspecified',
        system: 'http://hl7.org/fhir/sid/icd-10', version: 2, priceFen: 100,
      }],
      reference: [{
        id: 'reference-hypertension', code: 'I10', display: '原发性高血压',
        domain: 'diagnosis', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '2022',
        sourceLocator: 'synthetic:diagnoses.csv:10',
      }, {
        id: 'retired-reference', code: 'R50.9', display: '停用的合成诊断',
        domain: 'diagnosis', status: 'inactive', system: 'http://hl7.org/fhir/sid/icd-10', version: '2021',
        sourceLocator: 'synthetic:diagnoses.csv:11',
      }],
    },
  }
  const original = structuredClone(catalogs)

  const projected = projectRecommendationCatalogs(catalogs)

  expect(projected.diagnoses).toEqual({
    local: [{
      id: 'local-fever', code: 'R50.9', nameZh: '发热，未特指', nameEn: 'Fever, unspecified',
      system: 'http://hl7.org/fhir/sid/icd-10', version: 2, priceFen: 100,
    }],
    reference: [{
      id: 'reference-hypertension', code: 'I10', display: '原发性高血压',
      domain: 'diagnosis', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '2022',
    }, {
      id: 'retired-reference', code: 'R50.9', display: '停用的合成诊断',
      domain: 'diagnosis', status: 'inactive', system: 'http://hl7.org/fhir/sid/icd-10', version: '2021',
    }],
  })
  expect(catalogs).toEqual(original)

  const normalized = normalizeDoctorDiagnosisRecommendation({
    id: 'synthetic-suggestion', kind: 'diagnosis', catalogItemId: projected.diagnoses!.reference[0]!.id,
    label: '模型提供的名称', rationale: '根据合成病历核对。', supportingInformation: [], opposingInformation: [],
    missingInformation: [], guidelineEvidenceIds: ['synthetic-guideline'], caseEvidenceIds: ['synthetic-evidence'],
  }, catalogs.diagnoses!)

  expect(normalized).toMatchObject({
    label: '原发性高血压',
    referenceConcept: {
      id: 'reference-hypertension', code: 'I10', display: '原发性高血压',
      system: 'http://hl7.org/fhir/sid/icd-10', version: '2022', sourceLocator: 'synthetic:diagnoses.csv:10',
    },
  })
})
