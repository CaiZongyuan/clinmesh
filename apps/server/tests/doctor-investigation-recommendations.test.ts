import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { CaseLaboratoryCatalogSearch, ImagingServiceSnapshot, PathologyServiceSnapshot } from '@clinmesh/contracts/his'
import { describe, expect, it } from 'vitest'
import { normalizeInvestigationRecommendation } from '../src/application/doctor-investigation-recommendations.ts'

const evidence = {
  id: 'synthetic-suggestion', label: '模型给出的名称', rationale: '依据提供的条款与当前病例。',
  supportingInformation: ['医生已核实的症状'], opposingInformation: [], missingInformation: [],
  guidelineEvidenceIds: ['synthetic-guideline'], caseEvidenceIds: ['synthetic-case-evidence'],
}
const imaging: ImagingServiceSnapshot = {
  applicability: '合成成人检查适用范围', bodySite: '胸部', code: 'SYN-CT', department: '放射科',
  examCode: 'chest-ct-plain', id: 'synthetic-ct', method: '平扫', modality: 'CT', name: '合成胸部 CT 平扫',
  reportSections: ['technique', 'findings', 'impression'], version: 1,
}
const pathology: PathologyServiceSnapshot = {
  applicability: '合成既往乳腺手术切片会诊', bodySite: '乳腺', code: 'SYN-PATH', department: '病理科',
  examCode: 'breast-slide-consultation', id: 'synthetic-pathology', name: '合成乳腺切片病理会诊',
  reportSections: ['specimen', 'microscopy', 'diagnosis'], specimenType: '既往手术切片', stain: 'HE', version: 1,
}
const laboratory: CaseLaboratoryCatalogSearch = {
  items: [{
    allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: [], doctorOrderable: true,
    executingDepartmentId: 'laboratory', id: 'synthetic-laboratory', localCode: 'SYN-LAB',
    nameEn: 'Synthetic laboratory test', nameZh: '合成检验项目', priceFen: 2500,
    referenceConcept: { id: 'synthetic-reference', code: 'SYN-1', display: '合成指标',
      system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test' },
    referenceReleaseId: 'synthetic-release', reportDefinition: {
      conclusionTemplate: '合成检验结果。', results: [{
        referenceConcept: { id: 'synthetic-reference', code: 'SYN-1', display: '合成指标',
          system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test' },
        alternateCodings: [], referenceRange: { low: 0, high: 10, text: '0–10' },
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, valueType: 'quantity',
      }],
    }, specimen: { code: 'blood', display: '静脉血' }, serviceKind: 'laboratory', tatMinutes: 180, version: 1,
  }], page: 1, pageSize: 20, total: 1,
}
const laboratorySuggestion: DoctorRecommendationSuggestion = {
  ...evidence, kind: 'laboratory', catalogItemId: 'synthetic-laboratory', indicationCode: 'clinical-evaluation',
}
const imagingSuggestion: DoctorRecommendationSuggestion = {
  ...evidence, kind: 'imaging', serviceId: imaging.id, indication: '持续咳嗽两周。',
}
const pathologySuggestion: DoctorRecommendationSuggestion = {
  ...evidence, kind: 'pathology', serviceId: pathology.id,
  sourceProcedureReference: 'urn:uuid:synthetic-procedure', purpose: '复核既往手术切片。',
}

describe('doctor investigation recommendation targets', () => {
  it('uses the actual hospital laboratory label and rejects unknown items or unsupported indications', () => {
    expect(normalizeInvestigationRecommendation(laboratorySuggestion, { laboratory }))
      .toMatchObject({ label: '合成检验项目', catalogItemId: 'synthetic-laboratory', indicationCode: 'clinical-evaluation' })
    expect(normalizeInvestigationRecommendation({ ...laboratorySuggestion, catalogItemId: 'unknown' }, { laboratory })).toBeUndefined()
    expect(normalizeInvestigationRecommendation({ ...laboratorySuggestion, indicationCode: 'unapproved' }, { laboratory })).toBeUndefined()
  })

  it('only returns examinations that the current hospital offers, with the catalog label', () => {
    expect(normalizeInvestigationRecommendation(imagingSuggestion, { imaging: { items: [{ available: true, service: imaging }] } }))
      .toMatchObject({ label: '合成胸部 CT 平扫', serviceId: 'synthetic-ct', indication: '持续咳嗽两周。' })
    expect(normalizeInvestigationRecommendation(imagingSuggestion, { imaging: { items: [{ available: false, service: imaging }] } }))
      .toBeUndefined()
    expect(normalizeInvestigationRecommendation({ ...imagingSuggestion, serviceId: 'unknown' }, { imaging: { items: [{ available: true, service: imaging }] } }))
      .toBeUndefined()
    expect(normalizeInvestigationRecommendation(imagingSuggestion, { laboratory })).toBeUndefined()
  })

  it('requires an available pathology service and an authorized source procedure for that same service', () => {
    const catalog = { items: [{ available: true, service: pathology, sourceProcedures: [{
      code: 'synthetic-code', display: '合成乳腺手术', performedAt: '2023-01-05T08:00:00+08:00',
      sourceReference: 'urn:uuid:synthetic-procedure',
    }] }] }
    expect(normalizeInvestigationRecommendation(pathologySuggestion, { pathology: catalog }))
      .toMatchObject({ label: '合成乳腺切片病理会诊', sourceProcedureReference: 'urn:uuid:synthetic-procedure' })
    expect(normalizeInvestigationRecommendation({ ...pathologySuggestion, sourceProcedureReference: 'urn:uuid:other-procedure' }, { pathology: catalog }))
      .toBeUndefined()
    expect(normalizeInvestigationRecommendation(pathologySuggestion, { pathology: { items: [{ ...catalog.items[0]!, available: false }] } }))
      .toBeUndefined()
  })
})
