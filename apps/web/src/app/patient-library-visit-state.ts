import { commandResponseSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { startSyntheticCaseRequestSchema, startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ApiClientError } from './api-client.ts'

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
type VisitState = { key: string; draft: z.infer<typeof draftSchema>; completion: z.infer<typeof completionSchema> | null; error: ApiClientError | null }
const bindingSchema = ownerSchema.extend({ profileId: z.string().min(1), caseId: z.string().min(1) }).strict()
const storedSchema = z.object({ version: z.literal(1), binding: bindingSchema, draft: draftSchema, completion: completionSchema.nullable() }).strict().refine(value => value.completion === null
  || (value.completion.continuation.current.profileId === value.binding.profileId && value.completion.continuation.current.caseId === value.binding.caseId && value.completion.result.syntheticCaseId === value.binding.caseId))
const prefix = 'clinmesh.patient-library-visit:v1:'
const changedEvent = 'clinmesh.patient-library-visit.changed'
let discardPending = false
const emptyDraft = () => ({ departmentId: '', locationId: '', visitTypeId: '' })
export function patientLibraryOwner(session: SessionContext): Owner { return ownerSchema.parse({ accountId: session.user.id, actor: session.actor }) }
export function patientLibraryScope(session: SessionContext) { return JSON.stringify(patientLibraryOwner(session)) }
function storageError() { return new ApiClientError(0, 'INPATIENT_INTENT_STORAGE_UNAVAILABLE', 'Patient library visit storage unavailable') }
function discardStored() {
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index)
    if (key?.startsWith(prefix)) sessionStorage.removeItem(key)
  }
  discardPending = false
}
export function clearPatientLibraryVisitDrafts() {
  discardPending = true
  try { discardStored() } catch { /* Restore storage before exposing old unsubmitted drafts. */ }
}
export function patientLibraryVisitStorage(owner: Owner, target: Target) {
  const binding = bindingSchema.parse({ ...owner, profileId: target.profileId, caseId: target.caseId })
  const scope = JSON.stringify(binding)
  const key = `${prefix}${encodeURIComponent(scope)}`
  const load = (): VisitState => {
    try {
      if (discardPending) discardStored()
      const raw = sessionStorage.getItem(key)
      const stored = raw === null ? { draft: emptyDraft(), completion: null } : storedSchema.parse(JSON.parse(raw))
      if ('binding' in stored && JSON.stringify(stored.binding) !== scope) throw storageError()
      return { key, draft: stored.draft, completion: stored.completion, error: null }
    } catch { return { key, draft: emptyDraft(), completion: null, error: storageError() } }
  }
  const save = (draft: z.infer<typeof draftSchema>, completion: z.infer<typeof completionSchema> | null) => {
    if (discardPending) discardStored()
    sessionStorage.setItem(key, JSON.stringify(storedSchema.parse({ version: 1, binding, draft, completion })))
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
  }
  return { key, load, save }
}
export function completePatientLibraryVisit(command: z.infer<typeof outpatientStartCommandSchema>, result: unknown, owner: Owner) {
  const value = commandResponseSchema(startSyntheticCaseResultSchema).parse(result).data
  if (value.syntheticCaseId !== command.input.caseId) throw new ApiClientError(0, 'UNEXPECTED_RESPONSE', 'Original Synthetic Case changed')
  try { patientLibraryVisitStorage(owner, command.continuation.current).save(emptyDraft(), { continuation: command.continuation, result: value }) }
  catch { throw storageError() }
}
export function usePatientLibraryVisitState(session: SessionContext, target: Target) {
  const storage = patientLibraryVisitStorage(patientLibraryOwner(session), target)
  const [stored, setStored] = useState(storage.load)
  useEffect(() => {
    const refresh = () => setStored(storage.load())
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === storage.key) refresh() }
    refresh()
    window.addEventListener(changedEvent, changed)
    return () => window.removeEventListener(changedEvent, changed)
  }, [storage.key])
  return { state: stored.key === storage.key ? stored : storage.load(), storage,
    saveCompletion: (completion: z.infer<typeof completionSchema>) => {
      try { storage.save(storage.load().draft, completion) } catch { setStored(current => ({ ...current, error: storageError() })) }
    },
    saveDraft: (draft: z.infer<typeof draftSchema>) => {
      try { storage.save(draft, storage.load().completion) } catch { setStored(current => ({ ...current, draft, error: storageError() })) }
    } }
}
