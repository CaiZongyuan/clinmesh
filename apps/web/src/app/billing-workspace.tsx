import { InsurancePanel } from './insurance-panel.tsx'
import { multiChargePaymentResponseSchema, type BillingQueueItem, type SessionContext } from '@clinmesh/contracts/his'
import { refundPreviewResponseSchema } from '@clinmesh/contracts/refunds'
import { parseAgentToolInput } from '@clinmesh/contracts/agent'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircleIcon, CircleAlertIcon, CreditCardIcon, ReceiptTextIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { confirmPayment, getBillingCase, getBillingQueue, newIdempotencyKey, previewPayment, recoverPayment } from './api-client.ts'
import { BillingCasePanel, BillingPaymentHistory, outpatientBillTotals, paymentMethodLabel, paymentAllocations } from './billing-case-panel.tsx'
import { BillingMultiChargePanel } from './billing-multi-charge-panel.tsx'
import { parseTenderAmounts } from './billing-payment-input.ts'
import { BillingRefundPanel, type FrozenRefund } from './billing-refund-panel.tsx'
import { CollectedMultiChargeDraftUnreadable, useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspaceHeaderPatient, WorkspaceQueueCard, useWorkspaceCardView, useWorkspaceConfirmation, announceHandoff } from './workspace-card-layout.tsx'
import { outpatientFlow } from './workspace-flow.ts'

interface BillingWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

type BillingCategory = BillingQueueItem['category']
type BillingStatus = 'ambiguous' | 'declined' | 'paid' | 'pending'
type SimulatorRule = 'ambiguous' | 'ambiguous-decline' | 'ambiguous-pending' | 'decline' | 'success'
type TenderMethod = 'cash' | 'bank-card' | 'mobile'
type TenderAmounts = Partial<Record<TenderMethod, string>>
type PaymentDraft = { simulatorRule: SimulatorRule; tenderAmounts: TenderAmounts }
const emptyPaymentDraft: PaymentDraft = { simulatorRule: 'success', tenderAmounts: {} }

