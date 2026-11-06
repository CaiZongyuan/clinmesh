import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { z } from 'zod'
import { inpatientSurgeryCompletionPreviewSchema, type inpatientSurgeryCompletionReviewInputSchema,
  type inpatientSurgeryCatalogSchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Input } from '@clinmesh/ui/components/input'
import { ApiClientError, apiMutation } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

type Props = { execution: z.infer<typeof inpatientSurgeryExecutionSchema>; request: z.infer<typeof inpatientSurgeryRequestSchema>;
  catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; reservations: InpatientMaterialReservation[];
  write: ReturnType<typeof useInpatientWriteIntent>; locale: WorkspaceLocale; refresh: () => Promise<unknown>; summary?: string }
type FinalRow = z.infer<typeof inpatientSurgeryCompletionReviewInputSchema>['finalMaterials'][number]
type DraftRow = Omit<FinalRow, 'quantity'> & { quantity: string; display: string; unit: string | null; priceFen: number; previousQuantity: number }

function initialRows({ execution, reservations, request }: Props): DraftRow[] {
  const rows: DraftRow[] = []
  const grouped = new Map<string, DraftRow>()
  for (const use of execution.materialHistory.filter(use => use.correction === null)) {
    const key = JSON.stringify([use.item, use.reservationId]), row = grouped.get(key)
    if (row) { row.materialUseIds.push(use.id); row.previousQuantity += use.quantity; row.quantity = String(row.previousQuantity); continue }
    rows.push({ materialId: use.item.id, catalogVersion: use.item.version, materialUseIds: [use.id], quantity: String(use.quantity),
      previousQuantity: use.quantity, display: use.item.display, unit: use.item.chargeDefinition.unit, priceFen: use.item.chargeDefinition.priceFen,
      ...(use.reservationId ? { reservationId: use.reservationId } : {}) })
    grouped.set(key, rows.at(-1)!)
  }
  for (const reservation of reservations.filter(item => item.requestId === request.id && item.status === 'reserved')) {
    if (rows.some(row => row.reservationId === reservation.id) || reservation.catalogVersion === undefined || reservation.unit === null) continue
    rows.push({ materialId: reservation.materialId, catalogVersion: reservation.catalogVersion, materialUseIds: [], quantity: '0', previousQuantity: 0,
      display: reservation.materialDisplay, unit: reservation.unit, priceFen: reservation.priceFen, reservationId: reservation.id })
  }
  return rows
}

export function InpatientSurgeryCompletion(props: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const t = (cn: string, en: string) => props.locale === 'zh-CN' ? cn : en
  const action = <Button disabled={props.write.blocked} onClick={() => setOpen(true)}>{t('核实最终耗材并完成手术', 'Review final materials and complete surgery')}</Button>
  return <>
    <InpatientPrimaryAction stage="surgery" priority={50} fallback={action}><WorkspaceActionBar summary={props.execution.actualProcedure.coding.display}
      reason={props.summary} action={action} /></InpatientPrimaryAction>
    {open ? <section role="dialog" aria-label={t('核实最终耗材并完成手术', 'Review final materials and complete surgery')} className="flex flex-col rounded-lg border bg-card shadow-sm">
      <div className="flex flex-col gap-1 border-b px-4 py-3">
        <h4 className="text-sm font-semibold">{t('核实最终耗材并完成手术', 'Review final materials and complete surgery')}</h4>
        <p className="text-xs text-muted-foreground">{t('按真实最终总量填写；只补登或冲减与已登记的差额。剩余预留默认保留，需要释放的逐项勾选。', 'Enter true final totals; only the difference from recorded use is posted. Remaining reservations are kept unless selected for release.')}</p>
      </div>
      <CompletionEditor {...props} onClose={() => { if (!props.write.mutation.isPending) setOpen(false) }} />
    </section> : null}
  </>
}

