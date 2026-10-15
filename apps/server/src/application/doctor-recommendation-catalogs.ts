import type { ClinicalCatalog } from '@clinmesh/contracts/his'
import type { ReferenceConcept, ReferenceConceptSnapshot } from '@clinmesh/contracts/reference-data'
import type { DoctorInvestigationRecommendationCatalogs } from './doctor-investigation-recommendations.ts'
import type { WorkflowService } from './workflow-service.ts'

export type DoctorRecommendationCatalogs = DoctorInvestigationRecommendationCatalogs & {
  diagnoses?: { local: ClinicalCatalog['diagnoses']; reference: ReferenceConcept[] }
  medications?: ReturnType<WorkflowService['doctorRecommendationMedications']>
}

function projectCoding({ id, system, version, code, display }: ReferenceConceptSnapshot) {
  return { id, system, version, code, display }
}

export function projectRecommendationCatalogs(catalogs: DoctorRecommendationCatalogs) {
  const laboratory = catalogs.laboratory
  if (laboratory === undefined) return catalogs
  return { ...catalogs, laboratory: { ...laboratory, items: laboratory.items.map(item => ({
    id: item.id, localCode: item.localCode, nameZh: item.nameZh, nameEn: item.nameEn, version: item.version,
    serviceKind: item.serviceKind, doctorOrderable: item.doctorOrderable,
    allowedIndicationCodes: item.allowedIndicationCodes, componentServiceIds: item.componentServiceIds,
    referenceConcept: projectCoding(item.referenceConcept), specimen: item.specimen, standardStatus: item.standardStatus,
    ...(item.sourceDataset === undefined ? {} : { sourceDataset: { datasetId: item.sourceDataset.datasetId } }),
    ...(item.sourceDataset?.datasetId === 'laboratory-cn' ? { minimumAgeYears: 18 } : {}),
    reportDefinition: { results: item.reportDefinition.results.map(result => ({
      referenceConcept: projectCoding(result.referenceConcept), alternateCodings: result.alternateCodings,
      unit: result.unit, valueType: result.valueType, referenceRange: result.referenceRange, allowedValues: result.allowedValues,
      adultReferenceRules: result.adultReferenceRules?.map(({ high, low, normalValue, notes, referenceKind, sex }) => (
        { high, low, normalValue, notes, referenceKind, sex }
      )),
    })) },
  })) } }
}
