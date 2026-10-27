import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { patientPersonaContentSchema } from '@clinmesh/contracts/scenario'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { ApiClientError, createPatientPersonaRevision, getSession, newIdempotencyKey, selectPatientPersonaRevision } from './api-client.ts'

const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), content: patientPersonaContentSchema, forceDiagnosisLeakOverride: z.boolean() }).strict(),
  z.object({ kind: z.literal('select'), briefRevision: z.number().int().positive(), expectedCaseRevision: z.number().int().positive() }).strict(),
])
const bindingSchema = z.object({ userId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(), caseId: z.string().min(1) }).strict()
const intentSchema = z.object({ binding: bindingSchema, idempotencyKey: z.uuid(), command: commandSchema }).strict()
type PersonaCommand = z.infer<typeof commandSchema>
type PersonaIntent = z.infer<typeof intentSchema>
const changedEvent = 'clinmesh.persona-intent.changed'

function binding(session: SessionContext, caseId: string) {
  return bindingSchema.parse({ userId: session.user.id, actor: session.actor, caseId })
}
function storageError() { return new ApiClientError(0, 'PERSONA_INTENT_STORAGE_UNAVAILABLE', 'Patient Persona recovery storage is unavailable') }
function load(key: string, scope: string) {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return { key, intent: null, error: null }
    const intent = intentSchema.parse(JSON.parse(raw))
    if (JSON.stringify(intent.binding) !== scope) throw storageError()
    return { key, intent, error: null }
  } catch { return { key, intent: null, error: storageError() } }
}

export function hasPendingPersonaCreation(session: SessionContext, caseId: string): boolean {
  const scope = JSON.stringify(binding(session, caseId))
  const state = load(`clinmesh.persona-intent:v1:${encodeURIComponent(scope)}:create`, scope)
  return state.intent !== null || state.error !== null
}

/** Persona 编辑命令未加入 Agent Catalog；重发冻结输入，由原 Command 返回已保存回执。 */
export function usePatientPersonaWriteIntent(session: SessionContext, caseId: string, kind: PersonaCommand['kind'], onSuccess: () => Promise<void>) {
  const scope = JSON.stringify(binding(session, caseId))
  const key = `clinmesh.persona-intent:v1:${encodeURIComponent(scope)}:${kind}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const mounted = useRef(true)
  const busy = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [stored, setStored] = useState(() => load(key, scope))
  useEffect(() => {
    const refresh = () => setStored(load(key, scope))
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === key) refresh() }
    refresh()
    window.addEventListener(changedEvent, changed)
    return () => window.removeEventListener(changedEvent, changed)
  }, [key, scope])
  const pending = stored.key === key ? stored.intent : null
  const storageFailure = stored.key === key ? stored.error : null
  const mutation = useMutation({ mutationFn: async (command?: PersonaCommand) => {
    if (busy.current) throw new ApiClientError(409, 'PERSONA_INTENT_PENDING', 'Resolve the original Patient Persona operation first')
    busy.current = true
    try {
      const current = load(key, scope)
      if (current.error) throw current.error
      if (current.intent !== null && command !== undefined) throw new ApiClientError(409, 'PERSONA_INTENT_PENDING', 'Resolve the original Patient Persona operation first')
      const intent: PersonaIntent = current.intent ?? intentSchema.parse({ binding: binding(session, caseId), idempotencyKey: newIdempotencyKey(), command })
      if (intent.command.kind !== kind) throw storageError()
      const assertCurrent = () => {
        if (currentScope.current !== scope || !mounted.current) throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'Patient Persona context changed')
      }
      assertCurrent()
      if (JSON.stringify(binding(await getSession(), caseId)) !== scope) throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'Patient Persona context changed')
      assertCurrent()
      const latest = load(key, scope)
      if (latest.error) throw latest.error
      if (latest.intent !== null && latest.intent.idempotencyKey !== intent.idempotencyKey) throw new ApiClientError(409, 'PERSONA_INTENT_PENDING', 'Resolve the original Patient Persona operation first')
      try { sessionStorage.setItem(key, JSON.stringify(intent)) } catch { throw storageError() }
      window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
      const clear = () => {
        const latest = load(key, scope)
        if (latest.error) throw latest.error
        if (latest.intent !== null && latest.intent.idempotencyKey !== intent.idempotencyKey) return
        try { sessionStorage.removeItem(key) } catch { throw storageError() }
        window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
      }
      try {
        const saved = intent.command.kind === 'create'
          ? await createPatientPersonaRevision({ caseId, content: intent.command.content,
            forceDiagnosisLeakOverride: intent.command.forceDiagnosisLeakOverride }, intent.idempotencyKey)
          : await selectPatientPersonaRevision({ caseId, briefRevision: intent.command.briefRevision,
            expectedCaseRevision: intent.command.expectedCaseRevision }, intent.idempotencyKey)
        clear()
        return { saved, scope }
      } catch (error) {
        if (error instanceof ApiClientError && [400, 403, 404, 409, 422].includes(error.status)
          && !['UNEXPECTED_RESPONSE', 'IDEMPOTENCY_KEY_REUSED'].includes(error.code)) clear()
        throw error
      }
    } finally { busy.current = false }
  }, onSuccess: result => { if (mounted.current && currentScope.current === result.scope) return onSuccess() } })
  return { pending, storageFailure, mutation, blocked: pending !== null || storageFailure !== null || mutation.isPending }
}
