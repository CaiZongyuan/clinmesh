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
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Write = ReturnType<typeof useInpatientWriteIntent>
export function InpatientCharges({ admissionId, session, locale, write }: { admissionId: string; session: SessionContext; locale: WorkspaceLocale; write: Write }): React.JSX.Element {
  const charges = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admissionId, 'charges'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admissionId}/charges`, inpatientChargesSchema, signal) })
  return <>{charges.error ? <p role="alert">{getWorkspaceErrorMessage(charges.error, getWorkspaceMessages(locale))}</p> : null}
    {charges.data ? <InpatientChargeList data={charges.data} locale={locale} write={write} /> : null}</>
}
export function InpatientChargeList({ data, locale, write }: { data: z.infer<typeof inpatientChargesSchema>; locale: WorkspaceLocale; write?: Write }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [reason, setReason] = useState('')
  const reversedIds = new Set(data.charges.flatMap(charge => charge.reversalOf === undefined ? [] : [charge.reversalOf]))
  return <section aria-label={t('住院费用明细', 'Inpatient charges')} data-theme="paper" className="flex flex-col gap-3"><h3 className="font-serif font-bold">{t('费用明细', 'Charges')}</h3>
    {write ? <Field><FieldLabel htmlFor="inpatient-reversal-reason">{t('冲正理由', 'Reversal reason')}</FieldLabel><Input id="inpatient-reversal-reason" value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field> : null}
    <Table><TableHeader><TableRow><TableHead>{t('日期 / 项目', 'Date / item')}</TableHead><TableHead className="text-right">{t('金额', 'Amount')}</TableHead><TableHead>{t('状态', 'Status')}</TableHead></TableRow></TableHeader><TableBody>
      {data.charges.map(charge => {
        const reversed = reversedIds.has(charge.id)
        return <TableRow key={charge.id} className={reversed ? 'text-muted-foreground' : undefined}>
          <TableCell>{charge.serviceDate} · {charge.label}</TableCell>
          <TableCell className="whitespace-nowrap text-right"><span className="font-mono tabular-nums">{formatFen(charge.amountFen, locale)}</span></TableCell>
          <TableCell className="whitespace-nowrap">
            {charge.reversalOf !== undefined ? <><Badge variant="outline">{t('关联冲正', 'Linked reversal')}</Badge><span className="mt-0.5 block font-mono text-xs text-muted-foreground">{t('关联原账 ', 'Reverses ')}{charge.reversalOf}</span></>
              : reversed ? <Badge variant="outline">{t('已冲正', 'Reversed')}</Badge> : write ? <Button variant="outline" disabled={write.blocked || data.financialStatus !== 'open' || !reason.trim()}
              onClick={() => write.mutation.mutate({ operation: 'inpatient.charge.reverse', input: { admissionId: data.admissionId, chargeId: charge.id, expectedChargeVersion: charge.version, reason } })}>{t('冲正', 'Reverse')}</Button> : t('已入账', 'Recorded')}
          </TableCell>
        </TableRow>
      })}
    </TableBody></Table><p>{t('费用净额：', 'Net charges: ')}<span className="font-mono font-semibold tabular-nums">{formatFen(data.chargesFen, locale)}</span></p>
  </section>
}
