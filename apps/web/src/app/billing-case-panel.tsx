import type { z } from 'zod'
import type { billingCaseSchema } from '@clinmesh/contracts/his'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useState } from 'react'
import { formatFen } from './workspace-format.ts'
import { PaginationControls } from './pagination-controls.tsx'
import type { getWorkspaceMessages, WorkspaceLocale } from './workspace-i18n.ts'

type Messages = ReturnType<typeof getWorkspaceMessages>

export function paymentMethodLabel(method: 'cash' | 'bank-card' | 'mobile', messages: Messages) {
  return method === 'cash' ? messages.tenderCash : method === 'bank-card' ? messages.tenderCard : messages.tenderMobile
}

export function BillingCasePanel({ bill, locale, messages, onPageChange, onRecover, onRefresh, recovering }: {
  bill: z.infer<typeof billingCaseSchema>
  locale: WorkspaceLocale
  messages: Messages
  onPageChange: (page: number) => void
  onRecover: (paymentId: string) => Promise<unknown>
  onRefresh: () => unknown
  recovering: boolean
}) {
  const [reviewPaymentId, setReviewPaymentId] = useState<string>()
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
            <TableCell>{locale === 'zh-CN' ? charge.descriptionZh : charge.descriptionEn}</TableCell>
            <TableCell>{formatFen(charge.amountFen, locale)}</TableCell>
            <TableCell>{formatFen(charge.paidFen, locale)}</TableCell>
            <TableCell>{formatFen(charge.remainingFen, locale)}</TableCell>
          </TableRow>
        ))}</TableBody>
      </Table>
      {bill.charges.some(charge => charge.category === 'registration') ? <p className="text-xs text-muted-foreground">{messages.registrationReadOnly}</p> : null}
      <h4 className="text-sm font-semibold">{messages.paymentHistory}</h4>
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
              <AlertDialog open={reviewPaymentId === payment.paymentId} onOpenChange={open => setReviewPaymentId(open ? payment.paymentId : undefined)}>
                <AlertDialogTrigger render={<Button disabled={recovering} size="sm" type="button" variant="outline" />}>{messages.recoverPayment}</AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader><AlertDialogTitle>{messages.recoverPayment}</AlertDialogTitle><AlertDialogDescription>{messages.recoverPaymentDescription}</AlertDialogDescription></AlertDialogHeader>
                  <p className="break-all text-sm">{payment.paymentId} · {formatFen(payment.amountFen, locale)}</p>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={recovering}>{messages.cancel}</AlertDialogCancel>
                    <Button disabled={recovering} onClick={async () => {
                      try { await onRecover(payment.paymentId) }
                      catch { /* The workspace displays the mutation error. */ }
                      finally { setReviewPaymentId(undefined) }
                    }} type="button">{messages.recoverPayment}</Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        ))}</div>
      )}
      <PaginationControls ariaLabel={messages.paymentHistory} disabled={recovering} messages={messages} onPageChange={onPageChange} {...bill.paymentsPagination} />
    </section>
  )
}
