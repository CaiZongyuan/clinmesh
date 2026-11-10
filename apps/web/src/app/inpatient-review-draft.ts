import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ApiClientError } from './api-client.ts'
import { completeInpatientReviewQueue, InpatientReviewStorageUnreadable, readReviewCompletion } from './inpatient-review-queue.ts'
import { createDraftDiscard } from './draft-discard.ts'

type Binding = { accountId: string; actor: SessionContext['actor'] }
type ReviewCommand = { operation: string; input: object }
const prefix = 'clinmesh.inpatient-review-draft:v1:'
const changed = 'clinmesh.inpatient-review-draft.changed'
const mainSchema = z.object({ main: z.string().min(1).nullable(), revision: z.number().int().nonnegative(), hash: z.string().min(1) }).strict()
const valueSchema = z.object({
  version: z.literal(1), binding: z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict(),
  patientId: z.string().min(1), admissionId: z.string().min(1), kind: z.enum(['record', 'payer']),
  revision: z.number().int().nonnegative(), reason: z.string().max(2000), main: mainSchema.nullable(),
  submitted: z.object({ signature: z.string(), revision: z.number().int().nonnegative() }).strict().optional(),
}).strict()
type Draft = z.infer<typeof valueSchema>
type Content = Pick<Draft, 'reason' | 'main'>
function normalizedBinding(binding: Binding) { return valueSchema.shape.binding.parse(binding) }
function storageError() { return new ApiClientError(0, 'INPATIENT_REVIEW_DRAFT_STORAGE_UNAVAILABLE', 'Inpatient review draft storage unavailable') }
function signature(command: ReviewCommand) { return JSON.stringify([command.operation, Object.entries(command.input).sort(([a], [b]) => a.localeCompare(b))]) }
function kindOf(command: ReviewCommand) { return command.operation === 'inpatient.drg.payer.review' ? 'payer' : command.operation === 'inpatient.record.submit' || command.operation === 'inpatient.record.review' ? 'record' : undefined }
function emit(key: string) { window.dispatchEvent(new CustomEvent(changed, { detail: key })) }
const discard = createDraftDiscard(prefix, () => window.dispatchEvent(new Event(changed)))
function read(key: string, empty: Draft): Draft {
  const raw = discard.read(key)
  if (raw === null) return empty
  const value = valueSchema.parse(JSON.parse(raw))
  if (JSON.stringify([value.binding, value.patientId, value.admissionId, value.kind]) !== JSON.stringify([empty.binding, empty.patientId, empty.admissionId, empty.kind])) throw storageError()
  return value
}

/** 成功回执只消费原身份、原住院、原提交版本，保留发送后的编辑。由 writer 在清意图前执行。 */
export function completeInpatientReviewDraft(command: ReviewCommand, binding: Binding, discardUnread = false): void {
  const kind = kindOf(command)
  try {
    if (kind && 'admissionId' in command.input && typeof command.input.admissionId === 'string') {
      discard.ensureCleared()
      const ownerBinding = normalizedBinding(binding), admissionId = command.input.admissionId
      const ownerPrefix = prefix + encodeURIComponent(JSON.stringify([ownerBinding]).slice(0, -1) + ',')
      for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(ownerPrefix))) {
        let owner: unknown
        try { owner = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
        if (!Array.isArray(owner) || typeof owner[1] !== 'string' || owner[2] !== admissionId || owner[3] !== kind) continue
        const value = readReviewCompletion(key, () => read(key, { version: 1, binding: ownerBinding, patientId: owner[1], admissionId, kind, revision: 0, reason: '', main: null }), discardUnread)
        if (value?.submitted?.signature === signature(command)) {
          if (value.revision === value.submitted.revision) sessionStorage.removeItem(key)
          else { delete value.submitted; sessionStorage.setItem(key, JSON.stringify(value)) }
        }
        emit(key)
      }
    }
    completeInpatientReviewQueue(command, binding, discardUnread)
  } catch (error) { if (error instanceof InpatientReviewStorageUnreadable) throw error; throw storageError() }
}

/** 退出清私稿；已发原始 body/key 由独立住院 writer intent 保留及恢复。 */
export function clearInpatientReviewDrafts(): void {
  discard.clear()
}

export function useInpatientReviewDraft(session: SessionContext, patientId: string, admissionId: string, kind: Draft['kind']) {
  const binding = normalizedBinding({ accountId: session.user.id, actor: session.actor })
  const key = prefix + encodeURIComponent(JSON.stringify([binding, patientId, admissionId, kind]))
  const empty: Draft = { version: 1, binding, patientId, admissionId, kind, revision: 0, reason: '', main: null }
  type State = { key: string; value: Draft; failure: 'read' | 'write' | null }
  const load = (): State => { try { return { key, value: read(key, empty), failure: null } } catch { return { key, value: empty, failure: 'read' } } }
  const [state, setState] = useState<State>(load)
  const current = state.key === key ? state : load()
  useEffect(() => {
    const refresh = (event?: Event) => { if (!(event instanceof CustomEvent) || event.detail === key) setState(load()) }
    refresh()
    window.addEventListener(changed, refresh)
    return () => window.removeEventListener(changed, refresh)
    // key includes the complete frozen identity and admission binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const update = (content: Content) => {
    if (current.failure === 'read') return
    try { read(key, empty) } catch { setState(load()); return }
    const value = { ...current.value, ...content, revision: current.value.revision + 1 }
    try { sessionStorage.setItem(key, JSON.stringify(value)); emit(key) }
    catch { setState({ key, value, failure: 'write' }) }
  }
  return {
    reason: current.value.reason, main: current.value.main, error: current.failure !== null, failure: current.failure,
    setReason: (reason: string) => update({ reason, main: current.value.main }),
    setMain: (main: Content['main'] | ((previous: Content['main']) => Content['main'])) => update({ reason: current.value.reason, main: typeof main === 'function' ? main(current.value.main) : main }),
    retry: () => {
      if (current.failure !== 'write') { setState(load()); return }
      try { read(key, empty); sessionStorage.setItem(key, JSON.stringify(current.value)); emit(key) } catch { setState({ ...current, failure: 'write' }) }
    },
    discardUnread: () => {
      if (current.failure !== 'read') return false
      const reread = load()
      if (reread.failure === null) { setState(reread); return true }
      try { discard.ensureCleared(); sessionStorage.removeItem(key); emit(key); return true } catch { return false }
    },
    prepare: (command: ReviewCommand) => {
      if (current.failure !== null) return false
      let value: Draft
      try { value = read(key, empty) } catch { setState(load()); return false }
      try {
        value.submitted = { signature: signature(command), revision: value.revision }
        sessionStorage.setItem(key, JSON.stringify(value)); emit(key)
        return true
      } catch { setState({ ...current, failure: 'write' }); return false }
    },
  }
}
