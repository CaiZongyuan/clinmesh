import type { DoctorPreparationSelection, DoctorRecommendationKind, DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { generateDoctorRecommendations, getDoctorRecommendations } from '../api-client.ts'

export const preparationKinds = ['diagnosis', 'laboratory', 'imaging', 'pathology', 'prescription'] as const

type JobInput = { caseId: string; kind: DoctorRecommendationKind; enabled: boolean; paused: boolean; scope?: string | undefined; inputRevision?: string | undefined }

function newer(current: DoctorRecommendationState | undefined, incoming: DoctorRecommendationState) {
  if (current !== undefined && current.generation > incoming.generation) return current
  if (current?.generation === incoming.generation && current.inputFingerprint === incoming.inputFingerprint
    && ['ready', 'missing-evidence', 'failed'].includes(current.status) && incoming.status === 'pending' && !incoming.stale) return current
  return incoming
}

export function useDoctorPreparationJob({ caseId, kind, enabled, paused, scope, inputRevision }: JobInput) {
  const client = useQueryClient()
  const prefix = ['doctor-recommendations', scope, caseId, kind] as const
  const requestKey = [...prefix, inputRevision, paused] as const
  const identity = JSON.stringify([requestKey, enabled])
  const current = useRef({ identity, revision: 0 })
  if (current.current.identity !== identity) current.current = { identity, revision: current.current.revision + 1 }
  const viewRevision = current.current.revision
  const queryKey = [...requestKey, viewRevision] as const
  const lastAutomatic = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const query = useQuery({
    queryKey, enabled, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const incoming = await getDoctorRecommendations(caseId, kind, signal)
      const previous = client.getQueryData<DoctorRecommendationState>(queryKey)
      if (incoming.hidePreviousResults) {
        for (const [key, cached] of client.getQueriesData<DoctorRecommendationState>({ queryKey: prefix })) {
          if (cached !== undefined) client.setQueryData<DoctorRecommendationState>(key, { ...cached, items: [], considerations: [], guidelines: [], caseEvidence: [], stale: true })
        }
      }
      if (!incoming.hidePreviousResults && previous?.status === 'ready' && !previous.stale) client.setQueryData([...prefix, 'completed', previous.generation, previous.inputFingerprint], previous)
      return newer(previous, incoming)
    },
    refetchInterval: query => query.state.data?.status === 'pending' ? 1_000 : false,
  })
  const generation = useMutation({
    mutationFn: ({ state, refresh }: { state: DoctorRecommendationState; refresh: boolean; identity: string; viewRevision: number }) => generateDoctorRecommendations(state, refresh),
    onSuccess: (state, request) => {
      if (mounted.current && current.current.identity === request.identity && current.current.revision === request.viewRevision) {
        const previous = client.getQueryData<DoctorRecommendationState>(queryKey)
        if (previous?.status === 'ready' && !previous.stale) client.setQueryData([...prefix, 'completed', previous.generation, previous.inputFingerprint], previous)
        client.setQueryData<DoctorRecommendationState>(queryKey, previous => newer(previous, state))
      }
    },
    onSettled: (_result, _error, request) => {
      if (mounted.current && current.current.identity === request.identity && current.current.revision === request.viewRevision) void client.invalidateQueries({ queryKey, exact: true })
    },
  })
  const state = query.data?.caseId === caseId && query.data.kind === kind ? query.data : undefined
  const generating = generation.isPending && generation.variables?.identity === identity && generation.variables.viewRevision === viewRevision
  const mutate = generation.mutate
  useEffect(() => {
    if (!enabled || paused || state === undefined || generating || query.isError || !(state.status === 'idle' || state.stale)) return
    const request = `${identity}:${viewRevision}:${state.inputFingerprint}`
    if (lastAutomatic.current === request) return
    lastAutomatic.current = request
    mutate({ state, refresh: false, identity, viewRevision })
  }, [enabled, paused, state, generating, query.isError, identity, viewRevision, mutate])
  const previous = client.getQueriesData<DoctorRecommendationState>({ queryKey: prefix })
    .flatMap(([key, candidate]) => candidate?.caseId === caseId && candidate.kind === kind && candidate.status === 'ready' && !candidate.stale
      ? [{ state: candidate, updatedAt: client.getQueryState(key)?.dataUpdatedAt ?? 0 }] : [])
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0]?.state
  const error = query.error ?? (generation.variables?.identity === identity && generation.variables.viewRevision === viewRevision ? generation.error : null)
  const pending = enabled && (query.isPending || generating || state?.status === 'pending')
  return { state, previous, pending, error, paused,
    ready: enabled && !paused && !pending && !query.isFetching && error === null && state?.status === 'ready' && !state.stale,
    refresh: () => { if (!paused && state !== undefined) generation.mutate({ state, refresh: true, identity, viewRevision }) },
    invalidate: () => client.invalidateQueries({ queryKey: prefix }),
  }
}

