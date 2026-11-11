import { inpatientDrgAgentConfirmInputSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgExplainInputSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { inpatientGuidelineAdviceRequestInputSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { inpatientMaterialEstimateRequestInputSchema, inpatientMaterialEstimateSaveInputSchema, inpatientMaterialEstimateConfirmInputSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientDrgReviewTodoActionInputSchema, inpatientDrgReviewHandoffInputSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientPciSelectionConfirmInputSchema, inpatientPciSelectionSaveInputSchema } from '@clinmesh/contracts/inpatient-pci-selection'
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
import { inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema, inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgerySupplementMaterialInputSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryCompleteInputSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientInvestigationIssueInputSchema,inpatientInvestigationActionInputSchema,inpatientInvestigationAcknowledgeInputSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientTransferRequestInputSchema,inpatientTransferActionInputSchema,inpatientTransferReceiveInputSchema } from '@clinmesh/contracts/inpatient-transfer'
import { inpatientDiagnosisConfirmInputSchema, inpatientOrderIssueInputSchema, inpatientOrderActionInputSchema, inpatientOrderReasonInputSchema, inpatientExecutionActionInputSchema, inpatientDispenseInputSchema, inpatientChargeReverseInputSchema } from '@clinmesh/contracts/inpatient-clinical'
import { z } from 'zod'
import { inpatientPciDataPrepareRequestSchema, pciCaseSourcePrepareRequestSchema, startSyntheticInpatientCaseRequestSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { multiChargePaymentResponseSchema, type SessionContext } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema, getHisOperation, multiChargePaymentPreviewOperationInputSchema, multiChargePaymentConfirmOperationInputSchema,
  multiChargePaymentRecoverOperationInputSchema, refundAllocationPreviewOperationInputSchema } from '@clinmesh/contracts/his-operations'
import { advanceVirtualTimeInputSchema, advanceVirtualTimeResponseSchema, inpatientBedInputSchema,
  inpatientRegistrationInputSchema, inpatientSwapInputSchema, inpatientReferralInputSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { IssueDraftUnreadable, type IssueDraftOutcome } from './inpatient-issue-draft-settlement.ts'
import { settleIssuedOrder } from './inpatient-order-drafts.ts'
import { settleIssuedInvestigation } from './inpatient-investigation-drafts.ts'
import { consumeSurgeryDraft } from './inpatient-surgery-draft.ts'
import { ReservationDraftUnreadable, settleReservationAttempt } from './inpatient-reservation-batch.ts'
import { settleCorrectionAttempt } from './inpatient-correction-batch.ts'
import { settleInpatientOrderAttempt } from './inpatient-order-batch.ts'
import { settleInvestigationSendAttempt } from './inpatient-investigation-send-drafts.ts'
import { settleDispenseAttempt } from './inpatient-dispense-drafts.ts'
import { settleInpatientInvestigationActionAttempt } from './inpatient-investigation-action-drafts.ts'
import { settleInpatientReportAttempt } from './inpatient-report-reader-drafts.ts'
import { settleExecutionAttempt } from './inpatient-execution-drafts.ts'
import { ApiClientError, apiGet, apiMutation, getSession, newIdempotencyKey } from './api-client.ts'
import { removeCollectedMultiChargeDraftItems } from './billing-multi-charge-draft.ts'
import { completePatientLibraryVisit, outpatientStartCommandSchema, PatientLibraryDraftUnreadable } from './patient-library-visit-state.ts'
import { inpatientIntentBindingSchema as bindingSchema, inpatientIntentKey, inpatientLogoutRevision } from './inpatient-intent-storage.ts'
import { completeInpatientReviewDraft } from './inpatient-review-draft.ts'
import { completeInpatientReviewQueue, InpatientReviewStorageUnreadable } from './inpatient-review-queue.ts'

const commandSchema = z.discriminatedUnion('operation', [
  outpatientStartCommandSchema,
  z.object({ operation: z.literal('payment.multi-charge.preview'), patientId: z.string().min(1), encounterId: z.string().min(1), input: multiChargePaymentPreviewOperationInputSchema }).strict(),
  z.object({ operation: z.literal('payment.multi-charge.confirm'), caseId: z.string().min(1), patientId: z.string().min(1), encounterId: z.string().min(1), input: multiChargePaymentConfirmOperationInputSchema }).strict(),
  z.object({ operation: z.literal('payment.multi-charge.recover'), caseId: z.string().min(1), patientId: z.string().min(1), encounterId: z.string().min(1), input: multiChargePaymentRecoverOperationInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.record-checks.explain'), input: inpatientDrgExplainInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.guideline-advice.request'), input: inpatientGuidelineAdviceRequestInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.agent.confirm'), input: inpatientDrgAgentConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.request'), input: inpatientMaterialEstimateRequestInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.cancel'), input: inpatientMaterialEstimateRequestInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.save'), input: inpatientMaterialEstimateSaveInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.material-estimate.confirm'), input: inpatientMaterialEstimateConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.review.todo.act'), input: inpatientDrgReviewTodoActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.review.handoff'), input: inpatientDrgReviewHandoffInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.pci-selection.confirm'), input: inpatientPciSelectionConfirmInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.pci-selection.save'), input: inpatientPciSelectionSaveInputSchema }).strict(),
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
  z.object({ operation: z.literal('refund.allocation.preview'), caseId: z.string().min(1), input: refundAllocationPreviewOperationInputSchema }).strict(),
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
  z.object({ operation: z.literal('inpatient.surgery.supplement-material'), input: inpatientSurgerySupplementMaterialInputSchema }).strict(),
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
const intentSchema = z.object({ version: z.literal(1), binding: bindingSchema,
  idempotencyKey: z.uuid(), command: commandSchema }).strict().refine(intent =>
  !('expectedEpoch' in intent.command.input) || intent.command.input.expectedEpoch === intent.binding.actor.epoch)
type InpatientWriteCommand = z.infer<typeof commandSchema>
// 身份未变化也可能已切走视图；发送前守卫不进入可恢复意图。
type InpatientWriteAttempt = InpatientWriteCommand & { isCurrent?: () => boolean; canSend?: () => boolean; idempotencyKey?: string; recoverOriginal?: true; discardUnreadMultiChargeDraft?: true; discardUnreadContinuationDraft?: true }
type InpatientWriteIntent = z.infer<typeof intentSchema>
const intentChangedEvent = 'clinmesh.inpatient-intent.changed'

/** 只表示实际 Command 请求的确定拒绝；回执读取失败仍须恢复原尝试。 */
export class InpatientCommandRejection extends ApiClientError {
  readonly commandRejected = true
  constructor(error: ApiClientError) { super(error.status, error.code, error.message, error.conflict, error.correlationId, error.reason) }
}
/** 已证明原收款成功，但原范围私稿尚未完成可靠清理。 */
export class CollectedMultiChargeDraftUnreadable extends ApiClientError {
  constructor(readonly idempotencyKey: string) { super(0, 'INPATIENT_INTENT_STORAGE_UNAVAILABLE', 'The original collection succeeded; its private draft cannot be read') }
}
export class OriginalContinuationUnreadable extends ApiClientError {
  constructor(readonly idempotencyKey: string) { super(0, 'INPATIENT_INTENT_STORAGE_UNAVAILABLE', 'The original operation succeeded; its draft or continuation cannot be read') }
}
class InpatientCommandNotSent extends ApiClientError {
  readonly commandNotSent = true
  constructor() { super(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The new inpatient command was not sent') }
}

export function isInpatientDraftSave(command: Pick<InpatientWriteCommand, 'operation'> | undefined): boolean {
  return command?.operation === 'inpatient.material-estimate.save' || command?.operation === 'inpatient.pci-selection.save'
}

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
  const key = inpatientIntentKey(expectedBinding)
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
  const mutation = useMutation({ mutationFn: async (raw?: InpatientWriteAttempt) => {
    if (inFlight.current) throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'The original command is pending')
    inFlight.current = true
    try {
      const logoutRevision = inpatientLogoutRevision()
      const current = load(key, expectedBinding)
      if (current.error !== null) throw current.error
      if (raw !== undefined && current.intent !== null && (!raw.recoverOriginal || raw.idempotencyKey !== current.intent.idempotencyKey)) {
        setStored(current)
        throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'Resolve the existing inpatient intent')
      }
      const isCurrent = () => raw?.isCurrent?.() !== false
      if (!isCurrent()) throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The inpatient context changed')
      let submitted: unknown = raw
      if (raw !== undefined) {
        const { isCurrent: _guard, canSend: _sendGuard, idempotencyKey: _key, recoverOriginal: _recover, discardUnreadMultiChargeDraft: _discard, discardUnreadContinuationDraft: _discardContinuation, ...command } = raw
        submitted = command
      }
      let intent: InpatientWriteIntent
      try {
        if (raw?.discardUnreadContinuationDraft && (!raw.recoverOriginal || current.intent === null)) throw storageError()
        if (raw?.recoverOriginal && (raw.idempotencyKey === undefined || current.intent !== null
          && JSON.stringify(commandSchema.parse(submitted)) !== JSON.stringify(current.intent.command))) throw storageError()
        intent = current.intent ?? intentSchema.parse({ version: 1, binding: expectedBinding,
          idempotencyKey: raw?.idempotencyKey ?? newIdempotencyKey(), command: submitted })
      } catch { throw new ApiClientError(400, 'INVALID_INPUT', 'Invalid inpatient intent') }
      const assertCurrent = async () => {
        if (currentScope.current !== scope || !mounted.current || !isCurrent()
          || JSON.stringify(binding(await getSession())) !== scope || currentScope.current !== scope || !mounted.current || !isCurrent()) {
          throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The inpatient context changed')
        }
      }
      await assertCurrent()
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
      const sameLogin = () => logoutRevision === inpatientLogoutRevision()
      const stillOwnsIntent = () => {
        const latest = load(key, expectedBinding)
        if (latest.error !== null) throw latest.error
        return latest.intent?.idempotencyKey === intent.idempotencyKey
      }
      const settleIssue = (outcome: IssueDraftOutcome) => {
        try {
          const command = intent.command
          if (command.operation === 'inpatient.order.issue') settleIssuedOrder(command.input, intent.idempotencyKey, session, outcome)
          if (command.operation === 'inpatient.investigation.issue') settleIssuedInvestigation(command.input, intent.idempotencyKey, session, outcome)
        } catch (error) {
          if (error instanceof IssueDraftUnreadable) throw new OriginalContinuationUnreadable(intent.idempotencyKey)
          throw storageError()
        }
      }
      // 原视图卸载后仍须完成原范围清稿；存储失败时保留可恢复意图。
      const complete = (response: unknown, receiptProven = false) => {
        const command = intent.command
        const keepContinuation = sameLogin()
        const result = { command, response, scope, logoutRevision }
        if (!keepContinuation && !stillOwnsIntent()) return result
        try {
          consumeSurgeryDraft(intent.command, session)
          settleReservationAttempt(intent.command, intent.idempotencyKey, session, { response, discardUnread: receiptProven && raw?.discardUnreadContinuationDraft === true })
          settleCorrectionAttempt(intent.command, intent.idempotencyKey, session, response, undefined, current.intent !== null || raw?.recoverOriginal === true)
        } catch (error) {
          if (error instanceof ReservationDraftUnreadable) throw new OriginalContinuationUnreadable(intent.idempotencyKey)
          throw storageError()
        }
        try { settleInpatientOrderAttempt(intent.command, intent.idempotencyKey, session, undefined, current.intent !== null || raw?.recoverOriginal === true, response) } catch { throw storageError() }
        try { settleInvestigationSendAttempt(intent.command, intent.idempotencyKey, session, undefined, current.intent !== null || raw?.recoverOriginal === true, response) } catch { throw storageError() }
        try { settleDispenseAttempt(intent.command, intent.idempotencyKey, session, undefined, current.intent !== null || raw?.recoverOriginal === true, response) } catch { throw storageError() }
        try { settleInpatientInvestigationActionAttempt(intent.command, intent.idempotencyKey, session, undefined, current.intent !== null || raw?.recoverOriginal === true, response) } catch { throw storageError() }
        try { settleInpatientReportAttempt(intent.command, intent.idempotencyKey, session, undefined, response) } catch { throw storageError() }
        try { settleExecutionAttempt(intent.command, intent.idempotencyKey, session, undefined, current.intent !== null || raw?.recoverOriginal === true, response) } catch { throw storageError() }
        settleIssue({ response, discardUnread: receiptProven && raw?.discardUnreadContinuationDraft === true })
        if ((command.operation === 'payment.multi-charge.confirm' || command.operation === 'payment.multi-charge.recover')
          && multiChargePaymentResponseSchema.parse(response).data.outcome === 'success') {
          const state = removeCollectedMultiChargeDraftItems({ user: { id: intent.binding.accountId }, actor: intent.binding.actor }, {
            caseId: command.caseId, patientId: command.patientId, encounterId: command.encounterId,
          }, command.input.charges.map(charge => charge.chargeItemId), raw?.recoverOriginal === true && raw.discardUnreadMultiChargeDraft === true)
          if (state.unreadable) throw new CollectedMultiChargeDraftUnreadable(intent.idempotencyKey)
          if (state.failed) throw storageError()
        }
        if (command.operation === 'inpatient.record.submit' || command.operation === 'inpatient.record.review'
          || command.operation === 'inpatient.record.archive' || command.operation === 'inpatient.drg.payer.review') {
          const result = z.object({ data: z.object({ admissionId: z.string() }) }).safeParse(response)
          if (!result.success || result.data.data.admissionId !== command.input.admissionId) {
            throw new ApiClientError(0, 'UNEXPECTED_RESPONSE', 'Original review admission changed')
          }
        }
        const discardUnread = receiptProven && raw?.discardUnreadContinuationDraft === true
        try {
          if (command.operation === 'registration.synthetic-case.start') completePatientLibraryVisit(command, response, intent.binding, discardUnread, keepContinuation)
          if (keepContinuation) completeInpatientReviewDraft(command, intent.binding, discardUnread)
          else completeInpatientReviewQueue(command, intent.binding, discardUnread, false)
        } catch (error) {
          if (error instanceof InpatientReviewStorageUnreadable || error instanceof PatientLibraryDraftUnreadable) {
            throw new OriginalContinuationUnreadable(intent.idempotencyKey)
          }
          throw error
        }
        clear()
        return result
      }
      const operation = intent.command.operation === 'scenario.advance-time' ? undefined : getHisOperation(intent.command.operation)
      let sent = false
      try {
        if ((current.intent !== null || raw?.recoverOriginal) && operation !== undefined) {
          const query = new URLSearchParams({ operationId: operation.id, idempotencyKey: intent.idempotencyKey })
          try {
            const receipt = await apiGet(`/api/his/v1/command-receipts?${query}`, commandReceiptLookupSchema)
            const matches = receipt.operationId === operation.id && receipt.idempotencyKey === intent.idempotencyKey
            if (!matches && intent.command.operation === 'registration.synthetic-case.start') throw new ApiClientError(0, 'UNEXPECTED_RESPONSE', 'Original command receipt changed')
            if (!matches || receipt.status !== 'completed') {
              throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'The original command is pending')
            }
            if (!isCurrent()) throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The inpatient context changed')
            const response = operation.output.parse(receipt.response)
            await assertCurrent()
            return complete(response, true)
          } catch (error) {
            if (!(error instanceof ApiClientError) || error.code !== 'COMMAND_RECEIPT_NOT_FOUND' || error.status !== 404) throw error
          }
          if (raw?.discardUnreadMultiChargeDraft || raw?.discardUnreadContinuationDraft) {
            throw new ApiClientError(409, 'INPATIENT_INTENT_PENDING', 'A completed original receipt is required before discarding its private draft')
          }
          await assertCurrent()
          // 全局恢复入口没有动作窗口守卫；缺失回执后仍须读取原住院的最新可写状态。
          if (intent.command.operation === 'inpatient.investigation.acknowledge'
            || intent.command.operation === 'inpatient.execution.administer'
            || intent.command.operation === 'inpatient.execution.complete'
            || intent.command.operation === 'inpatient.execution.request-prn') {
            const admissionId = intent.command.input.admissionId
            const detail = await apiGet(`/api/his/v1/inpatient/admissions/${encodeURIComponent(admissionId)}`,
              inpatientDetailSchema.refine(value => value.admission.id === admissionId))
            await assertCurrent()
            if (detail.admission.recordStatus === 'archived'
              || intent.command.operation !== 'inpatient.investigation.acknowledge' && detail.admission.status !== 'admitted') {
              throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The original inpatient command cannot be resent')
            }
          }
        }
        if (currentScope.current !== scope || !mounted.current || !isCurrent()) {
          if (current.intent === null) clear()
          throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The inpatient context changed')
        }
        if (raw?.canSend?.() === false) {
          if (current.intent === null && !raw.recoverOriginal) { clear(); throw new InpatientCommandNotSent() }
          throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', 'The original inpatient command cannot be resent')
        }
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
          if ('paymentId' in input) path = path.replace(':paymentId', encodeURIComponent(input.paymentId))
          if ('adjustmentId' in input) path = path.replace(':adjustmentId', encodeURIComponent(input.adjustmentId))
          if ('reservationId' in input) path = path.replace(':reservationId', encodeURIComponent(input.reservationId))
          response = await apiMutation(path, definition.output, definition.http.encodeBody!(input), { idempotencyKey: intent.idempotencyKey })
        }
        return complete(response)
      } catch (error) {
        if (sent && error instanceof ApiClientError && [400, 403, 404, 409, 422].includes(error.status)
          && !['UNEXPECTED_RESPONSE', 'IDEMPOTENCY_KEY_REUSED', 'INPATIENT_INTENT_PENDING', 'INPATIENT_INTENT_CONTEXT_CHANGED'].includes(error.code)) {
          if (!sameLogin() && !stillOwnsIntent()) throw new InpatientCommandRejection(error)
          try { settleReservationAttempt(intent.command, intent.idempotencyKey, session, { error: { code: error.code, message: error.message,
            status: error.status, ...(error.reason === undefined ? {} : { reason: error.reason }) } }) } catch { throw storageError() }
          try { settleCorrectionAttempt(intent.command, intent.idempotencyKey, session, undefined, { code: error.code, message: error.message }) } catch { throw storageError() }
          try { settleInpatientOrderAttempt(intent.command, intent.idempotencyKey, session, { code: error.code, message: error.message }, current.intent !== null || raw?.recoverOriginal === true) } catch { throw storageError() }
          try { settleInvestigationSendAttempt(intent.command, intent.idempotencyKey, session, { code: error.code, message: error.message }, current.intent !== null || raw?.recoverOriginal === true) } catch { throw storageError() }
          try { settleDispenseAttempt(intent.command, intent.idempotencyKey, session, { code: error.code, message: error.message }, current.intent !== null || raw?.recoverOriginal === true) } catch { throw storageError() }
          try { settleInpatientInvestigationActionAttempt(intent.command, intent.idempotencyKey, session, { code: error.code, message: error.message }, current.intent !== null || raw?.recoverOriginal === true) } catch { throw storageError() }
          try { settleInpatientReportAttempt(intent.command, intent.idempotencyKey, session, { status: error.status, code: error.code,
            ...(error.conflict === undefined ? {} : { conflict: error.conflict }), ...(error.reason === undefined ? {} : { reason: error.reason }) }) } catch { throw storageError() }
          try { settleExecutionAttempt(intent.command, intent.idempotencyKey, session, { code: error.code, status: error.status }, current.intent !== null || raw?.recoverOriginal === true) } catch { throw storageError() }
          settleIssue({ failure: { status: error.status, code: error.code,
            ...(intent.command.operation === 'inpatient.order.issue' && error.code === 'CATALOG_CONFLICT' ? { message: error.message } : {}) } })
          clear()
          throw new InpatientCommandRejection(error)
        }
        throw error
      }
    } finally { inFlight.current = false }
  }, onMutate: raw => raw ?? load(key, expectedBinding).intent?.command,
  onSuccess: result => { if (mounted.current && result.scope === currentScope.current && result.logoutRevision === inpatientLogoutRevision()) return onSuccess(result.command, result.response) } })
  return { pending, storageFailure, mutation, blocked: pending !== null || storageFailure !== null || mutation.isPending }
}
