import type { DoctorPreparationSelection, DoctorRecommendationKind, DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import type { DoctorCaseDetail, SessionContext } from '@clinmesh/contracts/his'
import type { MedicationRoute } from '@clinmesh/contracts/medication-safety'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { getSession } from '../api-client.ts'
import { useInvestigationPreferences } from './investigation-draft-storage.ts'

export const preparationKinds = ['diagnosis', 'laboratory', 'imaging', 'pathology', 'prescription'] as const

type JobInput = { caseId: string; kind: DoctorRecommendationKind; enabled: boolean; paused: boolean; scope?: string | undefined; inputRevision?: string | undefined }

const noop = () => undefined
const noopInvalidate = () => Promise.resolve()

const idlePreparationJob = {
  state: undefined as DoctorRecommendationState | undefined,
  previous: undefined as DoctorRecommendationState | undefined,
  pending: false,
  error: null as Error | null,
  paused: false,
  ready: false,
  refresh: noop,
  continueOriginal: noop,
  invalidate: noopInvalidate,
}

export function useDoctorPreparationJob(_input: JobInput) {
  return idlePreparationJob
}

export type DoctorPreparationJob = typeof idlePreparationJob
type InvestigationPreparationDraft = { [Kind in 'laboratory' | 'imaging' | 'pathology']: Omit<Extract<DoctorPreparationSelection, { kind: Kind }>, 'reviewedService'> & { reviewedService?: Extract<DoctorPreparationSelection, { kind: Kind }>['reviewedService'] | undefined } }['laboratory' | 'imaging' | 'pathology']
export type PreparationDraft = InvestigationPreparationDraft | (Omit<Extract<DoctorPreparationSelection, { kind: 'diagnosis' }>, 'role'> & { role: 'primary' | 'secondary' | null }) | (Omit<Extract<DoctorPreparationSelection, { kind: 'prescription' }>, 'doseText' | 'frequencyCode' | 'routeCode' | 'courseDays' | 'quantity'> & { doseText: string | null; frequencyCode: string | null; routeCode: MedicationRoute | null; courseDays: number | null; quantity: number | null })
export type PreparedEdit = { label: string; selection: PreparationDraft; fingerprint: string; reviewedFingerprint?: string | undefined; formOwned?: boolean | undefined }
export type DraftPreferences = { edits: Record<string, PreparedEdit>; removed: Record<string, string>; unselected: string[]; completed: Record<string, string[]>; formRevision?: number | undefined }
type PreparationContext = {
  jobs: Record<DoctorRecommendationKind, DoctorPreparationJob>
  detail: DoctorCaseDetail | undefined
  verifySession: () => Promise<boolean>
  submitting: (kind: DoctorRecommendationKind) => boolean
  confirmedRevision: (kind: DoctorRecommendationKind) => number
  setSubmitting: (key: string, token: string, active: boolean) => void
  confirmed: (key: string) => void
  paused: boolean
  togglePaused: () => void
  preferences: (kind: DoctorRecommendationKind) => DraftPreferences
  reconcilePreferences: (kind: DoctorRecommendationKind, previous: DraftPreferences) => DraftPreferences
  details: { kind: DoctorRecommendationKind | 'quality'; open: boolean }
  openDetails: (kind: DoctorRecommendationKind | 'quality') => void
  closeDetails: () => void
}
const Context = createContext<PreparationContext | undefined>(undefined)
export const useDoctorPreparation = () => useContext(Context)

export function DoctorPreparationProvider({ children, detail, scope, caseId, formRevisions, session }: {
  children: ReactNode; detail: DoctorCaseDetail | undefined; scope: string; inputRevision?: string; enabled?: boolean; caseId?: string
  formRevisions?: Partial<Record<DoctorRecommendationKind, number>> | undefined
  session?: SessionContext | undefined
}) {
  const [pausedCases, setPausedCases] = useState<Record<string, boolean>>({})
  const [submissions, setSubmissions] = useState<Record<string, string[]>>({})
  const [confirmations, setConfirmations] = useState<Record<string, number>>({})
  const [details, setDetails] = useState<{ scope: string; kind: DoctorRecommendationKind | 'quality'; open: boolean }>({ scope, kind: 'diagnosis', open: false })
  const paused = pausedCases[scope] === true
  const resolvedCaseId = detail?.caseId ?? caseId ?? ''
  const preferenceKey = (kind: DoctorRecommendationKind) => JSON.stringify([scope, resolvedCaseId, detail?.encounter.id, kind])
  const preferences = {
    diagnosis: useInvestigationPreferences(preferenceKey('diagnosis')),
    laboratory: useInvestigationPreferences(preferenceKey('laboratory')),
    imaging: useInvestigationPreferences(preferenceKey('imaging')),
    pathology: useInvestigationPreferences(preferenceKey('pathology')),
    prescription: useInvestigationPreferences(preferenceKey('prescription')),
  }
  const currentPreferences = (kind: DoctorRecommendationKind, previous: DraftPreferences) => {
    const formRevision = formRevisions?.[kind] ?? 0
    return (previous.formRevision ?? 0) === formRevision ? previous : { ...previous, formRevision,
      edits: Object.fromEntries(Object.entries(previous.edits).filter(([, edit]) => !edit.formOwned)) }
  }
  return <Context.Provider value={{
    verifySession: async () => {
      if (session === undefined) return true
      const current = await getSession()
      const binding = (value: SessionContext) => JSON.stringify([value.user.id, value.actor.actorId, value.actor.epoch,
        value.actor.workspaceId, value.actor.scenarioRunId, value.actor.practitionerRoleId, value.actor.roleCode,
        value.actor.practitionerId, value.actor.organizationId, value.actor.locationId])
      return binding(current) === binding(session)
    },
    jobs: {
      diagnosis: idlePreparationJob,
      laboratory: idlePreparationJob,
      imaging: idlePreparationJob,
      pathology: idlePreparationJob,
      prescription: idlePreparationJob,
    }, detail, paused,
    submitting: kind => (submissions[JSON.stringify([scope, kind])]?.length ?? 0) > 0,
    confirmedRevision: kind => confirmations[JSON.stringify([scope, kind])] ?? 0,
    setSubmitting: (key, token, active) => setSubmissions(previous => ({ ...previous,
      [key]: active ? [...new Set([...(previous[key] ?? []), token])] : (previous[key] ?? []).filter(value => value !== token) })),
    confirmed: key => setConfirmations(previous => ({ ...previous, [key]: (previous[key] ?? 0) + 1 })),
    togglePaused: () => setPausedCases(previous => ({ ...previous, [scope]: !previous[scope] })),
    preferences: kind => currentPreferences(kind, preferences[kind].value),
    reconcilePreferences: currentPreferences,
    details: details.scope === scope ? details : { kind: 'diagnosis', open: false },
    openDetails: kind => setDetails({ scope, kind, open: true }),
    closeDetails: () => setDetails(previous => ({ ...previous, open: false })),
  }}>{children}</Context.Provider>
}