function CompletionEditor(props: Props & { onClose: () => void }): React.JSX.Element {
  const { execution, request, catalog, reservations, write, locale, refresh, onClose } = props
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [rows, setRows] = useState(() => initialRows(props)), [note, setNote] = useState('')
  const [releaseIds, setReleaseIds] = useState<string[]>([])
  const available = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  const originalReservations = reservations.filter(item => item.requestId === request.id && item.status !== 'released')
  const finalMaterials = rows.map(({ materialId, catalogVersion, quantity, materialUseIds, reservationId }) => ({
    materialId, catalogVersion, quantity: Number(quantity), materialUseIds,
    ...(reservationId ? { reservationId, expectedReservationVersion: reservations.find(item => item.id === reservationId)?.version } : {}),
  }))
  const input = { admissionId: execution.admissionId, requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id,
    note: note.trim(), finalMaterials, releaseReservations: originalReservations.filter(item => releaseIds.includes(item.id))
      .map(item => ({ reservationId: item.id, expectedReservationVersion: item.version })) }
  const basis = JSON.stringify({ execution, catalog, reservations })
  const preview = useMutation({ retry: false, mutationFn: ({ input }: { input: z.infer<typeof inpatientSurgeryCompletionReviewInputSchema>; basis: string }) =>
    apiMutation(`/api/his/v1/inpatient/admissions/${execution.admissionId}/surgeries/preview-completion`, inpatientSurgeryCompletionPreviewSchema,
      { input: { ...input, admissionId: undefined } }) })
  const failedCommand = write.mutation.variables
  const completeError = failedCommand?.operation === 'inpatient.surgery.complete' && failedCommand.input.executionId === execution.id ? write.mutation.error : null
  const reviewError = completeError instanceof ApiClientError && completeError.code === 'INPATIENT_SURGERY_REVIEW_CONFLICT' ? completeError : null
  const failedReview = reviewError !== null && failedCommand?.operation === 'inpatient.surgery.complete'
    && failedCommand.input.reconciliation?.expectedFingerprint === preview.data?.fingerprint
  const error = preview.error ?? completeError
  const reviewed = !failedReview && preview.isSuccess && preview.variables.basis === basis && JSON.stringify(preview.variables.input) === JSON.stringify(input)
  const refreshBasis = useMutation({ retry: false, mutationFn: refresh, onSuccess: () => preview.reset() })
  const valid = note.trim().length > 0 && rows.every(row => row.quantity.trim() !== '' && Number.isSafeInteger(Number(row.quantity)) && Number(row.quantity) >= 0 && Number(row.quantity) <= 1000)
  const blocked = write.blocked || preview.isPending || refreshBasis.isPending
  const remainingForRow = (row: DraftRow, item: InpatientMaterialReservation) => {
    const next = row.quantity.trim() !== '' && Number.isSafeInteger(Number(row.quantity)) ? Number(row.quantity) : row.previousQuantity
    return Math.max(0, item.quantity - (item.consumedQuantity - row.previousQuantity + next))
  }
  const unattached = originalReservations.filter(item => item.status === 'reserved' && !rows.some(row => row.reservationId === item.id))
  const release = (item: InpatientMaterialReservation, label: string) => <label className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
    <Checkbox aria-label={`${t('释放剩余预留', 'Release remaining reservation')} · ${item.materialDisplay}`} checked={releaseIds.includes(item.id)}
      onCheckedChange={checked => setReleaseIds(previous => checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />{label}</label>
  const submitComplete = async () => {
    if (blocked || !valid) return
    let expectedFingerprint = reviewed && preview.data ? preview.data.fingerprint : undefined
    if (!expectedFingerprint) {
      try {
        const res = await preview.mutateAsync({ input, basis })
        expectedFingerprint = res.fingerprint
      } catch {
        return
      }
    }
    write.mutation.mutate({
      operation: 'inpatient.surgery.complete',
      input: {
        admissionId: input.admissionId, requestId: input.requestId, executionId: input.executionId, expectedRequestVersion: input.expectedRequestVersion, note: input.note,
        reconciliation: { finalMaterials: input.finalMaterials, releaseReservations: input.releaseReservations, expectedFingerprint },
      },
    })
  }
  const hint = !valid ? t('还差：核实说明', 'Enter the review note') : t('确认后补登差额并计入术式费，手术结束', 'Confirmation posts the differences and procedure fee and completes surgery')
  const actionButtons = <>
    {reviewed && preview.data ? <Button type="button" variant="ghost" disabled={blocked} onClick={() => preview.reset()}>{t('改数量', 'Edit quantities')}</Button>
      : <Button type="button" variant="outline" disabled={write.mutation.isPending} onClick={onClose}>{t('取消', 'Cancel')}</Button>}
    {!reviewed ? <Button type="button" variant="outline" disabled={blocked || !valid} onClick={() => preview.mutate({ input, basis })}>{preview.isPending ? t('正在预览差额', 'Previewing differences') : t('预览本次差额', 'Preview differences')}</Button> : null}
    {!preview.data || reviewed ? <Button type="button" disabled={blocked || !valid} onClick={() => { void submitComplete() }}>{t('确认完成手术', 'Complete surgery')}</Button> : null}
  </>
  return <form className="flex min-h-0 flex-col p-0" onSubmit={event => event.preventDefault()}>
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"><InpatientWriteRecovery write={write} locale={locale} />
    <FieldSet disabled={blocked}><FieldGroup>
      <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('已登记', 'Recorded')}</TableHead><TableHead>{t('最终总量', 'Final total')}</TableHead><TableHead>{t('剩余预留', 'Remaining reservation')}</TableHead></TableRow></TableHeader>
        <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={4} className="whitespace-normal text-muted-foreground">{t('尚无逐笔使用或本计划预留，可直接新增真实用量；全部未用可保持空清单。', 'No use or reservations yet. Add actual materials, or leave the list empty if none were used.')}</TableCell></TableRow> : null}
        {rows.map((row, index) => {
          const reservation = originalReservations.find(item => item.id === row.reservationId), remainingAfter = reservation ? remainingForRow(row, reservation) : 0
          const current = row.materialUseIds.length === 0 && !reservation ? available.find(item => item.id === row.materialId && item.version === row.catalogVersion) : undefined
          const priceFen = current?.chargeDefinition.priceFen ?? row.priceFen, unit = current?.chargeDefinition.unit ?? row.unit ?? t('单位未确认', 'Unknown unit')
          return <TableRow key={index}>
            <TableCell className="whitespace-normal"><div>{row.display}</div><div className="text-xs text-muted-foreground tabular-nums">{formatFen(priceFen, locale)}/{unit}{reservation ? '' : ` · ${t('额外使用，不消耗预留', 'additional use')}`}</div>
              {row.materialUseIds.length === 0 ? <div className="mt-1 flex flex-wrap items-center gap-2">
                <WorkspaceSelect id={`final-reservation-${execution.id}-${index}`} ariaLabel={`${t('明确选择本项预留', 'Select this reservation explicitly')} ${index + 1}`} value={row.reservationId ?? ''} items={[
                  { value: '', label: t('额外使用，不消耗预留', 'Additional use without reservation') },
                  ...reservations.filter(item => item.materialId === row.materialId && item.catalogVersion === row.catalogVersion && item.status === 'reserved'
                    && item.unit !== null && (!item.requestId || item.requestId === request.id) && !rows.some((other, i) => i !== index && other.reservationId === item.id))
                    .map(item => ({ value: item.id, label: `${t('预留 ', 'Reservation ')}${t('余量', 'remaining')} ${item.remainingQuantity} · ${formatFen(item.priceFen, locale)} · ${item.reason}` })),
                ]} onValueChange={id => setRows(previous => previous.map((item, i) => {
                  if (i !== index) return item
                  const selected = reservations.find(item => item.id === id), current = available.find(value => value.id === row.materialId)
                  return { ...item, reservationId: id || undefined, priceFen: selected?.priceFen ?? current?.chargeDefinition.priceFen ?? item.priceFen,
                    unit: selected?.unit ?? current?.chargeDefinition.unit ?? item.unit }
                }))} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows(previous => previous.filter((_item, i) => i !== index))}>{t('移除此新增项', 'Remove this added item')} {index + 1}</Button>
              </div> : null}</TableCell>
            <TableCell className="tabular-nums">{row.previousQuantity} {row.unit ?? ''}</TableCell>
            <TableCell><Input aria-label={`${row.display} · ${t('最终总量', 'Final quantity')} ${index + 1}`} className="w-20" type="number" min="0" max="1000" step="1" value={row.quantity}
              onChange={event => setRows(previous => previous.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))} /></TableCell>
            <TableCell>{reservation && remainingAfter > 0 ? release(reservation, `${t('释放剩余预留 ', 'Release remaining ')}${remainingAfter} ${reservation.unit ?? ''}`) : <span className="text-muted-foreground">—</span>}</TableCell>
          </TableRow>
        })}</TableBody></Table>
      {unattached.map(item => <div key={item.id}>{release(item, `${t('释放剩余预留', 'Release remaining reservation')} · ${item.materialDisplay} × ${item.remainingQuantity ?? item.quantity - item.consumedQuantity}`)}</div>)}
      <Field><FieldLabel htmlFor={`final-add-${execution.id}`}>{t('新增最终耗材', 'Add final material')}</FieldLabel>
        <WorkspaceSelect id={`final-add-${execution.id}`} value={null} items={rows.length >= 100 ? [] : available.map(item => ({ value: item.id, label: item.display }))}
          onValueChange={id => { const item = available.find(item => item.id === id); if (item) setRows(previous => [...previous, {
            materialId: item.id, catalogVersion: item.version, quantity: '1', materialUseIds: [], previousQuantity: 0, display: item.display,
            unit: item.chargeDefinition.unit, priceFen: item.chargeDefinition.priceFen,
          }]) }} />
      </Field>
      <Field><FieldLabel htmlFor={`final-note-${execution.id}`}>{t('核实说明', 'Review note')}</FieldLabel><Input id={`final-note-${execution.id}`} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></Field>
    </FieldGroup></FieldSet>
    {error ? <Alert variant="destructive"><AlertDescription>{error instanceof ApiClientError && error.code === 'INPATIENT_SURGERY_REVIEW_CONFLICT'
      ? t(error.message, 'Sources are inconsistent. Refresh and review the original records before previewing again.')
      : getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => refreshBasis.mutate()}>{t('刷新核实依据，保留编辑', 'Refresh sources and retain edits')}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => { setRows(initialRows(props)); preview.reset() }}>{t('重新带入当前用量', 'Reload current quantities')}</Button></div>
    {preview.data && !reviewed ? <Alert><AlertDescription>{t('输入或依据已变化，请重新预览后确认。', 'Inputs or sources changed. Preview again before confirming.')}</AlertDescription></Alert> : null}
    {reviewed && preview.data ? <section aria-label={t('本次差额', 'Differences')} className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
      {preview.data.materials.map((row, index) => <div key={index} className="flex flex-col gap-1">
        {row.deltaQuantity !== 0 ? <p className="flex gap-3"><span className="flex-1">{row.item.display} {row.deltaQuantity > 0 ? t('补登', 'add') : t('冲减', 'reduce')} {Math.abs(row.deltaQuantity)} {row.item.chargeDefinition.unit}</span>{' '}<b className="tabular-nums">{formatFen(row.deltaFen, locale)}</b></p> : null}
        {rows[index] && (rows[index]!.priceFen !== row.item.chargeDefinition.priceFen || rows[index]!.unit !== row.item.chargeDefinition.unit)
          ? <Alert><AlertDescription>{t('计价依据已变化，请按本次预览的单价及单位重新核实数量。', 'Pricing changed. Review quantities using the price and unit in this preview.')}</AlertDescription></Alert> : null}
      </div>)}
      {originalReservations.filter(item => releaseIds.includes(item.id)).map(item => <p key={item.id} className="flex gap-3"><span className="flex-1">{t('释放预留', 'Release reservation')} · {item.materialDisplay}</span><b>—</b></p>)}
      {preview.data.retainedReservations.map(item => <p key={item.id} className="flex gap-3"><span className="flex-1">{t('保留预留', 'Keep reservation')} · {item.materialDisplay}</span><b>—</b></p>)}
      <p className="flex gap-3"><span className="flex-1">{t('耗材差额合计', 'Material difference')}</span>{' '}<b className="tabular-nums">{formatFen(preview.data.materialDeltaFen, locale)}</b></p>
      <p className="flex gap-3"><span className="flex-1">{t('术式费', 'Procedure fee')} · {execution.actualProcedure.coding.display}</span>{' '}<b className="tabular-nums">{formatFen(preview.data.procedureAmountFen, locale)}</b></p>
      <p className="flex gap-3 border-t pt-1.5 font-semibold"><span className="flex-1">{t('本次新增费用', 'New charges')}</span>{' '}<b className="tabular-nums">{formatFen(preview.data.totalDeltaFen, locale)}</b></p>
    </section> : null}
    </div>
    <InpatientPrimaryAction stage="surgery" priority={55} fallback={<div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3">{actionButtons}</div>}>
      <WorkspaceActionBar summary={hint} action={actionButtons} />
    </InpatientPrimaryAction>
  </form>
}
