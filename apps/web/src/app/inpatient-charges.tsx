import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientPaymentsSchema } from '@clinmesh/contracts/inpatient-discharge'
import { InpatientFunding } from './inpatient-funding.tsx'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

type Write = ReturnType<typeof useInpatientWriteIntent>
export function InpatientCharges({ admissionId, admission, session, locale, write }: { admissionId: string; admission?: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: Write }): React.JSX.Element {
  const charges = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admissionId, 'charges'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admissionId}/charges`, inpatientChargesSchema, signal) })
  const funds = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admissionId, 'payments'], enabled: admission !== undefined,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admissionId}/payments`, inpatientPaymentsSchema, signal) })
  return <>{charges.isPending ? <Skeleton className="h-24 w-full" /> : null}{charges.error ? <p role="alert">{locale === 'zh-CN' ? '费用读取失败：' : 'Charges failed to load: '}{getWorkspaceErrorMessage(charges.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void charges.refetch()}>{locale === 'zh-CN' ? '重试费用' : 'Retry charges'}</Button></p> : null}
    {charges.data ? <InpatientChargeList data={charges.data} locale={locale} write={write} /> : null}
    {admission && funds.data ? <InpatientFunding admission={admission} statement={funds.data} locale={locale} write={write} collect={false} stage="fees" /> : null}</>
}
export function InpatientChargeList({ data, locale, write }: { data: z.infer<typeof inpatientChargesSchema>; locale: WorkspaceLocale; write?: Write }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [reason, setReason] = useState('')
  const [selectedChargeId, setSelectedChargeId] = useState<string | null>(null)
  const reversedIds = new Set(data.charges.flatMap(charge => charge.reversalOf === undefined ? [] : [charge.reversalOf]))
  const reversibleCharges = data.charges.filter(charge => charge.reversalOf === undefined && !reversedIds.has(charge.id))
  const targetCharge = reversibleCharges.find(charge => charge.id === selectedChargeId) ?? reversibleCharges[0]
  const formatShortDate = (date: string) => date.length >= 10 ? date.slice(5, 10) : date
  return <section aria-label={t('住院费用明细', 'Inpatient charges')} className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-bold">{t('费用明细', 'Charges')}</h3>
      <span className="text-xs text-muted-foreground">{t('共 ', 'Total ')}{data.charges.length}{t(' 项 · 合计 ', ' items · ')}<strong className="text-foreground tabular-nums">{formatFen(data.chargesFen, locale)}</strong></span>
    </div>
    <Table><TableHeader><TableRow><TableHead>{t('日期', 'Date')}</TableHead><TableHead>{t('项目', 'Item')}</TableHead><TableHead className="text-right">{t('金额', 'Amount')}</TableHead><TableHead>{t('状态', 'Status')}</TableHead></TableRow></TableHeader><TableBody>
      {data.charges.map(charge => {
        const reversed = reversedIds.has(charge.id)
        return <TableRow key={charge.id} className={reversed ? 'text-muted-foreground' : undefined}>
          <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatShortDate(charge.serviceDate)}</TableCell>
          <TableCell>{charge.label}</TableCell>
          <TableCell className="whitespace-nowrap text-right"><span className="font-semibold tabular-nums">{formatFen(charge.amountFen, locale)}</span></TableCell>
          <TableCell className="whitespace-nowrap">
            {charge.reversalOf !== undefined ? <><Badge variant="outline">{t('关联退费', 'Linked charge correction')}</Badge><span className="mt-0.5 block text-xs text-muted-foreground">{t('关联原账 ', 'Corrects ')}{data.charges.find(item => item.id === charge.reversalOf)?.label ?? t('原费用', 'Original charge')}</span></>
              : reversed ? <Badge variant="outline">{t('已退费', 'Charge corrected')}</Badge> : <Badge variant="secondary">{t('已记账', 'Recorded')}</Badge>}
          </TableCell>
        </TableRow>
      })}
    </TableBody></Table>
    {data.charges.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无费用；已办理的床位、医嘱和手术费用会在这里列出。', 'No charges yet. Bed, order and surgery charges appear here after they are recorded.')}</p> : null}
    <p className="text-right text-sm">{t('费用合计：', 'Total charges: ')}<span className="font-semibold tabular-nums">{formatFen(data.chargesFen, locale)}</span></p>
    {write && data.financialStatus === 'open' && reversibleCharges.length > 0 ? <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-xs font-semibold">{t('费用冲正（退费）', 'Charge reversal')}</strong>
        <span className="text-xs text-muted-foreground">{t('结清封账前可对错记费用发起退费', 'Reverse misrecorded charges before settlement')}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="inpatient-reversal-charge">{t('退费项目', 'Charge item')}</FieldLabel>
          <WorkspaceSelect id="inpatient-reversal-charge" value={targetCharge?.id ?? null} onValueChange={setSelectedChargeId}
            items={reversibleCharges.map(charge => ({ value: charge.id, label: `${formatShortDate(charge.serviceDate)} · ${charge.label}（${formatFen(charge.amountFen, locale)}）` }))} />
        </Field>
        <Field>
          <FieldLabel htmlFor="inpatient-reversal-reason">{t('退费理由', 'Charge correction reason')}</FieldLabel>
          <div className="flex gap-2">
            <Input id="inpatient-reversal-reason" placeholder={t('填写退费原因后退费', 'Enter reason for reversal')} value={reason} onChange={event => setReason(event.currentTarget.value)} />
            <Button variant="outline" disabled={write.blocked || !targetCharge || !reason.trim()}
              onClick={() => { if (targetCharge) write.mutation.mutate({ operation: 'inpatient.charge.reverse', input: { admissionId: data.admissionId, chargeId: targetCharge.id, expectedChargeVersion: targetCharge.version, reason } }) }}>{t('退费', 'Correct charge')}</Button>
          </div>
        </Field>
      </div>
    </div> : null}
  </section>
}
