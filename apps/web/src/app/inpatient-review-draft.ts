import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ApiClientError } from './api-client.ts'

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
function storageError() { return new ApiClientError(0, 'INPATIENT_REVIEW_DRAFT_STORAGE_UNAVAILABLE', 'Inpatient review draft storage unavailable') }
function signature(command: ReviewCommand) { return JSON.stringify([command.operation, Object.entries(command.input).sort(([a], [b]) => a.localeCompare(b))]) }
function kindOf(command: ReviewCommand) { return command.operation === 'inpatient.drg.payer.review' ? 'payer' : command.operation === 'inpatient.record.submit' || command.operation === 'inpatient.record.review' ? 'record' : undefined }
function emit(key: string) { window.dispatchEvent(new CustomEvent(changed, { detail: key })) }
function read(key: string, empty: Draft): Draft {
  const raw = sessionStorage.getItem(key)
  if (raw === null) return empty
  const value = valueSchema.parse(JSON.parse(raw))
  if (JSON.stringify([value.binding, value.patientId, value.admissionId, value.kind]) !== JSON.stringify([empty.binding, empty.patientId, empty.admissionId, empty.kind])) throw storageError()
  return value
}

/** 成功回执只消费原身份、原住院、原提交版本，保留发送后的编辑。由 writer 在清意图前执行。 */
export function completeInpatientReviewDraft(command: ReviewCommand, binding: Binding): void {
  const kind = kindOf(command)
  if (!kind) return
  try {
    for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
      const value = valueSchema.parse(JSON.parse(sessionStorage.getItem(key)!))
      if (JSON.stringify(value.binding) !== JSON.stringify(binding) || !('admissionId' in command.input) || value.admissionId !== command.input.admissionId || value.kind !== kind || value.submitted?.signature !== signature(command)) continue
      if (value.revision === value.submitted.revision) sessionStorage.removeItem(key)
      else { delete value.submitted; sessionStorage.setItem(key, JSON.stringify(value)) }
      emit(key)
    }
  } catch { throw storageError() }
}

/** 退出仅移除未发草稿；已发原意图仍由住院 writer 恢复。 */
export function clearInpatientReviewDrafts(): void {
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    const value = valueSchema.parse(JSON.parse(sessionStorage.getItem(key)!))
    if (!value.submitted) { sessionStorage.removeItem(key); emit(key) }
  }
}

export function useInpatientReviewDraft(session: SessionContext, patientId: string, admissionId: string, kind: Draft['kind']) {
  const binding = { accountId: session.user.id, actor: session.actor }
  const key = prefix + encodeURIComponent(JSON.stringify([binding, patientId, admissionId, kind]))
  const empty: Draft = { version: 1, binding, patientId, admissionId, kind, revision: 0, reason: '', main: null }
  const load = () => { try { return { key, value: read(key, empty), error: false } } catch { return { key, value: empty, error: true } } }
  const [state, setState] = useState(load)
  const current = state.key === key ? state : load()
  useEffect(() => {
    const refresh = (event?: Event) => { if (!event || event instanceof CustomEvent && event.detail === key) setState(load()) }
    refresh()
    window.addEventListener(changed, refresh)
    return () => window.removeEventListener(changed, refresh)
    // key includes the complete frozen identity and admission binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const update = (content: Content) => {
    const value = { ...current.value, ...content, revision: current.value.revision + 1 }
    try { sessionStorage.setItem(key, JSON.stringify(value)); setState({ key, value, error: false }); emit(key) }
    catch { setState({ key, value, error: true }) }
  }
  return {
    reason: current.value.reason, main: current.value.main, error: current.error,
    setReason: (reason: string) => update({ reason, main: current.value.main }),
    setMain: (main: Content['main'] | ((previous: Content['main']) => Content['main'])) => update({ reason: current.value.reason, main: typeof main === 'function' ? main(current.value.main) : main }),
    retry: () => { try { sessionStorage.setItem(key, JSON.stringify(current.value)); setState({ ...current, error: false }); emit(key) } catch { setState({ ...current, error: true }) } },
    prepare: (command: ReviewCommand) => {
      try {
        if (current.error) throw storageError()
        const value = read(key, empty)
        value.submitted = { signature: signature(command), revision: value.revision }
        sessionStorage.setItem(key, JSON.stringify(value)); setState({ key, value, error: false }); emit(key)
        return true
      } catch { setState({ ...current, error: true }); return false }
    },
  }
}
