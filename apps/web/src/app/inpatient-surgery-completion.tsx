import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { z } from 'zod'
import { inpatientSurgeryCompletionPreviewSchema, type inpatientSurgeryCompletionReviewInputSchema,
  type inpatientSurgeryCatalogSchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ApiClientError, apiMutation } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

type Props = { execution: z.infer<typeof inpatientSurgeryExecutionSchema>; request: z.infer<typeof inpatientSurgeryRequestSchema>;
  catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; reservations: InpatientMaterialReservation[];
  write: ReturnType<typeof useInpatientWriteIntent>; locale: WorkspaceLocale; refresh: () => Promise<unknown> }
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
  return open ? <CompletionEditor {...props} onCancel={() => setOpen(false)} />
    : <Button variant="outline" disabled={props.write.blocked} onClick={() => setOpen(true)}>{t('核实最终耗材并完成手术', 'Review final materials and complete surgery')}</Button>
}

function CompletionEditor(props: Props & { onCancel: () => void }): React.JSX.Element {
  const { execution, request, catalog, reservations, write, locale, onCancel, refresh } = props
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
  const reviewError = write.mutation.error instanceof ApiClientError && write.mutation.error.code === 'INPATIENT_SURGERY_REVIEW_CONFLICT'
    && failedCommand?.operation === 'inpatient.surgery.complete' && failedCommand.input.executionId === execution.id ? write.mutation.error : null
  const failedReview = reviewError !== null && failedCommand?.operation === 'inpatient.surgery.complete'
    && failedCommand.input.reconciliation?.expectedFingerprint === preview.data?.fingerprint
  const error = preview.error ?? reviewError
  const reviewed = !failedReview && preview.isSuccess && preview.variables.basis === basis && JSON.stringify(preview.variables.input) === JSON.stringify(input)
  const refreshBasis = useMutation({ retry: false, mutationFn: refresh, onSuccess: () => preview.reset() })
  const valid = note.trim().length > 0 && rows.every(row => row.quantity.trim() !== '' && Number.isSafeInteger(Number(row.quantity)) && Number(row.quantity) >= 0 && Number(row.quantity) <= 1000)
  const blocked = write.blocked || preview.isPending || refreshBasis.isPending
  return <section aria-label={t('核实最终耗材', 'Review final materials')} className="flex flex-col gap-3 rounded-md border p-3">
    <FieldSet disabled={blocked}><FieldLegend>{t('核实最终耗材', 'Review final materials')}</FieldLegend><FieldGroup>
      <p>{t('按真实最终总量核实；仅追加与当前净使用的差额。原预留默认保留，释放须逐项选择。', 'Enter the true final totals. Only the difference from current net use is recorded. Reservations are retained unless explicitly selected for release.')}</p>
      {rows.length === 0 ? <p>{t('尚无逐笔使用或本计划预留，可直接新增真实用量；全部未用可保持空清单。', 'No use or reservations yet. Add actual materials, or leave the list empty if none were used.')}</p> : null}
      {rows.map((row, index) => {
        const reservation = reservations.find(item => item.id === row.reservationId)
        const current = row.materialUseIds.length === 0 && !reservation ? available.find(item => item.id === row.materialId && item.version === row.catalogVersion) : undefined
        const priceFen = current?.chargeDefinition.priceFen ?? row.priceFen, unit = current?.chargeDefinition.unit ?? row.unit
        return <Field key={index}>
          <FieldLabel htmlFor={`final-material-${execution.id}-${index}`}>{row.display} · {t('最终总量', 'Final quantity')} {index + 1}</FieldLabel>
          <p className="break-words text-sm text-muted-foreground">{row.materialId} · v{row.catalogVersion} · {formatFen(priceFen, locale)}/{unit ?? t('单位未确认', 'Unknown unit')} · {t('当前净使用', 'Current net use')} {row.previousQuantity}</p>
          {reservation ? <p className="break-words text-sm">{t('原预留', 'Original reservation')} {reservation.id} · v{reservation.version} · {t('原数量', 'Reserved')} {reservation.quantity} · {t('已用', 'Used')} {reservation.consumedQuantity} · {t('余量', 'Remaining')} {reservation.remainingQuantity ?? 0} · {reservation.reason}</p> : <p>{t('额外使用，不消耗预留', 'Additional use without reservation')}</p>}
          <Input id={`final-material-${execution.id}-${index}`} type="number" min="0" max="1000" step="1" value={row.quantity}
            onChange={event => setRows(previous => previous.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))} />
          {row.materialUseIds.length === 0 ? <>
            <FieldLabel htmlFor={`final-reservation-${execution.id}-${index}`}>{t('明确选择本项预留', 'Select this reservation explicitly')} {index + 1}</FieldLabel>
            <WorkspaceSelect id={`final-reservation-${execution.id}-${index}`} value={row.reservationId ?? ''} items={[
              { value: '', label: t('额外使用，不消耗预留', 'Additional use without reservation') },
              ...reservations.filter(item => item.materialId === row.materialId && item.catalogVersion === row.catalogVersion && item.status === 'reserved'
                && item.unit !== null && (!item.requestId || item.requestId === request.id) && !rows.some((other, i) => i !== index && other.reservationId === item.id))
                .map(item => ({ value: item.id, label: `${item.id} · ${t('余量', 'Remaining')} ${item.remainingQuantity} · ${formatFen(item.priceFen, locale)} · ${item.reason}` })),
            ]} onValueChange={id => setRows(previous => previous.map((item, i) => {
              if (i !== index) return item
              const selected = reservations.find(item => item.id === id), current = available.find(value => value.id === row.materialId)
              return { ...item, reservationId: id || undefined, priceFen: selected?.priceFen ?? current?.chargeDefinition.priceFen ?? item.priceFen,
                unit: selected?.unit ?? current?.chargeDefinition.unit ?? item.unit }
            }))} />
            <Button variant="outline" onClick={() => setRows(previous => previous.filter((_item, i) => i !== index))}>{t('移除此新增项', 'Remove this added item')} {index + 1}</Button>
          </> : null}
        </Field>
      })}
      <Field><FieldLabel htmlFor={`final-add-${execution.id}`}>{t('新增最终耗材', 'Add final material')}</FieldLabel>
        <WorkspaceSelect id={`final-add-${execution.id}`} value={null} items={rows.length >= 100 ? [] : available.map(item => ({ value: item.id, label: item.display }))}
          onValueChange={id => { const item = available.find(item => item.id === id); if (item) setRows(previous => [...previous, {
            materialId: item.id, catalogVersion: item.version, quantity: '1', materialUseIds: [], previousQuantity: 0, display: item.display,
            unit: item.chargeDefinition.unit, priceFen: item.chargeDefinition.priceFen,
          }]) }} />
      </Field>
      <FieldSet><FieldLegend>{t('明确处理原预留余量', 'Explicit reservation handling')}</FieldLegend><FieldGroup>
        {originalReservations.map(item => <Field key={item.id} orientation="horizontal"><Checkbox id={`final-release-${item.id}`} checked={releaseIds.includes(item.id)}
          onCheckedChange={checked => setReleaseIds(previous => checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
          <FieldLabel htmlFor={`final-release-${item.id}`} className="break-words">{t('释放完成后的余量', 'Release remainder after completion')} · {item.materialDisplay} · {item.id} · v{item.version} · {t('原数量', 'Reserved')} {item.quantity} · {formatFen(item.priceFen, locale)}/{item.unit ?? t('单位未确认', 'Unknown unit')}</FieldLabel></Field>)}
        <p>{t('未勾选项继续保留；其他手术及通用住院预留不由本次完成释放。', 'Unchecked reservations remain. Reservations for other surgeries or the admission are retained.')}</p>
      </FieldGroup></FieldSet>
      <Field><FieldLabel htmlFor={`final-note-${execution.id}`}>{t('最终用量核实依据', 'Final quantity review basis')}</FieldLabel><Input id={`final-note-${execution.id}`} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></Field>
      <Button variant="outline" disabled={blocked || !valid} onClick={() => preview.mutate({ input, basis })}>{preview.isPending ? t('正在预览差额', 'Previewing differences') : t('预览本次差额', 'Preview differences')}</Button>
    </FieldGroup></FieldSet>
    {error ? <Alert variant="destructive"><AlertDescription>{error instanceof ApiClientError && error.code === 'INPATIENT_SURGERY_REVIEW_CONFLICT'
      ? t(error.message, 'Sources are inconsistent. Refresh and review the original records before previewing again.')
      : getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={blocked} onClick={() => refreshBasis.mutate()}>{t('刷新核实依据，保留编辑', 'Refresh sources and retain edits')}</Button>
      <Button variant="outline" disabled={blocked} onClick={() => { setRows(initialRows(props)); preview.reset() }}>{t('重新带入当前用量', 'Reload current quantities')}</Button></div>
    {preview.data && !reviewed ? <Alert><AlertDescription>{t('输入或依据已变化，请重新预览后确认。', 'Inputs or sources changed. Preview again before confirming.')}</AlertDescription></Alert> : null}
    {reviewed && preview.data ? <>
      {preview.data.materials.map((row, index) => <article key={index} className="flex flex-col gap-1">
        <p>{row.item.display} · {t('当前', 'Current')} {row.previousQuantity} → {t('最终', 'Final')} {row.quantity} · {t('本次材料差额', 'Material difference')} {formatFen(row.deltaFen, locale)}</p>
        <p className="break-words text-sm">{t('本次确认计价依据', 'Confirmed pricing basis')} · {row.item.id} · v{row.item.version} · {formatFen(row.item.chargeDefinition.priceFen, locale)}/{row.item.chargeDefinition.unit}</p>
        {rows[index] && (rows[index]!.priceFen !== row.item.chargeDefinition.priceFen || rows[index]!.unit !== row.item.chargeDefinition.unit)
          ? <Alert><AlertDescription>{t('计价依据已变化，请按本次预览的单价及单位重新核实数量。', 'Pricing changed. Review quantities using the price and unit in this preview.')}</AlertDescription></Alert> : null}
      </article>)}
      <p>{t('本次材料差额合计', 'Total material difference')} {formatFen(preview.data.materialDeltaFen, locale)} · {t('一次术式费', 'Procedure fee')} {formatFen(preview.data.procedureAmountFen, locale)} · {t('本次净新增费用', 'Net new charges')} {formatFen(preview.data.totalDeltaFen, locale)}</p>
      {preview.data.retainedReservations.map(item => <p key={item.id} className="break-words">{t('未选预留保留', 'Unselected reservation retained')} · {item.materialDisplay} · {item.id}</p>)}
      <Button disabled={blocked || !valid} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.complete', input: {
        admissionId: input.admissionId, requestId: input.requestId, executionId: input.executionId, expectedRequestVersion: input.expectedRequestVersion, note: input.note,
        reconciliation: { finalMaterials: input.finalMaterials, releaseReservations: input.releaseReservations, expectedFingerprint: preview.data!.fingerprint },
      } })}>{t('确认完成本次手术', 'Complete this surgery')}</Button>
    </> : null}
    <Button variant="outline" disabled={write.blocked} onClick={onCancel}>{t('取消本次核实', 'Cancel review')}</Button>
  </section>
}
