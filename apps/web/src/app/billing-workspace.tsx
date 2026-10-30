import { InsurancePanel } from './insurance-panel.tsx'
import type { BillingQueueItem, SessionContext } from '@clinmesh/contracts/his'
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirmPayment, getBillingCase, getBillingQueue, newIdempotencyKey, previewPayment, recoverPayment } from './api-client.ts'
import { BillingCasePanel, BillingChargeOrigin, BillingPaymentHistory, paymentMethodLabel } from './billing-case-panel.tsx'
import { BillingRefundPanel, type FrozenRefund } from './billing-refund-panel.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspacePatientCard, WorkspaceQueueCard, useWorkspaceCardView, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
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
  const refundScope = agentViewRevision({ accountId: session.user.id, actor: session.actor })
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
  const historyRevision = useRef(0)
  const paymentInFlight = useRef(false)
  const [selectedChargeId, setSelectedChargeId] = useState<string>()
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, PaymentDraft>>({})
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
  const caseKey = agentViewRevision({ scope, caseId })
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
  const selectionRevision = useRef(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const latestView = useRef('')
  latestView.current = agentViewRevision({ scope, category, status, page, chargeItemId: selectedCharge?.chargeItemId })
  const paymentMutationContext = () => ({
    chargeItemId: selectedCharge?.chargeItemId,
    identity: latestView.current,
    revision: selectionRevision.current,
    scope: agentViewRevision({ scope }),
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
  const displaysPaymentResult = (context: ReturnType<typeof paymentMutationContext> | undefined) =>
    context?.chargeItemId !== undefined && context.chargeItemId === selectedCharge?.chargeItemId
      && context.scope === agentViewRevision({ scope }) && context.revision === selectionRevision.current
  const refreshBilling = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['billing-queue', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['billing-case', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['billing-refunds', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['pharmacy-queue', ...scope] }),
    ])
  },[queryClient,session.actor.workspaceId,session.actor.epoch])
  const refundWrite = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'refund.preview') setRefundPreview(command.caseId, {
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
      if (refundWrite.blocked) throw new Error(messages.paymentUnavailable)
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
      if (refundWrite.blocked) throw new Error(messages.paymentUnavailable)
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
      if (refundWrite.blocked) throw new Error(messages.paymentUnavailable)
      return confirmPayment(submission.input, `payment-confirm:${submission.input.previewId}`)
    },
    onSuccess: (response, submission, context) => {
      if (!ownsPaymentResult(context)) return
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
  },[preview.reset,confirm.reset,recover.reset,draftKey])
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
  const unknownAttempt = bill.data?.payments.find(payment => payment.chargeItemId === selectedCharge?.chargeItemId && payment.outcome === 'ambiguous')
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
    if (paymentCollectionBlocked || preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge?.chargeItemId) throw new Error(messages.paymentUnavailable)
    const value = preview.data.data
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
  const recoverOriginal = (paymentId: string) => recover.mutateAsync(recoverSubmission(paymentId))

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
        enabled: !paymentWriteBlocked && unknownAttempt !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (paymentWriteBlocked || unknownAttempt === undefined) throw new Error(messages.paymentUnavailable)
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
        enabled: !paymentCollectionBlocked && preview.data?.data.chargeItemId === selectedCharge?.chargeItemId && preview.data !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (paymentCollectionBlocked || preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge?.chargeItemId) throw new Error(messages.paymentUnavailable)
          const submission = confirmSubmission()
          const frozen = preview.data.data
          const amountFen = preview.data.data.amountFen
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
        category,
        page,
        paymentPage,
        previewId: preview.data?.data.previewId,
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
      preview: preview.data?.data ?? null,
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
    preview.data,
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

  const currentPreview = selectedCharge?.status !== 'cancelled' && preview.data?.data.chargeItemId === selectedCharge?.chargeItemId
    && displaysPaymentResult(paymentContexts.current.preview) ? preview.data?.data : undefined
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
  const action = unknownAttempt !== undefined ? <Button ref={recoveryFocus.triggerRef} disabled={paymentWriteBlocked} onClick={() => { recoveryFocus.captureTrigger(); setRecoveryConfirmation(recoverSubmission(unknownAttempt.paymentId)) }}>{messages.recoverPayment}</Button>
    : status === 'ambiguous' ? <Button disabled>{messages.recoverPayment}</Button>
      : selectedCharge === undefined ? <Button disabled>{messages.previewPayment}</Button>
        : status === 'paid' || selectedCharge.status === 'cancelled' ? undefined
      : currentPreview === undefined ? <Button disabled={paymentCollectionBlocked || tenderErrors.size > 0} onClick={() => preview.mutate(previewSubmission())}><CreditCardIcon data-icon="inline-start" />{messages.previewPayment}</Button>
        : <><Button variant="outline" disabled={paymentCollectionBlocked || tenderErrors.size > 0} onClick={() => preview.mutate(previewSubmission())}>{messages.previewPayment}</Button>
          <Button ref={paymentFocus.triggerRef} disabled={paymentCollectionBlocked} onClick={() => { paymentFocus.captureTrigger(); setPaymentConfirmation(confirmSubmission()); confirm.reset() }}><CheckCircleIcon data-icon="inline-start" />{messages.confirmPayment}</Button></>
  const queuePanel = (
      <section aria-labelledby="billing-queue-heading" className="min-w-0">
        <WorkspaceQueueCard title={<h2 id="billing-queue-heading">{messages.billingQueue}</h2>}><div className="flex flex-col gap-4"><WorkspaceModeSwitch />
        <div className="flex items-center justify-end gap-2">
          <Badge variant="secondary">{queue.data?.total ?? 0}</Badge>
        </div>
        <Tabs onValueChange={value => changeCategory(value as BillingCategory)} value={category}>
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1">
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="laboratory">{messages.laboratoryCharges}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="imaging">{messages.imagingCharges}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="pathology">{messages.pathologyCharges}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="medication">{messages.medicationCharges}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs onValueChange={value => changeStatus(value as BillingStatus)} value={status}>
          <TabsList className="grid h-auto w-full grid-cols-2">
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="pending">{messages.pendingPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="paid">{messages.paidPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="declined">{messages.declinedPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="ambiguous">{messages.ambiguousPayment}</TabsTrigger>
          </TabsList>
        </Tabs>
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <><PaymentError message={getWorkspaceErrorMessage(queue.error, messages)} title={getWorkspaceErrorTitle(queue.error, messages, messages.paymentUnavailable)} /><Button variant="outline" onClick={() => void queue.refetch()}>{locale === 'zh-CN' ? '重试读取收费队列' : 'Retry billing queue'}</Button></>
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
      <section aria-labelledby="payment-details-heading" className="flex min-w-0 flex-col gap-5">
        <WorkspaceCard title={<h2 id="payment-details-heading">{messages.paymentDetails}</h2>}>
        {confirm.isSuccess && displaysPaymentResult(paymentContexts.current.confirm) ? <PaymentOutcome outcome={confirm.data.data.outcome} messages={messages} /> : null}
        {recover.isSuccess && displaysPaymentResult(paymentContexts.current.recover) ? <PaymentOutcome outcome={recover.data.data.outcome} messages={messages} /> : null}
        {recover.isError && displaysPaymentResult(paymentContexts.current.recover) ? <PaymentError message={getWorkspaceErrorMessage(recover.error, messages)} title={messages.operationFailed} /> : null}
        {selectedCharge === undefined ? (
          <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><CreditCardIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noBillingItems}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <div className="flex flex-col gap-5">
            {bill.isPending ? <Skeleton className="h-24 w-full" /> : bill.isError ? (
              <PaymentError message={getWorkspaceErrorMessage(bill.error, messages)} title={messages.paymentUnavailable} />
            ) : bill.data === undefined ? null : (
              <BillingCasePanel key={caseKey} bill={bill.data} locale={locale} messages={messages} onRefresh={refreshBilling} />
            )}
            <section aria-label={locale === 'zh-CN' ? '当前费用来源' : 'Selected charge origin'}>
              <BillingChargeOrigin charge={selectedCharge} locale={locale} />
            </section>
            <Table>
              <TableHeader><TableRow><TableHead>{messages.chargeItem}</TableHead><TableHead>{messages.quantity}</TableHead><TableHead>{messages.unitPrice}</TableHead><TableHead>{messages.subtotal}</TableHead></TableRow></TableHeader>
              <TableBody>{selectedCharge.lines.map(line => (
                <TableRow key={line.sourceReference}>
                  <TableCell className="font-medium">{locale === 'zh-CN' ? line.descriptionZh : line.descriptionEn}<p className="mt-1 break-all text-xs font-normal text-muted-foreground">{line.sourceReference}</p></TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{formatFen(line.unitPriceFen, locale)}</TableCell>
                  <TableCell>{formatFen(line.subtotalFen, locale)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
            {selectedCharge.status === 'cancelled' ? <p className="text-sm">{locale === 'zh-CN' ? '已取消，原付款由收费员按原交易退款。' : 'Cancelled. The cashier refunds the original payments through their original transactions.'}</p> : null}
            {selectedCharge.status !== 'cancelled' && (status === 'pending' || status === 'declined') ? (
              <FieldGroup>
                <p className="text-sm text-muted-foreground">{messages.installmentHint}</p>
                <h3 className="text-sm font-semibold">{messages.paymentMethods}</h3>
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

                {preview.isError && displaysPaymentResult(paymentContexts.current.preview) ? <PaymentError message={getWorkspaceErrorMessage(preview.error, messages)} title={getWorkspaceErrorTitle(preview.error, messages, messages.operationFailed)} /> : null}
              </FieldGroup>
            ) : null}
            {selectedCharge.status === 'cancelled' || preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge.chargeItemId || !displaysPaymentResult(paymentContexts.current.preview) ? null : (
              <section aria-labelledby="payment-preview-heading" className="flex flex-col gap-3 border-t pt-5">
                <h3 className="text-sm font-semibold" id="payment-preview-heading">{messages.paymentPreview}</h3>
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">{messages.amount}</dt><dd className="font-medium">{formatFen(preview.data.data.amountFen, locale)}</dd></div>
                  <div><dt className="text-muted-foreground">{messages.expectedOutcome}</dt><dd className="font-medium">{expectedOutcomeLabel(preview.data.data.expectedOutcome, messages)}</dd></div>
                  <div><dt className="text-muted-foreground">{messages.paymentChannel}</dt><dd className="font-medium">{messages.syntheticPaymentChannel}</dd></div>
                  {preview.data.data.tenders?.map(tender => <div key={tender.method}><dt className="text-muted-foreground">{paymentMethodLabel(tender.method, messages)}</dt><dd>{formatFen(tender.amountFen, locale)}</dd></div>)}
                </dl>
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-semibold">{messages.paymentAllocations}</h4>
                  <Table>
                    <TableHeader><TableRow><TableHead>{messages.chargeItem}</TableHead><TableHead>{messages.amount}</TableHead></TableRow></TableHeader>
                    <TableBody>{preview.data.data.allocations.map(allocation => (
                      <TableRow key={allocation.chargeItemId}>
                        <TableCell className="font-medium">{allocation.chargeItemId === selectedCharge.chargeItemId
                          ? selectedChargeDescription
                          : allocation.chargeItemId}</TableCell>
                        <TableCell>{formatFen(allocation.amountFen, locale)}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </div>
              </section>
            )}
          </div>
        )}
      </WorkspaceCard></section>
  )
  return <WorkspaceCardLayout id="billing-workspace" locale={locale} flow={outpatientFlow(locale, selectedCharge ? { billing: selectedCharge.status === 'paid' ? 'completed' : 'current' } : {})} queue={queuePanel}
    patient={selectedCharge === undefined ? undefined : <WorkspacePatientCard title={selectedCharge.patient.name}>
      <p className="text-sm text-muted-foreground">{selectedChargeDescription}</p>
      <p className="tabular-nums text-lg font-semibold">{formatFen(selectedCharge.amountFen, locale)}</p>
    </WorkspacePatientCard>}
    aside={caseId === undefined ? undefined : <WorkspaceCard title={messages.paymentHistory}>
      {bill.isPending ? <Skeleton className="h-32 w-full" /> : bill.isError ? <><PaymentError message={getWorkspaceErrorMessage(bill.error, messages)} title={messages.paymentUnavailable} /><Button variant="outline" onClick={() => void bill.refetch()}>{messages.refreshBill}</Button></>
        : bill.data === undefined ? null : <BillingPaymentHistory key={caseKey} bill={bill.data} locale={locale} messages={messages} onPageChange={changeHistoryPage} onRecover={recoverOriginal} recovering={paymentPending} />}
    </WorkspaceCard>}
    action={activeRecovery !== undefined ? <section role="region" aria-label={messages.recoverPayment}><WorkspaceActionBar tone="confirm" onKeyDown={recoveryFocus.onKeyDown}
      summary={activeRecovery.input.paymentId} reason={messages.recoverPaymentDescription}
      action={<><Button variant="outline" disabled={recover.isPending} onClick={() => setRecoveryConfirmation(undefined)}>{messages.cancel}</Button>
        <Button ref={recoveryFocus.confirmRef} disabled={paymentWriteBlocked} onClick={() => recover.mutate(activeRecovery)}>{messages.recoverPayment}</Button></>} /></section>
      : activeConfirmation === undefined ? <WorkspaceActionBar summary={selectedCharge?.patient.name} reason={actionReason} action={action}
      tone={status === 'paid' ? 'complete' : paymentCollectionBlocked ? 'blocked' : 'normal'} />
      : <section role="region" aria-label={messages.confirmPaymentTitle}><WorkspaceActionBar tone="confirm" onKeyDown={paymentFocus.onKeyDown}
        summary={formatFen(activeConfirmation.amountFen, locale)} reason={messages.confirmPaymentDescription}
        action={<><Button variant="outline" disabled={confirm.isPending} onClick={() => setPaymentConfirmation(undefined)}>{messages.cancel}</Button>
          <Button ref={paymentFocus.confirmRef} disabled={paymentCollectionBlocked} onClick={() => confirm.mutate(activeConfirmation)}>{messages.submitPayment}</Button></>} /></section>}>
      {refundWrite.pending === null ? null : <Alert className="xl:col-span-2"><AlertTitle>{locale === 'zh-CN' ? '原操作结果待确认' : 'Original operation awaiting confirmation'}</AlertTitle><AlertDescription>
        <p>{locale === 'zh-CN' ? '已保留原输入和幂等键；先恢复原操作，再办理新的收退款。' : 'The original input and key are saved. Resolve the original operation before another collection or refund.'}</p>
        {pendingRefund ? <Button disabled={refundWrite.mutation.isPending} onClick={() => refundWrite.mutation.mutate(undefined)} variant="outline">{locale === 'zh-CN' ? '恢复原费用操作' : 'Recover original billing operation'}</Button> : null}
      </AlertDescription></Alert>}
      {refundError === null ? null : <div className="xl:col-span-2"><PaymentError message={getWorkspaceErrorMessage(refundError, messages)} title={messages.operationFailed} /></div>}

    {confirm.isError && displaysPaymentResult(paymentContexts.current.confirm) ? <PaymentError message={getWorkspaceErrorMessage(confirm.error, messages)} title={getWorkspaceErrorTitle(confirm.error, messages, messages.operationFailed)} /> : null}
    {paymentPanel}
    {bill.data === undefined ? null : <BillingRefundPanel key={`refund:${caseKey}`} bill={bill.data} session={session} locale={locale} disabled={paymentPending} onChanged={refreshBilling}
      frozen={refundPreviews.scope === refundScope ? refundPreviews.cases.get(bill.data.caseId) : undefined} onFrozenChange={setRefundPreview} />}
    {selectedCharge === undefined ? null : <WorkspaceCard title={locale === 'zh-CN' ? '医保待遇' : 'Insurance'}><InsurancePanel key={agentViewRevision({session,target:selectedCharge.caseId})} target={{kind:'outpatient',id:selectedCharge.caseId}} session={session} locale={locale} disabled={paymentPending} onChanged={insuranceChanged}/></WorkspaceCard>}
  </WorkspaceCardLayout>
}

function parseTenderAmounts(amounts: Partial<Record<TenderMethod, string>>, errorMessage: string) {
  const tenders = (['cash', 'bank-card', 'mobile'] as const).flatMap(method => {
    const value = amounts[method]?.trim() ?? ''
    if (value === '') return []
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error(errorMessage)
    const [yuan, fraction = ''] = value.split('.')
    const amountFen = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 1_000_000_000) throw new Error(errorMessage)
    return [{ method, amountFen }]
  })
  return tenders.length === 0 ? undefined : tenders
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

function PaymentOutcome({ outcome, messages }: {
  outcome: 'ambiguous' | 'declined' | 'success'
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  const title = outcome === 'success'
    ? messages.paymentSuccess
    : outcome === 'declined' ? messages.paymentDeclined : messages.paymentAmbiguousResult
  return <Alert variant={outcome === 'success' ? 'default' : 'destructive'}><CheckCircleIcon aria-hidden="true" /><AlertTitle>{title}</AlertTitle></Alert>
}

function PaymentError({ message, title }: { message: string; title: string }): React.JSX.Element {
  return <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
}

function expectedOutcomeLabel(
  outcome: 'ambiguous' | 'declined' | 'success',
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (outcome === 'success') return messages.outcomeSuccess
  if (outcome === 'declined') return messages.outcomeDeclined
  return messages.outcomeAmbiguous
}