export function BillingWorkspace({ locale, session }: BillingWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const agentReview = useAgentReview()
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const identity = agentViewRevision({ accountId: session.user.id, actor: session.actor })
  const identityOwner = useRef({ identity, revision: 0 })
  const selectionRevision = useRef(0)
  const historyRevision = useRef(0)
  if (identityOwner.current.identity !== identity) {
    identityOwner.current = { identity, revision: identityOwner.current.revision + 1 }
    selectionRevision.current += 1
    historyRevision.current += 1
  }
  const refundScope = agentViewRevision(identityOwner.current)
  const [refundPreviews, setRefundPreviews] = useState({ scope: refundScope, cases: new Map<string, FrozenRefund>() })
  const setRefundPreview = (targetCaseId: string, frozen?: FrozenRefund) => {
    setRefundPreviews(current => {
      const cases = current.scope === refundScope ? new Map(current.cases) : new Map<string, FrozenRefund>()
      if (frozen === undefined) cases.delete(targetCaseId)
      else cases.set(targetCaseId, frozen)
      return { scope: refundScope, cases }
    })
  }
  const categoryView = useWorkspaceCardView('billing-category')
  const category: BillingCategory = ['imaging', 'pathology', 'medication'].includes(categoryView.tab ?? '') ? categoryView.tab as BillingCategory : 'laboratory'
  const setCategory = (value: BillingCategory) => categoryView.setTab(value)
  const statusView = useWorkspaceCardView('billing-status')
  const status: BillingStatus = ['declined', 'paid', 'ambiguous'].includes(statusView.tab ?? '') ? statusView.tab as BillingStatus : 'pending'
  const setStatus = (value: BillingStatus) => statusView.setTab(value)
  const [page, setPage] = useState(1)
  const [historyPage, setHistoryPage] = useState({ caseKey: '', page: 1 })
  const paymentInFlight = useRef(false)
  const [selectedChargeId, setSelectedChargeId] = useState<string>()
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, PaymentDraft>>({})
  type MultiOutcome = { amountFen: number; outcome: 'ambiguous' | 'declined' | 'success'; caseId: string; patientId: string; encounterId: string }
  const [multiOutcome, setMultiOutcome] = useState<MultiOutcome & { scope: string }>()
  const [discardingRecoveredDraft, setDiscardingRecoveredDraft] = useState<string>()
  const simulatorItems: Array<{ label: string; value: SimulatorRule }> = [
    { label: messages.simulatorSuccess, value: 'success' },
    { label: messages.simulatorDecline, value: 'decline' },
    { label: messages.simulatorAmbiguous, value: 'ambiguous' },
    { label: messages.simulatorAmbiguousDecline, value: 'ambiguous-decline' },
    { label: messages.simulatorAmbiguousPending, value: 'ambiguous-pending' },
  ]
  const queueKey = ['billing-queue', ...scope, category, status, page] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getBillingQueue(category, status, signal, page),
    queryKey: queueKey,
  })
  const selectedCharge = queue.data?.items.find(item => item.chargeItemId === selectedChargeId)
    ?? queue.data?.items[0]
  const currentMultiTarget = useRef({ scope: refundScope, charge: selectedCharge, ready: queue.data !== undefined })
  currentMultiTarget.current = { scope: refundScope, charge: selectedCharge, ready: queue.data !== undefined }
  const multiPaymentOutcome = (value: MultiOutcome) => {
    const target = currentMultiTarget.current
    if (target.scope !== refundScope || !target.ready || (target.charge !== undefined
      && (target.charge.caseId !== value.caseId || target.charge.patient.id !== value.patientId || target.charge.encounterId !== value.encounterId))) return
    setMultiOutcome({ ...value, scope: refundScope })
    setStatus(value.outcome === 'success' ? 'paid' : value.outcome)
    setPage(1)
  }
  const visibleMultiOutcome = multiOutcome?.scope === refundScope && (selectedCharge === undefined
    || (selectedCharge.caseId === multiOutcome.caseId && selectedCharge.patient.id === multiOutcome.patientId && selectedCharge.encounterId === multiOutcome.encounterId)) ? multiOutcome : undefined
  const draftKey = agentViewRevision({ accountId: session.user.id, actor: session.actor, chargeItemId: selectedCharge?.chargeItemId })
  const { simulatorRule, tenderAmounts } = paymentDrafts[draftKey] ?? emptyPaymentDraft
  const setSimulatorRule = (value: SimulatorRule) => setPaymentDrafts(current => ({ ...current,
    [draftKey]: { ...(current[draftKey] ?? emptyPaymentDraft), simulatorRule: value } }))
  const setTenderAmounts = (value: TenderAmounts | ((previous: TenderAmounts) => TenderAmounts)) => setPaymentDrafts(current => {
    const previous = current[draftKey] ?? emptyPaymentDraft
    return { ...current, [draftKey]: { ...previous, tenderAmounts: typeof value === 'function' ? value(previous.tenderAmounts) : value } }
  })
  const formSignature = agentViewRevision({ simulatorRule, tenderAmounts })
  const latestForm = useRef(formSignature)
  latestForm.current = formSignature
  const caseId = selectedCharge?.caseId
  const caseKey = agentViewRevision({ owner: refundScope, caseId })
  const paymentPage = historyPage.caseKey === caseKey ? historyPage.page : 1
  if (historyPage.caseKey !== caseKey) setHistoryPage({ caseKey, page: 1 })
  const bill = useQuery({
    enabled: caseId !== undefined,
    queryKey: ['billing-case', ...scope, caseId, paymentPage],
    queryFn: ({ signal }) => {
      if (caseId === undefined) throw new Error(messages.paymentUnavailable)
      return getBillingCase(caseId, signal, paymentPage)
    },
  })
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const latestView = useRef('')
  latestView.current = agentViewRevision({ owner: refundScope, category, status, page, chargeItemId: selectedCharge?.chargeItemId })
  const paymentMutationContext = () => ({
    chargeItemId: selectedCharge?.chargeItemId,
    identity: latestView.current,
    revision: selectionRevision.current,
    scope: refundScope,
    formSignature,
  })
  type PaymentContext = ReturnType<typeof paymentMutationContext> & { category?: BillingCategory }
  type PreviewSubmission = { input: Parameters<typeof previewPayment>[0]; context: PaymentContext }
  type ConfirmSubmission = { input: Parameters<typeof confirmPayment>[0]; context: PaymentContext; caseKey: string; amountFen: number }
  type RecoverSubmission = { input: Parameters<typeof recoverPayment>[0]; context: PaymentContext }
  const [paymentConfirmation, setPaymentConfirmation] = useState<ConfirmSubmission>()
  const [recoveryConfirmation, setRecoveryConfirmation] = useState<RecoverSubmission>()
  const paymentContexts = useRef<Partial<Record<'confirm' | 'preview' | 'recover', ReturnType<typeof paymentMutationContext>>>>({})
  const ownsPaymentResult = (context: ReturnType<typeof paymentMutationContext> | undefined) =>
    mounted.current && context?.identity === latestView.current && context.revision === selectionRevision.current
      && context.scope === agentViewRevision(identityOwner.current)
  const displaysPaymentResult = (context: ReturnType<typeof paymentMutationContext> | undefined) =>
    context?.chargeItemId !== undefined && context.chargeItemId === selectedCharge?.chargeItemId
      && context.scope === refundScope && context.revision === selectionRevision.current
  const refreshBilling = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['billing-queue', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['billing-case', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['billing-refunds', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['pharmacy-queue', ...scope] }),
    ])
  },[queryClient,session.actor.workspaceId,session.actor.epoch])
  const refundWrite = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'payment.multi-charge.confirm' || command.operation === 'payment.multi-charge.recover') {
      const value = multiChargePaymentResponseSchema.parse(response).data
      multiPaymentOutcome(value)
    }
    if (command.operation === 'refund.preview' || command.operation === 'refund.allocation.preview') setRefundPreview(command.caseId, {
      preview: refundPreviewResponseSchema.parse(response).data, chargeVersion: command.input.chargeVersion,
    })
    if (command.operation === 'billing.charge.adjust') setRefundPreview(command.input.caseId)
    if (command.operation === 'refund.confirm') setRefundPreview(command.caseId)
    await refreshBilling()
  })
  const recover = useMutation({
    onMutate: (submission: RecoverSubmission) => {
      historyRevision.current += 1
      const context = submission.context
      paymentContexts.current.recover = context
      return context
    },
    mutationFn: (submission: RecoverSubmission) => {
      if (refundWrite.blocked || !ownsPaymentResult(submission.context)) throw new Error(messages.paymentUnavailable)
      return recoverPayment(submission.input, newIdempotencyKey())
    },
    onSuccess: (response, _paymentId, context) => {
      if (!ownsPaymentResult(context)) return
      setRecoveryConfirmation(undefined)
      setSelectedChargeId(context?.chargeItemId)
      if (context?.category === 'laboratory' || context?.category === 'imaging' || context?.category === 'pathology' || context?.category === 'medication') setCategory(context.category)
      const nextStatus = paymentQueueStatus(response.data)
      if (nextStatus !== status || (context.category !== undefined && context.category !== category)) setPage(1)
      setStatus(nextStatus)
    },
    onSettled: refreshBilling,
  })
  const selectedChargeDescription = selectedCharge === undefined
    ? ''
    : locale === 'zh-CN' ? selectedCharge.descriptionZh : selectedCharge.descriptionEn
  const preview = useMutation({
    onMutate: (submission: PreviewSubmission) => {
      historyRevision.current += 1
      const context = submission.context
      paymentContexts.current.preview = context
      return context
    },
    mutationFn: (submission: PreviewSubmission) => {
      if (refundWrite.blocked || !ownsPaymentResult(submission.context)) throw new Error(messages.paymentUnavailable)
      return previewPayment(submission.input, newIdempotencyKey())
    },
  })
  const confirm = useMutation({
    onMutate: (submission: ConfirmSubmission) => {
      historyRevision.current += 1
      const context = submission.context
      paymentContexts.current.confirm = context
      return context
    },
    mutationFn: (submission: ConfirmSubmission) => {
      if (refundWrite.blocked || !ownsPaymentResult(submission.context)) throw new Error(messages.paymentUnavailable)
      return confirmPayment(submission.input, `payment-confirm:${submission.input.previewId}`)
    },
    onSuccess: (response, submission, context) => {
      if (!ownsPaymentResult(context)) return
      if (response.data.outcome === 'success') {
        announceHandoff(locale === 'zh-CN' ? '收款完成' : 'Payment collected', locale === 'zh-CN' ? '缴费项目已交给执行科室' : 'Paid items are handed to the performing department')
      }
      setPaymentConfirmation(undefined)
      setSelectedChargeId(context?.chargeItemId)
      setHistoryPage({ caseKey: submission.caseKey, page: 1 })
      const nextStatus = paymentQueueStatus(response.data)
      if (nextStatus !== status) setPage(1)
      setStatus(nextStatus)
      if (context.formSignature === latestForm.current) setTenderAmounts({})
      preview.reset()
    },
    onSettled: refreshBilling,
  })
  const clearPayment = useCallback(() => {
    historyRevision.current += 1
    selectionRevision.current += 1
    setPaymentConfirmation(undefined)
    setRecoveryConfirmation(undefined)
    preview.reset()
    confirm.reset()
    recover.reset()
    setTenderAmounts({})
    setMultiOutcome(undefined)
  },[preview.reset,confirm.reset,recover.reset,draftKey])
  useEffect(() => {
    setPaymentConfirmation(undefined)
    setRecoveryConfirmation(undefined)
    preview.reset()
    confirm.reset()
    recover.reset()
  }, [refundScope, preview.reset, confirm.reset, recover.reset])
  const insuranceChanged=useCallback(async()=>{clearPayment();await refreshBilling()},[clearPayment,refreshBilling])
  const changeCategory = (value: BillingCategory) => {
    if (paymentPending) return
    setCategory(value)
    setPage(1)
    setSelectedChargeId(undefined)
    clearPayment()
  }
  const changeStatus = (value: BillingStatus) => {
    if (paymentPending) return
    setStatus(value)
    setPage(1)
    setSelectedChargeId(undefined)
    clearPayment()
  }
  const selectCharge = (chargeItemId: string) => {
    if (paymentPending) return
    setSelectedChargeId(chargeItemId)
    clearPayment()
  }
  const unknownAttempt = bill.data?.payments.find(payment => paymentAllocations(payment).some(item => item.chargeItemId === selectedCharge?.chargeItemId) && payment.outcome === 'ambiguous')
  const paymentPending = preview.isPending || confirm.isPending || recover.isPending || refundWrite.mutation.isPending
  const paymentWriteBlocked = paymentPending || refundWrite.blocked
  const paymentCollectionBlocked = paymentWriteBlocked || selectedCharge?.status === 'cancelled'
    || selectedCharge?.status === 'ambiguous' || status === 'ambiguous' || unknownAttempt !== undefined
  const tenderErrors = new Set<TenderMethod>()
  let tenderTotal = 0
  for (const method of ['cash', 'bank-card', 'mobile'] as const) {
    try { tenderTotal += parseTenderAmounts({ [method]: tenderAmounts[method] }, messages.invalidPaymentAmount)?.[0]?.amountFen ?? 0 }
    catch { tenderErrors.add(method) }
  }
  const remainingFen = bill.data?.charges.find(item => item.chargeItemId === selectedCharge?.chargeItemId)?.remainingFen ?? selectedCharge?.amountFen
  if (remainingFen !== undefined && tenderTotal > remainingFen) {
    for (const method of ['cash', 'bank-card', 'mobile'] as const) if (tenderAmounts[method]?.trim()) tenderErrors.add(method)
  }
  const pendingRefund = refundWrite.pending?.command.operation === 'billing.charge.adjust'
    || refundWrite.pending?.command.operation.startsWith('refund.') === true
  const refundError = refundWrite.storageFailure ?? refundWrite.mutation.error
  const frozenRefund = bill.data !== undefined && refundPreviews.scope === refundScope ? refundPreviews.cases.get(bill.data.caseId) : undefined
  const pendingRefundCommand = refundWrite.pending?.command
  const unreadableCollectedDraft = refundWrite.mutation.error instanceof CollectedMultiChargeDraftUnreadable
    && refundWrite.mutation.error.idempotencyKey === refundWrite.pending?.idempotencyKey
    && (pendingRefundCommand?.operation === 'payment.multi-charge.confirm' || pendingRefundCommand?.operation === 'payment.multi-charge.recover')
  const pendingRefundForCase = pendingRefund && bill.data !== undefined && pendingRefundCommand !== undefined
    && (pendingRefundCommand.operation === 'billing.charge.adjust' ? pendingRefundCommand.input.caseId === bill.data.caseId
      : 'caseId' in pendingRefundCommand && pendingRefundCommand.caseId === bill.data.caseId)
  paymentInFlight.current = paymentPending
  const changeHistoryPage = (page: number) => {
    if (paymentInFlight.current) return
    historyRevision.current += 1
    setHistoryPage({ caseKey, page })
  }
  const previewSubmission = (): PreviewSubmission => {
    if (paymentCollectionBlocked || selectedCharge === undefined) throw new Error(messages.paymentUnavailable)
    if (tenderErrors.size > 0) throw new Error(messages.invalidPaymentAmount)
    return { input: { caseId: selectedCharge.caseId, category: selectedCharge.category,
      chargeItemId: selectedCharge.chargeItemId, chargeVersion: selectedCharge.chargeVersion, simulatorRule,
      tenders: parseTenderAmounts(tenderAmounts, messages.invalidPaymentAmount) }, context: paymentMutationContext() }
  }
  const confirmSubmission = (): ConfirmSubmission => {
    if (paymentCollectionBlocked || currentPreview === undefined) throw new Error(messages.paymentUnavailable)
    const value = currentPreview
    return { input: { chargeItemId: value.chargeItemId, chargeVersion: value.chargeVersion,
      commitToken: value.commitToken, previewId: value.previewId }, context: paymentMutationContext(), caseKey, amountFen: value.amountFen }
  }
  const recoverSubmission = (paymentId: string): RecoverSubmission => {
    const attempt = bill.data?.payments.find(item => item.paymentId === paymentId)
    const charge = bill.data?.charges.find(item => item.chargeItemId === attempt?.chargeItemId)
    if (refundWrite.blocked || attempt === undefined || charge === undefined || charge.category === 'registration') throw new Error(messages.paymentUnavailable)
    return { input: { paymentId, expectedPaymentVersion: attempt.version, chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion },
      context: { ...paymentMutationContext(), chargeItemId: charge.chargeItemId, category: charge.category } }
  }
  const recoverOriginal = (paymentId: string) => {
    const attempt = bill.data?.payments.find(item => item.paymentId === paymentId)
    if (attempt?.kind !== 'multi-charge' || bill.data === undefined) return recover.mutateAsync(recoverSubmission(paymentId))
    const currentBill = bill.data
    return refundWrite.mutation.mutateAsync({ operation: 'payment.multi-charge.recover', caseId: currentBill.caseId,
      patientId: currentBill.patient.id, encounterId: currentBill.encounterId,
      input: { paymentId, expectedPaymentVersion: attempt.version, charges: attempt.allocations.map(allocation => {
        const charge = currentBill.charges.find(item => item.chargeItemId === allocation.chargeItemId)
        if (charge === undefined) throw new Error(messages.paymentUnavailable)
        return { chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion }
      }) } })
  }
  const currentPreview = selectedCharge?.status !== 'cancelled' && preview.data?.data.chargeItemId === selectedCharge?.chargeItemId
    && displaysPaymentResult(paymentContexts.current.preview) ? preview.data?.data : undefined

  const agentPage = useMemo(() => ({
    actions: {
      'billing.queue.read': {
        description: 'Read the current authorized billing queue page.',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => getBillingQueue(category, status, signal, page),
      },
      'billing.case.read': {
        description: 'Read the selected bill with complete balances and display a payment history page (20 attempts per page).',
        enabled: !paymentPending && selectedCharge !== undefined,
        parameters: { type: 'object' as const, properties: { page: { type: 'integer', minimum: 1 } }, additionalProperties: false },
        execute: async (raw: unknown, signal: AbortSignal) => {
          if (paymentInFlight.current || selectedCharge === undefined) throw new Error(messages.paymentUnavailable)
          const { page: requestedPage = paymentPage } = parseAgentToolInput('billing.case.read', raw)
          const context = paymentMutationContext()
          const revision = ++historyRevision.current
          const result = await getBillingCase(selectedCharge.caseId, signal, requestedPage)
          const pageCount = Math.max(1, Math.ceil(result.paymentsPagination.total / result.paymentsPagination.pageSize))
          if (requestedPage > pageCount) throw new Error(`Payment history has ${pageCount} page(s); choose a page from 1 to ${pageCount}`)
          if (!signal.aborted && !paymentInFlight.current && ownsPaymentResult(context) && revision === historyRevision.current) {
            setHistoryPage({ caseKey, page: requestedPage })
          }
          return result
        },
      },
      'billing.payment.recover.propose': {
        description: 'Request human review to query the original unknown payment attempt.',
        enabled: !paymentWriteBlocked && unknownAttempt !== undefined && unknownAttempt.kind !== 'multi-charge',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (paymentWriteBlocked || unknownAttempt === undefined || unknownAttempt.kind === 'multi-charge') throw new Error(messages.paymentUnavailable)
          const submission = recoverSubmission(unknownAttempt.paymentId)
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).recoverPayment,
            description: locale => `${selectedCharge?.patient.name ?? ''} · ${unknownAttempt.paymentId} · ${formatFen(unknownAttempt.amountFen, locale)}`,
            onConfirm: () => recover.mutateAsync(submission),
            signal,
            title: locale => getWorkspaceMessages(locale).recoverPayment,
          })
        },
      },
      'billing.item.select': {
        description: 'Select one charge from the current billing queue.',
        enabled: !paymentPending && (queue.data?.items.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: { chargeItemId: { type: 'string', maxLength: 128 } },
          required: ['chargeItemId'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          if (paymentPending) throw new Error(messages.paymentUnavailable)
          const chargeItemId = billingString(raw, 'chargeItemId')
          if (!queue.data?.items.some(item => item.chargeItemId === chargeItemId)) {
            throw new Error('Charge is not in the current billing queue')
          }
          selectCharge(chargeItemId)
          return { chargeItemId, selected: true }
        },
      },
      'billing.payment.preview': {
        description: 'Generate a payment preview for the selected synthetic charge.',
        enabled: !paymentCollectionBlocked && tenderErrors.size === 0 && selectedCharge !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: async () => {
          if (paymentCollectionBlocked || selectedCharge === undefined) throw new Error(messages.paymentUnavailable)
          return preview.mutateAsync(previewSubmission())
        },
      },
      'billing.payment.confirm.propose': {
        description: 'Open human review for the current payment preview.',
        enabled: !paymentCollectionBlocked && currentPreview !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (paymentCollectionBlocked || currentPreview === undefined) throw new Error(messages.paymentUnavailable)
          const submission = confirmSubmission()
          const frozen = currentPreview
          const amountFen = currentPreview.amountFen
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).submitPayment,
            description: locale => `${selectedCharge?.patient.name ?? ''} · ${formatFen(amountFen, locale)} · ${frozen.tenders?.map(tender => `${paymentMethodLabel(tender.method, getWorkspaceMessages(locale))} ${formatFen(tender.amountFen, locale)}`).join(' + ') ?? ''}`,
            onConfirm: () => confirm.mutateAsync(submission),
            signal,
            title: locale => getWorkspaceMessages(locale).confirmPaymentTitle,
          })
        },
      },
    },
    claim: {
      version: 1 as const,
      viewId: 'billing' as const,
      viewRevision: agentViewRevision({
        owner: refundScope,
        category,
        page,
        paymentPage,
        previewId: currentPreview?.previewId,
        selectedChargeId: selectedCharge?.chargeItemId,
        simulatorRule,
        tenderAmounts,
        paymentPending,
        unknownPaymentId: unknownAttempt?.paymentId,
        status,
      }),
      activeSection: `${category}:${status}`,
      ...(selectedCharge === undefined ? {} : {
        selection: {
          id: selectedCharge.chargeItemId,
          kind: 'billing-item' as const,
          version: String(selectedCharge.chargeVersion),
        },
      }),
      ui: {
        status: queue.isPending ? 'loading' as const
          : queue.isError ? 'error' as const
            : queue.data?.items.length === 0 ? 'empty' as const : 'ready' as const,
      },
    },
    label: 'ClinMesh · 门诊收费',
    readState: () => ({
      category,
      preview: currentPreview ?? null,
      queueCount: queue.data?.total ?? 0,
      selectedCharge: selectedCharge === undefined ? null : {
        amountFen: selectedCharge.amountFen,
        category: selectedCharge.category,
        chargeItemId: selectedCharge.chargeItemId,
        patientName: selectedCharge.patient.name,
      },
      simulatorRule,
      bill: bill.data ?? null,
      status,
    }),
  }), [
    agentReview,
    category,
    confirm.mutateAsync,
    locale,
    messages,
    page,
    caseKey,
    paymentPage,
    currentPreview,
    preview.mutateAsync,
    preview.reset,
    queue.data,
    queue.isError,
    queue.isPending,
    selectedCharge,
    simulatorRule,
    tenderAmounts,
    paymentPending,
    paymentWriteBlocked,
    paymentCollectionBlocked,
    bill.data,
    unknownAttempt,
    recover.mutateAsync,
    status,
  ])
  useRegisterAgentPage(agentPage)

  const activeConfirmation = paymentConfirmation !== undefined && ownsPaymentResult(paymentConfirmation.context) ? paymentConfirmation : undefined
  const activeRecovery = recoveryConfirmation !== undefined && ownsPaymentResult(recoveryConfirmation.context) ? recoveryConfirmation : undefined
  const paymentFocus = useWorkspaceConfirmation({ open: activeConfirmation !== undefined, pending: confirm.isPending, disabled: paymentCollectionBlocked, scope: draftKey, onCancel: () => setPaymentConfirmation(undefined) })
  const recoveryFocus = useWorkspaceConfirmation({ open: activeRecovery !== undefined, pending: recover.isPending, disabled: paymentWriteBlocked, scope: draftKey, onCancel: () => setRecoveryConfirmation(undefined) })
  const actionReason = paymentWriteBlocked ? (locale === 'zh-CN' ? '正在办理或等待恢复原操作' : 'Resolve the current operation first')
    : selectedCharge === undefined ? messages.noBillingItems
      : status === 'ambiguous' || selectedCharge.status === 'ambiguous' ? unknownAttempt === undefined
        ? (locale === 'zh-CN' ? '在支付尝试记录中翻页查找原尝试，再查询结果。' : 'Find the original attempt in payment history before querying its result.') : messages.recoverPaymentDescription
        : status === 'paid' ? (locale === 'zh-CN' ? '本项费用已缴清' : 'This charge is paid')
          : selectedCharge.status === 'cancelled' ? (locale === 'zh-CN' ? '已取消，请按原交易办理退款' : 'Cancelled; refund the original payment')
            : currentPreview === undefined ? messages.installmentHint : messages.confirmPaymentDescription
  const action = unknownAttempt?.kind === 'multi-charge' ? <Button disabled={paymentWriteBlocked} onClick={() => { void recoverOriginal(unknownAttempt.paymentId).catch(() => undefined) }}>{locale === 'zh-CN' ? '查询原合并收款' : 'Query original combined payment'}</Button>
    : unknownAttempt !== undefined ? <Button ref={recoveryFocus.triggerRef} disabled={paymentWriteBlocked} onClick={() => { recoveryFocus.captureTrigger(); setRecoveryConfirmation(recoverSubmission(unknownAttempt.paymentId)) }}>{messages.recoverPayment}</Button>
    : status === 'ambiguous' ? <Button className="disabled:border disabled:border-dashed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100" disabled>{messages.recoverPayment}</Button>
      : selectedCharge === undefined ? <Button className="disabled:border disabled:border-dashed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100" disabled>{messages.previewPayment}</Button>
        : status === 'paid' ? <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" onClick={() => window.print?.()}>{locale === 'zh-CN' ? '打印收费凭条' : 'Print receipt'}</Button><Button type="button" onClick={() => changeStatus('pending')}>{locale === 'zh-CN' ? '返回待缴队列' : 'Back to pending queue'}</Button></div>
          : selectedCharge.status === 'cancelled' ? undefined
      : currentPreview === undefined ? <Button className="disabled:border disabled:border-dashed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100" disabled={paymentCollectionBlocked || tenderErrors.size > 0} onClick={() => preview.mutate(previewSubmission())}>{messages.previewPayment}</Button>
        : <><Button className="disabled:border-dashed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100" variant="outline" disabled={paymentCollectionBlocked || tenderErrors.size > 0} onClick={() => preview.mutate(previewSubmission())}>{messages.previewPayment}</Button>
          <Button ref={paymentFocus.triggerRef} disabled={paymentCollectionBlocked} onClick={() => { paymentFocus.captureTrigger(); setPaymentConfirmation(confirmSubmission()); confirm.reset() }}><CheckCircleIcon data-icon="inline-start" />{messages.confirmPayment}</Button></>
  const queuePanel = (
      <section aria-labelledby="billing-queue-heading" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspaceQueueCard className="flex-1" title={<div className="flex w-full items-center justify-between gap-2"><h2 id="billing-queue-heading">{messages.billingQueue}</h2><Badge variant="secondary" className="tabular-nums">{queue.isError ? '—' : (queue.data?.total ?? 0)}</Badge></div>}><div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-wrap gap-2 [&>[data-slot=select-trigger]]:w-auto [&>[data-slot=select-trigger]]:max-w-full [&>[data-slot=select-trigger]]:flex-auto"><WorkspaceModeSwitch presentation="select" />
        <WorkspaceSelect id="billing-category-filter" ariaLabel={locale === 'zh-CN' ? '费用类别' : 'Charge category'} disabled={paymentPending} value={category} onValueChange={value => { if (value !== null) changeCategory(value as BillingCategory) }} items={[
          { value: 'laboratory', label: messages.laboratoryCharges }, { value: 'imaging', label: messages.imagingCharges },
          { value: 'pathology', label: messages.pathologyCharges }, { value: 'medication', label: messages.medicationCharges },
        ]} /></div>
        <Tabs onValueChange={value => changeStatus(value as BillingStatus)} value={status}>
          <TabsList className="h-auto! w-full items-stretch">
            <TabsTrigger disabled={paymentPending} className="h-auto min-h-8 min-w-0 flex-auto px-0.5 leading-snug wrap-anywhere whitespace-normal" value="pending">{messages.pendingPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="h-auto min-h-8 min-w-0 flex-auto px-0.5 leading-snug wrap-anywhere whitespace-normal" value="paid">{messages.paidPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="h-auto min-h-8 min-w-0 flex-auto px-0.5 leading-snug wrap-anywhere whitespace-normal" value="declined">{messages.declinedPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="h-auto min-h-8 min-w-0 flex-auto px-0.5 leading-snug wrap-anywhere whitespace-normal" value="ambiguous">{messages.ambiguousPayment}</TabsTrigger>
          </TabsList>
        </Tabs>
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <PaymentError
            action={<Button size="sm" variant="outline" onClick={() => void queue.refetch()}>{locale === 'zh-CN' ? '重试读取收费队列' : 'Retry billing queue'}</Button>}
            message={getWorkspaceErrorMessage(queue.error, messages)}
            title={getWorkspaceErrorTitle(queue.error, messages, messages.paymentUnavailable)}
          />
        ) : queue.data.items.length === 0 ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ReceiptTextIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noBillingItems}</EmptyTitle>
              <EmptyDescription>{messages.noBillingItemsDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div data-workspace-queue-items="" className="flex flex-col gap-2" role="list">
            {queue.data.items.map(item => (
              <ChargeRow
                disabled={paymentPending}
                item={item}
                key={item.chargeItemId}
                locale={locale}
                messages={messages}
                onSelect={() => selectCharge(item.chargeItemId)}
                selected={item.chargeItemId === selectedCharge?.chargeItemId}
              />
            ))}
          </div>
        )}
        {queue.data === undefined || queue.data.items.length === 0 ? null : (
            <PaginationControls
              disabled={paymentPending}
              messages={messages}
              onPageChange={(nextPage) => {
                if (paymentPending) return
                setPage(nextPage)
                setSelectedChargeId(undefined)
                clearPayment()
              }}
              page={queue.data.page}
              pageSize={queue.data.pageSize}
              total={queue.data.total}
            />
        )}
      </div></WorkspaceQueueCard></section>
  )
  const paymentPanel = (
      <section aria-label={messages.paymentDetails} className="@container/payment-details flex min-w-0 flex-col gap-5">
        <WorkspaceCard>
        {confirm.isSuccess && displaysPaymentResult(paymentContexts.current.confirm) ? <PaymentOutcome outcome={confirm.data.data.outcome} locale={locale} messages={messages} />
          : recover.isSuccess && displaysPaymentResult(paymentContexts.current.recover) ? <PaymentOutcome outcome={recover.data.data.outcome} locale={locale} messages={messages} />
          : selectedCharge !== undefined && (status === 'declined' || selectedCharge.status === 'declined') ? <PaymentOutcome outcome="declined" locale={locale} messages={messages} /> : null}
        {recover.isError && displaysPaymentResult(paymentContexts.current.recover) ? <PaymentError message={getWorkspaceErrorMessage(recover.error, messages)} title={messages.operationFailed} /> : null}
        {selectedCharge === undefined ? (
          <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><CreditCardIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noBillingItems}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <div data-billing-receipt={status === 'paid' || selectedCharge.status === 'paid' ? '' : undefined} className="flex flex-col gap-5">
            <ol aria-label={locale === 'zh-CN' ? '收费办理步骤' : 'Billing workflow steps'} className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-2 text-xs sm:grid-cols-4">
              <li className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium ${status === 'paid' || selectedCharge.status === 'paid' ? 'text-emerald-700 dark:text-emerald-300' : currentPreview === undefined ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
                <span>{status === 'paid' || selectedCharge.status === 'paid' || currentPreview !== undefined ? '✓' : '①'} {locale === 'zh-CN' ? '核对项目与结算方式' : 'Verify items & settlement'}</span>
              </li>
              <li className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium ${status === 'paid' || selectedCharge.status === 'paid' ? 'text-emerald-700 dark:text-emerald-300' : currentPreview !== undefined && activeConfirmation === undefined ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
                <span>{status === 'paid' || selectedCharge.status === 'paid' || activeConfirmation !== undefined ? '✓' : '②'} {locale === 'zh-CN' ? '预审锁价' : 'Preview & lock price'}</span>
              </li>
              <li className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium ${status === 'paid' || selectedCharge.status === 'paid' ? 'text-emerald-700 dark:text-emerald-300' : activeConfirmation !== undefined ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
                <span>{status === 'paid' || selectedCharge.status === 'paid' ? '✓' : '③'} {locale === 'zh-CN' ? '确认实收' : 'Confirm collection'}</span>
              </li>
              <li className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium ${status === 'paid' || selectedCharge.status === 'paid' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
                <span>{status === 'paid' || selectedCharge.status === 'paid' ? '✓' : '④'} {locale === 'zh-CN' ? '完成入账' : 'Settled'}</span>
              </li>
            </ol>
            {status === 'paid' || selectedCharge.status === 'paid' ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0 text-emerald-600" />
                <span>{locale === 'zh-CN' ? '收费结算已完成 · 缴费项目已同步至对应执行科室' : 'Settlement completed · Paid items synced to performing department'}</span>
              </div>
            ) : null}
            {status === 'ambiguous' || selectedCharge.status === 'ambiguous' || unknownAttempt !== undefined ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200">
                <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <span>{locale === 'zh-CN' ? '支付状态未明（严禁直接重收）：渠道超时未返回明确入账结果，原交易已冻结锁定，请先查询原支付尝试状态。' : 'Payment status unknown (do not re-collect): query the original payment attempt status first.'}</span>
              </div>
            ) : null}
            {bill.isPending ? <Skeleton className="h-24 w-full" /> : bill.isError ? (
              <PaymentError message={getWorkspaceErrorMessage(bill.error, messages)} title={messages.paymentUnavailable} />
            ) : bill.data === undefined ? null : (
              <div className="flex min-w-0 flex-col gap-4">
                <BillingCasePanel key={caseKey} bill={bill.data} chargeDetails={queue.isSuccess && !queue.isFetching ? queue.data.items : []} locale={locale} messages={messages} onRefresh={refreshBilling} />
                <BillingMultiChargePanel key={`multi:${caseKey}`} bill={bill.data} session={session} locale={locale} blocked={paymentWriteBlocked || bill.isFetching} onRefresh={refreshBilling} onOutcome={multiPaymentOutcome} />
              </div>
            )}
            {selectedCharge.status === 'cancelled' ? <p className="text-sm">{locale === 'zh-CN' ? '已取消，原付款由收费员按原交易退款。' : 'Cancelled. The cashier refunds the original payments through their original transactions.'}</p> : null}
          </div>
        )}
      </WorkspaceCard>
      {selectedCharge !== undefined && selectedCharge.status !== 'cancelled' && (status === 'pending' || status === 'declined') ? (
        <WorkspaceCard>
          <div className="flex flex-col gap-5">
            <FieldGroup className="grid min-w-0 grid-cols-1 gap-3 @min-[18rem]/payment-details:grid-cols-2 @min-[38rem]/payment-details:grid-cols-4">
              <div className="col-span-full flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{messages.paymentMethods}</h3>
                <span className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '留空默认按整笔未收金额收款；填写多分项可办理组合支付' : 'Leave blank to collect full remaining balance; fill multiple fields for split tender'}</span>
              </div>
              {(['cash', 'bank-card', 'mobile'] as const).map(method => (
                <Field key={method} data-invalid={tenderErrors.has(method) || undefined}>
                  <FieldLabel htmlFor={`payment-${method}`}>{paymentMethodLabel(method, messages)}</FieldLabel>
                  <Input aria-invalid={tenderErrors.has(method) || undefined} aria-describedby={tenderErrors.has(method) ? `payment-${method}-error` : undefined} disabled={paymentPending} id={`payment-${method}`} inputMode="decimal" placeholder="0.00" value={tenderAmounts[method] ?? ''} onInput={event => {
                    const value = event.currentTarget.value
                    setTenderAmounts(current => ({ ...current, [method]: value }))
                    preview.reset()
                    setPaymentConfirmation(undefined)
                  }} />
                  {tenderErrors.has(method) ? <FieldError id={`payment-${method}-error`}>{messages.invalidPaymentAmount}</FieldError> : null}
                </Field>
              ))}
              <Field>
                <FieldLabel htmlFor="payment-simulator-rule">{messages.paymentSimulatorRule}</FieldLabel>
                <WorkspaceSelect
                  disabled={paymentPending}
                  id="payment-simulator-rule"
                  items={simulatorItems}
                  onValueChange={value => {
                    setSimulatorRule(value as SimulatorRule)
                    preview.reset()
                    setPaymentConfirmation(undefined)
                  }}
                  value={simulatorRule}
                />
              </Field>

              {preview.isError && displaysPaymentResult(paymentContexts.current.preview) ? <div className="col-span-full"><PaymentError message={getWorkspaceErrorMessage(preview.error, messages)} title={getWorkspaceErrorTitle(preview.error, messages, messages.operationFailed)} /></div> : null}
            </FieldGroup>
            {preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge.chargeItemId || !displaysPaymentResult(paymentContexts.current.preview) ? null : (
              <section aria-labelledby="payment-preview-heading" className="flex flex-col gap-3 border-t pt-5">
                <h3 className="text-sm font-semibold" id="payment-preview-heading">{messages.paymentPreview}</h3>
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">{messages.amount}</dt><dd className="font-medium tabular-nums">{formatFen(preview.data.data.amountFen, locale)}</dd></div>
                  <div><dt className="text-muted-foreground">{messages.expectedOutcome}</dt><dd className="font-medium">{expectedOutcomeLabel(preview.data.data.expectedOutcome, messages)}</dd></div>
                  <div><dt className="text-muted-foreground">{messages.paymentChannel}</dt><dd className="font-medium">{messages.syntheticPaymentChannel}</dd></div>
                  {preview.data.data.tenders?.map(tender => <div key={tender.method}><dt className="text-muted-foreground">{paymentMethodLabel(tender.method, messages)}</dt><dd className="tabular-nums">{formatFen(tender.amountFen, locale)}</dd></div>)}
                </dl>
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-semibold">{messages.paymentAllocations}</h4>
                  <Table>
                    <TableHeader><TableRow><TableHead>{messages.chargeItem}</TableHead><TableHead className="text-right">{messages.amount}</TableHead></TableRow></TableHeader>
                    <TableBody>{preview.data.data.allocations.map(allocation => (
                      <TableRow key={allocation.chargeItemId}>
                        <TableCell className="font-medium">{allocation.chargeItemId === selectedCharge.chargeItemId
                          ? selectedChargeDescription
                          : (locale === 'zh-CN' ? '其他费用项目' : 'Other charge')}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatFen(allocation.amountFen, locale)}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </div>
              </section>
            )}
          </div>
        </WorkspaceCard>
      ) : null}
      </section>
  )
  const flowOverrides = selectedCharge
    ? {
        registration: 'completed' as const,
        triage: 'completed' as const,
        consultation: 'completed' as const,
        billing: selectedCharge.status === 'paid' || status === 'paid' ? ('completed' as const) : ('current' as const),
      }
    : {}
  return <WorkspaceCardLayout id="billing-workspace" locale={locale} flow={outpatientFlow(locale, flowOverrides)} queue={queuePanel}
    patient={selectedCharge === undefined ? undefined : <><WorkspaceHeaderPatient>{selectedCharge.patient.name}</WorkspaceHeaderPatient><section aria-label={locale === 'zh-CN' ? '当前收费患者' : 'Current billing patient'} className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-base font-semibold">{selectedCharge.patient.name}</h2>
        <Badge variant={status === 'paid' || selectedCharge.status === 'paid' ? 'secondary' : status === 'declined' || selectedCharge.status === 'declined' ? 'destructive' : 'outline'}>
          {status === 'paid' || selectedCharge.status === 'paid' ? messages.paidPayment : status === 'declined' || selectedCharge.status === 'declined' ? (locale === 'zh-CN' ? '已拒 · 待重收' : messages.declinedPayment) : status === 'ambiguous' || selectedCharge.status === 'ambiguous' ? messages.ambiguousPayment : messages.pendingPayment}
        </Badge>
        {status === 'declined' || selectedCharge.status === 'declined' ? <Badge variant="outline">{locale === 'zh-CN' ? '未扣款' : 'No charge'}</Badge> : null}
        <p className="text-sm text-muted-foreground">{selectedChargeDescription}</p>
      </div>
      <p className="ml-auto inline-flex shrink-0 items-baseline gap-2 tabular-nums"><span className="text-sm text-muted-foreground">{status === 'paid' || selectedCharge.status === 'paid' ? messages.paidAmount : (locale === 'zh-CN' ? '本次应收' : 'Amount due')}</span><strong className="text-lg font-semibold">{bill.data === undefined ? formatFen(selectedCharge.amountFen, locale) : formatFen(status === 'paid' || selectedCharge.status === 'paid' ? outpatientBillTotals(bill.data).paid : outpatientBillTotals(bill.data).remaining, locale)}</strong></p>
    </section></>}
    action={activeRecovery !== undefined ? <section role="region" aria-label={messages.recoverPayment}><WorkspaceActionBar tone="confirm" onKeyDown={recoveryFocus.onKeyDown}
      busy={recover.isPending ? (locale === 'zh-CN' ? '正在查询支付结果' : 'Checking payment result') : undefined}
      summary={messages.recoverPayment} reason={messages.recoverPaymentDescription}
      action={<><Button variant="outline" disabled={recover.isPending} onClick={() => setRecoveryConfirmation(undefined)}>{messages.cancel}</Button>
        <Button ref={recoveryFocus.confirmRef} disabled={paymentWriteBlocked} onClick={() => recover.mutate(activeRecovery)}>{messages.recoverPayment}</Button></>} /></section>
      : activeConfirmation === undefined ? (selectedCharge === undefined && !confirm.isSuccess && !recover.isSuccess ? undefined : <WorkspaceActionBar summary={selectedCharge?.patient.name} reason={actionReason} action={action}
      tone={status === 'paid' ? 'complete' : paymentCollectionBlocked ? 'blocked' : 'normal'} />)
      : <section role="region" aria-label={messages.confirmPaymentTitle}><WorkspaceActionBar tone="confirm" onKeyDown={paymentFocus.onKeyDown}
        busy={confirm.isPending ? (locale === 'zh-CN' ? '正在收款' : 'Collecting payment') : undefined}
        summary={formatFen(activeConfirmation.amountFen, locale)} reason={messages.confirmPaymentDescription}
        action={<><Button variant="outline" disabled={confirm.isPending} onClick={() => setPaymentConfirmation(undefined)}>{messages.cancel}</Button>
          <Button ref={paymentFocus.confirmRef} disabled={paymentCollectionBlocked} onClick={() => confirm.mutate(activeConfirmation)}>{messages.submitPayment}</Button></>} /></section>}>
      {refundWrite.pending === null ? null : <Alert className="xl:col-span-2"><AlertTitle>{locale === 'zh-CN' ? '原操作结果待确认' : 'Original operation awaiting confirmation'}</AlertTitle><AlertDescription>
        <p>{locale === 'zh-CN' ? '已保留原输入和幂等键；先恢复原操作，再办理新的收退款。' : 'The original input and key are saved. Resolve the original operation before another collection or refund.'}</p>
        {pendingRefund ? <Button disabled={refundWrite.mutation.isPending} onClick={() => refundWrite.mutation.mutate(undefined)} variant="outline">{locale === 'zh-CN' ? '恢复原费用操作' : 'Recover original billing operation'}</Button> : null}
        {refundWrite.pending.command.operation === 'payment.multi-charge.confirm' || refundWrite.pending.command.operation === 'payment.multi-charge.recover'
          ? <Button disabled={refundWrite.mutation.isPending || refundWrite.storageFailure !== null} onClick={() => refundWrite.mutation.mutate(undefined)} variant="outline">{locale === 'zh-CN' ? '查询原合并收款操作' : 'Recover original payment command'}</Button> : null}
        {!unreadableCollectedDraft ? null : <div className="flex flex-col gap-2">
          <p>{locale === 'zh-CN' ? '原收款已查明成功，原患者私稿无法读取。可恢复存储后重试查询，或明确丢弃该私稿并完成恢复。' : 'The original collection succeeded, but its private draft cannot be read. Restore storage and retry, or explicitly discard that draft to finish recovery.'}</p>
          {discardingRecoveredDraft !== refundWrite.pending.idempotencyKey
            ? <Button variant="outline" disabled={refundWrite.mutation.isPending} onClick={() => setDiscardingRecoveredDraft(refundWrite.pending?.idempotencyKey)}>{locale === 'zh-CN' ? '丢弃不可读原私稿' : 'Discard unreadable original draft'}</Button>
            : <><p>{locale === 'zh-CN' ? '将丢弃原收款所属患者的整份未提交多费用私稿，包括尚未收款项目的选择和付款输入。再次查询原回执确认成功后才清除；不会再次收款。' : 'This removes the original patient’s entire unsubmitted multi-charge draft, including remaining selections and tender inputs. The original receipt must prove success again before removal; no new payment is collected.'}</p>
              <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={refundWrite.mutation.isPending} onClick={() => setDiscardingRecoveredDraft(undefined)}>{messages.cancel}</Button>
                <Button disabled={refundWrite.mutation.isPending || refundWrite.storageFailure !== null} onClick={() => {
                  const intent = refundWrite.pending
                  if (!intent || (intent.command.operation !== 'payment.multi-charge.confirm' && intent.command.operation !== 'payment.multi-charge.recover')) return
                  refundWrite.mutation.mutate({ ...intent.command, idempotencyKey: intent.idempotencyKey, recoverOriginal: true, discardUnreadMultiChargeDraft: true })
                  setDiscardingRecoveredDraft(undefined)
                }}>{locale === 'zh-CN' ? '确认丢弃原私稿并完成恢复' : 'Confirm original draft discard and finish recovery'}</Button></div></>}
        </div>}
      </AlertDescription></Alert>}
      {refundError === null ? null : <div className="xl:col-span-2"><PaymentError message={getWorkspaceErrorMessage(refundError, messages)} title={messages.operationFailed} /></div>}
      {visibleMultiOutcome === undefined ? null : <Alert className="xl:col-span-2"><AlertTitle>{visibleMultiOutcome.outcome === 'success' ? (locale === 'zh-CN' ? '合并收款成功' : 'Combined payment succeeded')
        : visibleMultiOutcome.outcome === 'declined' ? (locale === 'zh-CN' ? '合并收款未成功' : 'Combined payment declined') : (locale === 'zh-CN' ? '合并收款结果待确认' : 'Combined payment result unknown')}</AlertTitle>
        <AlertDescription>{formatFen(visibleMultiOutcome.amountFen, locale)}</AlertDescription></Alert>}

    {confirm.isError && displaysPaymentResult(paymentContexts.current.confirm) ? <PaymentError message={getWorkspaceErrorMessage(confirm.error, messages)} title={getWorkspaceErrorTitle(confirm.error, messages, messages.operationFailed)} /> : null}
    {paymentPanel}
    <div data-billing-non-receipt="" className="flex min-w-0 flex-wrap items-start gap-2">
    {bill.data === undefined || (status !== 'paid' && selectedCharge?.status !== 'paid' && outpatientBillTotals(bill.data).paid === 0 && frozenRefund === undefined && !pendingRefundForCase) ? null : <RefundDisclosure key={caseKey} label={locale === 'zh-CN' ? '费用更正与退款' : 'Fee corrections and refunds'} attention={frozenRefund?.preview.previewId ?? (pendingRefundForCase ? 'pending' : undefined)}><BillingRefundPanel key={`refund:${caseKey}`} bill={bill.data} session={session} locale={locale} disabled={paymentPending} onChanged={refreshBilling}
      frozen={frozenRefund} onFrozenChange={setRefundPreview} /></RefundDisclosure>}
    {selectedCharge === undefined ? null : <details className="min-w-0 rounded-md border px-3 py-2 open:basis-full"><summary className="cursor-pointer text-sm font-medium">{locale === 'zh-CN' ? '医保待遇' : 'Insurance'}</summary><div className="mt-4"><InsurancePanel key={agentViewRevision({session,target:selectedCharge.caseId})} target={{kind:'outpatient',id:selectedCharge.caseId}} session={session} locale={locale} disabled={paymentPending} onChanged={insuranceChanged}/></div></details>}
    {caseId === undefined ? undefined : <details className="min-w-0 rounded-md border px-3 py-2 open:basis-full"><summary className="cursor-pointer text-sm font-medium">{messages.paymentHistory}</summary><div className="mt-4">
      {bill.isPending ? <Skeleton className="h-32 w-full" /> : bill.isError ? <PaymentError action={<Button size="sm" variant="outline" onClick={() => void bill.refetch()}>{messages.refreshBill}</Button>} message={getWorkspaceErrorMessage(bill.error, messages)} title={messages.paymentUnavailable} />
        : bill.data === undefined ? null : <BillingPaymentHistory key={caseKey} bill={bill.data} locale={locale} messages={messages} onPageChange={changeHistoryPage} onRecover={recoverOriginal} recovering={paymentPending} />}
    </div></details>}
    </div>
  </WorkspaceCardLayout>
}

/** 恢复的审阅先可见再由子表单接收焦点；操作结束保留用户展开状态。 */
function RefundDisclosure({ attention, children, label }: { attention: string | undefined; children: ReactNode; label: string }) {
  const [open, setOpen] = useState(attention !== undefined)
  const [previousAttention, setPreviousAttention] = useState(attention)
  if (previousAttention !== attention) {
    setPreviousAttention(attention)
    if (attention !== undefined) setOpen(true)
  }
  return <details className="min-w-0 rounded-md border px-3 py-2 open:basis-full" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">{label}</summary><div className="mt-4">{children}</div>
  </details>
}

function billingString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Billing Agent input must be an object')
  }
  const candidate = (value as Record<string, unknown>)[key]
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new TypeError(`${key} must be a non-empty string`)
  }
  return candidate.trim()
}

