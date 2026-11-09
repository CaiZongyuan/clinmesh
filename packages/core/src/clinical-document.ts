const femaleHistoryFields = ['menstrualHistory', 'obstetricHistory'] as const

export function requiredClinicalHistoryFields(gender: unknown): readonly (typeof femaleHistoryFields)[number][] {
  return gender === 'female' ? femaleHistoryFields : []
}
