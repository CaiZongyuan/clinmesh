import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog } from '@clinmesh/contracts/his'

type PrescriptionSuggestion = Extract<DoctorRecommendationSuggestion, { kind: 'prescription' }>
type MedicationCatalog = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications']

export function normalizePrescriptionRecommendation(
  suggestion: PrescriptionSuggestion,
  catalog: MedicationCatalog,
): PrescriptionSuggestion | undefined {
  const medication = catalog.find(item => item.id === suggestion.catalogItemId)
  if (medication === undefined) return undefined
  const doseText = suggestion.doseText?.trim() || null
  const frequencyCode = suggestion.frequencyCode?.trim() || null
  if ((doseText !== null && !medication.allowedDoseTexts.includes(doseText))
    || (frequencyCode !== null && !medication.allowedFrequencyCodes.includes(frequencyCode))
    || (suggestion.courseDays !== null && !medication.allowedCourseDays.includes(suggestion.courseDays))
    || (suggestion.quantity !== null && !medication.allowedQuantities.includes(suggestion.quantity))) return undefined
  return {
    ...suggestion,
    doseText,
    frequencyCode,
    label: medication.nameZh,
  }
}
