import type { z } from 'zod'
import type { billingCaseSchema } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useState } from 'react'
import { InvestigationPrice } from './doctor/investigation-billing.tsx'
import { formatFen } from './workspace-format.ts'
import { PaginationControls } from './pagination-controls.tsx'
import type { getWorkspaceMessages, WorkspaceLocale } from './workspace-i18n.ts'

type Messages = ReturnType<typeof getWorkspaceMessages>

export function BillingChargeOrigin({ charge, locale }: { charge: Pick<z.infer<typeof billingCaseSchema>['charges'][number], 'chargeItemId' | 'requestId' | 'sourceReference' | 'price'>; locale: WorkspaceLocale }) {
  return <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
    <p className="break-all">{locale === 'zh-CN' ? '原费用：' : 'Original charge: '}{charge.chargeItemId}</p>
    {charge.requestId === undefined ? null : <p className="break-all">{locale === 'zh-CN' ? '申请：' : 'Request: '}{charge.requestId}</p>}
    {charge.sourceReference === undefined ? null : <p className="break-all">{charge.sourceReference}</p>}
    {charge.price === undefined ? null : <InvestigationPrice locale={locale} price={charge.price} />}
  </div>
}

export function paymentMethodLabel(method: 'cash' | 'bank-card' | 'mobile', messages: Messages) {
  return method === 'cash' ? messages.tenderCash : method === 'bank-card' ? messages.tenderCard : messages.tenderMobile
}

export function BillingCasePanel({ bill, locale, messages, onRefresh }: {
  bill: z.infer<typeof billingCaseSchema>
  locale: WorkspaceLocale
  messages: Messages
  onRefresh: () => unknown
}) {
  return (
    <section aria-label={messages.unifiedBill} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{messages.unifiedBill}</h3>
        <Button onClick={onRefresh} size="sm" type="button" variant="outline">{messages.refreshBill}</Button>
      </div>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div><dt>{messages.billTotal}</dt><dd>{formatFen(bill.totalFen, locale)}</dd></div>
        <div><dt>{messages.paidAmount}</dt><dd>{formatFen(bill.paidFen, locale)}</dd></div>
        <div><dt>{messages.remainingAmount}</dt><dd>{formatFen(bill.remainingFen, locale)}</dd></div>
      </dl>
      <Table>
        <TableHeader><TableRow><TableHead>{messages.chargeItem}</TableHead><TableHead>{messages.amount}</TableHead><TableHead>{messages.paidAmount}</TableHead><TableHead>{messages.remainingAmount}</TableHead></TableRow></TableHeader>
        <TableBody>{bill.charges.map(charge => (
          <TableRow key={charge.chargeItemId}>
            <TableCell>{locale === 'zh-CN' ? charge.descriptionZh : charge.descriptionEn}<BillingChargeOrigin charge={charge} locale={locale} /></TableCell>
            <TableCell>{formatFen(charge.amountFen, locale)}</TableCell>
            <TableCell>{formatFen(charge.paidFen, locale)}</TableCell>
            <TableCell>{formatFen(charge.remainingFen, locale)}</TableCell>
          </TableRow>
        ))}</TableBody>
      </Table>
      {bill.charges.some(charge => charge.category === 'registration') ? <p className="text-xs text-muted-foreground">{messages.registrationReadOnly}</p> : null}
    </section>
  )
}

export function BillingPaymentHistory({ bill, locale, messages, onPageChange, onRecover, recovering }: {
  bill: z.infer<typeof billingCaseSchema>
  locale: WorkspaceLocale
  messages: Messages
  onPageChange: (page: number) => void
  onRecover: (paymentId: string) => Promise<unknown>
  recovering: boolean
}) {
  const [reviewPaymentId, setReviewPaymentId] = useState<string>()
  return <section aria-label={messages.paymentHistory} className="flex min-w-0 flex-col gap-3">
      {bill.payments.length === 0 ? <p className="text-sm text-muted-foreground">{messages.noPaymentAttempts}</p> : (
        <div className="flex min-w-0 flex-col gap-3">{bill.payments.map(payment => (
          <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3" key={payment.paymentId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{formatFen(payment.amountFen, locale)}</span>
              <Badge variant={payment.outcome === 'success' ? 'secondary' : 'outline'}>{payment.outcome === 'success' ? messages.paymentSuccess : payment.outcome === 'declined' ? messages.paymentDeclined : messages.paymentAmbiguousResult}</Badge>
            </div>
            <p className="break-all text-xs text-muted-foreground">{messages.paymentReference}: {payment.paymentId} · {payment.createdAt}</p>
            <p className="break-all text-xs text-muted-foreground">{payment.chargeItemId} · {payment.correlationId}</p>
            <p className="text-sm">{payment.tenders.map(tender => `${paymentMethodLabel(tender.method, messages)} ${formatFen(tender.amountFen, locale)}`).join(' + ')}</p>
            {payment.resolvedAt === null ? null : <p className="text-xs text-muted-foreground">{messages.paymentInitiallyUnknown} · {payment.resolvedAt}</p>}
            {payment.outcome === 'ambiguous' ? (
              reviewPaymentId !== payment.paymentId ? <Button disabled={recovering} size="sm" type="button" variant="outline" onClick={() => setReviewPaymentId(payment.paymentId)}>{messages.recoverPayment}</Button>
                : <section role="region" aria-label={messages.recoverPayment} className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
                  <h5 className="font-semibold">{messages.recoverPayment}</h5><p className="text-sm">{messages.recoverPaymentDescription}</p>
                  <p className="break-all text-sm">{payment.paymentId} · {formatFen(payment.amountFen, locale)}</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" disabled={recovering} onClick={() => setReviewPaymentId(undefined)}>{messages.cancel}</Button>
                    <Button disabled={recovering} onClick={async () => {
                      try { await onRecover(payment.paymentId) }
                      catch { /* The workspace displays the mutation error. */ }
                      finally { setReviewPaymentId(undefined) }
                    }} type="button">{messages.recoverPayment}</Button>
                  </div>
                </section>
            ) : null}
          </div>
        ))}</div>
      )}
      <PaginationControls ariaLabel={messages.paymentHistory} disabled={recovering} messages={messages} onPageChange={onPageChange} {...bill.paymentsPagination} />
    </section>
}
