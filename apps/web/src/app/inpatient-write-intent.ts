import { z } from 'zod'
import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema, getHisOperation } from '@clinmesh/contracts/his-operations'
import { advanceVirtualTimeInputSchema, advanceVirtualTimeResponseSchema, inpatientBedInputSchema,
  inpatientRegistrationInputSchema, inpatientSwapInputSchema, inpatientReferralInputSchema } from '@clinmesh/contracts/inpatient'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiClientError, apiGet, apiMutation, getSession, newIdempotencyKey } from './api-client.ts'

const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inpatient.admission.register'), input: inpatientRegistrationInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.admission.receive'), input: inpatientBedInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.admission.move-bed'), input: inpatientBedInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.admission.swap-bed'), input: inpatientSwapInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.referral.issue'), input: inpatientReferralInputSchema }).strict(),
  z.object({ operation: z.literal('scenario.advance-time'), input: advanceVirtualTimeInputSchema }).strict(),
])
const bindingSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict()
const intentSchema = z.object({ version: z.literal(1), binding: bindingSchema,
  idempotencyKey: z.uuid(), command: commandSchema }).strict().refine(intent =>
  intent.command.operation !== 'inpatient.admission.register' || intent.command.input.expectedEpoch === intent.binding.actor.epoch)
type InpatientWriteCommand = z.infer<typeof commandSchema>
type InpatientWriteIntent = z.infer<typeof intentSchema>
const intentChangedEvent = 'clinmesh.inpatient-intent.changed'

function binding(session: SessionContext) { return bindingSchema.parse({ accountId: session.user.id, actor: session.actor }) }
function storageError() { return new ApiClientError(0, 'INPATIENT_INTENT_STORAGE_UNAVAILABLE', 'Inpatient intent storage unavailable') }

function load(key: string, expectedBinding: z.infer<typeof bindingSchema>) {
  try {
    const value = sessionStorage.getItem(key)
    if (value === null) return { key, intent: null, error: null }
    const intent = intentSchema.parse(JSON.parse(value))
    if (JSON.stringify(intent.binding) !== JSON.stringify(expectedBinding)) throw storageError()
    return { key, intent, error: null }
  } catch { return { key, intent: null, error: storageError() } }
}

/** 仅保存当前住院操作的原始意图；查询结果继续由 TanStack Query 拥有。 */
export function useInpatientWriteIntent(session: SessionContext, onSuccess: (command: InpatientWriteCommand, response: unknown) => void | Promise<void>) {
  const expectedBinding = binding(session)
  const scope = JSON.stringify(expectedBinding)
  const key = `clinmesh.inpatient-intent:v1:${encodeURIComponent(scope)}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [stored, setStored] = useState(() => load(key, expectedBinding))
  useEffect(() => {
    const refresh = () => setStored(load(key, bindingSchema.parse(JSON.parse(scope))))
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === key) refresh() }
    refresh()
    window.addEventListener(intentChangedEvent, changed)
    return () => window.removeEventListener(intentChangedEvent, changed)
  }, [key, scope])
  const pending = stored.key === key ? stored.intent : null
  const storageFailure = stored.key === key ? stored.error : null
  const mutation = useMutation({ mutationFn: async (raw?: InpatientWriteCommand) => {
    if (inFlight.current) throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'The original command is pending')
    inFlight.current = true
    try {
      const current = load(key, expectedBinding)
      if (current.error !== null) throw current.error
      if (raw !== undefined && current.intent !== null) {
        setStored(current)
        throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'Resolve the existing inpatient intent')
      }
      let intent: InpatientWriteIntent
      try {
        intent = current.intent ?? intentSchema.parse({ version: 1, binding: expectedBinding,
          idempotencyKey: newIdempotencyKey(), command: raw })
      } catch { throw new ApiClientError(400, 'INVALID_INPUT', 'Invalid inpatient intent') }
      if (JSON.stringify(binding(await getSession())) !== scope || currentScope.current !== scope || !mounted.current) {
        throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The inpatient context changed')
      }
      const concurrent = load(key, expectedBinding)
      if (concurrent.error !== null) throw concurrent.error
      if (concurrent.intent !== null && concurrent.intent.idempotencyKey !== intent.idempotencyKey) {
        setStored(concurrent)
        throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'Resolve the existing inpatient intent')
      }
      try { sessionStorage.setItem(key, JSON.stringify(intent)) } catch { throw storageError() }
      window.dispatchEvent(new CustomEvent(intentChangedEvent, { detail: key }))
      const clear = () => {
        const latest = load(key, expectedBinding)
        if (latest.error !== null) throw latest.error
        if (latest.intent !== null && latest.intent.idempotencyKey !== intent.idempotencyKey) {
          setStored(latest)
          return
        }
        try { sessionStorage.removeItem(key) } catch { throw storageError() }
        window.dispatchEvent(new CustomEvent(intentChangedEvent, { detail: key }))
      }
      const operation = intent.command.operation === 'scenario.advance-time' ? undefined : getHisOperation(intent.command.operation)
      let sent = false
      try {
        if (current.intent !== null && operation !== undefined) {
          const query = new URLSearchParams({ operationId: operation.id, idempotencyKey: intent.idempotencyKey })
          try {
            const receipt = await apiGet(`/api/his/v1/command-receipts?${query}`, commandReceiptLookupSchema)
            if (receipt.status !== 'completed') throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'The original command is pending')
            const response = operation.output.parse(receipt.response)
            clear()
            return { command: intent.command, response, scope }
          } catch (error) {
            if (!(error instanceof ApiClientError) || error.code !== 'COMMAND_RECEIPT_NOT_FOUND') throw error
          }
        }
        if (currentScope.current !== scope || !mounted.current) throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The inpatient context changed')
        let response: unknown
        sent = true
        if (intent.command.operation === 'scenario.advance-time') {
          response = await apiMutation(`/api/sim/v1/scenario-runs/${intent.binding.actor.scenarioRunId}/actions/advance-time`,
            advanceVirtualTimeResponseSchema, { input: intent.command.input }, { idempotencyKey: intent.idempotencyKey })
        } else {
          const definition = getHisOperation(intent.command.operation)
          const input = intent.command.input
          const path = 'admissionId' in input ? definition.http.path.replace(':admissionId', encodeURIComponent(input.admissionId)) : definition.http.path
          response = await apiMutation(path, definition.output, definition.http.encodeBody!(input), { idempotencyKey: intent.idempotencyKey })
        }
        clear()
        return { command: intent.command, response, scope }
      } catch (error) {
        if (sent && error instanceof ApiClientError && [400, 403, 404, 409, 422].includes(error.status)
          && !['UNEXPECTED_RESPONSE', 'IDEMPOTENCY_KEY_REUSED', 'INPATIENT_INTENT_PENDING', 'INPATIENT_INTENT_CONTEXT_CHANGED'].includes(error.code)) clear()
        throw error
      }
    } finally { inFlight.current = false }
  }, onSuccess: result => { if (mounted.current && result.scope === currentScope.current) return onSuccess(result.command, result.response) } })
  return { pending, storageFailure, mutation, blocked: pending !== null || storageFailure !== null || mutation.isPending }
}
