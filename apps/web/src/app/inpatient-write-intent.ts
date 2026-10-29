import { inpatientDrgAgentConfirmInputSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientMaterialEstimateRequestInputSchema, inpatientMaterialEstimateSaveInputSchema, inpatientMaterialEstimateConfirmInputSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientDrgReviewTodoActionInputSchema, inpatientDrgReviewHandoffInputSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientPciSelectionConfirmInputSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientDrgFollowupStartInputSchema, inpatientDrgFollowupStopInputSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { insuranceTargetSchema } from '@clinmesh/contracts/insurance'
import { chargeAdjustmentInputSchema, refundPreviewInputSchema, refundConfirmInputSchema, refundRecoverInputSchema } from '@clinmesh/contracts/refunds'
import { inpatientFinancialInsuranceCancelInputSchema, inpatientFinancialInsurancePreviewInputSchema, inpatientFinancialInsuranceConfirmInputSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientRecordSubmitInputSchema, inpatientRecordReviewInputSchema, inpatientRecordArchiveInputSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewCreateInputSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientFinancialAdjustmentInputSchema, inpatientFinancialRefundPreviewInputSchema, inpatientFinancialRefundConfirmInputSchema, inpatientFinancialRefundRecoverInputSchema, inpatientFinancialPaymentPreviewInputSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientDischargeInputSchema, inpatientDepartInputSchema, inpatientSettleInputSchema,
  inpatientPaymentInputSchema, inpatientPaymentConfirmInputSchema, inpatientPaymentRecoverInputSchema,
  inpatientRefundInputSchema, inpatientRefundConfirmInputSchema, inpatientRefundRecoverInputSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema, inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryCompleteInputSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientInvestigationIssueInputSchema,inpatientInvestigationActionInputSchema,inpatientInvestigationAcknowledgeInputSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientTransferRequestInputSchema,inpatientTransferActionInputSchema,inpatientTransferReceiveInputSchema } from '@clinmesh/contracts/inpatient-transfer'
import { inpatientDiagnosisConfirmInputSchema, inpatientOrderIssueInputSchema, inpatientOrderActionInputSchema, inpatientOrderReasonInputSchema, inpatientExecutionActionInputSchema, inpatientDispenseInputSchema, inpatientChargeReverseInputSchema } from '@clinmesh/contracts/inpatient-clinical'
import { z } from 'zod'
import { inpatientPciDataPrepareRequestSchema, pciCaseSourcePrepareRequestSchema, startSyntheticInpatientCaseRequestSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema, getHisOperation } from '@clinmesh/contracts/his-operations'
import { advanceVirtualTimeInputSchema, advanceVirtualTimeResponseSchema, inpatientBedInputSchema,
  inpatientRegistrationInputSchema, inpatientSwapInputSchema, inpatientReferralInputSchema } from '@clinmesh/contracts/inpatient'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiClientError, apiGet, apiMutation, getSession, newIdempotencyKey } from './api-client.ts'

