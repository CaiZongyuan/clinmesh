import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { inpatientSurgeryCatalogSchema, inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Fragment, useState } from 'react'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { InpatientSurgeryCompletion } from './inpatient-surgery-completion.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { ChevronRightIcon } from 'lucide-react'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; execution: z.infer<typeof inpatientSurgeryExecutionSchema>;
  request: z.infer<typeof inpatientSurgeryRequestSchema>; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined;
  reservations: InpatientMaterialReservation[]; running: boolean; refresh: () => Promise<unknown>; onOpenDrg?: (() => void) | undefined }

const remaining = (item: InpatientMaterialReservation) => item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)

export function InpatientSurgeryMaterials({ admission, session, locale, write, execution, request, catalog, reservations, running, refresh, onOpenDrg }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const time = (value: string) => new Date(value).toLocaleTimeString(locale, { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })
  const [materialId, setMaterialId] = useState<string | null>(null), [quantity, setQuantity] = useState('1'), [note, setNote] = useState('')
  const [extra, setExtra] = useState(false)
  const [correctFor, setCorrectFor] = useState<string | null>(null), [correctTo, setCorrectTo] = useState('void')
  const [correctQuantity, setCorrectQuantity] = useState('1'), [correctNote, setCorrectNote] = useState('')
  const materials = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  const writable = session.actor.roleCode === 'inpatient-doctor' && admission.recordStatus !== 'archived' && admission.financialStatus === 'open'
  const common = { admissionId: admission.id, requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id }
  const usable = (id: string | null, version?: number) => reservations.filter(item => item.status === 'reserved' && item.materialId === id && remaining(item) > 0
    && (item.catalogVersion === undefined || version === undefined || item.catalogVersion === version) && (!item.requestId || item.requestId === request.id))
    .sort((left, right) => Number(right.requestId === request.id) - Number(left.requestId === request.id))
  const selection = (id: string | null, amountText: string, preferred?: string | null) => {
    const material = materials.find(item => item.id === id), amount = Number(amountText)
    if (!material || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1000) return null
    const candidates = usable(material.id, material.version)
    const reservation = preferred === null ? undefined : candidates.find(item => item.id === preferred) ?? candidates[0]
    return { material, amount, reservation, input: { materialId: material.id, catalogVersion: material.version, quantity: amount,
      ...(reservation ? { reservationId: reservation.id, expectedReservationVersion: reservation.version } : {}) } }
  }
  const material = materials.find(item => item.id === materialId)
  const left = usable(materialId, material?.version)[0]
  const entry = selection(materialId, quantity, extra ? null : undefined)
  const overReserved = entry?.reservation !== undefined && entry.amount > remaining(entry.reservation)
  const register = () => { if (entry && !overReserved && note.trim()) write.mutation.mutate({ operation: 'inpatient.surgery.record-material', input: { ...common, note: note.trim(), material: entry.input } },
    { onSuccess: () => { setMaterialId(null); setQuantity('1'); setNote(''); setExtra(false) } }) }
  const correcting = execution.materialHistory.find(use => use.id === correctFor)
  const replacement = correcting && correctTo !== 'void' ? selection(correctTo === 'quantity' ? correcting.item.id : correctTo, correctQuantity, correctTo === 'quantity' ? correcting.reservationId : undefined) : null
  const correctionReady = correcting !== undefined && correctNote.trim().length > 0 && (correctTo === 'void' || replacement !== null)
  const correct = () => { if (correcting && correctionReady) write.mutation.mutate({ operation: 'inpatient.surgery.correct-material', input: { ...common, note: correctNote.trim(), materialUseId: correcting.id,
    ...(replacement ? { replacement: replacement.input } : {}) } }, { onSuccess: () => setCorrectFor(null) }) }
  const planned = reservations.filter(item => item.requestId === request.id)
  const ids = [...new Set([...planned.map(item => item.materialId), ...execution.materialHistory.map(use => use.item.id)])]
  const live = execution.materials.reduce((sum, use) => sum + use.amountFen, 0)
  const correctionBar = correcting ? <InpatientPrimaryAction stage="surgery" priority={60} fallback={null}><WorkspaceActionBar summary={correcting.item.display} tone={correctionReady ? 'normal' : 'blocked'}
    reason={correctionReady ? t('原记录保留，另记费用退回', 'The original record is kept and a charge reversal is recorded') : t('还差：更正依据', 'Enter the correction basis')}
    action={<><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setCorrectFor(null)}>{t('取消', 'Cancel')}</Button><Button disabled={write.blocked || !correctionReady} onClick={correct}>{t('确认更正', 'Confirm correction')}</Button></>} /></InpatientPrimaryAction> : null
  return <section aria-label={t('本台耗材', 'Materials for this surgery')} className="flex min-w-0 flex-col gap-3">
    {running ? <div className="clinmesh-inpatient-summary">
      <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{t('手术进行中', 'Surgery in progress')} · {execution.actualProcedure.coding.display}</h4><span className="font-mono text-xs text-muted-foreground">{execution.actualProcedure.coding.code}</span></div>
      <dl className="grid gap-3 text-sm @lg:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('计划术式', 'Planned procedure')}</dt><dd>{request.plannedProcedure.coding.code === execution.actualProcedure.coding.code ? t('与实际相同', 'Same as performed') : request.plannedProcedure.coding.display}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t('开始', 'Started')}</dt><dd className="tabular-nums">{new Date(execution.performedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t('开始说明', 'Start note')}</dt><dd>{execution.note}</dd></div></dl>
    </div> : null}
    <div className="flex flex-wrap items-baseline gap-2"><h4 className="text-sm font-semibold">{t('本台耗材', 'Materials for this surgery')}</h4><span className="text-xs text-muted-foreground">{t('按笔登记即计费；更正保留原记录并另记退回', 'Each entry is charged; corrections keep the original and record a reversal')}</span></div>
    <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('计划预留', 'Reserved')}</TableHead><TableHead>{t('本笔用量', 'Entry')}</TableHead><TableHead className="text-right">{t('费用', 'Charge')}</TableHead><TableHead className="w-px" /></TableRow></TableHeader>
      <TableBody>{ids.length === 0 ? <TableRow><TableCell colSpan={5} className="text-muted-foreground">{t('尚无本计划预留或耗材登记。', 'No reservations or material entries for this plan.')}</TableCell></TableRow> : null}
        {ids.flatMap(id => {
          const own = planned.filter(item => item.materialId === id), uses = execution.materialHistory.filter(use => use.item.id === id)
          const display = own[0]?.materialDisplay ?? uses[0]?.item.display ?? id, unit = own[0]?.unit ?? uses[0]?.item.chargeDefinition.unit ?? ''
          const reservedQuantity = own.reduce((sum, item) => sum + item.quantity, 0), reservedLeft = own.reduce((sum, item) => sum + remaining(item), 0)
          const reserved = own.length > 0 ? <>{reservedQuantity} {unit}{reservedLeft > 0 ? <span className="text-xs text-muted-foreground"> · {t('剩', 'left')} {reservedLeft}</span> : null}</> : <span className="text-muted-foreground">—</span>
          if (uses.length === 0) return [<TableRow key={id}><TableCell className="whitespace-normal">{display}</TableCell><TableCell className="tabular-nums">{reserved}</TableCell><TableCell className="text-muted-foreground">{t('未使用', 'Not used')}</TableCell><TableCell className="text-right text-muted-foreground">—</TableCell><TableCell /></TableRow>]
          return uses.map((use, index) => <Fragment key={use.id}>
            <TableRow aria-label={`${use.item.display} × ${use.quantity}${use.item.chargeDefinition.unit}`} className={use.correction ? 'text-muted-foreground' : undefined}>
              <TableCell className="whitespace-normal">{index === 0 ? display : <span aria-hidden="true" className="text-muted-foreground">〃</span>}</TableCell>
              <TableCell className="tabular-nums">{index === 0 ? reserved : null}</TableCell>
              <TableCell className="tabular-nums"><span className={use.correction ? 'line-through' : undefined}>{use.quantity} {use.item.chargeDefinition.unit}</span> <span className="text-xs text-muted-foreground">· {time(use.recordedAt)}{use.reservationId ? '' : ` · ${t('额外使用', 'additional use')}`}</span></TableCell>
              <TableCell className="text-right tabular-nums">{use.correction ? use.correction.replacementMaterialUseId ? t('已更正', 'Corrected') : t('已撤销', 'Voided') : formatFen(use.amountFen, locale)}</TableCell>
              <TableCell className="text-right">{writable && !use.correction ? <Button variant="ghost" size="sm" aria-label={`${t('更正', 'Correct')} ${use.item.display} × ${use.quantity}`} aria-expanded={correctFor === use.id} disabled={write.blocked}
                onClick={() => { setCorrectFor(correctFor === use.id ? null : use.id); setCorrectTo('void'); setCorrectQuantity(String(use.quantity)); setCorrectNote('') }}>{t('更正', 'Correct')}</Button> : null}</TableCell>
            </TableRow>
            {correctFor === use.id ? <TableRow className="bg-muted/50 hover:bg-muted/50"><TableCell colSpan={5} className="whitespace-normal"><FieldGroup className="grid gap-3 @lg:grid-cols-3">
              <Field><FieldLabel htmlFor={`surgery-correct-to-${use.id}`}>{t('更正方式', 'Correction')}</FieldLabel><WorkspaceSelect id={`surgery-correct-to-${use.id}`} value={correctTo} onValueChange={value => setCorrectTo(value ?? 'void')} items={[
                { value: 'void', label: t('撤销这笔，不替换', 'Void without replacement') }, { value: 'quantity', label: `${t('改数量', 'Change quantity')}（${use.item.display}）` },
                ...materials.filter(item => item.id !== use.item.id).map(item => ({ value: item.id, label: `${t('改为 ', 'Change to ')}${item.display}` }))]} /></Field>
              {correctTo !== 'void' ? <Field><FieldLabel htmlFor={`surgery-correct-quantity-${use.id}`}>{t('更正后数量', 'Corrected quantity')}</FieldLabel><Input id={`surgery-correct-quantity-${use.id}`} type="number" min="1" max="1000" step="1" value={correctQuantity} onChange={event => setCorrectQuantity(event.target.value)} /></Field> : null}
              <Field><FieldLabel htmlFor={`surgery-correct-note-${use.id}`}>{t('更正依据', 'Correction basis')}</FieldLabel><Input id={`surgery-correct-note-${use.id}`} maxLength={2000} value={correctNote} onChange={event => setCorrectNote(event.target.value)} /></Field>
            </FieldGroup></TableCell></TableRow> : null}
          </Fragment>)
        })}</TableBody></Table>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span>{t('已登记耗材 ', 'Recorded materials ')}<b className="font-semibold text-foreground tabular-nums">{formatFen(live, locale)}</b></span>
      {running ? <span>{t('术式费 ', 'Procedure fee ')}<b className="font-semibold text-foreground tabular-nums">{formatFen(execution.actualProcedure.chargeDefinition.priceFen, locale)}</b>{t(' 在完成手术时计入', ' is posted at completion')}</span> : null}
      <span className="flex-1" /><SurgeryDrgLink locale={locale} onOpenDrg={onOpenDrg} />
    </div>
    {execution.materialHistory.length > 0 ? <details className="clinmesh-inpatient-disclosure"><summary>{t('登记与更正记录', 'Entry and correction history')}（{execution.materialHistory.length}）</summary>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">{execution.materialHistory.map(use => <p key={use.id}>{new Date(use.recordedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })} · {use.item.display} × {use.quantity} · {use.note}{use.correction ? ` · ${t('已更正：', 'Corrected: ')}${use.correction.note}` : ''}</p>)}</div></details> : null}
    {running && writable ? <section aria-label={t('登记本笔使用', 'Record a material entry')} className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{t('登记本笔使用', 'Record a material entry')}</h4><span className="flex-1" />
        <Button variant="outline" disabled={write.blocked || !entry || overReserved || !note.trim()} onClick={register}>{t('登记这笔', 'Record entry')}</Button></div>
      <FieldGroup className="grid gap-3 @lg:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.6fr)]">
        <Field><FieldLabel htmlFor={`surgery-entry-material-${execution.id}`}>{t('耗材', 'Material')}</FieldLabel><WorkspaceSelect id={`surgery-entry-material-${execution.id}`} value={materialId} disabled={write.blocked} items={materials.map(item => ({ value: item.id, label: item.display }))} onValueChange={id => { setMaterialId(id); setExtra(false) }} /></Field>
        <Field><FieldLabel htmlFor={`surgery-entry-quantity-${execution.id}`}>{t('数量', 'Quantity')}</FieldLabel><Input id={`surgery-entry-quantity-${execution.id}`} type="number" min="1" max="1000" step="1" disabled={write.blocked} value={quantity} onChange={event => setQuantity(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor={`surgery-entry-note-${execution.id}`}>{t('依据', 'Basis')}</FieldLabel><Input id={`surgery-entry-note-${execution.id}`} maxLength={2000} disabled={write.blocked} value={note} onChange={event => setNote(event.target.value)} /></Field>
      </FieldGroup>
      {material ? <FieldDescription className="flex flex-wrap items-center gap-2">
        <span>{formatFen(material.chargeDefinition.priceFen, locale)}/{material.chargeDefinition.unit}</span>
        {left ? <><span>· {t('本计划还预留', 'Reserved for this plan')} {remaining(left)} {material.chargeDefinition.unit}：</span>
          <span role="group" aria-label={t('本笔是否消耗预留', 'Consume reservation')} className="inline-flex gap-1">
            <Button size="sm" variant={extra ? 'ghost' : 'secondary'} aria-pressed={!extra} onClick={() => setExtra(false)}>{t('消耗预留', 'Consume reservation')}</Button>
            <Button size="sm" variant={extra ? 'secondary' : 'ghost'} aria-pressed={extra} onClick={() => setExtra(true)}>{t('额外使用，不消耗预留', 'Additional use without reservation')}</Button></span></>
          : planned.some(item => item.materialId === material.id) ? <span>· {t('本计划预留已用完，这笔记为额外使用。', 'Reservation used up; this entry is additional use.')}</span> : null}
        {overReserved ? <span className="text-destructive">{t('超过剩余预留，可改为额外使用。', 'Exceeds the remaining reservation; record as additional use instead.')}</span> : null}
      </FieldDescription> : null}
    </section> : null}
    {correctionBar}
    {running && writable ? <InpatientSurgeryCompletion execution={execution} request={request} catalog={catalog} reservations={reservations} locale={locale} write={write} refresh={refresh}
      summary={`${t('已登记 ', 'Recorded ')}${execution.materials.length}${t(' 笔 · ', ' entries · ')}${formatFen(live, locale)}`} /> : null}
  </section>
}

/** 费用只写一行，分组与支付由 DRG 预分组页签统一呈现。 */
export function SurgeryDrgLink({ locale, onOpenDrg }: { locale: WorkspaceLocale; onOpenDrg: (() => void) | undefined }): React.JSX.Element | null {
  if (!onOpenDrg) return null
  return <Button variant="link" size="sm" className="h-auto px-0 text-info" onClick={onOpenDrg}>{locale === 'zh-CN' ? '分组与支付见 DRG 预分组' : 'Grouping and payment under DRG'}<ChevronRightIcon aria-hidden="true" data-icon="inline-end" /></Button>
}
