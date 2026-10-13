import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog } from '@clinmesh/contracts/his'
import type { ReferenceConcept, ReferenceConceptSnapshot } from '@clinmesh/contracts/reference-data'

type DiagnosisRecommendation = Extract<DoctorRecommendationSuggestion, { kind: 'diagnosis' }>

export function normalizeDoctorDiagnosisRecommendation(
  suggestion: DiagnosisRecommendation,
  catalog: { local: ClinicalCatalog['diagnoses']; reference: ReferenceConcept[] },
): DiagnosisRecommendation | undefined {
  const reference = catalog.reference.find(item => item.id === suggestion.catalogItemId)
  let referenceConcept: ReferenceConceptSnapshot
  if (reference !== undefined) {
    if (reference.status !== 'active' || reference.domain !== 'diagnosis') return undefined
    referenceConcept = {
      id: reference.id,
      code: reference.code,
      display: reference.display,
      system: reference.system,
      version: reference.version,
      sourceLocator: reference.sourceLocator,
    }
  } else {
    const local = catalog.local.find(item => item.id === suggestion.catalogItemId)
    if (local === undefined) return undefined
    referenceConcept = local.referenceConcept ?? {
      id: local.id,
      code: local.code,
      display: local.nameZh,
      system: local.system,
      version: String(local.version),
      sourceLocator: 'operational:diagnosis_catalog',
    }
  }
  const claimed = suggestion.referenceConcept
  if (claimed !== undefined && (['id', 'code', 'system', 'version'] as const)
    .some(field => claimed[field] !== referenceConcept[field])) return undefined
  return { ...suggestion, label: referenceConcept.display, referenceConcept }
}