function paymentQueueStatus(payment: { outcome: 'success' | 'declined' | 'ambiguous'; status: string; remainingFen?: number | undefined }): BillingStatus {
  if (payment.outcome !== 'success') return payment.outcome
  if (payment.remainingFen !== undefined) return payment.remainingFen === 0 ? 'paid' : 'pending'
  return ['awaiting-lis', 'awaiting-dispense'].includes(payment.status) ? 'paid' : 'pending'
}

function ChargeRow({ disabled, item, locale, messages, onSelect, selected }: {
  disabled: boolean
  item: BillingQueueItem
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button disabled={disabled} data-agent-selection={item.chargeItemId} aria-label={`${messages.selectCharge} ${item.patient.name}`} className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left" onClick={onSelect} role="listitem" type="button" variant={selected ? 'secondary' : 'outline'}>
      <span className="min-w-0"><span className="block truncate font-medium">{item.patient.name}</span><span className="block truncate text-xs text-muted-foreground">{locale === 'zh-CN' ? item.descriptionZh : item.descriptionEn}</span></span>
      <span className="shrink-0 font-semibold">{formatFen(item.amountFen, locale)}</span>
    </Button>
  )
}

function PaymentOutcome({ outcome, locale, messages }: {
  outcome: 'ambiguous' | 'declined' | 'success'
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  const title = outcome === 'success'
    ? messages.paymentSuccess
    : outcome === 'declined' ? messages.paymentDeclined : messages.paymentAmbiguousResult
  return (
    <Alert variant={outcome === 'success' ? 'default' : 'destructive'}>
      {outcome === 'success' ? <CheckCircleIcon aria-hidden="true" /> : <CircleAlertIcon aria-hidden="true" />}
      <AlertTitle>{title}</AlertTitle>
      {outcome === 'declined' ? <AlertDescription>{locale === 'zh-CN' ? '支付渠道返回拒绝交易（卡内余额不足或超出单笔限额），未产生扣款记录，请更换支付方式或重新发起。' : 'Payment channel declined the transaction. No funds were deducted; choose another tender or retry.'}</AlertDescription> : null}
    </Alert>
  )
}

function PaymentError({ action, message, title }: { action?: ReactNode; message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        {action}
      </AlertDescription>
    </Alert>
  )
}

function expectedOutcomeLabel(
  outcome: 'ambiguous' | 'declined' | 'success',
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (outcome === 'success') return messages.outcomeSuccess
  if (outcome === 'declined') return messages.outcomeDeclined
  return messages.outcomeAmbiguous
}
