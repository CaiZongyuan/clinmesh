import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservationList } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import type { z } from 'zod'
import { apiGet } from './api-client.ts'
import { InpatientConfirmation } from './inpatient-confirmation.tsx'
import { reservationDraftScope, useReservationBatchDraft, type reservationBatchCommandSchema } from './inpatient-reservation-batch.ts'
import { reservationInputSchema, releaseInputRow, reservationReason, reservationRemaining, validReservationQuantity, type ReservationInputRow } from './inpatient-reservation-input.ts'
import { ReservationMaterialPicker } from './inpatient-reservation-picker.tsx'
import { ReservationEvidence, ReservationInputCard } from './inpatient-reservation-rows.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; active?: boolean; requestId?: string }
type Command = z.infer<typeof reservationBatchCommandSchema>
type Entry = { rowId: string; rowRevision: string; label: string; command: Command }
type SectionProps = Props & { action: 'create' | 'release'; dataReady: boolean; list: InpatientMaterialReservationList | undefined; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; planAvailable: boolean; planDisplay: string }
const safeText = (text: string) => text.replaceAll(/草稿/g, '未提交输入').replaceAll(/版本/g, '核对依据')

export function InpatientMaterialReservations(props: Props): React.JSX.Element {
  const ownerKey = JSON.stringify(reservationDraftScope({ session: props.session, patientId: props.admission.patientId, admissionId: props.admission.id, requestId: props.requestId ?? null, action: 'create' }))
  return <ReservationWorkspace key={ownerKey} {...props} />
}

