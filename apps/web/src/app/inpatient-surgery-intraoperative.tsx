import { equivalentMaterialSuggestions } from '@clinmesh/core/inpatient-equivalent-materials'
import { type InpatientEquivalentMaterialSuggestion } from '@clinmesh/contracts/inpatient-pci-selection'
import { EquivalentMaterialAdvice } from './inpatient-equivalent-materials.tsx'
import type { z } from 'zod'
import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { inpatientSurgeryCatalogSchema, inpatientSurgeryExecutionSchema, inpatientSurgeryMaterialSelectionSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@clinmesh/ui/components/table'
import { Badge } from '@clinmesh/ui/components/badge'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Execution = z.infer<typeof inpatientSurgeryExecutionSchema>
type Catalog = z.infer<typeof inpatientSurgeryCatalogSchema>
type Props = { admissionId: string; session: SessionContext; locale: WorkspaceLocale; execution: Execution;
  catalog: Catalog | undefined; reservations: InpatientMaterialReservation[]; active: boolean; dataReady: boolean; editable: boolean;
  onCorrect: (uses: Execution['materialHistory']) => void;
  write: ReturnType<typeof useInpatientWriteIntent>; requestVersion: number }
const remaining = (item: InpatientMaterialReservation) => item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)
const extraReasons = [['首根未能通过病变，更换', 'First wire could not cross the lesion; replaced'], ['分支保护', 'Side branch protection'], ['术中污染更换', 'Replaced after contamination']] as const

