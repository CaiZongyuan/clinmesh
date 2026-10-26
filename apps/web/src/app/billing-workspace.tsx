import { InsurancePanel } from './insurance-panel.tsx'
import type { BillingQueueItem, SessionContext } from '@clinmesh/contracts/his'
import { refundPreviewResponseSchema } from '@clinmesh/contracts/refunds'
import { parseAgentToolInput } from '@clinmesh/contracts/agent'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircleIcon, CircleAlertIcon, CreditCardIcon, ReceiptTextIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { confirmPayment, getBillingCase, getBillingQueue, newIdempotencyKey, previewPayment, recoverPayment } from './api-client.ts'
import { BillingCasePanel, BillingChargeOrigin, paymentMethodLabel } from './billing-case-panel.tsx'
import { BillingRefundPanel, type FrozenRefund } from './billing-refund-panel.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'

interface BillingWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

type BillingCategory = BillingQueueItem['category']
type BillingStatus = 'ambiguous' | 'declined' | 'paid' | 'pending'
type SimulatorRule = 'ambiguous' | 'ambiguous-decline' | 'ambiguous-pending' | 'decline' | 'success'
type TenderMethod = 'cash' | 'bank-card' | 'mobile'

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
  const [category, setCategory] = useState<BillingCategory>('laboratory')
  const [status, setStatus] = useState<BillingStatus>('pending')
  const [page, setPage] = useState(1)
  const [historyPage, setHistoryPage] = useState({ caseKey: '', page: 1 })
  const historyRevision = useRef(0)
  const paymentInFlight = useRef(false)
  const [paymentConfirmationOpen, setPaymentConfirmationOpen] = useState(false)
  const [simulatorRule, setSimulatorRule] = useState<SimulatorRule>('success')
  const [selectedChargeId, setSelectedChargeId] = useState<string>()
  const [tenderAmounts, setTenderAmounts] = useState<Partial<Record<TenderMethod, string>>>({})
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
  const latestView = useRef('')
  latestView.current = agentViewRevision({ scope, category, status, page, chargeItemId: selectedCharge?.chargeItemId })
  const paymentMutationContext = () => ({
    chargeItemId: selectedCharge?.chargeItemId,
    identity: latestView.current,
    revision: selectionRevision.current,
    scope: agentViewRevision({ scope }),
  })
  const paymentContexts = useRef<Partial<Record<'confirm' | 'preview' | 'recover', ReturnType<typeof paymentMutationContext>>>>({})
  const ownsPaymentResult = (context: ReturnType<typeof paymentMutationContext> | undefined) =>
    context?.identity === latestView.current && context.revision === selectionRevision.current
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
    onMutate: (paymentId: string) => {
      historyRevision.current += 1
      const attempt = bill.data?.payments.find(item => item.paymentId === paymentId)
      const charge = bill.data?.charges.find(item => item.chargeItemId === attempt?.chargeItemId)
      const context = { ...paymentMutationContext(), chargeItemId: charge?.chargeItemId, category: charge?.category }
      paymentContexts.current.recover = context
      return context
    },
    mutationFn: (paymentId: string) => {
      if (refundWrite.blocked) throw new Error(messages.paymentUnavailable)
      const attempt = bill.data?.payments.find(item => item.paymentId === paymentId)
      const charge = bill.data?.charges.find(item => item.chargeItemId === attempt?.chargeItemId)
      if (attempt === undefined || charge === undefined) throw new Error(messages.paymentUnavailable)
      return recoverPayment({ paymentId, expectedPaymentVersion: attempt.version, chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion }, newIdempotencyKey())
    },
    onSuccess: (response, _paymentId, context) => {
      if (!ownsPaymentResult(context)) return
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
    onMutate: () => {
      historyRevision.current += 1
      const context = paymentMutationContext()
      paymentContexts.current.preview = context
      return context
    },
    mutationFn: () => {
      if (refundWrite.blocked) throw new Error(messages.paymentUnavailable)
      if (selectedCharge === undefined) throw new Error(messages.paymentUnavailable)
      return previewPayment({
        caseId: selectedCharge.caseId,
        category: selectedCharge.category,
        chargeItemId: selectedCharge.chargeItemId,
        chargeVersion: selectedCharge.chargeVersion,
        simulatorRule,
        tenders: parseTenderAmounts(tenderAmounts, messages.invalidPaymentAmount),
      }, newIdempotencyKey())
    },
  })
  const confirm = useMutation({
    onMutate: () => {
      historyRevision.current += 1
      const context = paymentMutationContext()
      paymentContexts.current.confirm = context
      return context
    },
    mutationFn: () => {
      if (refundWrite.blocked) throw new Error(messages.paymentUnavailable)
      if (preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge?.chargeItemId) throw new Error(messages.paymentUnavailable)
      return confirmPayment({
        chargeItemId: preview.data.data.chargeItemId,
        chargeVersion: preview.data.data.chargeVersion,
        commitToken: preview.data.data.commitToken,
        previewId: preview.data.data.previewId,
      }, `payment-confirm:${preview.data.data.previewId}`)
    },
    onSuccess: (response, _variables, context) => {
      if (!ownsPaymentResult(context)) return
      setPaymentConfirmationOpen(false)
      setSelectedChargeId(context?.chargeItemId)
      setHistoryPage({ caseKey, page: 1 })
      const nextStatus = paymentQueueStatus(response.data)
      if (nextStatus !== status) setPage(1)
      setStatus(nextStatus)
      setTenderAmounts({})
      preview.reset()
    },
    onSettled: refreshBilling,
  })
  const clearPayment = useCallback(() => {
    historyRevision.current += 1
    selectionRevision.current += 1
    setPaymentConfirmationOpen(false)
    preview.reset()
    confirm.reset()
    recover.reset()
    setTenderAmounts({})
  },[preview.reset,confirm.reset,recover.reset])
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
  const pendingRefund = refundWrite.pending?.command.operation === 'billing.charge.adjust'
    || refundWrite.pending?.command.operation.startsWith('refund.') === true
  const refundError = refundWrite.storageFailure ?? refundWrite.mutation.error
  paymentInFlight.current = paymentPending
  const changeHistoryPage = (page: number) => {
    if (paymentInFlight.current) return
    historyRevision.current += 1
    setHistoryPage({ caseKey, page })
  }

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
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).recoverPayment,
            description: locale => `${selectedCharge?.patient.name ?? ''} · ${unknownAttempt.paymentId} · ${formatFen(unknownAttempt.amountFen, locale)}`,
            onConfirm: () => recover.mutateAsync(unknownAttempt.paymentId),
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
        enabled: !paymentWriteBlocked && selectedCharge !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: async () => {
          if (paymentWriteBlocked || selectedCharge === undefined) throw new Error(messages.paymentUnavailable)
          return preview.mutateAsync()
        },
      },
      'billing.payment.confirm.propose': {
        description: 'Open human review for the current payment preview.',
        enabled: !paymentWriteBlocked && preview.data?.data.chargeItemId === selectedCharge?.chargeItemId && preview.data !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (paymentWriteBlocked || preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge?.chargeItemId) throw new Error(messages.paymentUnavailable)
          const amountFen = preview.data.data.amountFen
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).submitPayment,
            description: locale => `${selectedCharge?.patient.name ?? ''} · ${formatFen(amountFen, locale)} · ${preview.data?.data.tenders?.map(tender => `${paymentMethodLabel(tender.method, getWorkspaceMessages(locale))} ${formatFen(tender.amountFen, locale)}`).join(' + ') ?? ''}`,
            onConfirm: () => confirm.mutateAsync(),
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
    bill.data,
    unknownAttempt,
    recover.mutateAsync,
    status,
  ])
  useRegisterAgentPage(agentPage)

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(19rem,0.8fr)_minmax(28rem,1.2fr)]">
      {refundWrite.pending === null ? null : <Alert className="xl:col-span-2"><AlertTitle>{locale === 'zh-CN' ? '原操作结果待确认' : 'Original operation awaiting confirmation'}</AlertTitle><AlertDescription>
        <p>{locale === 'zh-CN' ? '已保留原输入和幂等键；先恢复原操作，再办理新的收退款。' : 'The original input and key are saved. Resolve the original operation before another collection or refund.'}</p>
        {pendingRefund ? <Button disabled={refundWrite.mutation.isPending} onClick={() => refundWrite.mutation.mutate(undefined)} variant="outline">{locale === 'zh-CN' ? '恢复原费用操作' : 'Recover original billing operation'}</Button> : null}
      </AlertDescription></Alert>}
      {refundError === null ? null : <div className="xl:col-span-2"><PaymentError message={getWorkspaceErrorMessage(refundError, messages)} title={messages.operationFailed} /></div>}
      <section aria-labelledby="billing-queue-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="billing-queue-heading">{messages.billingQueue}</h2>
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
          <TabsList className="w-full">
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="pending">{messages.pendingPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="paid">{messages.paidPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="declined">{messages.declinedPayment}</TabsTrigger>
            <TabsTrigger disabled={paymentPending} className="min-w-0 flex-1" value="ambiguous">{messages.ambiguousPayment}</TabsTrigger>
          </TabsList>
        </Tabs>
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <PaymentError message={getWorkspaceErrorMessage(queue.error, messages)} title={getWorkspaceErrorTitle(queue.error, messages, messages.paymentUnavailable)} />
        ) : queue.data.items.length === 0 ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ReceiptTextIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noBillingItems}</EmptyTitle>
              <EmptyDescription>{messages.noBillingItemsDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2" role="list">
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
          </div>
        )}
      </section>

      <section aria-labelledby="payment-details-heading" className="flex min-w-0 flex-col gap-5">
        <h2 className="text-base font-semibold" id="payment-details-heading">{messages.paymentDetails}</h2>
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
              <BillingCasePanel key={caseKey} bill={bill.data} locale={locale} messages={messages} onPageChange={changeHistoryPage} onRecover={paymentId => recover.mutateAsync(paymentId)} onRefresh={refreshBilling} recovering={paymentPending} />
            )}
            {bill.data === undefined ? null : <BillingRefundPanel key={`refund:${caseKey}`} bill={bill.data} session={session} locale={locale} disabled={paymentPending} onChanged={refreshBilling}
              frozen={refundPreviews.scope === refundScope ? refundPreviews.cases.get(bill.data.caseId) : undefined} onFrozenChange={setRefundPreview} />}
            <InsurancePanel key={agentViewRevision({session,target:selectedCharge.caseId})} target={{kind:'outpatient',id:selectedCharge.caseId}} session={session} locale={locale} disabled={paymentPending} onChanged={insuranceChanged}/>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
              <div><div className="text-lg font-semibold">{selectedCharge.patient.name}</div><div className="text-sm text-muted-foreground">{selectedChargeDescription}</div></div>
              <div className="text-right"><div className="text-xs text-muted-foreground">{messages.amount}</div><div className="text-lg font-semibold">{formatFen(selectedCharge.amountFen, locale)}</div></div>
            </div>
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
            {status === 'pending' || status === 'declined' ? (
              <FieldGroup>
                <p className="text-sm text-muted-foreground">{messages.installmentHint}</p>
                <h3 className="text-sm font-semibold">{messages.paymentMethods}</h3>
                {(['cash', 'bank-card', 'mobile'] as const).map(method => (
                  <Field key={method}>
                    <FieldLabel htmlFor={`payment-${method}`}>{paymentMethodLabel(method, messages)}</FieldLabel>
                    <Input disabled={paymentPending} id={`payment-${method}`} inputMode="decimal" placeholder="0.00" value={tenderAmounts[method] ?? ''} onChange={event => {
                      setTenderAmounts(current => ({ ...current, [method]: event.target.value }))
                      preview.reset()
                      setPaymentConfirmationOpen(false)
                    }} />
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
                      clearPayment()
                    }}
                    value={simulatorRule}
                  />
                </Field>
                <div className="flex justify-end"><Button disabled={paymentWriteBlocked} onClick={() => preview.mutate()} type="button"><CreditCardIcon data-icon="inline-start" />{messages.previewPayment}</Button></div>
                {preview.isError && displaysPaymentResult(paymentContexts.current.preview) ? <PaymentError message={getWorkspaceErrorMessage(preview.error, messages)} title={getWorkspaceErrorTitle(preview.error, messages, messages.operationFailed)} /> : null}
              </FieldGroup>
            ) : null}
            {preview.data === undefined || preview.data.data.chargeItemId !== selectedCharge.chargeItemId || !displaysPaymentResult(paymentContexts.current.preview) ? null : (
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
                <div className="flex justify-end">
                  <AlertDialog
                    onOpenChange={(open) => {
                      if (confirm.isPending) return
                      setPaymentConfirmationOpen(open)
                      if (open) confirm.reset()
                    }}
                    open={paymentConfirmationOpen}
                  >
                    <AlertDialogTrigger render={<Button disabled={paymentWriteBlocked} type="button" />}>
                      <CheckCircleIcon data-icon="inline-start" />{messages.confirmPayment}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{messages.confirmPaymentTitle}</AlertDialogTitle>
                        <AlertDialogDescription>{messages.confirmPaymentDescription}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                        <div><dt className="text-muted-foreground">{messages.amount}</dt><dd className="font-medium">{formatFen(preview.data.data.amountFen, locale)}</dd></div>
                        <div><dt className="text-muted-foreground">{messages.paymentChannel}</dt><dd className="font-medium">{messages.syntheticPaymentChannel}</dd></div>
                        {preview.data.data.tenders?.map(tender => <div key={tender.method}><dt>{paymentMethodLabel(tender.method, messages)}</dt><dd>{formatFen(tender.amountFen, locale)}</dd></div>)}
                      </dl>
                      {confirm.isError && displaysPaymentResult(paymentContexts.current.confirm) ? <PaymentError message={getWorkspaceErrorMessage(confirm.error, messages)} title={getWorkspaceErrorTitle(confirm.error, messages, messages.operationFailed)} /> : null}
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={confirm.isPending}>{messages.cancel}</AlertDialogCancel>
                        <AlertDialogAction disabled={paymentWriteBlocked} onClick={() => confirm.mutate()}>
                          <CheckCircleIcon data-icon="inline-start" />{messages.submitPayment}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  )
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

function paymentQueueStatus(payment: { outcome: 'success' | 'declined' | 'ambiguous'; status: string; remainingFen?: number }): BillingStatus {
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
