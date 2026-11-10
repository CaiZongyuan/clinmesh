import { commandResponseSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { startSyntheticCaseRequestSchema, startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ApiClientError } from './api-client.ts'
import { createDraftDiscard } from './draft-discard.ts'

const ownerSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict()
const targetSchema = z.object({ profileId: z.string().min(1), caseId: z.string().min(1), name: z.string().min(1) }).strict()
const nextSchema = targetSchema.extend({ profileRevision: z.number().int().positive(), caseRevision: z.number().int().positive(), activeBriefRevision: z.number().int().positive() }).strict()
export const patientLibraryContinuationSchema = z.object({
  current: targetSchema, next: nextSchema.nullable(), page: z.number().int().positive(), search: z.string().max(200),
  hasMore: z.boolean(), queueReady: z.boolean(),
}).strict()
export const outpatientStartCommandSchema = z.object({
  operation: z.literal('registration.synthetic-case.start'),
  input: startSyntheticCaseRequestSchema.extend({ caseId: z.string().min(1).max(128) }).strict(),
  continuation: patientLibraryContinuationSchema,
}).strict().refine(command => command.input.caseId === command.continuation.current.caseId)
export type PatientLibraryContinuation = z.infer<typeof patientLibraryContinuationSchema>
type Owner = z.infer<typeof ownerSchema>
type Target = Pick<z.infer<typeof targetSchema>, 'caseId' | 'profileId'>
const draftSchema = z.object({ departmentId: z.string().max(128), locationId: z.string().max(128), visitTypeId: z.string().max(128) }).strict()
const completionSchema = z.object({ continuation: patientLibraryContinuationSchema, result: startSyntheticCaseResultSchema }).strict()
type VisitContent = { draft: z.infer<typeof draftSchema>; completion: z.infer<typeof completionSchema> | null }
type VisitState = VisitContent & { key: string; failure: 'read' | 'save' | null; error: ApiClientError | null }
const bindingSchema = ownerSchema.extend({ profileId: z.string().min(1), caseId: z.string().min(1) }).strict()
const storedSchema = z.object({ version: z.literal(1), binding: bindingSchema, draft: draftSchema, completion: completionSchema.nullable() }).strict().refine(value => value.completion === null
  || (value.completion.continuation.current.profileId === value.binding.profileId && value.completion.continuation.current.caseId === value.binding.caseId && value.completion.result.syntheticCaseId === value.binding.caseId))
const prefix = 'clinmesh.patient-library-visit:v1:'
const changedEvent = 'clinmesh.patient-library-visit.changed'
const discard = createDraftDiscard(prefix, () => window.dispatchEvent(new CustomEvent(changedEvent)))
const emptyDraft = () => ({ departmentId: '', locationId: '', visitTypeId: '' })
export function patientLibraryOwner(session: SessionContext): Owner { return ownerSchema.parse({ accountId: session.user.id, actor: session.actor }) }
export function patientLibraryScope(session: SessionContext) { return JSON.stringify(patientLibraryOwner(session)) }
function storageError() { return new ApiClientError(0, 'INPATIENT_INTENT_STORAGE_UNAVAILABLE', 'Patient library visit storage unavailable') }
export function clearPatientLibraryVisitDrafts() {
  try { discard.clear() } catch { /* 恢复存储后接续退出清理，原写意图由独立 owner 保留。 */ }
}
export function patientLibraryVisitStorage(owner: Owner, target: Target) {
  const binding = bindingSchema.parse({ ...owner, profileId: target.profileId, caseId: target.caseId })
  const scope = JSON.stringify(binding)
  const key = `${prefix}${encodeURIComponent(scope)}`
  const load = (): VisitState => {
    try {
      const raw = discard.read(key)
      const stored = raw === null ? { draft: emptyDraft(), completion: null } : storedSchema.parse(JSON.parse(raw))
      if ('binding' in stored && JSON.stringify(stored.binding) !== scope) throw storageError()
      return { key, draft: stored.draft, completion: stored.completion, failure: null, error: null }
    } catch { return { key, draft: emptyDraft(), completion: null, failure: 'read', error: storageError() } }
  }
  const save = (draft: z.infer<typeof draftSchema>, completion: z.infer<typeof completionSchema> | null) => {
    discard.ensureCleared()
    sessionStorage.setItem(key, JSON.stringify(storedSchema.parse({ version: 1, binding, draft, completion })))
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
  }
  const discardUnread = () => {
    const current = load()
    if (current.failure !== 'read') return current
    try {
      discard.ensureCleared()
      sessionStorage.removeItem(key)
      window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
      return load()
    } catch { return current }
  }
  return { key, load, save, discardUnread }
}
export class PatientLibraryDraftUnreadable extends Error {
  constructor() { super('The original outpatient visit succeeded; its private draft cannot be read'); this.name = 'PatientLibraryDraftUnreadable' }
}
export function completePatientLibraryVisit(command: z.infer<typeof outpatientStartCommandSchema>, result: unknown, owner: Owner, discardUnread = false, keepContinuation = true) {
  const value = commandResponseSchema(startSyntheticCaseResultSchema).parse(result).data
  if (value.syntheticCaseId !== command.input.caseId) throw new ApiClientError(0, 'UNEXPECTED_RESPONSE', 'Original Synthetic Case changed')
  if (!keepContinuation) return
  const storage = patientLibraryVisitStorage(owner, command.continuation.current)
  const current = storage.load()
  if (current.failure === 'read' && !discardUnread) throw new PatientLibraryDraftUnreadable()
  if (current.completion?.result.encounterId === value.encounterId) return
  const { draft } = current
  const submitted = (!draft.departmentId || draft.departmentId === command.input.departmentId)
    && (!draft.locationId || draft.locationId === command.input.locationId)
    && (!draft.visitTypeId || draft.visitTypeId === command.input.visitTypeId)
  // 显式丢弃只替换仍不可读的原记录；重读成功时不清除可用输入。
  try { storage.save(!discardUnread && submitted ? emptyDraft() : draft, { continuation: command.continuation, result: value }) }
  catch { throw storageError() }
}
export function usePatientLibraryVisitState(session: SessionContext, target: Target) {
  const storage = patientLibraryVisitStorage(patientLibraryOwner(session), target)
  const [stored, setStored] = useState(storage.load)
  useEffect(() => {
    const refresh = () => setStored(storage.load())
    const changed = (event: Event) => { if (event instanceof CustomEvent && (event.detail === storage.key || event.detail === undefined || event.detail === null)) refresh() }
    refresh()
    window.addEventListener(changedEvent, changed)
    return () => window.removeEventListener(changedEvent, changed)
  }, [storage.key])
  const state = stored.key === storage.key ? stored : storage.load()
  const save = (content: VisitContent) => {
    try { storage.save(content.draft, content.completion) }
    catch { setStored({ ...content, key: storage.key, failure: 'save', error: storageError() }) }
  }
  return { state, storage,
    retry: () => {
      const latest = storage.load()
      if (state.failure !== 'save') { setStored(latest); return }
      if (latest.failure === null) save(state)
    },
    discardUnread: () => {
      if (state.failure !== 'read') return false
      const latest = storage.discardUnread()
      setStored(latest)
      return latest.failure === null
    },
    saveCompletion: (completion: z.infer<typeof completionSchema>) => {
      if (state.failure !== null) return
      const latest = storage.load()
      if (latest.failure !== null) { setStored(latest); return }
      save({ draft: latest.draft, completion })
    },
    saveDraft: (draft: z.infer<typeof draftSchema>) => {
      if (state.failure === 'read') return
      const latest = storage.load()
      if (latest.failure !== null) { setStored(state.failure === 'save' ? { ...state, draft } : latest); return }
      save({ draft, completion: state.failure === 'save' ? state.completion : latest.completion })
    },
  }
}
