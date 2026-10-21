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

// 请求目录保留项目身份、编码、标本、组合、允许适应证与适用条件；报告定义与参考范围只在归一化、
// 独立核验、保存与失效判断中使用完整定义（选中条目经 selectedCatalogItems 提供）。
export function projectRecommendationCatalogs({ diagnoses, laboratory, ...catalogs }: DoctorRecommendationCatalogs) {
  return { ...catalogs, ...(diagnoses === undefined ? {} : { diagnoses: {
    ...diagnoses, reference: diagnoses.reference.map(({ sourceLocator: _sourceLocator, domain: _domain, status: _status, ...clinical }) => clinical),
  } }), ...(laboratory === undefined ? {} : { laboratory: { ...laboratory, items: laboratory.items.map(item => ({
    id: item.id, localCode: item.localCode, nameZh: item.nameZh, nameEn: item.nameEn, version: item.version,
    serviceKind: item.serviceKind, doctorOrderable: item.doctorOrderable,
    allowedIndicationCodes: item.allowedIndicationCodes, componentServiceIds: item.componentServiceIds,
    referenceConcept: projectCoding(item.referenceConcept), specimen: item.specimen, standardStatus: item.standardStatus,
    ...(item.sourceDataset === undefined ? {} : { sourceDataset: { datasetId: item.sourceDataset.datasetId } }),
    ...(item.sourceDataset?.datasetId === 'laboratory-cn' ? { minimumAgeYears: 18 } : {}),
  })) } }) }
}
