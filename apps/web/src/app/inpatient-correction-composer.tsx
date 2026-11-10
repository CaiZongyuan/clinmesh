import type { z } from 'zod'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { inpatientMaterialItemSchema, inpatientSurgeryCatalogSchema, inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useId, useRef, useState } from 'react'
import { correctionInput, type CorrectionRow, type useCorrectionBatchDraft } from './inpatient-correction-batch.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Material = z.infer<typeof inpatientMaterialItemSchema>
type Props = { draft: ReturnType<typeof useCorrectionBatchDraft>; write: ReturnType<typeof useInpatientWriteIntent>; locale: WorkspaceLocale;
  execution: z.infer<typeof inpatientSurgeryExecutionSchema>; request: z.infer<typeof inpatientSurgeryRequestSchema>;
  catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; reservations: InpatientMaterialReservation[];
  active: boolean; writable: boolean; dataReady: boolean; refresh: () => Promise<unknown> }
const remaining = (item: InpatientMaterialReservation) => item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)
const rowLabel = (row: CorrectionRow) => `${row.original.item.display} × ${row.original.quantity}`

export function InpatientCorrectionComposer({ draft, write, locale, execution, request, catalog, reservations, active, writable, dataReady, refresh }: Props) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const id = useId(), { rows, commonReason } = draft.value, selected = rows.filter(row => row.selected)
  const [review, setReview] = useState<string | null>(null), [message, setMessage] = useState(''), [discard, setDiscard] = useState<string | null>(null)
  const [clearFailed, setClearFailed] = useState(false)
  const owner = `${request.id}:${execution.id}`, current = useRef({ owner, active, writable })
  current.current = { owner, active, writable }
  const isCurrent = () => current.current.owner === owner && current.current.active && current.current.writable
  const materials = (catalog?.materials ?? []).filter((item): item is Material => 'chargeDefinition' in item)
  const unknown = draft.items.some(item => item.status === 'unknown'), ready = draft.items.some(item => item.status === 'ready')
  const editable = active && writable && !draft.busy && !unknown && !write.blocked
  const locked = !editable || draft.failed
  const basis = JSON.stringify({ value: draft.value, requestVersion: request.version, history: execution.materialHistory, catalog, reservations })
  const edit = (row: CorrectionRow, change: Partial<CorrectionRow>) => {
    setReview(null); setMessage('')
    draft.save({ ...draft.value, rows: rows.map(item => item.id === row.id ? { ...item, ...change, revision: crypto.randomUUID() } : item) })
  }
  const issue = (row: CorrectionRow) => {
    const original = execution.materialHistory.find(item => item.id === row.id)
    if (!original || original.correction || JSON.stringify(original) !== JSON.stringify(row.original)) return t('原记录已更正或已变化，请移除此项并重新读取。', 'The original entry changed or was corrected. Remove it and reload.')
    if (row.mode !== 'void') {
      if (!dataReady) return t('替换耗材资料尚未读取完成，请重试。', 'Replacement data is not ready. Retry loading.')
      const material = materials.find(item => item.id === row.material?.id && item.version === row.material.version)
      if (!material || row.mode === 'quantity' && material.id !== original.item.id) return t('重新选择当前可用耗材。', 'Select a currently available material.')
      if (row.reservation) {
        const reservation = reservations.find(item => item.id === row.reservation?.id)
        if (!reservation || reservation.version !== row.reservation.version || reservation.materialId !== material.id
          || reservation.admissionId !== request.admissionId || reservation.requestId && reservation.requestId !== request.id) {
          return t('预留已变化，请重新核对并选择。', 'Reservation changed. Review and select it again.')
        }
        const restored = original.reservationId === reservation.id ? original.quantity : 0
        if (Number(row.quantity) > remaining(reservation) + restored) return t('替换数量超过更正退回后的可用预留。', 'Replacement exceeds the reservation after returning the original use.')
      }
    }
    if (!correctionInput(row, commonReason, request.version).success) return t('请填写实际数量及更正依据（1–1000、依据最多2000字）。', 'Enter the actual quantity (1–1000) and a correction basis (up to 2000 characters).')
    return null
  }
  const issues = selected.map(row => ({ row, issue: issue(row) })).filter(item => item.issue !== null)
  const describe = (row: CorrectionRow) => row.mode === 'void' ? t('撤销这笔，不替换', 'Void without replacement')
    : `${row.material?.display ?? t('未选耗材', 'No material')} × ${row.quantity} ${row.material?.chargeDefinition.unit ?? ''} · ${row.reservation ? t('使用已核对预留', 'Use reviewed reservation') : t('额外使用，不消耗预留', 'Additional use without reservation')}`
  const requestReview = () => {
    setMessage('')
    if (ready) draft.discardReady()
    if (selected.length === 0 || selected.length > 20 || issues.length || !editable || draft.failed) {
      setMessage(t('请先修正清单中标明的问题，再集中核对。', 'Resolve the highlighted issues before reviewing.')); return
    }
    if (draft.prepareBatch(request.version)) setReview(basis)
    else setMessage(t('未能保存本次核对，输入保留，请检查浏览器存储。', 'The review could not be saved. Input is kept. Check browser storage.'))
  }
  return <section aria-label={t('待更正清单', 'Pending corrections')} className="flex min-w-0 flex-col gap-3 border-t pt-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{t('待更正清单', 'Pending corrections')}（{rows.length}/20） · {t('已选 ', 'Selected ')}{selected.length}</h4>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" size="sm" disabled={!editable || rows.length === 0} onClick={() => { setReview(null); draft.save({ ...draft.value, rows: rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() })) }) }}>{t('清空选择', 'Clear selection')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!editable || rows.length === 0} onClick={() => { setClearFailed(false); setDiscard('all') }}>{t('清空更正输入', 'Discard correction input')}</Button></div>
    </div>
    <p className="text-xs text-muted-foreground">{t('每次最多20笔；同一种耗材的不同原登记分别更正。原记录保留并追加费用冲正，不代表现金退款。', 'Up to 20 entries. Separate original uses remain separate corrections. Originals and charge reversals are retained; this does not mean a cash refund.')}</p>
    {!writable ? <p role="status">{t('当前岗位、归档或结算状态不允许更正；未提交输入保留。', 'The current role, archive or settlement state prevents corrections. Input is kept.')}</p> : null}
    {draft.failed ? <Alert variant="destructive"><AlertDescription>{t('更正输入或原尝试的存储不可用，已阻止发送。原输入保留；请检查存储后重试。', 'Correction storage or original attempt is unavailable. Sending is blocked and input is kept. Check storage and retry.')}</AlertDescription><Button type="button" variant="outline" size="sm" disabled={!active || draft.busy || write.mutation.isPending} onClick={() => draft.retryStorage()}>{t('重试保存更正输入', 'Retry saving correction input')}</Button></Alert> : null}
    {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('从上方既有用量中选择需要更正的原记录。', 'Choose existing material entries above to correct.')}</p> : <>
      <Field><FieldLabel htmlFor={`${id}-common`}>{t('共同更正依据', 'Common correction basis')}</FieldLabel><Input id={`${id}-common`} maxLength={2000} disabled={!editable} value={commonReason} onChange={event => { setReview(null); draft.save({ ...draft.value, commonReason: event.target.value, rows: rows.map(row => ({ ...row, revision: crypto.randomUUID() })) }) }} /></Field>
      <div className="flex max-h-[min(45svh,440px)] min-h-0 flex-col gap-3 overflow-y-auto" tabIndex={0} aria-label={t('逐项更正输入', 'Correction entry inputs')}>
        {rows.map(row => { const label = rowLabel(row), problem = issue(row), material = row.material
          const usable = reservations.filter(item => item.materialId === material?.id && item.admissionId === request.admissionId
            && (!item.requestId || item.requestId === request.id) && (item.catalogVersion === undefined || item.catalogVersion === material?.version)
            && (item.status === 'reserved' && remaining(item) > 0 || item.id === row.original.reservationId))
          return <article key={row.id} aria-label={label} className="flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2"><Checkbox aria-label={`${t('选择更正', 'Select correction')} ${label}`} checked={row.selected} disabled={!editable} onCheckedChange={checked => edit(row, { selected: checked === true })} /><h5 className="min-w-0 flex-1 break-words font-medium">{label} {row.original.item.chargeDefinition.unit}</h5><Button type="button" variant="ghost" size="sm" disabled={!editable} onClick={() => { setClearFailed(false); setDiscard(row.id) }}>{t('移除输入', 'Remove input')}</Button></div>
            <p className="break-words text-xs text-muted-foreground">{formatShanghaiMinute(row.original.recordedAt)} · {row.original.note} · {t('原费用 ', 'Original charge ')}{formatFen(row.original.amountFen, locale)} · {row.original.reservationId ? t('原登记消耗预留', 'Original consumed reservation') : t('原登记为额外使用', 'Original additional use')}</p>
            <FieldGroup className="grid min-w-0 gap-3 @lg:grid-cols-2">
              <Field><FieldLabel htmlFor={`${id}-${row.id}-mode`}>{t('更正方式', 'Correction mode')}</FieldLabel><WorkspaceSelect id={`${id}-${row.id}-mode`} ariaLabel={`${t('更正方式', 'Correction mode')} ${label}`} value={row.mode} disabled={!editable} items={[
                { value: 'void', label: t('撤销这笔，不替换', 'Void without replacement') }, { value: 'quantity', label: t('改数量', 'Change quantity') }, { value: 'material', label: t('换材料', 'Replace material') },
              ]} onValueChange={mode => { const next = mode === 'quantity' ? materials.find(item => item.id === row.original.item.id) ?? row.original.item : mode === 'material' ? null : row.material
                edit(row, { mode: mode ?? 'void', material: next, reservation: null }) }} /></Field>
              {row.mode === 'material' ? <Field><FieldLabel htmlFor={`${id}-${row.id}-material`}>{t('替换耗材', 'Replacement material')}</FieldLabel><WorkspaceSelect id={`${id}-${row.id}-material`} ariaLabel={`${t('替换耗材', 'Replacement material')} ${label}`} value={material?.id ?? null} disabled={!editable || !dataReady} placeholder={t('请选择耗材', 'Choose material')} items={materials.map(item => ({ value: item.id, label: `${item.display} · ${formatFen(item.chargeDefinition.priceFen, locale)}/${item.chargeDefinition.unit}` }))} onValueChange={materialId => edit(row, { material: materials.find(item => item.id === materialId) ?? null, reservation: null })} /></Field> : null}
              {row.mode !== 'void' ? <>
                <Field data-invalid={row.selected && !!problem || undefined}><FieldLabel htmlFor={`${id}-${row.id}-quantity`}>{t('更正后数量', 'Corrected quantity')}</FieldLabel><Input id={`${id}-${row.id}-quantity`} aria-label={`${t('更正后数量', 'Corrected quantity')} ${label}`} type="number" min="1" max="1000" step="1" value={row.quantity} disabled={!editable} onChange={event => edit(row, { quantity: event.target.value })} /></Field>
                <Field><FieldLabel htmlFor={`${id}-${row.id}-reservation`}>{t('替换预留', 'Replacement reservation')}</FieldLabel><WorkspaceSelect id={`${id}-${row.id}-reservation`} ariaLabel={`${t('替换预留', 'Replacement reservation')} ${label}`} disabled={!editable || !dataReady || !material} value={row.reservation?.id ?? 'none'} items={[
                  { value: 'none', label: t('额外使用，不消耗预留', 'Additional use without reservation') }, ...usable.map((item, index) => ({ value: item.id, label: `${t('预留', 'Reservation')} ${index + 1} · ${item.materialDisplay} · ${t('当前剩余', 'remaining')} ${remaining(item)}${item.unit} ${item.id === row.original.reservationId ? t('（另退回原用量）', '(original quantity also returned)') : ''}` })),
                  ...(row.reservation && !usable.some(item => item.id === row.reservation?.id) ? [{ value: row.reservation.id, label: t('原选择已变化，请重新核对', 'Original selection changed; review again') }] : []),
                ]} onValueChange={reservationId => edit(row, { reservation: usable.find(item => item.id === reservationId) ?? null })} /></Field>
              </> : null}
              <Field><FieldLabel htmlFor={`${id}-${row.id}-reason`}>{t('逐项更正依据', 'Entry correction basis')}</FieldLabel><Input id={`${id}-${row.id}-reason`} aria-label={`${t('逐项更正依据', 'Entry correction basis')} ${label}`} maxLength={2000} placeholder={t('留空时使用共同更正依据', 'Uses common basis when blank')} disabled={!editable} value={row.reason} onChange={event => edit(row, { reason: event.target.value })} /></Field>
            </FieldGroup>
            <p className="break-words text-xs">{t('最终依据：', 'Final basis: ')}{row.reason.trim() || commonReason.trim() || t('尚未填写', 'Not entered')}</p>
            {row.selected && problem ? <p role="status" className="break-words text-xs text-destructive">{problem}</p> : null}
          </article>
        })}
      </div>
    </>}
    {message ? <Alert variant="destructive"><AlertDescription>{message}</AlertDescription></Alert> : null}
    {draft.items.length ? <section aria-label={t('逐项更正结果', 'Correction results')} className="flex flex-col gap-2 text-sm">
      <h5 className="font-medium">{t('逐项更正结果', 'Correction results')} · {t('成功 ', 'Succeeded ')}{draft.items.filter(item => item.status === 'success').length}/{draft.items.length}</h5>
      {draft.items.map(item => <p key={item.idempotencyKey} className="break-words">{item.label} · {item.status === 'success' ? t('已更正，原记录保留', 'Corrected; original retained') : item.status === 'failed' ? t('未生效，输入保留', 'Rejected; input kept') : item.status === 'unknown' ? t('结果待核实', 'Outcome unknown') : t('尚未发送', 'Not sent')} · {item.command.input.note}{item.error ? ` · ${item.error.message}` : ''}</p>)}
    </section> : null}
    {unknown ? <Alert><AlertDescription>{t('一笔更正结果待核实，已停止后续项目。恢复只核查原尝试；其余项目仍需重新核对。', 'One correction has an unknown outcome. Later items stopped. Recover the original attempt, then review remaining entries.')}</AlertDescription>
      <Button type="button" variant="outline" disabled={!active || !writable || draft.busy || write.mutation.isPending || draft.failed} onClick={() => { setReview(null); void draft.resume(isCurrent) }}>{t('恢复原更正结果', 'Recover original correction')}</Button></Alert> : null}
    {draft.paused ? <Alert><AlertDescription>{draft.pauseReason === 'reservation' ? t('前一笔已改变后续项关联的预留，余项已暂停。请读取当前余量，重新选择预留并核对。', 'An earlier correction changed a reservation used by a later entry. Remaining entries paused. Reload current quantities, select reservations again and review.')
      : t('原更正已恢复或未发送输入已变化，余项已暂停。请重读资料并逐项核对实际用量与预留，再继续办理。', 'The original correction was recovered or unsent input changed. Remaining entries paused. Reload and review actual quantities and reservations before proceeding.')}</AlertDescription></Alert> : null}
    {!unknown && ready && review === null ? <Button type="button" variant="outline" disabled={locked} onClick={async () => {
      if (!draft.discardReady()) return
      try { await refresh(); if (isCurrent()) setMessage(t('资料已重读；请重新核对预留与每项实际用量，再集中核对。', 'Data reloaded. Review reservations and actual quantities before confirming.')) }
      catch { if (isCurrent()) setMessage(t('资料读取失败，未提交输入保留，请重试。', 'Reload failed. Input is kept. Retry.')) }
    }}>{t('重新核对余项', 'Review remaining entries')}</Button> : null}
    {review !== null ? <section aria-label={t('更正核对清单', 'Correction review')} className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
      <h5 className="font-semibold">{t('本次核对 ', 'Review ')}{selected.length}{t(' 笔更正', ' corrections')}</h5>
      {selected.map(row => <p key={row.id} className="break-words">{rowLabel(row)} → {describe(row)} · {t('最终依据：', 'Final basis: ')}{row.reason.trim() || commonReason.trim()}</p>)}
      <p className="text-xs text-muted-foreground">{t('逐笔执行。成功项保留；同一预留受前项影响时暂停余项，重新核对后再办理。', 'Processed entry by entry. Successful corrections remain. If a prior entry changes a shared reservation, later entries pause for review.')}</p>
      {review !== basis ? <p role="status" className="text-destructive">{t('核对期间资料已变化，请重新核对。', 'Data changed during review. Review again.')}</p> : null}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={draft.busy} onClick={() => { if (draft.discardReady()) setReview(null) }}>{t('返回编辑', 'Back to edit')}</Button><Button type="button" disabled={locked || review !== basis || issues.length > 0} onClick={() => { setReview(null); void draft.start(isCurrent) }}>{t('确认更正', 'Confirm corrections')}</Button></div>
    </section> : !unknown ? <Button type="button" className="self-end" disabled={locked || ready || selected.length === 0 || selected.length > 20 || issues.length > 0} onClick={requestReview}>{t('集中核对更正', 'Review corrections')}</Button> : null}
    <AlertDialog pending={draft.busy} open={discard !== null && active} onOpenChange={next => { if (!next) setDiscard(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('丢弃未提交更正输入？', 'Discard unsubmitted correction input?')}</AlertDialogTitle><AlertDialogDescription>{t('将丢弃所选输入及已填内容，已保存的用量、更正和费用记录不受影响。', 'The selected input will be discarded. Saved usage, corrections and charges remain.')}</AlertDialogDescription></AlertDialogHeader>
      {clearFailed ? <Alert variant="destructive"><AlertDescription>{t('丢弃失败，原输入仍保留。请检查存储后重试。', 'Discard failed. Input is kept. Check storage and retry.')}</AlertDescription></Alert> : null}
      <AlertDialogFooter><AlertDialogCancel>{t('保留输入', 'Keep input')}</AlertDialogCancel><Button type="button" onClick={() => { const saved = discard === 'all' ? draft.clear() : draft.save({ ...draft.value, rows: rows.filter(row => row.id !== discard) }, true)
        if (saved) { setDiscard(null); setReview(null); if (ready) draft.discardReady() } else setClearFailed(true) }}>{t('确认丢弃', 'Discard')}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </section>
}
