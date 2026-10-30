import { useEffect, useState } from 'react'
import { z } from 'zod'
import { insurancePreviewResponseSchema, insuranceSettlementSchema } from '@clinmesh/contracts/insurance'
import { inpatientFinancialInsuranceCancelInputSchema, inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

export function InpatientFinancialInsurance({ bill, locale, write, fetching }: { bill: z.infer<typeof inpatientFinancialSchema>;
  locale: WorkspaceLocale; write?: ReturnType<typeof useInpatientWriteIntent> | undefined; fetching: boolean }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [cancel, setCancel] = useState<{ input: z.infer<typeof inpatientFinancialInsuranceCancelInputSchema>; settlement: z.infer<typeof insuranceSettlementSchema> }>()
  const [review, setReview] = useState<z.infer<typeof insurancePreviewResponseSchema>['data']>()
  const result = write?.mutation.data
  useEffect(() => {
    if (result?.command.operation === 'inpatient.financial.insurance.preview' && result.command.input.admissionId === bill.admissionId)
      setReview(insurancePreviewResponseSchema.parse(result.response).data)
    if (result?.command.operation === 'inpatient.financial.insurance.confirm') setReview(undefined)
    if (result?.command.operation === 'inpatient.financial.insurance.cancel') setCancel(undefined)
  }, [result, bill.admissionId])
  const insurance = bill.insurance
  if (!insurance) return null
  const latest = bill.adjustments.at(-1), cycle = insurance.cycles.find(row => row.adjustmentId === latest?.adjustmentId)
  const busy = !write || write.blocked || fetching || bill.reservedFen + bill.reservedCollectFen > 0
  const error = write?.mutation.error ? getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale)) : undefined
  const detail = (value: typeof insurance.original): React.JSX.Element => <span className="font-mono">{t('基金', 'Fund')} {formatFen(value.fundFen, locale)} · {t('账户', 'Account')} {formatFen(value.accountFen, locale)} · {t('患者', 'Patient')} {formatFen(value.patientFen, locale)}</span>
  return <section aria-label={t('后续医保更正', 'Later insurance correction')} className="flex flex-col gap-3 border-t border-border pt-3">
    <h4>{t('后续医保更正', 'Later insurance correction')}</h4>
    <p>{t('首次固定待遇', 'First fixed benefits')} · {detail(insurance.original)}</p>
    <p><span className="font-mono">{insurance.original.year}</span> · {t('原年度账户余额', 'Original year account balance')} <span className="font-mono">{formatFen(insurance.balance.accountFen, locale)}</span> · {t('年度统筹累计', 'Annual fund total')} <span className="font-mono">{formatFen(insurance.balance.fundFen, locale)}</span></p>
    {insurance.active ? <p data-testid="financial-insurance-active">{t('当前待遇', 'Current benefits')} · {detail(insurance.active)}</p> : null}
    {!insurance.ready ? <Alert><AlertDescription>{t('请先补偿原待遇并确认更正后的医保分摊，再按患者现金差额收退。', 'Compensate original benefits and confirm the revised allocation before collecting or refunding the patient cash difference.')}</AlertDescription></Alert> : null}
    {insurance.cycles.map(row => <p className="break-all font-mono text-xs" key={row.adjustmentId}>{t('原待遇', 'Original')} {row.originalSettlementId} · {t('补偿', 'Compensation')} {row.compensationId} · {t('新待遇', 'Replacement')} {row.replacementSettlementId ?? t('待确认', 'Pending')}</p>)}
    {write && latest && !insurance.ready ? <>
      {insurance.active && !cycle ? <Button variant="outline" disabled={busy} onClick={() => setCancel({ input: { admissionId: bill.admissionId,
        adjustmentId: latest.adjustmentId, settlementId: insurance.active!.id, expectedBalanceVersion: insurance.balance.version,
        expectedFingerprint: bill.fingerprint }, settlement: insurance.active! })}>{t('审阅原待遇补偿', 'Review original benefit compensation')}</Button> : null}
      {cycle && !cycle.replacementSettlementId ? <Button variant="outline" disabled={busy} onClick={() => write.mutation.mutate({ operation: 'inpatient.financial.insurance.preview',
        input: { admissionId: bill.admissionId, adjustmentId: latest.adjustmentId, expectedFingerprint: bill.fingerprint } })}>{t('预览更正医保', 'Preview revised insurance')}</Button> : null}
    </> : null}
    <AlertDialog open={!!cancel} onOpenChange={open => { if (!open && !write?.mutation.isPending) setCancel(undefined) }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('确认原待遇补偿', 'Confirm original benefit compensation')}</AlertDialogTitle><AlertDialogDescription>{t('补偿原年度待遇影响，后续其他就诊的累计继续保留。补偿后须审阅新待遇。', 'Reverse the original year benefit effects while preserving later encounters. Review replacement benefits afterward.')}</AlertDialogDescription></AlertDialogHeader>
      <p>{cancel ? detail(cancel.settlement) : ''}</p>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <AlertDialogFooter><AlertDialogCancel disabled={write?.mutation.isPending}>{t('取消', 'Cancel')}</AlertDialogCancel><Button disabled={write?.blocked} onClick={() => { if (cancel) write?.mutation.mutate({ operation: 'inpatient.financial.insurance.cancel', input: cancel.input }) }}>{t('确认补偿原待遇', 'Confirm benefit compensation')}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    <AlertDialog open={!!review} onOpenChange={open => { if (!open && !write?.mutation.isPending) setReview(undefined) }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('确认更正医保待遇', 'Confirm revised insurance')}</AlertDialogTitle><AlertDialogDescription>{t('核对本次固定分摊；费用或原年度余额变化后，须重新预览并审阅。', 'Review this fixed allocation. Preview and review again if charges or the original year balance change.')}</AlertDialogDescription></AlertDialogHeader>
      {review ? <p data-testid="financial-insurance-review"><span className="font-mono">{review.settlement.year}</span> · {detail(review.settlement)}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <AlertDialogFooter><AlertDialogCancel disabled={write?.mutation.isPending}>{t('取消', 'Cancel')}</AlertDialogCancel><Button disabled={write?.blocked} onClick={() => { if (review && latest) write?.mutation.mutate({ operation: 'inpatient.financial.insurance.confirm',
        input: { admissionId: bill.admissionId, adjustmentId: latest.adjustmentId, previewId: review.previewId, commitToken: review.commitToken } }) }}>{t('确认更正待遇', 'Confirm revised benefits')}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </section>
}
