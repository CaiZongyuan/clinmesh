import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { z } from 'zod'
import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema, getHisOperation } from '@clinmesh/contracts/his-operations'
import { chargeAdjustmentInputSchema, refundPreviewInputSchema, refundConfirmInputSchema, refundRecoverInputSchema } from '@clinmesh/contracts/refunds'
import { ApiClientError, apiGet, apiMutation, getSession, newIdempotencyKey } from './api-client.ts'

const chargeVersion = { chargeVersion: z.number().int().positive() }
const charge = { chargeItemId: z.string().min(1), ...chargeVersion }
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('billing.charge.adjust'), input: chargeAdjustmentInputSchema.extend({ caseId: z.string().min(1), ...chargeVersion }).strict() }).strict(),
  z.object({ operation: z.literal('refund.preview'), input: refundPreviewInputSchema.extend(charge).strict() }).strict(),
  z.object({ operation: z.literal('refund.confirm'), input: refundConfirmInputSchema.extend({ previewId: z.string().min(1), ...charge }).strict() }).strict(),
  z.object({ operation: z.literal('refund.recover'), input: refundRecoverInputSchema.extend({ refundId: z.string().min(1), ...charge }).strict() }).strict(),
])
const bindingSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict()
const requestSchema = z.object({ caseId: z.string().min(1), command: commandSchema }).strict()
const intentSchema = requestSchema.extend({ version: z.literal(1), binding: bindingSchema, idempotencyKey: z.uuid() }).strict()
  .refine(intent => intent.command.operation !== 'billing.charge.adjust' || intent.command.input.caseId === intent.caseId)
type RefundWriteRequest = z.infer<typeof requestSchema>
type RefundWriteIntent = z.infer<typeof intentSchema>
const changedEvent = 'clinmesh.refund-intent.changed'

function binding(session: SessionContext) { return bindingSchema.parse({ accountId: session.user.id, actor: session.actor }) }
function storageError() { return new ApiClientError(0, 'REFUND_INTENT_STORAGE_UNAVAILABLE', 'Refund intent storage unavailable') }
function load(key: string, expectedBinding: z.infer<typeof bindingSchema>) {
  try {
    const value = sessionStorage.getItem(key)
    if (value === null) return { key, intent: null, error: null }
    const intent = intentSchema.parse(JSON.parse(value))
    if (JSON.stringify(intent.binding) !== JSON.stringify(expectedBinding)) throw storageError()
    return { key, intent, error: null }
  } catch { return { key, intent: null, error: storageError() } }
}

/** 只持久化原始写入意图；账本和退款结果仍由 TanStack Query 拥有。 */
export function useRefundWriteIntent(session: SessionContext, onSuccess: () => Promise<unknown>) {
  const expectedBinding = binding(session)
  const scope = JSON.stringify(expectedBinding)
  const key = `clinmesh.refund-intent:v1:${encodeURIComponent(scope)}`
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
    window.addEventListener(changedEvent, changed)
    return () => window.removeEventListener(changedEvent, changed)
  }, [key, scope])
  const pending = stored.key === key ? stored.intent : null
  const storageFailure = stored.key === key ? stored.error : null
  const mutation = useMutation({ mutationFn: async (raw?: RefundWriteRequest) => {
    if (inFlight.current) throw new ApiClientError(409, 'REFUND_INTENT_PENDING', 'The original fee operation is pending')
    inFlight.current = true
    try {
      const current = load(key, expectedBinding)
      if (current.error !== null) throw current.error
      if (raw !== undefined && current.intent !== null) throw new ApiClientError(409, 'REFUND_INTENT_PENDING', 'Resolve the existing fee operation')
      const intent: RefundWriteIntent = current.intent ?? intentSchema.parse({ ...raw, version: 1, binding: expectedBinding, idempotencyKey: newIdempotencyKey() })
      const checkContext = async () => {
        if (JSON.stringify(binding(await getSession())) !== scope || currentScope.current !== scope || !mounted.current) {
          throw new ApiClientError(409, 'REFUND_INTENT_CONTEXT_CHANGED', 'The refund context changed')
        }
      }
      await checkContext()
      const concurrent = load(key, expectedBinding)
      if (concurrent.error !== null) throw concurrent.error
      if (concurrent.intent !== null && concurrent.intent.idempotencyKey !== intent.idempotencyKey) {
        setStored(concurrent)
        throw new ApiClientError(409, 'REFUND_INTENT_PENDING', 'Resolve the existing fee operation')
      }
      try { sessionStorage.setItem(key, JSON.stringify(intent)) } catch { throw storageError() }
      window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
      const clear = () => {
        const latest = load(key, expectedBinding)
        if (latest.error !== null) throw latest.error
        if (latest.intent !== null && latest.intent.idempotencyKey !== intent.idempotencyKey) return
        try { sessionStorage.removeItem(key) } catch { throw storageError() }
        window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
      }
      const operation = getHisOperation(intent.command.operation)
      let sent = false
      try {
        if (current.intent !== null) {
          const query = new URLSearchParams({ operationId: operation.id, idempotencyKey: intent.idempotencyKey })
          try {
            const receipt = await apiGet(`/api/his/v1/command-receipts?${query}`, commandReceiptLookupSchema)
            if (receipt.status !== 'completed') throw new ApiClientError(409, 'REFUND_INTENT_PENDING', 'The original fee operation is pending')
            const response = operation.output.parse(receipt.response)
            clear()
            return { ...intent, response, scope }
          } catch (error) {
            if (!(error instanceof ApiClientError) || error.code !== 'COMMAND_RECEIPT_NOT_FOUND') throw error
          }
          await checkContext()
        }
        const input = intent.command.input
        const path = operation.http.path
          .replace(':caseId', encodeURIComponent(intent.caseId))
          .replace(':previewId', encodeURIComponent('previewId' in input ? input.previewId : ''))
          .replace(':refundId', encodeURIComponent('refundId' in input ? input.refundId : ''))
        sent = true
        const response = await apiMutation(path, operation.output, operation.http.encodeBody!(input), { idempotencyKey: intent.idempotencyKey })
        clear()
        return { ...intent, response, scope }
      } catch (error) {
        if (sent && error instanceof ApiClientError && [400, 403, 404, 409, 422].includes(error.status)
          && !['UNEXPECTED_RESPONSE', 'IDEMPOTENCY_KEY_REUSED', 'REFUND_INTENT_PENDING', 'REFUND_INTENT_CONTEXT_CHANGED'].includes(error.code)) clear()
        throw error
      }
    } finally { inFlight.current = false }
  }, onSuccess: result => { if (mounted.current && result.scope === currentScope.current) return onSuccess() } })
  useEffect(() => { mutation.reset() }, [key, mutation.reset])
  return { pending, storageFailure, mutation, blocked: pending !== null || storageFailure !== null || mutation.isPending }
}

export type RefundWrite = ReturnType<typeof useRefundWriteIntent>