const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inpatient.drg.agent.confirm'), input: inpatientDrgAgentConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.request'), input: inpatientMaterialEstimateRequestInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.cancel'), input: inpatientMaterialEstimateRequestInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.save'), input: inpatientMaterialEstimateSaveInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.confirm'), input: inpatientMaterialEstimateConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.review.todo.act'), input: inpatientDrgReviewTodoActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.review.handoff'), input: inpatientDrgReviewHandoffInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.pci-selection.confirm'), input: inpatientPciSelectionConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.followup.start'), input: inpatientDrgFollowupStartInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.followup.stop'), input: inpatientDrgFollowupStopInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.pci-data.prepare'), input: inpatientPciDataPrepareRequestSchema.shape.input }).strict(),
  z.object({ operation: z.literal('admin.pci-case.prepare'), input: pciCaseSourcePrepareRequestSchema.shape.input }).strict(),
  z.object({ operation: z.literal('registration.synthetic-case.start-inpatient'), input: startSyntheticInpatientCaseRequestSchema.extend({ caseId: z.string().min(1).max(128) }).strict() }).strict(),
  z.object({ operation: z.literal('inpatient.drg.reservation.create'), input: inpatientMaterialReservationCreateInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.reservation.release'), input: inpatientMaterialReservationReleaseInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.payer.review'), input: inpatientDrgPayerReviewCreateInputSchema }).strict(),
  z.object({ operation: z.literal('billing.charge.adjust'), input: chargeAdjustmentInputSchema.extend({ caseId: z.string().min(1), chargeVersion: z.number().int().positive() }).strict() }).strict(),
  z.object({ operation: z.literal('refund.preview'), caseId: z.string().min(1), input: refundPreviewInputSchema.extend({ chargeItemId: z.string().min(1), chargeVersion: z.number().int().positive() }).strict() }).strict(),
  z.object({ operation: z.literal('refund.confirm'), caseId: z.string().min(1), input: refundConfirmInputSchema.extend({ previewId: z.string().min(1), chargeItemId: z.string().min(1), chargeVersion: z.number().int().positive() }).strict() }).strict(),
  z.object({ operation: z.literal('refund.recover'), caseId: z.string().min(1), input: refundRecoverInputSchema.extend({ refundId: z.string().min(1), chargeItemId: z.string().min(1), chargeVersion: z.number().int().positive() }).strict() }).strict(),
  z.object({ operation: z.literal('inpatient.financial.insurance.cancel'), input: inpatientFinancialInsuranceCancelInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.insurance.preview'), input: inpatientFinancialInsurancePreviewInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.insurance.confirm'), input: inpatientFinancialInsuranceConfirmInputSchema }).strict(),
  z.object({operation:z.literal('insurance.confirm'),input:insuranceTargetSchema.extend({previewId:z.string().min(1),commitToken:z.string().min(16).max(256)})}).strict(),
  z.object({operation:z.literal('insurance.cancel'),input:insuranceTargetSchema.extend({settlementId:z.string().min(1),expectedBalanceVersion:z.number().int().nonnegative()})}).strict(),
  z.object({ operation: z.literal('inpatient.financial.adjust'), input: inpatientFinancialAdjustmentInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.refund.preview'), input: inpatientFinancialRefundPreviewInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.refund.confirm'), input: inpatientFinancialRefundConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.refund.recover'), input: inpatientFinancialRefundRecoverInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.payment.preview'), input: inpatientFinancialPaymentPreviewInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.payment.confirm'), input: inpatientPaymentConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.financial.payment.recover'), input: inpatientPaymentRecoverInputSchema }).strict(),
  z.object({operation:z.literal('inpatient.payment.preview'),input:inpatientPaymentInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.payment.confirm'),input:inpatientPaymentConfirmInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.payment.recover'),input:inpatientPaymentRecoverInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.refund.preview'),input:inpatientRefundInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.refund.confirm'),input:inpatientRefundConfirmInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.refund.recover'),input:inpatientRefundRecoverInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.record.submit'),input:inpatientRecordSubmitInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.record.review'),input:inpatientRecordReviewInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.record.archive'),input:inpatientRecordArchiveInputSchema}).strict(),
  z.object({ operation: z.literal('inpatient.admission.register'), input: inpatientRegistrationInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.admission.receive'), input: inpatientBedInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.admission.move-bed'), input: inpatientBedInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.admission.swap-bed'), input: inpatientSwapInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.referral.issue'), input: inpatientReferralInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.diagnosis.confirm'), input: inpatientDiagnosisConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.order.issue'), input: inpatientOrderIssueInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.order.verify'), input: inpatientOrderActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.order.request-stop'), input: inpatientOrderReasonInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.order.verify-stop'), input: inpatientOrderActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.execution.request-prn'), input: inpatientOrderReasonInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.execution.dispense'), input: inpatientDispenseInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.execution.administer'), input: inpatientExecutionActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.execution.complete'), input: inpatientExecutionActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.charge.reverse'), input: inpatientChargeReverseInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.discharge.issue'), input: inpatientDischargeInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.discharge.depart'), input: inpatientDepartInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.discharge.recall'), input: inpatientDischargeInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.discharge.clear'), input: inpatientDischargeInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.discharge.settle'), input: inpatientSettleInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.request'), input: inpatientSurgeryRequestInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.check-preop'), input: inpatientSurgeryActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.confirm-consent'), input: inpatientSurgeryActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.cancel'), input: inpatientSurgeryActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.start'), input: inpatientSurgeryStartInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.record-material'), input: inpatientSurgeryRecordMaterialInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.correct-material'), input: inpatientSurgeryCorrectMaterialInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.complete'), input: inpatientSurgeryCompleteInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.execute'), input: inpatientSurgeryExecuteInputSchema }).strict(),
  z.object({operation:z.literal('inpatient.investigation.issue'),input:inpatientInvestigationIssueInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.investigation.send'),input:inpatientInvestigationActionInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.investigation.cancel'),input:inpatientInvestigationActionInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.investigation.retry'),input:inpatientInvestigationActionInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.investigation.acknowledge'),input:inpatientInvestigationAcknowledgeInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.transfer.request'),input:inpatientTransferRequestInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.transfer.handover'),input:inpatientTransferActionInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.transfer.receive'),input:inpatientTransferReceiveInputSchema}).strict(),
  z.object({operation:z.literal('inpatient.transfer.cancel'),input:inpatientTransferActionInputSchema}).strict(),
  z.object({ operation: z.literal('scenario.advance-time'), input: advanceVirtualTimeInputSchema }).strict(),
])
const bindingSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict()
const intentSchema = z.object({ version: z.literal(1), binding: bindingSchema,
  idempotencyKey: z.uuid(), command: commandSchema }).strict().refine(intent =>
  !('expectedEpoch' in intent.command.input) || intent.command.input.expectedEpoch === intent.binding.actor.epoch)
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

/** 保存当前受信会话的原始写意图，供住院及门诊财务恢复；查询结果继续由 TanStack Query 拥有。 */
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
          let path = 'admissionId' in input ? definition.http.path.replace(':admissionId', encodeURIComponent(input.admissionId)) : 'kind' in input && 'id' in input ? definition.http.path.replace(':kind', input.kind).replace(':id', encodeURIComponent(input.id)) : definition.http.path
          if ('caseId' in input) path = path.replace(':caseId', encodeURIComponent(input.caseId))
          if ('previewId' in input) path = path.replace(':previewId', encodeURIComponent(input.previewId))
          if ('refundId' in input) path = path.replace(':refundId', encodeURIComponent(input.refundId))
          if ('adjustmentId' in input) path = path.replace(':adjustmentId', encodeURIComponent(input.adjustmentId))
          if ('reservationId' in input) path = path.replace(':reservationId', encodeURIComponent(input.reservationId))
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
