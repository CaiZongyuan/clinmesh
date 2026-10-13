import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type {
  CaseLaboratoryCatalogSearch,
  caseImagingServiceCatalogSchema,
  casePathologyServiceCatalogSchema,
} from '@clinmesh/contracts/his'
import type { z } from 'zod'

export interface DoctorInvestigationRecommendationCatalogs {
  laboratory?: CaseLaboratoryCatalogSearch
  imaging?: z.infer<typeof caseImagingServiceCatalogSchema>
  pathology?: z.infer<typeof casePathologyServiceCatalogSchema>
}

export function normalizeInvestigationRecommendation(
  suggestion: DoctorRecommendationSuggestion,
  catalogs: DoctorInvestigationRecommendationCatalogs,
): DoctorRecommendationSuggestion | undefined {
  switch (suggestion.kind) {
    case 'laboratory': {
      const item = catalogs.laboratory?.items.find(item => item.id === suggestion.catalogItemId)
      if (item === undefined || !item.doctorOrderable
        || !item.allowedIndicationCodes.includes(suggestion.indicationCode)) return undefined
      return { ...suggestion, label: item.nameZh }
    }
    case 'imaging': {
      const item = catalogs.imaging?.items.find(item => item.service.id === suggestion.serviceId)
      if (item === undefined || !item.available) return undefined
      return { ...suggestion, label: item.service.name }
    }
    case 'pathology': {
      const item = catalogs.pathology?.items.find(item => item.service.id === suggestion.serviceId)
      if (item === undefined || !item.available
        || !item.sourceProcedures.some(procedure => procedure.sourceReference === suggestion.sourceProcedureReference)) return undefined
      return { ...suggestion, label: item.service.name }
    }
    default:
      return undefined
  }
}