function ReservationWorkspace(props: Props): React.JSX.Element {
  const { admission, session, locale, active = true, requestId } = props
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const list = useQuery({ enabled: active, queryKey: [...scope, 'drg-reservations'], queryFn: ({ signal }) => apiGet(`${path}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const catalog = useQuery({ enabled: active, queryKey: [...scope, 'surgery-catalog'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema, signal) })
  const surgery = useQuery({ enabled: active, queryKey: [...scope, 'surgeries'], queryFn: ({ signal }) => apiGet(`${path}/surgeries`, inpatientSurgerySchema, signal) })
  const queries = [list, catalog, surgery], error = queries.find(query => query.isError)?.error
  const dataReady = queries.every(query => query.isSuccess && !query.isFetching)
  const plan = surgery.data?.requests.find(item => item.id === requestId)
  const planDisplay = plan?.plannedProcedure.coding.display ?? t('当前手术', 'Current surgery')
  const shared = { ...props, dataReady, list: list.data, catalog: catalog.data, planAvailable: !requestId || !!plan && (plan.status === 'requested' || plan.status === 'ready'), planDisplay }
  return <section aria-label={t('治疗耗材预留', 'Treatment material reservations')} className="flex min-w-0 flex-col gap-4">
    <p className="text-sm text-muted-foreground">{t('预留用于预计，未使用余量不计费。新增与释放分别核对，每次最多20项；已消耗部分保留正式收费。', 'Reservations are estimates; unused quantities carry no charge. Review creation and release separately, up to 20 items each. Consumed quantities retain their posted charges.')}</p>
    <p className="break-words text-sm">{requestId ? `${t('当前手术：', 'Current surgery: ')}${planDisplay}` : t('当前为未关联手术的独立单项维护，每次最多1项。', 'Independent, unlinked maintenance: one item per action.')}</p>
    {!dataReady && !error ? <p role="status">{t('正在核对预留、目录与手术资料；未提交输入已保留，核对完成后可办理。', 'Checking reservations, catalog and surgery data. Input is kept; submit when checks finish.')}</p> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{safeText(getWorkspaceErrorMessage(error, getWorkspaceMessages(locale)))} {t('未提交输入已保留，请重试资料读取后重新核对。', 'Input is kept. Retry loading, then review again.')}</AlertDescription>
      <Button type="button" variant="outline" size="sm" disabled={!active || queries.some(query => query.isFetching)} onClick={() => { void Promise.all(queries.map(query => query.refetch())) }}>{t('重试预留资料', 'Retry reservation data')}</Button></Alert> : null}
    <ReservationBatchSection {...shared} action="create" />
    <ReservationBatchSection {...shared} action="release" />
  </section>
}

function ReservationBatchSection({ admission, session, locale, write, active = true, requestId, action, list, catalog, dataReady, planAvailable, planDisplay }: SectionProps) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const creating = action === 'create', limit = requestId ? 20 : 1, id = useId()
  const scope = reservationDraftScope({ session, patientId: admission.patientId, admissionId: admission.id, requestId: requestId ?? null, action }), scopeKey = JSON.stringify(scope)
  const draft = useReservationBatchDraft({ scope, schema: reservationInputSchema, initial: { rows: [], commonReason: '' }, session, write })
  const { rows, commonReason } = draft.value, selected = rows.filter(row => row.selected)
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), [selectionError, setSelectionError] = useState('')
  const [clearOpen, setClearOpen] = useState(false), [clearFailed, setClearFailed] = useState(false)
  const [review, setReview] = useState<{ basis: string; entries: Entry[]; existing: boolean }>(), [attemptError, setAttemptError] = useState('')
  const current = useRef({ scopeKey, active }), mounted = useRef(true)
  current.current = { scopeKey, active }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const isCurrent = () => mounted.current && current.current.scopeKey === scopeKey && current.current.active
  const writable = active && admission.status === 'admitted' && admission.recordStatus !== 'archived' && session.actor.roleCode === 'inpatient-doctor'
  const unknown = draft.items.some(item => item.status === 'unknown'), ready = draft.items.filter(item => item.status === 'ready')
  const blocked = !writable || draft.blocked
  const editable = writable && !draft.busy && !unknown && !write.blocked
  const saveRows = (next: ReservationInputRow[], keepCurrentOnFailure = false) => {
    setReview(undefined); setSelectionError('')
    return draft.save({ ...draft.value, rows: next }, { keepCurrentOnFailure })
  }
  const editRow = (rowId: string, change: Partial<ReservationInputRow>) => saveRows(rows.map(row => row.id === rowId ? { ...row, ...change, revision: crypto.randomUUID() } : row))
  const reservations = list?.reservations.filter(item => (item.requestId ?? null) === (requestId ?? null))
  const problem = (row: ReservationInputRow) => {
    if (creating) {
      if (!validReservationQuantity(row.quantity)) return t('数量须为1至1000的整数', 'Quantity must be an integer from 1 to 1000')
      if (!planAvailable) return t('当前手术已不可新增预留，请重新核对手术状态', 'This surgery no longer accepts new reservations. Review its status.')
      const material = catalog?.materials.find(item => item.id === row.materialId && item.version === row.catalogVersion)
      if (!material || !('chargeDefinition' in material) || material.chargeDefinition.priceFen !== row.priceFen || material.chargeDefinition.unit !== row.unit) return t('材料目录或计价依据已变化，请移除后重新选择', 'Material catalog or pricing changed. Remove and select again.')
    } else {
      const original = row.reservation, latest = reservations?.find(item => item.id === row.id)
      if (!original || !latest || latest.status !== 'reserved' || reservationRemaining(latest) <= 0) return t('原预留已不可释放，请清除选择并核对当前状态', 'The reservation cannot be released. Clear the selection and review its status.')
      if (latest.version !== original.version || latest.quantity !== original.quantity || latest.consumedQuantity !== original.consumedQuantity || reservationRemaining(latest) !== reservationRemaining(original)) return t('原预留的核对依据已变化，请取消勾选后重新选择', 'Reservation evidence changed. Deselect and select it again.')
    }
    const reason = reservationReason(row, commonReason)
    if (!reason || reason.length > 2000) return t('最终理由须填写且不超过2000字', 'A final reason is required, up to 2000 characters')
    return null
  }
  const availableRows = creating ? rows : [
    ...(reservations?.map(item => {
      const saved = rows.find(row => row.id === item.id)
      return saved?.selected ? saved : { ...releaseInputRow(item, saved), selected: false }
    }) ?? []),
    ...selected.filter(row => !reservations?.some(item => item.id === row.id)),
  ]
  const filtered = availableRows.filter(row => row.display.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / 10)), currentPage = Math.min(page, pages), visible = filtered.slice((currentPage - 1) * 10, currentPage * 10)
  const selectRows = (targets: ReservationInputRow[]) => {
    const additions = targets.filter(row => !selected.some(item => item.id === row.id))
    if (selected.length + additions.length > limit) { setSelectionError(t(`选择将超过${limit}项上限，原选择与输入已保留，请先取消部分勾选。`, `Selection would exceed ${limit} items. Existing selection and input are kept; deselect some items first.`)); return }
    const next = [...rows]
    for (const row of targets) {
      const index = next.findIndex(item => item.id === row.id)
      const updated = !creating && row.reservation ? releaseInputRow(reservations?.find(item => item.id === row.id) ?? row.reservation, row) : { ...row, selected: true, revision: crypto.randomUUID() }
      if (index < 0) next.push(updated); else next[index] = updated
    }
    saveRows(next)
  }
  const selectable = visible.filter(row => !problem(row))
  const allSelected = selectable.length > 0 && selectable.every(row => selected.some(item => item.id === row.id))
  const entries: Entry[] = selected.flatMap<Entry>(row => {
    if (!list) return []
    if (creating && row.catalogVersion !== undefined) return [{ rowId: row.id, rowRevision: row.revision, label: row.display, command: { operation: 'inpatient.drg.reservation.create', input: { admissionId: admission.id, encounterVersion: list.encounterVersion, materialId: row.materialId, catalogVersion: row.catalogVersion, quantity: Number(row.quantity), ...(requestId ? { requestId } : {}), reason: reservationReason(row, commonReason) } } }]
    if (!creating && row.reservation) return [{ rowId: row.id, rowRevision: row.revision, label: row.display, command: { operation: 'inpatient.drg.reservation.release', input: { admissionId: admission.id, encounterVersion: list.encounterVersion, reservationId: row.reservation.id, expectedReservationVersion: row.reservation.version, reason: reservationReason(row, commonReason) } } }]
    return []
  })
  const basis = JSON.stringify({ value: draft.value, list, catalog, planAvailable, dataReady })
  const canReview = !blocked && dataReady && selected.length > 0 && selected.length <= limit && selected.every(row => !problem(row)) && entries.length === selected.length
  const readyMatches = ready.length > 0 && ready.every(item => entries.some(entry => entry.rowId === item.rowId && entry.rowRevision === item.rowRevision && JSON.stringify(entry.command) === JSON.stringify(item.command)))
  const canReviewReady = !blocked && dataReady && readyMatches && ready.every(item => {
    const row = rows.find(row => row.id === item.rowId)
    return row && !problem(row)
  })
  const reviewValid = review?.basis === basis && (review.existing ? canReviewReady : canReview && ready.length === 0)
  const title = creating ? t('新增预留', 'Create reservations') : t('释放预留', 'Release reservations')
  return <section aria-label={title} className="flex min-w-0 flex-col gap-3 border-t pt-4">
    <FieldSet disabled={!editable} className="min-w-0"><FieldLegend>{title}</FieldLegend>
      <p className="text-sm text-muted-foreground">{creating ? t('同窗连续加入耗材，再按项核对数量；逐项理由留空时采用共同理由。', 'Add materials continuously, then review each quantity. A blank item reason uses the common reason.') : t('仅释放当前手术的未用余量，已用部分及正式收费保留。逐项理由留空时采用共同理由。', 'Release only unused quantities for this surgery. Used quantities and posted charges remain. A blank item reason uses the common reason.')}</p>
      {creating ? <ReservationMaterialPicker catalog={catalog} locale={locale} added={rows.map(row => row.materialId)} limit={limit} disabled={!editable || !dataReady || !planAvailable}
        onAdd={item => { if (!editable || !('chargeDefinition' in item) || rows.length >= limit || rows.some(row => row.materialId === item.id)) return; saveRows([...rows, { id: crypto.randomUUID(), revision: crypto.randomUUID(), selected: true, materialId: item.id, catalogVersion: item.version, display: item.display, unit: item.chargeDefinition.unit, priceFen: item.chargeDefinition.priceFen, quantity: '1', reason: '' }]) }} /> : null}
      <FieldGroup><Field><FieldLabel htmlFor={`${id}-reason`}>{creating ? t('新增预留共同理由', 'Common creation reason') : t('释放预留共同理由', 'Common release reason')}</FieldLabel><Input id={`${id}-reason`} value={commonReason} maxLength={2000} onChange={event => { setReview(undefined); draft.save({ ...draft.value, commonReason: event.target.value, rows: rows.map(row => ({ ...row, revision: crypto.randomUUID() })) }) }} /></Field>
        <Field><FieldLabel htmlFor={`${id}-search`}>{creating ? t('搜索未提交新增项', 'Search creation input') : t('搜索当前手术预留', 'Search surgery reservations')}</FieldLabel><Input id={`${id}-search`} value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setPage(1) }} /></Field></FieldGroup>
      <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={!editable || !dataReady || selectable.length === 0} onClick={() => { if (allSelected) saveRows(rows.map(row => selectable.some(item => item.id === row.id) ? { ...row, selected: false, revision: crypto.randomUUID() } : row)); else selectRows(selectable) }}>{allSelected ? t('取消本页选择', 'Deselect this page') : t('全选本页可办理项', 'Select eligible items on this page')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!editable || selected.length === 0} onClick={() => saveRows(rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() })))}>{t('清空选择', 'Clear selection')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!editable || rows.length === 0 && !commonReason} onClick={() => { setClearOpen(true); setClearFailed(false) }}>{t('清空未提交输入', 'Clear unsubmitted input')}</Button></div>
      <p role="status" className="text-sm">{t(`已选择 ${selected.length} / ${limit} 项；清空选择保留数量与理由。`, `${selected.length} / ${limit} selected. Clearing selection keeps quantities and reasons.`)}</p>
      {selectionError ? <Alert variant="destructive"><AlertDescription>{selectionError}</AlertDescription></Alert> : null}
      {visible.map(row => <ReservationInputCard key={row.id} row={row} creating={creating} locale={locale} prefix={id} commonReason={commonReason} disabled={!editable} selectionDisabled={!dataReady || !creating && !row.selected && (row.reservation?.status !== 'reserved' || reservationRemaining(row.reservation) <= 0)} problem={row.selected ? problem(row) : null}
        onSelect={checked => { if (checked) selectRows([row]); else editRow(row.id, { selected: false }) }} onEdit={change => { if (rows.some(item => item.id === row.id)) editRow(row.id, change); else saveRows([...rows, { ...row, ...change, revision: crypto.randomUUID() }]) }} onRemove={() => saveRows(rows.filter(item => item.id !== row.id), true)} />)}
      {dataReady && visible.length === 0 ? <p className="text-sm text-muted-foreground">{creating ? t('尚无匹配的未提交新增项。', 'No matching creation input.') : t('当前手术没有匹配预留。', 'No matching reservations for this surgery.')}</p> : null}
      <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{t(`第 ${currentPage} / ${pages} 页，共 ${filtered.length} 项`, `Page ${currentPage} / ${pages}, ${filtered.length} items`)}</span>
        <Button type="button" variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t('上一页待办', 'Previous input page')}</Button><Button type="button" variant="outline" size="sm" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>{t('下一页待办', 'Next input page')}</Button></div>
    </FieldSet>
    {selected.length > 0 ? <section aria-label={creating ? t('完整新增待办清单', 'All selected creation items') : t('完整释放待办清单', 'All selected release items')} className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/30 p-3"><h5 className="font-medium">{t('完整待办清单', 'Complete selected list')} · {selected.length}</h5>
      {selected.map(row => <div key={row.id} className="min-w-0 break-words text-sm"><p>{row.display} · {creating ? t('数量 ', 'Quantity ') : t('释放余量 ', 'Release remainder ')}{row.quantity} {row.unit} · {t('最终理由：', 'Final reason: ')}{reservationReason(row, commonReason) || t('待填写', 'Required')}</p>{!creating ? <ReservationEvidence row={row} locale={locale} /> : null}{problem(row) ? <p role="alert" className="text-destructive">{problem(row)}</p> : null}<Button type="button" variant="ghost" size="sm" disabled={!editable} aria-label={`${t('取消选择', 'Deselect ')}${row.display}`} onClick={() => editRow(row.id, { selected: false })}>{t('取消此项选择', 'Deselect this item')}</Button></div>)}
    </section> : null}
    {draft.failed ? <Alert variant="destructive"><AlertDescription>{t('未提交输入暂未可靠保存，已保留当前内容。请恢复会话存储后再编辑保存；当前不能发送。', 'Input could not be saved reliably and remains visible. Restore session storage and save again before submitting.')}</AlertDescription></Alert> : null}
    <Button type="button" variant="outline" className="self-start" disabled={!canReview || ready.length > 0} onClick={() => { setAttemptError(''); setReview({ basis, entries, existing: false }) }}>{creating ? t('审阅新增预留', 'Review creation') : t('审阅释放预留', 'Review release')}</Button>
    {review ? <InpatientConfirmation locale={locale} title={creating ? t('确认新增预留清单', 'Confirm reservation creation list') : t('确认释放预留清单', 'Confirm reservation release list')} description={t('逐项核对耗材、数量、手术关联和最终理由。每项独立办理；确定失败保留输入，结果未明时暂停并核查原请求。', 'Review each material, quantity, surgery link and final reason. Each item is independent; rejected items keep their input and uncertain outcomes pause the queue.')}
      confirmLabel={creating ? t('确认新增所选预留', 'Confirm selected creations') : t('确认释放所选预留', 'Confirm selected releases')} pending={draft.busy} disabled={!reviewValid || draft.busy}
      onCancel={() => { setReview(undefined); setAttemptError('') }} onConfirm={() => { if (!reviewValid || !isCurrent()) return; if (!review.existing && !draft.prepareBatch(review.entries)) { setAttemptError(t('未能保存本次核对，请保留输入并重新核对待办。', 'Could not save this review. Keep the input and review the list again.')); return }; setReview(undefined); void draft.start(isCurrent) }}>
      <p>{t('手术关联：', 'Surgery link: ')}{requestId ? planDisplay : t('未关联（独立单项）', 'Unlinked (single item)')}</p>
      {review.entries.map(entry => {
        const row = rows.find(row => row.id === entry.rowId)
        return <div key={entry.rowId} className="break-words text-sm"><p>{entry.label} · {entry.command.operation === 'inpatient.drg.reservation.create' ? `${t('数量 ', 'Quantity ')}${entry.command.input.quantity} ${row?.unit ?? ''} · ${t('预计 ', 'Estimate ')}${formatFen((row?.priceFen ?? 0) * entry.command.input.quantity, locale)}` : `${t('释放未用余量 ', 'Release unused quantity ')}${row?.quantity ?? ''} ${row?.unit ?? ''}`} · {t('最终理由：', 'Final reason: ')}{entry.command.input.reason}</p>{!creating ? <ReservationEvidence row={row} locale={locale} /> : null}</div>
      })}
      {!reviewValid ? <p role="alert">{t('输入或资料已变化，请取消后重新核对当前清单。', 'Input or data changed. Cancel and review the current list again.')}</p> : null}
      {attemptError ? <Alert variant="destructive"><AlertDescription>{attemptError}</AlertDescription></Alert> : null}
    </InpatientConfirmation> : null}
    {draft.items.length > 0 ? <section aria-label={`${title}${t('逐项结果', ' item results')}`} className="flex min-w-0 flex-col gap-2"><h5 className="font-medium">{t('逐项结果', 'Item results')}</h5>{draft.items.map(item => <div key={item.idempotencyKey} className="break-words text-sm"><p>{item.label} · {{ ready: t('待办理，需核对后继续', 'Ready; review before continuing'), unknown: t('结果未明，先核查原请求', 'Uncertain; check the original request'), success: t('已成功，已移出原输入', 'Succeeded; original input removed'), failed: t('未成功，输入已保留', 'Rejected; input kept') }[item.status]}</p>{item.error ? <Alert variant="destructive"><AlertDescription>{safeText(item.error.message)}</AlertDescription></Alert> : null}</div>)}
      {unknown ? <Button type="button" variant="outline" className="self-start" disabled={!writable || draft.busy || write.mutation.isPending || !!write.storageFailure || draft.failed} onClick={() => { setReview(undefined); void draft.resume(isCurrent) }}>{t('核查并恢复原预留请求', 'Check and recover original reservation request')}</Button> : null}
      {!unknown && ready.length > 0 ? <><p className="text-sm">{t('剩余项目尚未发送，恢复原请求后不会自动继续；请重新核对再办理。', 'Remaining items have not been sent. Recovery does not continue automatically; review them before proceeding.')}</p>
        <Button type="button" variant="outline" className="self-start" disabled={!canReviewReady} onClick={() => { setAttemptError(''); setReview({ basis, entries: ready, existing: true }) }}>{t('核对剩余待办理项', 'Review remaining items')}</Button>
        <Button type="button" variant="ghost" className="self-start" disabled={!editable} onClick={() => { if (draft.discardReady()) setReview(undefined) }}>{t('重新准备待办理项', 'Prepare remaining items again')}</Button></> : null}
    </section> : null}
    <AlertDialog open={clearOpen && active} onOpenChange={next => { if (!draft.busy) setClearOpen(next) }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('清空未提交输入？', 'Clear unsubmitted input?')}</AlertDialogTitle><AlertDialogDescription>{t(`将清空${title}的全部数量、理由和选择；正式预留与已用记录不受影响。`, `Clear all quantities, reasons and selections for ${title}. Existing reservations and usage remain.`)}</AlertDialogDescription></AlertDialogHeader>
      {clearFailed ? <Alert variant="destructive"><AlertDescription>{t('清空未能保存，原输入已保留，请修复会话存储后重试。', 'Clearing could not be saved. Original input is kept; restore session storage and retry.')}</AlertDescription></Alert> : null}
      <AlertDialogFooter><Button type="button" variant="outline" onClick={() => setClearOpen(false)}>{t('保留输入', 'Keep input')}</Button><Button type="button" disabled={draft.busy || unknown} onClick={() => { if (draft.clear()) { setClearOpen(false); setReview(undefined) } else setClearFailed(true) }}>{t('确认清空输入', 'Confirm clearing input')}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </section>
}
