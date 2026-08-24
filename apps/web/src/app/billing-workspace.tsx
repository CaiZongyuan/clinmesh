import type { BillingQueueItem, SessionContext } from '@clinmesh/contracts/his'
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircleIcon, CircleAlertIcon, CreditCardIcon, ReceiptTextIcon } from 'lucide-react'
import { useState } from 'react'
import { confirmPayment, getBillingQueue, newIdempotencyKey, previewPayment } from './api-client.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

interface BillingWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

type BillingCategory = 'laboratory' | 'medication'
type BillingStatus = 'ambiguous' | 'declined' | 'paid' | 'pending'
type SimulatorRule = 'ambiguous' | 'decline' | 'success'

export function BillingWorkspace({ locale, session }: BillingWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [category, setCategory] = useState<BillingCategory>('laboratory')
  const [status, setStatus] = useState<BillingStatus>('pending')
  const [page, setPage] = useState(1)
  const [paymentConfirmationOpen, setPaymentConfirmationOpen] = useState(false)
  const [simulatorRule, setSimulatorRule] = useState<SimulatorRule>('success')
  const [selectedChargeId, setSelectedChargeId] = useState<string>()
  const queueKey = ['billing-queue', ...scope, category, status, page] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getBillingQueue(category, status, signal, page),
    queryKey: queueKey,
  })
  const selectedCharge = queue.data?.items.find(item => item.chargeItemId === selectedChargeId)
    ?? queue.data?.items[0]
  const selectedChargeDescription = selectedCharge === undefined
    ? ''
    : locale === 'zh-CN' ? selectedCharge.descriptionZh : selectedCharge.descriptionEn
  const preview = useMutation({
    mutationFn: () => {
      if (selectedCharge === undefined) throw new Error(messages.paymentUnavailable)
      return previewPayment({
        caseId: selectedCharge.caseId,
        category: selectedCharge.category,
        chargeItemId: selectedCharge.chargeItemId,
        chargeVersion: selectedCharge.chargeVersion,
        simulatorRule,
      }, newIdempotencyKey())
    },
  })
  const confirm = useMutation({
    mutationFn: () => {
      if (preview.data === undefined) throw new Error(messages.paymentUnavailable)
      return confirmPayment({
        chargeItemId: preview.data.data.chargeItemId,
        chargeVersion: preview.data.data.chargeVersion,
        commitToken: preview.data.data.commitToken,
        previewId: preview.data.data.previewId,
      }, newIdempotencyKey())
    },
    onSuccess: async () => {
      setPaymentConfirmationOpen(false)
      setSelectedChargeId(undefined)
      await queryClient.invalidateQueries({ queryKey: ['billing-queue', ...scope] })
    },
  })
  const clearPayment = () => {
    setPaymentConfirmationOpen(false)
    preview.reset()
    confirm.reset()
  }
  const changeCategory = (value: BillingCategory) => {
    setCategory(value)
    setPage(1)
    setSelectedChargeId(undefined)
    clearPayment()
  }
  const changeStatus = (value: BillingStatus) => {
    setStatus(value)
    setPage(1)
    setSelectedChargeId(undefined)
    clearPayment()
  }
  const selectCharge = (chargeItemId: string) => {
    setSelectedChargeId(chargeItemId)
    clearPayment()
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(19rem,0.8fr)_minmax(28rem,1.2fr)]">
      <section aria-labelledby="billing-queue-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="billing-queue-heading">{messages.billingQueue}</h2>
          <Badge variant="secondary">{queue.data?.total ?? 0}</Badge>
        </div>
        <Tabs onValueChange={value => changeCategory(value as BillingCategory)} value={category}>
          <TabsList className="w-full">
            <TabsTrigger className="min-w-0 flex-1" value="laboratory">{messages.laboratoryCharges}</TabsTrigger>
            <TabsTrigger className="min-w-0 flex-1" value="medication">{messages.medicationCharges}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs onValueChange={value => changeStatus(value as BillingStatus)} value={status}>
          <TabsList className="w-full">
            <TabsTrigger className="min-w-0 flex-1" value="pending">{messages.pendingPayment}</TabsTrigger>
            <TabsTrigger className="min-w-0 flex-1" value="paid">{messages.paidPayment}</TabsTrigger>
            <TabsTrigger className="min-w-0 flex-1" value="declined">{messages.declinedPayment}</TabsTrigger>
            <TabsTrigger className="min-w-0 flex-1" value="ambiguous">{messages.ambiguousPayment}</TabsTrigger>
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
                item={item}
                key={item.chargeItemId}
                locale={locale}
                messages={messages}
                onSelect={() => selectCharge(item.chargeItemId)}
                selected={item.chargeItemId === selectedCharge?.chargeItemId}
              />
            ))}
            <PaginationControls
              messages={messages}
              onPageChange={(nextPage) => {
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
        {confirm.isSuccess ? <PaymentOutcome outcome={confirm.data.data.outcome} messages={messages} /> : null}
        {selectedCharge === undefined ? (
          <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><CreditCardIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noBillingItems}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
              <div><div className="text-lg font-semibold">{selectedCharge.patient.name}</div><div className="text-sm text-muted-foreground">{selectedChargeDescription}</div></div>
              <div className="text-right"><div className="text-xs text-muted-foreground">{messages.amount}</div><div className="text-lg font-semibold">{formatFen(selectedCharge.amountFen, locale)}</div></div>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>{messages.chargeItem}</TableHead><TableHead>{messages.quantity}</TableHead><TableHead>{messages.unitPrice}</TableHead><TableHead>{messages.subtotal}</TableHead></TableRow></TableHeader>
              <TableBody>{selectedCharge.lines.map(line => (
                <TableRow key={line.sourceReference}>
                  <TableCell className="font-medium">{locale === 'zh-CN' ? line.descriptionZh : line.descriptionEn}</TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{formatFen(line.unitPriceFen, locale)}</TableCell>
                  <TableCell>{formatFen(line.subtotalFen, locale)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
            {status === 'pending' || status === 'declined' ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="payment-simulator-rule">{messages.paymentSimulatorRule}</FieldLabel>
                  <Select
                    onValueChange={value => {
                      setSimulatorRule(value as SimulatorRule)
                      clearPayment()
                    }}
                    value={simulatorRule}
                  >
                    <SelectTrigger className="w-full" id="payment-simulator-rule"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      <SelectItem value="success">{messages.simulatorSuccess}</SelectItem>
                      <SelectItem value="decline">{messages.simulatorDecline}</SelectItem>
                      <SelectItem value="ambiguous">{messages.simulatorAmbiguous}</SelectItem>
                    </SelectGroup></SelectContent>
                  </Select>
                </Field>
                <div className="flex justify-end"><Button disabled={preview.isPending} onClick={() => preview.mutate()} type="button"><CreditCardIcon data-icon="inline-start" />{messages.previewPayment}</Button></div>
                {preview.isError ? <PaymentError message={getWorkspaceErrorMessage(preview.error, messages)} title={getWorkspaceErrorTitle(preview.error, messages, messages.operationFailed)} /> : null}
              </FieldGroup>
            ) : null}
            {preview.data === undefined ? null : (
              <section aria-labelledby="payment-preview-heading" className="flex flex-col gap-3 border-t pt-5">
                <h3 className="text-sm font-semibold" id="payment-preview-heading">{messages.paymentPreview}</h3>
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">{messages.amount}</dt><dd className="font-medium">{formatFen(preview.data.data.amountFen, locale)}</dd></div>
                  <div><dt className="text-muted-foreground">{messages.expectedOutcome}</dt><dd className="font-medium">{expectedOutcomeLabel(preview.data.data.expectedOutcome, messages)}</dd></div>
                  <div><dt className="text-muted-foreground">{messages.paymentChannel}</dt><dd className="font-medium">{messages.syntheticPaymentChannel}</dd></div>
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
                      setPaymentConfirmationOpen(open)
                      if (open) confirm.reset()
                    }}
                    open={paymentConfirmationOpen}
                  >
                    <AlertDialogTrigger render={<Button disabled={confirm.isPending} type="button" />}>
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
                      </dl>
                      {confirm.isError ? <PaymentError message={getWorkspaceErrorMessage(confirm.error, messages)} title={getWorkspaceErrorTitle(confirm.error, messages, messages.operationFailed)} /> : null}
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={confirm.isPending}>{messages.cancel}</AlertDialogCancel>
                        <AlertDialogAction disabled={confirm.isPending} onClick={() => confirm.mutate()}>
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

function ChargeRow({ item, locale, messages, onSelect, selected }: {
  item: BillingQueueItem
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button aria-label={`${messages.selectCharge} ${item.patient.name}`} className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left" onClick={onSelect} role="listitem" type="button" variant={selected ? 'secondary' : 'outline'}>
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
