import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { PreparationDraft } from './doctor-preparation-state.tsx'

export const doctorPreparationItemIdentity = (item: DoctorRecommendationSuggestion | PreparationDraft) => JSON.stringify([item.kind,
  item.kind === 'imaging' || item.kind === 'pathology' ? item.serviceId : item.catalogItemId])
