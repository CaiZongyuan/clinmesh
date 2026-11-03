import type { z } from 'zod'
import type { BillingQueueItem, billingCaseSchema } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Fragment, useState } from 'react'
import { InvestigationPrice } from './doctor/investigation-billing.tsx'
import { formatFen } from './workspace-format.ts'
import { PaginationControls } from './pagination-controls.tsx'
import type { getWorkspaceMessages, WorkspaceLocale } from './workspace-i18n.ts'

type Messages = ReturnType<typeof getWorkspaceMessages>

export function BillingChargeOrigin({ charge, locale }: { charge: Pick<z.infer<typeof billingCaseSchema>['charges'][number], 'chargeItemId' | 'requestId' | 'sourceReference' | 'price'>; locale: WorkspaceLocale }) {
  return charge.price === undefined ? null : <InvestigationPrice locale={locale} price={charge.price} />
}

export function paymentMethodLabel(method: 'cash' | 'bank-card' | 'mobile', messages: Messages) {
  return method === 'cash' ? messages.tenderCash : method === 'bank-card' ? messages.tenderCard : messages.tenderMobile
}

export function outpatientBillTotals(bill: z.infer<typeof billingCaseSchema>) {
  const charges = bill.charges.filter(charge => charge.category !== 'registration')
  return { charges,
    total: charges.reduce((sum, charge) => sum + charge.amountFen, 0),
    paid: charges.reduce((sum, charge) => sum + charge.paidFen, 0),
    remaining: charges.reduce((sum, charge) => sum + charge.remainingFen, 0),
  }
}

export function BillingCasePanel({ bill, chargeDetails = [], locale, messages, onRefresh }: {
  bill: z.infer<typeof billingCaseSchema>
  chargeDetails?: readonly BillingQueueItem[]
  locale: WorkspaceLocale
  messages: Messages
  onRefresh: () => unknown
}) {
  const { charges, total, paid, remaining } = outpatientBillTotals(bill)
  return (
    <section aria-label={messages.unifiedBill} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{messages.unifiedBill}</h3>
        <Button onClick={onRefresh} size="sm" type="button" variant="outline">{messages.refreshBill}</Button>
      </div>
      <Table className="table-fixed [&_th]:whitespace-normal [&_th]:px-1 [&_td]:whitespace-normal [&_td]:break-words [&_td]:px-1">
        <TableHeader><TableRow><TableHead className="w-[40%]">{messages.chargeItem}</TableHead><TableHead>{messages.amount}</TableHead><TableHead>{messages.paidAmount}</TableHead><TableHead>{messages.remainingAmount}</TableHead></TableRow></TableHeader>
        <TableBody>{charges.map(charge => {
          const detail = charge.category === 'medication' ? chargeDetails.find(item => item.category === 'medication'
            && item.caseId === bill.caseId && item.chargeItemId === charge.chargeItemId && item.chargeVersion === charge.chargeVersion) : undefined
          return <Fragment key={charge.chargeItemId}><TableRow>
            <TableCell>{locale === 'zh-CN' ? charge.descriptionZh : charge.descriptionEn}<BillingChargeOrigin charge={charge} locale={locale} /></TableCell>
            <TableCell>{formatFen(charge.amountFen, locale)}</TableCell>
            <TableCell>{formatFen(charge.paidFen, locale)}</TableCell>
            <TableCell>{formatFen(charge.remainingFen, locale)}</TableCell>
          </TableRow>
          {charge.category === 'medication' ? <TableRow className="bg-muted/20"><TableCell colSpan={4}>
            {detail === undefined ? <p className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '尚未取得该项药品明细。' : 'Medication details for this charge are unavailable.'}</p>
              : <div className="@container/bill-lines flex min-w-0 flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">{locale === 'zh-CN' ? '原处方明细' : 'Original prescription items'}</p>
                <ul aria-label={locale === 'zh-CN' ? '原处方明细' : 'Original prescription items'}>{detail.lines.map((line, index) => <li key={`${line.sourceReference}:${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-b py-2 last:border-b-0 @min-[36rem]/bill-lines:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                  <span className="font-medium">{locale === 'zh-CN' ? line.descriptionZh : line.descriptionEn}</span>
                  <span>{messages.quantity} {line.quantity}</span>
                  <span>{locale === 'zh-CN' ? '原单价' : 'Original unit price'} {formatFen(line.unitPriceFen, locale)}</span>
                  <span>{locale === 'zh-CN' ? '原小计' : 'Original subtotal'} {formatFen(line.subtotalFen, locale)}</span>
                </li>)}</ul>
              </div>}
          </TableCell></TableRow> : null}
          </Fragment>
        })}</TableBody>
        <TableFooter><TableRow>
          <TableCell>{locale === 'zh-CN' ? '合计' : 'Total'}</TableCell>
          <TableCell>{formatFen(total, locale)}</TableCell>
          <TableCell>{formatFen(paid, locale)}</TableCell>
          <TableCell>{formatFen(remaining, locale)}</TableCell>
        </TableRow></TableFooter>
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
            <p className="text-xs text-muted-foreground">{new Date(payment.createdAt).toLocaleString(locale)}</p>
            <p className="text-sm">{payment.tenders.map(tender => `${paymentMethodLabel(tender.method, messages)} ${formatFen(tender.amountFen, locale)}`).join(' + ')}</p>
            {payment.resolvedAt === null ? null : <p className="text-xs text-muted-foreground">{messages.paymentInitiallyUnknown} · {payment.resolvedAt}</p>}
            {payment.outcome === 'ambiguous' ? (
              reviewPaymentId !== payment.paymentId ? <Button disabled={recovering} size="sm" type="button" variant="outline" onClick={() => setReviewPaymentId(payment.paymentId)}>{messages.recoverPayment}</Button>
                : <section role="region" aria-label={messages.recoverPayment} className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
                  <h5 className="font-semibold">{messages.recoverPayment}</h5><p className="text-sm">{messages.recoverPaymentDescription}</p>
                  <p className="break-all text-sm">{formatFen(payment.amountFen, locale)}</p>
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
