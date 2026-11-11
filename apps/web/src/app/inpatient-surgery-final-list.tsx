import { useId } from 'react'
import type { z } from 'zod'
import type { inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { Button } from '@clinmesh/ui/components/button'
import { FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { remainingAfterCompletion, type CompletionDraftRow } from './inpatient-surgery-completion-draft.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Props = { rows: CompletionDraftRow[]; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined;
  reservations: InpatientMaterialReservation[]; requestId: string; locale: WorkspaceLocale; disabled: boolean;
  rowProblem: (row: CompletionDraftRow) => string | null;
  onChange: (change: (previous: CompletionDraftRow[]) => CompletionDraftRow[], discard?: boolean) => void }

export function SurgeryFinalMaterialList({ rows, catalog, reservations, requestId, locale, disabled, rowProblem, onChange }: Props) {
  const id = useId(), t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const available = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  return <FieldSet disabled={disabled} className="min-w-0">
    <p role="status" className="text-sm">{t(`最终耗材 ${rows.length} / 100 项`, `Final materials ${rows.length} / 100 items`)}</p>
    <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('已登记', 'Recorded')}</TableHead><TableHead>{t('最终总量', 'Final total')}</TableHead><TableHead>{t('剩余预留', 'Remaining reservation')}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={4} className="whitespace-normal text-muted-foreground">{t('尚无逐笔使用或本计划预留，可直接新增真实用量；全部未用可保持空清单。', 'No use or reservations yet. Add actual materials, or leave the list empty if none were used.')}</TableCell></TableRow> : null}
      {rows.map((row, index) => {
        const reservation = reservations.find(item => item.id === row.reservationId && (!item.requestId || item.requestId === requestId) && item.status !== 'released')
        const remainingAfter = reservation ? remainingAfterCompletion(reservation, rows) : null
        const current = row.materialUseIds.length === 0 && !reservation ? available.find(item => item.id === row.materialId && item.version === row.catalogVersion) : undefined
        const priceFen = current?.chargeDefinition.priceFen ?? row.priceFen, unit = current?.chargeDefinition.unit ?? row.unit ?? t('单位未确认', 'Unknown unit')
        const problem = rowProblem(row)
        return <TableRow key={row.key}>
          <TableCell className="whitespace-normal"><div>{row.display}</div><div className="text-xs text-muted-foreground tabular-nums">{formatFen(priceFen, locale)}/{unit}{reservation ? '' : ` · ${t('额外使用，不消耗预留', 'additional use')}`}</div>
            {row.materialUseIds.length === 0 ? <div className="mt-1 flex flex-wrap items-center gap-2">
              <WorkspaceSelect id={`${id}-reservation-${index}`} ariaLabel={`${t('明确选择本项预留', 'Select this reservation explicitly')} ${index + 1}`} value={row.reservationId ?? ''} items={[
                { value: '', label: t('额外使用，不消耗预留', 'Additional use without reservation') },
                ...reservations.filter(item => item.materialId === row.materialId && item.catalogVersion === row.catalogVersion && item.status === 'reserved'
                  && item.unit !== null && (!item.requestId || item.requestId === requestId) && !rows.some((other, i) => i !== index && other.reservationId === item.id))
                  .map(item => ({ value: item.id, label: `${t('预留 ', 'Reservation ')}${t('余量', 'remaining')} ${item.remainingQuantity} · ${formatFen(item.priceFen, locale)} · ${item.reason}` })),
              ]} onValueChange={reservationId => onChange(previous => previous.map((item, i) => {
                if (i !== index) return item
                const selected = reservations.find(item => item.id === reservationId), current = available.find(value => value.id === row.materialId)
                return { ...item, reservationId: reservationId || undefined, expectedReservationVersion: selected?.version, priceFen: selected?.priceFen ?? current?.chargeDefinition.priceFen ?? item.priceFen,
                  unit: selected?.unit ?? current?.chargeDefinition.unit ?? item.unit }
              }))} />
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange(previous => previous.filter((_item, i) => i !== index), true)}>{t('移除此新增项', 'Remove this added item')} {index + 1}</Button>
            </div> : null}</TableCell>
          <TableCell className="tabular-nums">{row.previousQuantity} {row.unit ?? ''}</TableCell>
          <TableCell><Input aria-label={`${row.display} · ${t('最终总量', 'Final quantity')} ${index + 1}`} className="w-20" type="number" min="0" max="1000" step="1" value={row.quantity} aria-invalid={problem !== null || undefined}
            onChange={event => onChange(previous => previous.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))} />{problem ? <p className="whitespace-normal text-xs text-destructive">{problem}</p> : null}</TableCell>
          <TableCell>{reservation && remainingAfter !== null ? <span className="whitespace-normal text-xs">{t('本预留合计剩余', 'Combined remaining')} {Math.max(0, remainingAfter)} {reservation.unit ?? ''}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
        </TableRow>
      })}</TableBody></Table>
  </FieldSet>
}