export type DoctorPreparationJob = ReturnType<typeof useDoctorPreparationJob>
export type PreparedEdit = { label: string; selection: DoctorPreparationSelection; fingerprint: string; reviewedFingerprint?: string }
export type DraftPreferences = { edits: Record<string, PreparedEdit>; removed: string[]; unselected: string[]; completed: Record<string, string> }
const emptyPreferences: DraftPreferences = { edits: {}, removed: [], unselected: [], completed: {} }
type PreparationContext = {
  jobs: Record<DoctorRecommendationKind, DoctorPreparationJob>
  detail: DoctorCaseDetail | undefined
  submitting: (kind: DoctorRecommendationKind) => boolean
  confirmedRevision: (kind: DoctorRecommendationKind) => number
  setSubmitting: (key: string, active: boolean) => void
  confirmed: (key: string) => void
  paused: boolean
  togglePaused: () => void
  preferences: (kind: DoctorRecommendationKind) => DraftPreferences
  updatePreferences: (kind: DoctorRecommendationKind, update: (previous: DraftPreferences) => DraftPreferences) => void
  details: { kind: DoctorRecommendationKind | 'quality'; open: boolean }
  openDetails: (kind: DoctorRecommendationKind | 'quality') => void
  closeDetails: () => void
}
const Context = createContext<PreparationContext | undefined>(undefined)
export const useDoctorPreparation = () => useContext(Context)

export function DoctorPreparationProvider({ children, detail, scope, inputRevision, enabled, caseId }: {
  children: ReactNode; detail: DoctorCaseDetail | undefined; scope: string; inputRevision: string; enabled: boolean; caseId?: string
}) {
  const [pausedCases, setPausedCases] = useState<Record<string, boolean>>({})
  const [submissions, setSubmissions] = useState<Record<string, boolean>>({})
  const [confirmations, setConfirmations] = useState<Record<string, number>>({})
  const [drafts, setDrafts] = useState<Record<string, DraftPreferences>>({})
  const [details, setDetails] = useState<{ scope: string; kind: DoctorRecommendationKind | 'quality'; open: boolean }>({ scope, kind: 'diagnosis', open: false })
  const paused = pausedCases[scope] === true
  const input = { caseId: detail?.caseId ?? caseId ?? '', enabled, paused, scope, inputRevision }
  const diagnosis = useDoctorPreparationJob({ ...input, kind: 'diagnosis' })
  const laboratory = useDoctorPreparationJob({ ...input, kind: 'laboratory' })
  const imaging = useDoctorPreparationJob({ ...input, kind: 'imaging' })
  const pathology = useDoctorPreparationJob({ ...input, kind: 'pathology' })
  const prescription = useDoctorPreparationJob({ ...input, kind: 'prescription' })
  return <Context.Provider value={{
    jobs: { diagnosis, laboratory, imaging, pathology, prescription }, detail, paused,
    submitting: kind => submissions[JSON.stringify([scope, kind])] === true,
    confirmedRevision: kind => confirmations[JSON.stringify([scope, kind])] ?? 0,
    setSubmitting: (key, active) => setSubmissions(previous => ({ ...previous, [key]: active })),
    confirmed: key => setConfirmations(previous => ({ ...previous, [key]: (previous[key] ?? 0) + 1 })),
    togglePaused: () => setPausedCases(previous => ({ ...previous, [scope]: !previous[scope] })),
    preferences: kind => drafts[JSON.stringify([scope, kind])] ?? emptyPreferences,
    updatePreferences: (kind, update) => setDrafts(previous => {
      const key = JSON.stringify([scope, kind])
      return { ...previous, [key]: update(previous[key] ?? emptyPreferences) }
    }),
    details: details.scope === scope ? details : { kind: 'diagnosis', open: false },
    openDetails: kind => setDetails({ scope, kind, open: true }),
    closeDetails: () => setDetails(previous => ({ ...previous, open: false })),
  }}>{children}</Context.Provider>
}
