import type { ClinicalHistoryRequirements, ClinicalVisitKind } from '@clinmesh/contracts/his'

export const clinicalHistoryPolicyVersion = 'outpatient-history-v2'
const specialtyCodes = new Set(['GYN', 'OB', 'OBGYN', 'REPRO', 'BREAST'])

export interface ClinicalHistoryContext {
  gender?: string | undefined
  birthDate?: string | undefined
  visitDate?: string | undefined
  departmentCode?: string | undefined
  visitKind: ClinicalVisitKind
}

function ageAtVisit(birthDate: string | undefined, visitDate: string | undefined): number | undefined {
  const validDate = (value: string | undefined): value is string => value !== undefined
    && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value
  if (!validDate(birthDate) || !validDate(visitDate) || birthDate > visitDate) return undefined
  return Number(visitDate.slice(0, 4)) - Number(birthDate.slice(0, 4)) - (visitDate.slice(5) < birthDate.slice(5) ? 1 : 0)
}

export function resolveClinicalHistoryRequirements(context: ClinicalHistoryContext): ClinicalHistoryRequirements {
  const result = (reason: ClinicalHistoryRequirements['reason'], showByDefault = true): ClinicalHistoryRequirements => ({
    policyVersion: clinicalHistoryPolicyVersion,
    requiredFields: reason === 'specialty-initial' ? ['menstrualHistory', 'obstetricHistory'] : [],
    reason, showByDefault, visitKind: context.visitKind,
  })
  if (context.gender === 'male') return result('non-female', false)
  const age = ageAtVisit(context.birthDate, context.visitDate)
  if (context.gender !== 'female' || age === undefined) return result('context-incomplete')
  if (age < 10) return result('under-ten', false)
  if (age < 12) return result('under-twelve')
  if (!context.departmentCode) return result('context-incomplete')
  if (!specialtyCodes.has(context.departmentCode)) return result('general-outpatient')
  if (context.visitKind === 'initial') return result('specialty-initial')
  if (context.visitKind === 'follow-up') return result('specialty-follow-up')
  return result('context-incomplete')
}