export function IntraoperativeMaterialRows({ admissionId, session, locale, execution, catalog, reservations, active, dataReady, editable, onCorrect, write, requestVersion }: Props) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const query = useQuery({ queryKey: [...inpatientScopeKey(session), admissionId, 'drg-agent'], enabled: active, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admissionId}/drg/agent`, inpatientDrgAgentSchema, signal),
    refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false })
  const data = query.error === null ? query.data : undefined
  const [extraId, setExtraId] = useState<string | null>(null), [extraNote, setExtraNote] = useState(''), [otherOpen, setOtherOpen] = useState(false)
  const [otherId, setOtherId] = useState<string | null>(null), [quantity, setQuantity] = useState('1'), [otherNote, setOtherNote] = useState('')
  const [adopted, setAdopted] = useState<InpatientEquivalentMaterialSuggestion | null>(null)
  const own = reservations.filter(item => item.requestId === execution.requestId)
  const plan = data?.intraoperativePlans.find(item => item.requestId === execution.requestId)
  const items = catalog?.materials.filter(item => 'chargeDefinition' in item) ?? []
  const ids = [...new Set([...(plan?.items.map(item => item.materialId) ?? own.map(item => item.materialId)), ...execution.materials.map(use => use.item.id)])]
  const blocked = !editable || write.blocked || !dataReady
  const register = (material: z.infer<typeof inpatientSurgeryMaterialSelectionSchema>, note: string, clear: () => void) => {
    if (blocked || !note.trim()) return
    write.mutation.mutate({ operation: 'inpatient.surgery.record-material', input: { admissionId, requestId: execution.requestId,
      expectedRequestVersion: requestVersion, executionId: execution.id, material, note: note.trim().slice(0, 2000) } }, { onSuccess: clear })
  }
  const reviewLine = (use: Execution['materialHistory'][number], fallbackDeviation: boolean) => {
    const review = data?.intraoperativeReviews.find(item => item.materialUseId === use.id)
    if (!review && !fallbackDeviation) return null
    const costs = data?.costs
    const reference = costs?.projectedPaymentReference ?? costs?.currentPaymentReference
    const cachedQuantity = data?.usage.find(item => item.executionId === execution.id && item.materialId === use.item.id && item.catalogVersion === use.item.version)?.actualQuantity ?? 0
    const actualQuantity = execution.materials.filter(item => item.item.id === use.item.id && item.item.version === use.item.version).reduce((sum, item) => sum + item.quantity, 0)
    const pendingFen = review ? 0 : Math.max(0, actualQuantity - cachedQuantity) * use.item.chargeDefinition.priceFen
    const projected = costs && costs.projectionComplete !== false ? costs.components.projectedTotalFen + pendingFen : null
    return <TableRow key={`review-${use.id}`}><TableCell colSpan={5} className="whitespace-normal bg-muted/30">
      <div className="flex min-w-0 flex-col gap-1 text-xs">
        <p className="flex flex-wrap gap-x-3 tabular-nums"><span>{t('本笔金额 ', 'Entry charge ')}{formatFen(use.amountFen, locale)}</span>
          <span>{t('做完预计总费用 ', 'Projected total ')}{projected === null ? t('正在核对', 'Checking') : formatFen(projected, locale)}</span>
          <span>{t('离支付参考还剩 ', 'Reference headroom ')}{projected === null ? t('预计费用待核对', 'Projected charges under review') : !reference ? t('暂无支付参考', 'No payment reference') : formatFen(reference.referenceFen - projected, locale)}</span></p>
        {plan && review ? review.status === 'succeeded' && review.explanation ? <p><Badge variant="secondary" className="mr-2">{t('助手', 'Assistant')}</Badge>{review.explanation}{review.costExplanation ? ` ${review.costExplanation}` : ''}</p>
          : <p className="text-muted-foreground" role="status">{review.status === 'queued' || review.status === 'running' ? t('助手正在核对这笔计划外使用…', 'Assistant is reviewing this entry…') : t('助手未能说明', 'Assistant could not explain')}</p>
          : plan ? <p className="text-muted-foreground">{t('助手未能说明', 'Assistant could not explain')}</p> : null}
      </div>
    </TableCell></TableRow>
  }
  const otherMaterial = items.find(item => item.id === otherId), amount = Number(quantity)
  const equivalentSuggestions = otherMaterial && data?.costs && plan
    ? equivalentMaterialSuggestions(plan, [{ materialId: otherMaterial.id, catalogVersion: otherMaterial.version, quantity: amount }], data.costs, true) : []
  return <>
    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{t('本台耗材', 'Materials for this surgery')}</h4><span className="flex-1" />
      <Button variant="link" size="sm" onClick={() => setOtherOpen(value => !value)}>{otherOpen ? t('收起', 'Collapse') : t('登记计划外的其他耗材', 'Record another unplanned material')}</Button></div>
    <Table aria-label={t('术中耗材按行登记', 'Intraoperative material entries')}><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('计划', 'Planned')}</TableHead><TableHead>{t('已用', 'Used')}</TableHead><TableHead className="text-right">{t('费用', 'Charge')}</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>{ids.length === 0 ? <TableRow><TableCell colSpan={5} className="whitespace-normal text-muted-foreground">{t('尚无本计划耗材，可登记计划外的其他耗材。', 'No planned materials. You can record an unplanned material.')}</TableCell></TableRow> : null}
        {ids.map(id => {
          const plannedItem = plan?.items.find(item => item.materialId === id), reserved = own.filter(item => item.materialId === id)
          const uses = execution.materialHistory.filter(use => use.item.id === id && !use.correction)
          const used = execution.materials.filter(use => use.item.id === id).reduce((sum, use) => sum + use.quantity, 0)
          const material = items.find(item => item.id === id), historical = execution.materials.find(use => use.item.id === id)?.item
          const display = plannedItem?.display ?? reserved[0]?.materialDisplay ?? historical?.display ?? id
          const unit = plannedItem?.unit ?? reserved[0]?.unit ?? historical?.chargeDefinition.unit ?? ''
          const plannedQuantity = plannedItem?.quantity ?? (reserved.length ? reserved.reduce((sum, item) => sum + item.quantity, 0) : 0)
          const basis = plannedItem?.quantityBasis ?? reserved[0]?.reason ?? ''
          const reservation = reserved.find(item => item.status === 'reserved' && remaining(item) > 0 && (item.catalogVersion === undefined || item.catalogVersion === material?.version))
          const plannedRemaining = Math.max(0, plannedQuantity - used)
          const plannedEntry = reservation && material ? Math.min(plannedRemaining, remaining(reservation), 1000) : 0
          const latest = uses.at(-1), over = used > plannedQuantity
          return <Fragment key={id}>
            <TableRow aria-label={`${display} × ${used}${unit}`}><TableCell className="max-w-[24rem] whitespace-normal"><span>{display}</span>{basis ? <p className="text-xs text-muted-foreground">{basis}</p> : null}</TableCell>
              <TableCell className="tabular-nums">{plannedQuantity || '—'} {unit}</TableCell><TableCell className="tabular-nums">{used ? `${used} ${unit}` : t('未用', 'Not used')}{over ? <Badge variant="secondary" className="ml-1">{t('多 ', 'Extra ')}{used - plannedQuantity}</Badge> : null}</TableCell>
              <TableCell className="text-right tabular-nums">{used ? formatFen(execution.materials.filter(use => use.item.id === id).reduce((sum, use) => sum + use.amountFen, 0), locale) : '—'}</TableCell>
              <TableCell className="whitespace-normal text-right"><div className="flex flex-wrap justify-end gap-1">
                {material && plannedEntry > 0 ? <Button size="sm" disabled={blocked} aria-label={`${t('用', 'Use')} ${plannedEntry} ${unit} ${display}`} onClick={() => register({ materialId: material.id, catalogVersion: material.version, quantity: plannedEntry,
                  reservationId: reservation!.id, expectedReservationVersion: reservation!.version }, `${t('按计划', 'As planned')} · ${basis}`, () => undefined)}>{t('用', 'Use')} {plannedEntry} {unit}</Button>
                  : material && extraId !== id ? <Button variant="link" size="sm" disabled={blocked} aria-label={`${t('再用', 'Use another')} 1 ${unit} ${display}`} onClick={() => { setExtraId(id); setExtraNote('') }}>{t('再用', 'Use another')} 1 {unit}</Button> : null}
                {uses.length ? <Button variant="ghost" size="sm" disabled={!editable} aria-label={`${t('更正', 'Correct')} ${display} × ${uses[0]!.quantity}`} onClick={() => onCorrect(uses)}>{t('更正', 'Correct')}</Button> : null}
              </div></TableCell></TableRow>
            {extraId === id && material ? <TableRow><TableCell colSpan={5} className="whitespace-normal bg-muted/30"><div className="flex min-w-0 flex-wrap items-end gap-2">
              <Field className="min-w-0 flex-1"><FieldLabel htmlFor={`extra-note-${execution.id}-${id}`}>{t('计划外再用 1 ', 'Use one extra ')}{unit}{t('，说明原因', '; explain why')}</FieldLabel>
                <div className="flex flex-wrap gap-1">{extraReasons.map(([cn, en]) => <Button key={cn} variant="outline" size="sm" disabled={blocked} onClick={() => setExtraNote(t(cn, en))}>{t(cn, en)}</Button>)}</div>
                <Input id={`extra-note-${execution.id}-${id}`} maxLength={2000} value={extraNote} disabled={blocked} placeholder={t('点上面的选项，或直接写', 'Choose a reason above or enter your own')} onChange={event => setExtraNote(event.target.value)} /></Field>
              <Button variant="ghost" size="sm" disabled={write.blocked} onClick={() => setExtraId(null)}>{t('取消', 'Cancel')}</Button>
              <Button size="sm" disabled={blocked || !extraNote.trim()} onClick={() => register({ materialId: material.id, catalogVersion: material.version, quantity: 1 }, extraNote, () => { setExtraId(null); setExtraNote('') })}>{t('登记这笔', 'Record entry')}</Button>
            </div></TableCell></TableRow> : latest ? reviewLine(latest, over || plannedQuantity === 0) : null}
          </Fragment>
        })}
      </TableBody></Table>
    {otherOpen ? <section aria-label={t('登记计划外的其他耗材', 'Record another unplanned material')}>
      <FieldGroup className="grid gap-3 @lg:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.6fr)_auto] @lg:items-end">
        <Field><FieldLabel htmlFor={`other-material-${execution.id}`}>{t('耗材', 'Material')}</FieldLabel><WorkspaceSelect id={`other-material-${execution.id}`} value={otherId} disabled={blocked} items={items.map(item => ({ value: item.id, label: item.display }))} onValueChange={setOtherId} /></Field>
        <Field><FieldLabel htmlFor={`other-quantity-${execution.id}`}>{t('数量', 'Quantity')}</FieldLabel><Input id={`other-quantity-${execution.id}`} type="number" min="1" max="1000" step="1" value={quantity} disabled={blocked} onChange={event => setQuantity(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor={`other-note-${execution.id}`}>{t('依据', 'Basis')}</FieldLabel><Input id={`other-note-${execution.id}`} maxLength={2000} value={otherNote} disabled={blocked} placeholder={t('例如：分支保护', 'e.g. side branch protection')} onChange={event => setOtherNote(event.target.value)} /></Field>
        <Button size="sm" disabled={blocked || !otherMaterial || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1000 || !otherNote.trim()}
          onClick={() => { if (otherMaterial) register({ materialId: otherMaterial.id, catalogVersion: otherMaterial.version, quantity: amount }, otherNote, () => { setOtherId(null); setQuantity('1'); setOtherNote('') }) }}>{t('登记这笔', 'Record entry')}</Button>
      </FieldGroup>
      <EquivalentMaterialAdvice locale={locale} suggestions={equivalentSuggestions} disabled={blocked}
        onPick={suggestion => { setOtherId(suggestion.to.id); setAdopted(suggestion) }}
        undo={adopted && otherId === adopted.to.id ? { savingsFen: adopted.totalSavingsFen, onUndo: () => { setOtherId(adopted.from.id); setAdopted(null) } } : undefined} />
    </section> : null}
  </>
}
