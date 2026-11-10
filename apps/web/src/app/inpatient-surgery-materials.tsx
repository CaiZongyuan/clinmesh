import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { inpatientSurgeryCatalogSchema, inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Fragment, useEffect, useState } from 'react'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { InpatientSurgeryCompletion } from './inpatient-surgery-completion.tsx'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { ChevronRightIcon } from 'lucide-react'
import { correctionDraftScope, useCorrectionBatchDraft, type CorrectionRow } from './inpatient-correction-batch.ts'
import { InpatientCorrectionComposer } from './inpatient-correction-composer.tsx'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; execution: z.infer<typeof inpatientSurgeryExecutionSchema>;
  request: z.infer<typeof inpatientSurgeryRequestSchema>; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined;
  reservations: InpatientMaterialReservation[]; dataReady: boolean; running: boolean; active?: boolean; inDialog?: boolean; refresh: () => Promise<unknown>; onOpenDrg?: (() => void) | undefined }

const remaining = (item: InpatientMaterialReservation) => item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)

export function InpatientSurgeryMaterials({ admission, session, locale, write, execution, request, catalog, reservations, dataReady, running, active = true, inDialog = false, refresh, onOpenDrg }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const time = (value: string) => new Date(value).toLocaleTimeString(locale, { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })
  const [materialId, setMaterialId] = useState<string | null>(null), [quantity, setQuantity] = useState('1'), [note, setNote] = useState('')
  const [extra, setExtra] = useState(false)
  const [supplementReservationId, setSupplementReservationId] = useState<string | null>(null)
  const successfulCommand = write.mutation.data?.command
  useEffect(() => {
    if (successfulCommand?.operation !== 'inpatient.surgery.record-material' && successfulCommand?.operation !== 'inpatient.surgery.supplement-material') return
    if (successfulCommand.input.admissionId !== admission.id || successfulCommand.input.requestId !== request.id || successfulCommand.input.executionId !== execution.id) return
    { setMaterialId(null); setQuantity('1'); setNote(''); setExtra(false); setSupplementReservationId(null) }
  }, [successfulCommand, admission.id, request.id, execution.id])
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), [selectionError, setSelectionError] = useState('')
  const scope = correctionDraftScope({ session, patientId: admission.patientId, admissionId: admission.id, requestId: request.id, executionId: execution.id })
  const corrections = useCorrectionBatchDraft({ scope, session, write })
  const materials = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  const writable = session.actor.roleCode === 'inpatient-doctor' && admission.recordStatus !== 'archived' && admission.financialStatus === 'open'
  const supplement = !running && request.status === 'completed' && admission.status === 'admitted'
  const common = { admissionId: admission.id, requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id }
  const usable = (id: string | null, version?: number, restoredId?: string | null, restoredQuantity = 0) => reservations.filter(item =>
    ((item.status === 'reserved' && remaining(item) > 0) || (item.id === restoredId && item.quantity - item.consumedQuantity + restoredQuantity > 0))
    && item.materialId === id && (item.catalogVersion === undefined || version === undefined || item.catalogVersion === version) && (!item.requestId || item.requestId === request.id))
    .sort((left, right) => Number(right.requestId === request.id) - Number(left.requestId === request.id))
  const selection = (id: string | null, amountText: string, preferred?: string | null, restoredQuantity = 0) => {
    const material = materials.find(item => item.id === id), amount = Number(amountText)
    if (!material || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1000) return null
    const candidates = usable(material.id, material.version, preferred, restoredQuantity)
    const reservation = preferred === null ? undefined : preferred === undefined ? candidates[0] : candidates.find(item => item.id === preferred)
    if (preferred !== undefined && preferred !== null && !reservation) return null
    return { material, amount, reservation, input: { materialId: material.id, catalogVersion: material.version, quantity: amount,
      ...(reservation ? { reservationId: reservation.id, expectedReservationVersion: reservation.version } : {}) } }
  }
  const material = materials.find(item => item.id === materialId)
  const left = usable(materialId, material?.version)[0]
  const supplementReservations = usable(materialId, material?.version).filter(item => item.unit === material?.chargeDefinition.unit)
  const supplementReservationUnavailable = supplement && supplementReservationId !== null && !supplementReservations.some(item => item.id === supplementReservationId)
  const entry = supplementReservationUnavailable ? null : selection(materialId, quantity, supplement ? supplementReservationId : extra ? null : undefined)
  const entryCharge = entry ? { ...entry.material.chargeDefinition, priceFen: entry.reservation?.priceFen ?? entry.material.chargeDefinition.priceFen } : null
  const overReserved = entry?.reservation !== undefined && entry.amount > remaining(entry.reservation)
  const register = () => { if (entry && entryCharge && !overReserved && note.trim()) write.mutation.mutate(supplement
    ? { operation: 'inpatient.surgery.supplement-material', input: { ...common, note: note.trim(), material: entry.input,
      expectedCharge: { id: entryCharge.id, priceFen: entryCharge.priceFen, unit: entryCharge.unit } } }
    : { operation: 'inpatient.surgery.record-material', input: { ...common, note: note.trim(), material: entry.input } }) }
  const filtered = execution.materialHistory.filter(use => `${use.item.display} ${use.note}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / 10)), shownPage = Math.min(page, pages)
  const visible = filtered.slice((shownPage - 1) * 10, shownPage * 10)
  const editable = active && writable && !corrections.busy && !corrections.blocked
  const addCorrections = (uses: typeof execution.materialHistory) => {
    const toAdd = uses.filter(use => !use.correction && !corrections.value.rows.some(row => row.id === use.id))
    if (corrections.value.rows.length + toAdd.length > 20) { setSelectionError(t('每次最多20笔，原输入已保留，请减少选择。', 'Up to 20 entries. Input is kept; reduce the selection.')); return }
    const added: CorrectionRow[] = toAdd.map(original => ({ id: original.id, revision: crypto.randomUUID(), binding: { admissionId: admission.id, requestId: request.id, executionId: execution.id },
      original, selected: true, mode: 'void', material: materials.find(item => item.id === original.item.id) ?? original.item, quantity: String(original.quantity), reservation: null, reason: '' }))
    corrections.save({ ...corrections.value, rows: [...corrections.value.rows.map(row => uses.some(use => use.id === row.id) ? { ...row, selected: true, revision: crypto.randomUUID() } : row), ...added] })
    setSelectionError('')
  }
  const planned = reservations.filter(item => item.requestId === request.id)
  const ids = [...new Set([...(!search ? planned.filter(item => !execution.materialHistory.some(use => use.item.id === item.materialId)).map(item => item.materialId) : []), ...visible.map(use => use.item.id)])]
  const live = execution.materials.reduce((sum, use) => sum + use.amountFen, 0)
  const pendingCommand = write.pending?.command
  const ownPending = pendingCommand && (pendingCommand.operation === 'inpatient.surgery.supplement-material' || pendingCommand.operation === 'inpatient.surgery.correct-material')
    && pendingCommand.input.admissionId === admission.id && pendingCommand.input.requestId === request.id && pendingCommand.input.executionId === execution.id
  const readOnlyReason = admission.recordStatus === 'archived' ? t('病案已归档，不能补登记或更正耗材。', 'The record is archived; material entries are read-only.')
    : admission.financialStatus !== 'open' ? t('住院账户已结算，不能补登记或更正耗材。', 'The account is settled; material entries are read-only.')
    : admission.status !== 'admitted' ? t('患者已离院，不能补登记耗材。', 'Materials cannot be added after departure.')
    : session.actor.roleCode !== 'inpatient-doctor' ? t('仅住院医生可以补登记或更正耗材。', 'Only an inpatient doctor can add or correct materials.') : null
  return <section aria-label={t('本台耗材', 'Materials for this surgery')} className="flex min-w-0 flex-col gap-3">
    {running ? <div className="clinmesh-inpatient-summary">
      <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{t('手术进行中', 'Surgery in progress')} · {execution.actualProcedure.coding.display}</h4><span className="font-mono text-xs text-muted-foreground">{execution.actualProcedure.coding.code}</span></div>
      <dl className="grid gap-3 text-sm @lg:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('计划术式', 'Planned procedure')}</dt><dd>{request.plannedProcedure.coding.code === execution.actualProcedure.coding.code ? t('与实际相同', 'Same as performed') : request.plannedProcedure.coding.display}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t('开始', 'Started')}</dt><dd className="tabular-nums">{formatShanghaiMinute(execution.performedAt)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t('开始说明', 'Start note')}</dt><dd>{execution.note}</dd></div></dl>
    </div> : null}
    <div className="flex flex-wrap items-baseline gap-2"><h4 className="text-sm font-semibold">{t('本台耗材', 'Materials for this surgery')}</h4><span className="text-xs text-muted-foreground">{t('按笔登记即计费；更正保留原记录并另记退回', 'Each entry is charged; corrections keep the original and record a reversal')}</span></div>
    {execution.materialHistory.length > 0 ? <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={t('搜索原耗材记录', 'Search original material entries')} value={search} className="min-w-0 flex-1" onChange={event => { setSearch(event.target.value); setPage(1) }} />
      {writable ? <Button type="button" variant="outline" size="sm" disabled={!editable || visible.every(use => use.correction)} onClick={() => addCorrections(visible)}>{t('全选当前页可更正记录', 'Select correctable entries on this page')}</Button> : null}
      <span className="text-xs text-muted-foreground">{shownPage}/{pages}</span><Button type="button" variant="ghost" size="sm" disabled={shownPage === 1} onClick={() => setPage(shownPage - 1)}>{t('上一页', 'Previous')}</Button><Button type="button" variant="ghost" size="sm" disabled={shownPage === pages} onClick={() => setPage(shownPage + 1)}>{t('下一页', 'Next')}</Button>
    </div> : null}
    {selectionError ? <p role="alert" className="text-sm text-destructive">{selectionError}</p> : null}
    <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('计划预留', 'Reserved')}</TableHead><TableHead>{t('本笔用量', 'Entry')}</TableHead><TableHead className="text-right">{t('费用', 'Charge')}</TableHead><TableHead className="w-px" /></TableRow></TableHeader>
      <TableBody>{ids.length === 0 ? <TableRow><TableCell colSpan={5} className="text-muted-foreground">{t('尚无本计划预留或耗材登记。', 'No reservations or material entries for this plan.')}</TableCell></TableRow> : null}
        {ids.flatMap(id => {
          const own = planned.filter(item => item.materialId === id), uses = visible.filter(use => use.item.id === id)
          const display = own[0]?.materialDisplay ?? uses[0]?.item.display ?? id, unit = own[0]?.unit ?? uses[0]?.item.chargeDefinition.unit ?? ''
          const reservedQuantity = own.reduce((sum, item) => sum + item.quantity, 0), reservedLeft = own.reduce((sum, item) => sum + remaining(item), 0)
          const reserved = own.length > 0 ? <>{reservedQuantity} {unit}{reservedLeft > 0 ? <span className="text-xs text-muted-foreground"> · {t('剩', 'left')} {reservedLeft}</span> : null}</> : <span className="text-muted-foreground">—</span>
          if (uses.length === 0) return [<TableRow key={id}><TableCell className="whitespace-normal">{display}</TableCell><TableCell className="tabular-nums">{reserved}</TableCell><TableCell className="text-muted-foreground">{t('未使用', 'Not used')}</TableCell><TableCell className="text-right text-muted-foreground">—</TableCell><TableCell /></TableRow>]
          return uses.map((use, index) => <Fragment key={use.id}>
            <TableRow aria-label={`${use.item.display} × ${use.quantity}${use.item.chargeDefinition.unit}`} className={use.correction ? 'text-muted-foreground' : undefined}>
              <TableCell className="whitespace-normal">{index === 0 ? display : <span aria-hidden="true" className="text-muted-foreground">〃</span>}</TableCell>
              <TableCell className="tabular-nums">{index === 0 ? reserved : null}</TableCell>
              <TableCell className="tabular-nums"><span className={use.correction ? 'line-through' : undefined}>{use.quantity} {use.item.chargeDefinition.unit}</span> <span className="text-xs text-muted-foreground">· {time(use.recordedAt)}{use.recordingKind === 'postoperative-addendum' ? ` · ${t('术后补登记', 'Postoperative addendum')}` : ''}{use.reservationId ? '' : ` · ${t('额外使用', 'additional use')}`}</span></TableCell>
              <TableCell className="text-right tabular-nums">{use.correction ? use.correction.replacementMaterialUseId ? t('已更正', 'Corrected') : t('已撤销', 'Voided') : formatFen(use.amountFen, locale)}</TableCell>
              <TableCell className="text-right">{writable && !use.correction ? <Button variant="ghost" size="sm" aria-label={`${t('更正', 'Correct')} ${use.item.display} × ${use.quantity}`} aria-pressed={corrections.value.rows.some(row => row.id === use.id && row.selected)} disabled={!editable}
                onClick={() => addCorrections([use])}>{corrections.value.rows.some(row => row.id === use.id) ? t('已加入', 'Added') : t('更正', 'Correct')}</Button> : null}</TableCell>
            </TableRow>
          </Fragment>)
        })}</TableBody></Table>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span>{t('已登记耗材 ', 'Recorded materials ')}<b className="font-semibold text-foreground tabular-nums">{formatFen(live, locale)}</b></span>
      {running ? <span>{t('术式费 ', 'Procedure fee ')}<b className="font-semibold text-foreground tabular-nums">{formatFen(execution.actualProcedure.chargeDefinition.priceFen, locale)}</b>{t(' 在完成手术时计入', ' is posted at completion')}</span> : null}
      <span className="flex-1" /><SurgeryDrgLink locale={locale} onOpenDrg={onOpenDrg} />
    </div>
    {(running || supplement) && writable ? <section aria-label={supplement ? t('补登记耗材', 'Add omitted material') : t('登记本笔使用', 'Record a material entry')} className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{supplement ? t('补登记耗材', 'Add omitted material') : t('登记本笔使用', 'Record a material entry')}</h4></div>
      {running ? (() => {
        const remainingList = planned.filter(item => item.status === 'reserved' && remaining(item) > 0)
        const nextItem = remainingList[0]
        if (!nextItem) return null
        const summaryText = remainingList.map(item => `${item.materialDisplay.replace(/^合成演示/, '')} ${remaining(item)}${item.unit ? ` ${item.unit}` : ''}`).join(t('、', ', '))
        const nextLabel = `${nextItem.materialDisplay.replace(/^合成演示/, '')} 1${nextItem.unit ? ` ${nextItem.unit}` : ''}`
        return <div className="flex flex-wrap items-center gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs">
          <span className="rounded border border-info/40 px-1 py-0.5 text-[11px] font-semibold text-info">{t('助手', 'Assistant')}</span>
          <span>{t(`预留还剩：${summaryText}。下一笔多为${nextLabel}。`, `Remaining reservation: ${summaryText}. Next entry is typically ${nextLabel}.`)}</span>
          <Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs text-info" disabled={write.blocked}
            onClick={() => { setMaterialId(nextItem.materialId); setQuantity('1'); setExtra(false) }}>{t('填入', 'Fill in')}</Button>
        </div>
      })() : null}
      <FieldGroup className="grid gap-3 @lg:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.6fr)_auto] @lg:items-end">
        <Field><FieldLabel htmlFor={`surgery-entry-material-${execution.id}`}>{t('耗材', 'Material')}</FieldLabel><WorkspaceSelect id={`surgery-entry-material-${execution.id}`} value={materialId} disabled={write.blocked} items={materials.map(item => {
          const rem = usable(item.id, item.version).reduce((sum, r) => sum + remaining(r), 0)
          return { value: item.id, label: rem > 0 ? `${item.display} · ${formatFen(item.chargeDefinition.priceFen, locale)}/${item.chargeDefinition.unit} · ${t('剩余预留 ', 'reserved ')}${rem}` : item.display }
        })} onValueChange={id => { setMaterialId(id); setExtra(false); setSupplementReservationId(null) }} /></Field>
        <Field><FieldLabel htmlFor={`surgery-entry-quantity-${execution.id}`}>{t('数量', 'Quantity')}</FieldLabel><Input id={`surgery-entry-quantity-${execution.id}`} type="number" min="1" max="1000" step="1" disabled={write.blocked} value={quantity} onChange={event => setQuantity(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor={`surgery-entry-note-${execution.id}`}>{supplement ? t('补登记依据', 'Addendum basis') : t('依据', 'Basis')}</FieldLabel><Input id={`surgery-entry-note-${execution.id}`} maxLength={2000} placeholder={supplement ? t('说明漏记的实际使用及核实依据', 'Describe the omitted use and verification basis') : t('例如：前降支近段植入', 'e.g. implanted in proximal LAD')} disabled={write.blocked} value={note} onChange={event => setNote(event.target.value)} /></Field>
        <Button variant="outline" data-unavailable={!write.mutation.isPending && (write.blocked || !entry || overReserved || !note.trim()) || undefined} disabled={write.blocked || !entry || overReserved || !note.trim()} onClick={register}>{supplement ? t('确认补登记', 'Confirm addendum') : t('登记这笔', 'Record entry')}</Button>
      </FieldGroup>
      {supplement && material ? <Field><FieldLabel htmlFor={`surgery-addendum-reservation-${execution.id}`}>{t('预留处理', 'Reservation handling')}</FieldLabel>
        <WorkspaceSelect id={`surgery-addendum-reservation-${execution.id}`} value={supplementReservationId ?? 'additional'} disabled={write.blocked}
          items={[{ value: 'additional', label: t('额外使用，不消耗预留', 'Additional use without reservation') }, ...supplementReservations.map(item => ({ value: item.id,
            label: `${item.requestId ? t('本计划预留', 'Plan reservation') : t('住院通用预留', 'Admission reservation')} · ${formatShanghaiMinute(item.createdAt)} · ${remaining(item)} ${item.unit ?? material.chargeDefinition.unit} · ${formatFen(item.priceFen, locale)}/${item.unit ?? material.chargeDefinition.unit}` }))]}
          onValueChange={value => setSupplementReservationId(value === 'additional' ? null : value)} />
        <FieldDescription>{t('仅可消耗单位一致且计费依据完整的有效预留。已释放预留保持关闭；失效或依据不完整的预留不能消耗，可按当前目录登记额外使用。', 'Only active reservations with matching units and a complete charge basis can be used. Released reservations stay closed. Invalid or incomplete reservations cannot be consumed; additional use follows the current catalog.')}</FieldDescription>
        {supplementReservationUnavailable ? <FieldDescription className="text-destructive">{t('原选预留已变化，请重新核对预留处理。', 'The selected reservation changed. Review reservation handling again.')}</FieldDescription> : null}
      </Field> : null}
      {entry && entryCharge ? <p className="text-sm tabular-nums">{entry.material.display} · {entry.amount} {entryCharge.unit} × {formatFen(entryCharge.priceFen, locale)}/{entryCharge.unit} · <strong>{t('本笔新增费用 ', 'New charge ')}{formatFen(entryCharge.priceFen * entry.amount, locale)}</strong></p> : null}
      {material ? <FieldDescription className="flex flex-wrap items-center gap-2">
        {running ? <span>{formatFen(material.chargeDefinition.priceFen, locale)}/{material.chargeDefinition.unit}</span> : null}
        {left && running ? <><span>· {t('本计划还预留', 'Reserved for this plan')} {remaining(left)} {material.chargeDefinition.unit}：</span>
          <span role="group" aria-label={t('本笔是否消耗预留', 'Consume reservation')} className="inline-flex gap-1">
            <Button size="sm" variant={extra ? 'ghost' : 'secondary'} aria-pressed={!extra} onClick={() => setExtra(false)}>{t('消耗预留', 'Consume reservation')}</Button>
            <Button size="sm" variant={extra ? 'secondary' : 'ghost'} aria-pressed={extra} onClick={() => setExtra(true)}>{t('额外使用，不消耗预留', 'Additional use without reservation')}</Button></span></>
          : !left && planned.some(item => item.materialId === material.id) ? <span>· {t('本计划预留已用完或已释放，这笔记为额外使用。', 'Reservation used up or released; this entry is additional use.')}</span> : null}
        {overReserved ? <span className="text-destructive">{t('超过剩余预留，可改为额外使用。', 'Exceeds the remaining reservation; record as additional use instead.')}</span> : null}
      </FieldDescription> : null}
    </section> : !running && readOnlyReason ? <FieldDescription>{readOnlyReason}</FieldDescription> : null}
    {execution.materialHistory.length > 0 ? <details className="clinmesh-inpatient-disclosure"><summary>{t('登记与更正记录', 'Entry and correction history')}（{execution.materialHistory.length}）</summary>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">{execution.materialHistory.map(use => <p key={use.id}>{formatShanghaiMinute(use.recordedAt)} · {use.recordingKind === 'postoperative-addendum' ? `${t('术后补登记', 'Postoperative addendum')} · ` : ''}{use.recordedBy === session.actor.actorId ? session.user.name : use.recordedBy} · {use.item.display} × {use.quantity} · {use.note}{use.correction ? ` · ${t('已更正：', 'Corrected: ')}${use.correction.note}` : ''}</p>)}</div></details> : null}
    {inDialog && ownPending ? <InpatientWriteRecovery write={write} locale={locale} /> : null}
    {(writable || corrections.value.rows.length > 0 || corrections.items.length > 0) ? <InpatientCorrectionComposer draft={corrections} write={write} locale={locale} execution={execution} request={request} catalog={catalog} reservations={reservations} active={active} writable={writable} dataReady={dataReady} refresh={refresh} /> : null}
    {running && writable ? <InpatientSurgeryCompletion admission={admission} session={session} active={active} dataReady={dataReady} execution={execution} request={request} catalog={catalog} reservations={reservations} locale={locale} write={write} refresh={refresh}
      summary={`${t('已登记 ', 'Recorded ')}${execution.materials.length}${t(' 笔 · ', ' entries · ')}${formatFen(live, locale)}`} /> : null}
  </section>
}

/** 费用只写一行，分组与支付由 DRG 预分组页签统一呈现。 */
export function SurgeryDrgLink({ locale, onOpenDrg }: { locale: WorkspaceLocale; onOpenDrg: (() => void) | undefined }): React.JSX.Element | null {
  if (!onOpenDrg) return null
  return <Button variant="link" size="sm" className="h-auto px-0 text-info" onClick={onOpenDrg}>{locale === 'zh-CN' ? '分组与支付见 DRG 预分组' : 'Grouping and payment under DRG'}<ChevronRightIcon aria-hidden="true" data-icon="inline-end" /></Button>
}
