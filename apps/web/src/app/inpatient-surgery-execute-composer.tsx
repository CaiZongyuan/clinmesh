import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { inpatientSurgeryCatalogSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { z } from 'zod'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { surgeryDraftScope, useSurgeryDraft } from './inpatient-surgery-draft.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type Catalog = z.infer<typeof inpatientSurgeryCatalogSchema>
type Request = z.infer<typeof inpatientSurgeryRequestSchema>
const draftSchema = z.object({ procedureId: z.string(), procedureVersion: z.number().int().positive(), note: z.string().max(2000),
  rows: z.array(z.object({ materialId: z.string(), catalogVersion: z.number().int().positive(), display: z.string(),
    quantity: z.string(), reservationId: z.string().nullable() }).strict()).max(20)
    .refine(rows => new Set(rows.map(row => row.materialId)).size === rows.length),
}).strict()
type Discard = { kind: 'clear' } | { kind: 'remove'; id: string; display: string }

export function SurgeryExecuteComposer({ admission, session, request, catalog, reservations, dataReady, onRetry, locale, write, open, focused, onOpenChange, returnFocus }: {
  admission: InpatientAdmission; session: SessionContext; request: Request; catalog: Catalog | undefined; reservations: InpatientMaterialReservation[];
  locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; open: boolean; focused: boolean;
  dataReady: boolean; onRetry: () => void;
  onOpenChange: (open: boolean) => void; returnFocus: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = surgeryDraftScope({ session, patientId: admission.patientId, admissionId: admission.id, requestId: request.id, action: 'execute' })
  const draft = useSurgeryDraft({ scope, schema: draftSchema, initial: { procedureId: request.plannedProcedure.id, procedureVersion: request.plannedProcedure.version, note: '', rows: [] } })
  const value = draft.value
  const [search, setSearch] = useState(''), [page, setPage] = useState(0)
  const [discard, setDiscard] = useState<Discard | null>(null), [attemptOwner, setAttemptOwner] = useState<string | null>(null)
  const owner = JSON.stringify(scope), current = useRef({ owner, focused, open })
  current.current = { owner, focused, open }
  const mounted = useRef(true)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const previousOwner = useRef(owner)
  useLayoutEffect(() => {
    if (!focused || previousOwner.current !== owner) { if (open) onOpenChange(false); setDiscard(null); setSearch(''); setPage(0) }
    previousOwner.current = owner
  }, [focused, owner, open, onOpenChange])
  const blocked = write.blocked || admission.status !== 'admitted' || admission.recordStatus === 'archived' || request.status !== 'ready' || !focused
  const actual = catalog?.procedures.find(item => item.id === value.procedureId)
  const procedureValid = actual !== undefined && actual.version === value.procedureVersion
  const candidates = (catalog?.materials ?? []).filter(item => item.display.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const unavailableCount = catalog?.materials.filter(item => !('chargeDefinition' in item)).length ?? 0
  const pageCount = Math.max(1, Math.ceil(candidates.length / 8)), currentPage = Math.min(page, pageCount - 1)
  const eligibleReservation = (reservation: InpatientMaterialReservation, materialId: string, catalogVersion: number) => reservation.status === 'reserved'
    && reservation.materialId === materialId && reservation.catalogVersion === catalogVersion
    && (!reservation.requestId || reservation.requestId === request.id) && reservation.consumedQuantity === 0
  const rows = value.rows.map(row => {
    const item = catalog?.materials.find(item => item.id === row.materialId)
    const reservation = reservations.find(item => item.id === row.reservationId)
    const quantity = Number(row.quantity)
    const problem = !item || !('chargeDefinition' in item) ? t('耗材目录已失效或计价单位未确认，请移除或重新选择', 'Material is unavailable; remove it or choose again')
      : item.version !== row.catalogVersion ? t('耗材目录依据已变化，请重新核对', 'Material catalog changed; review it again')
      : !row.quantity.trim() || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000 ? t('实际用量须为 0–1000 的整数，不能留空', 'Enter an integer from 0 to 1000; blank is invalid')
      : row.reservationId && (!reservation || !eligibleReservation(reservation, row.materialId, row.catalogVersion) || quantity !== reservation.quantity) ? t('关联预留已变化、目录依据不符或已部分使用，请取消关联后重新核对', 'The linked reservation changed, uses a different catalog version or was partially used; unlink and review it') : null
    return { row, item, quantity, problem }
  })
  const valid = dataReady && procedureValid && catalog !== undefined && rows.every(row => row.problem === null) && !!value.note.trim() && !draft.failed
  const updateRow = (id: string, update: Partial<(typeof value.rows)[number]>) => draft.save({ ...value, rows: value.rows.map(row => row.materialId === id ? { ...row, ...update } : row) })
  const submit = () => {
    if (blocked || !valid || !actual) return
    const command = { operation: 'inpatient.surgery.execute' as const, input: { admissionId: admission.id, requestId: request.id, expectedRequestVersion: request.version,
      procedureId: actual.id, catalogVersion: actual.version, note: value.note.trim(), materials: rows.filter(row => row.quantity > 0).map(({ row, quantity }) => ({
        materialId: row.materialId, catalogVersion: row.catalogVersion, quantity, ...(row.reservationId ? { reservationId: row.reservationId } : {}),
      })) } }
    if (!draft.prepareSubmission(command)) return
    setAttemptOwner(owner)
    const isCurrent = () => mounted.current && current.current.owner === owner && current.current.focused && current.current.open
    write.mutation.mutate({ ...command, isCurrent }, { onSuccess: () => { if (isCurrent()) onOpenChange(false) } })
  }
  return <Dialog open={open && focused} onOpenChange={next => { if (!write.mutation.isPending) { onOpenChange(next); if (!next) setDiscard(null) } }}>
    <DialogContent className="h-[min(860px,calc(100svh-2rem))] sm:max-w-[960px]" showCloseButton={!write.mutation.isPending} finalFocus={returnFocus}>
      <DialogHeader><DialogTitle>{t('整台补录', 'Record entire surgery')}</DialogTitle><DialogDescription>{t('连续添加并核实实际术式与全部耗材，一次提交后手术完成。最多 20 种；数量 0 不记录使用。', 'Add and review all materials, then submit the entire surgery once. Up to 20 materials; zero quantities are not recorded.')}</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); submit() }}>
        <div className="@container/surgery-execute flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          <FieldSet disabled={blocked} className="flex-none @min-[38rem]/surgery-execute:min-h-0 @min-[38rem]/surgery-execute:flex-1"><FieldGroup className="flex-none @min-[38rem]/surgery-execute:min-h-0 @min-[38rem]/surgery-execute:flex-1">
            {draft.failed ? <Alert variant="destructive"><AlertDescription>{t('未提交输入未能安全保存，已阻止提交。请重试保存或确认清空输入。', 'Draft could not be saved safely. Retry saving or confirm discarding it.')}</AlertDescription><Button type="button" variant="outline" onClick={() => draft.save(value)}>{t('重试保存未提交输入', 'Retry saving draft')}</Button></Alert> : null}
            {write.mutation.error && attemptOwner === owner ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
            <Field data-invalid={!procedureValid || undefined}><FieldLabel htmlFor={`execute-procedure-${request.id}`}>{t('实际术式', 'Performed procedure')}</FieldLabel>
              <WorkspaceSelect id={`execute-procedure-${request.id}`} value={value.procedureId} items={(catalog?.procedures ?? []).map(item => ({ value: item.id, label: `${item.coding.code} · ${item.coding.display}` }))}
                onValueChange={id => { const item = catalog?.procedures.find(item => item.id === id); if (item) draft.save({ ...value, procedureId: item.id, procedureVersion: item.version }) }} />
              <FieldDescription>{procedureValid ? actual.coding.code === request.plannedProcedure.coding.code ? t('默认与计划术式相同', 'Defaults to the planned procedure') : t(`与计划不同（计划：${request.plannedProcedure.coding.display}）；DRG 预分组按实际术式重算`, `Differs from the planned procedure; DRG uses the performed procedure`) : t('实际术式目录未加载或已变化，请重新选择并核对', 'Procedure catalog is unavailable or changed; review and select again')}</FieldDescription>
              {actual && !procedureValid ? <Button type="button" variant="outline" onClick={() => draft.save({ ...value, procedureVersion: actual.version })}>{t('重新核对术式', 'Review procedure again')}</Button> : null}
            </Field>
            {!dataReady ? <Alert><AlertDescription>{t('手术资料正在加载或读取失败，暂不能提交；已有输入保留。', 'Surgery data is loading or unavailable. Submission is blocked and input is retained.')}<Button type="button" variant="outline" size="sm" onClick={onRetry}>{t('重试手术资料', 'Retry surgery records')}</Button></AlertDescription></Alert> : null}
            <div className="grid min-w-0 flex-none gap-4 @min-[38rem]/surgery-execute:min-h-0 @min-[38rem]/surgery-execute:flex-1 @min-[38rem]/surgery-execute:grid-cols-2">
              <section aria-label={t('手术耗材目录', 'Surgical material catalog')} className="flex h-[26rem] min-h-0 min-w-0 flex-col gap-3 @min-[38rem]/surgery-execute:h-auto">
                <Field className="shrink-0"><FieldLabel htmlFor={`execute-search-${request.id}`}>{t('搜索手术耗材', 'Search surgical materials')}</FieldLabel><Input id={`execute-search-${request.id}`} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} /></Field>
                <p className="shrink-0 text-xs text-muted-foreground">{t('添加后保持本窗打开；清单最多 20 种耗材。', 'The window stays open after adding; up to 20 materials.')}</p>
                {unavailableCount > 0 ? <p className="shrink-0 text-xs text-muted-foreground">{t(`${unavailableCount} 项耗材因计价单位未确认而未启用`, `${unavailableCount} materials are unavailable because their billing unit is unconfirmed`)}</p> : null}
                {catalog === undefined ? <Alert><AlertDescription>{t('耗材目录尚未加载，暂不能提交；已有输入保留。请关闭后重试加载。', 'The catalog is unavailable. Existing input is retained; close and retry loading.')}</AlertDescription></Alert>
                  : candidates.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('没有匹配耗材', 'No matching materials')}</EmptyTitle><EmptyDescription>{t('调整搜索词，已加入的耗材继续保留。', 'Change the search; added materials are retained.')}</EmptyDescription></EmptyHeader></Empty>
                  : <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{candidates.slice(currentPage * 8, currentPage * 8 + 8).map(item => {
                    const added = value.rows.some(row => row.materialId === item.id), available = 'chargeDefinition' in item
                    return <li key={item.id} className="flex min-w-0 shrink-0 items-start justify-between gap-2 rounded-md border p-3"><div className="min-w-0 break-words"><p className="text-sm">{item.display}</p><p className="text-xs text-muted-foreground">{available ? `${formatFen(item.chargeDefinition.priceFen, locale)}/${item.chargeDefinition.unit}` : t('计价单位未确认，暂不可用', 'Billing unit is unconfirmed; unavailable')}</p></div>
                      <Button type="button" variant="outline" size="sm" disabled={!available || added || value.rows.length >= 20} aria-label={`${added ? t('已添加', 'Added') : t('添加', 'Add')} ${item.display}`} onClick={() => { if (available && !added && value.rows.length < 20) draft.save({ ...value, rows: [...value.rows, { materialId: item.id, catalogVersion: item.version, display: item.display, quantity: '1', reservationId: null }] }) }}>{added ? t('已添加', 'Added') : t('添加', 'Add')}</Button></li>
                  })}</ul>}
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2"><Button type="button" variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('上一页', 'Previous page')}</Button><span className="text-xs">{t(`第 ${currentPage + 1}/${pageCount} 页 · ${candidates.length} 项`, `Page ${currentPage + 1}/${pageCount} · ${candidates.length} items`)}</span><Button type="button" variant="outline" size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t('下一页', 'Next page')}</Button></div>
              </section>
              <section aria-label={t('完整待录耗材清单', 'Complete pending material list')} className="flex h-[26rem] min-h-0 min-w-0 flex-col gap-3 @min-[38rem]/surgery-execute:h-auto">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t(`待录耗材（${rows.length}/20）`, `Pending materials (${rows.length}/20)`)}</h4><Button type="button" variant="ghost" size="sm" onClick={() => setDiscard({ kind: 'clear' })}>{t('清空输入', 'Discard draft')}</Button></div>
                {rows.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('尚未加入耗材', 'No materials added')}</EmptyTitle><EmptyDescription>{t('从目录连续添加；确无耗材时可仅记录术式。', 'Add materials from the catalog, or record only the procedure when no materials were used.')}</EmptyDescription></EmptyHeader></Empty> : null}
                <FieldGroup className="min-h-0 flex-1 overflow-y-auto">{rows.map(({ row, item, problem }) => <Field key={row.materialId} data-invalid={!!problem || undefined} className="rounded-md border p-3">
                  <FieldLabel htmlFor={`execute-quantity-${request.id}-${row.materialId}`}>{row.display}{t('实际用量', ' quantity used')}</FieldLabel><Input id={`execute-quantity-${request.id}-${row.materialId}`} type="number" min="0" max="1000" step="1" aria-invalid={!!problem || undefined} disabled={!!row.reservationId} value={row.quantity} onChange={event => updateRow(row.materialId, { quantity: event.currentTarget.value })} />
                  <FieldLabel htmlFor={`execute-reservation-${request.id}-${row.materialId}`}>{t('替换治疗预留', 'Replace treatment reservation')}</FieldLabel>
                  <WorkspaceSelect id={`execute-reservation-${request.id}-${row.materialId}`} value={row.reservationId ?? ''} items={[{ value: '', label: t('独立记录实际使用', 'Record separate actual use') }, ...reservations.filter(reservation => eligibleReservation(reservation, row.materialId, row.catalogVersion)).map(reservation => ({ value: reservation.id, label: `${reservation.materialDisplay} × ${reservation.quantity} · ${reservation.reason}` }))]}
                    onValueChange={id => { const reservation = reservations.find(item => item.id === id); updateRow(row.materialId, { reservationId: id || null, ...(reservation ? { quantity: String(reservation.quantity) } : {}) }) }} />
                  <FieldDescription>{row.reservationId ? t('整笔替换原预留，数量已锁定；部分使用请改用逐笔登记。', 'Replaces the entire reservation; quantity is locked. Use individual recording for partial use.') : t('不关联预留；按此实际用量记录。', 'Records actual use without a reservation.')}</FieldDescription>
                  {problem ? <FieldDescription role="alert">{problem}</FieldDescription> : null}
                  <div className="flex flex-wrap gap-2">{item && 'chargeDefinition' in item && item.version !== row.catalogVersion ? <Button type="button" variant="outline" size="sm" onClick={() => updateRow(row.materialId, { catalogVersion: item.version, display: item.display })}>{t('重新核对目录', 'Review catalog again')}</Button> : null}
                    <Button type="button" variant="outline" size="sm" aria-label={`${t('移除耗材', 'Remove material')} ${row.display}`} onClick={() => setDiscard({ kind: 'remove', id: row.materialId, display: row.display })}>{t('移除', 'Remove')}</Button></div>
                </Field>)}</FieldGroup>
              </section>
            </div>
            <Field><FieldLabel htmlFor={`execute-note-${request.id}`}>{t('补录依据', 'Record basis')}</FieldLabel><Input id={`execute-note-${request.id}`} maxLength={2000} value={value.note} onChange={event => draft.save({ ...value, note: event.currentTarget.value })} /></Field>
          </FieldGroup></FieldSet>
        </div>
        <OrderComposerFooter hint={valid ? t('已核实整台清单，提交后计入耗材与术式费并完成手术', 'Submit the reviewed list to post fees and complete surgery') : t('请补齐依据并修正清单中标明的问题；整台手术一次提交', 'Complete the basis and resolve marked issues; the entire surgery is submitted once')}>
          <Button type="button" variant="outline" disabled={write.mutation.isPending} onClick={() => onOpenChange(false)}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={blocked || !valid}>{t('记录实际手术', 'Record performed surgery')}</Button>
        </OrderComposerFooter>
      </form>
      <AlertDialog open={discard !== null} onOpenChange={next => { if (!next) setDiscard(null) }}><AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{discard?.kind === 'remove' ? t('移除这项手术耗材？', 'Remove this surgical material?') : t('清空手术补录输入？', 'Discard this surgery draft?')}</AlertDialogTitle><AlertDialogDescription>{discard?.kind === 'remove' ? t(`将丢弃“${discard.display}”的实际用量和预留关联。`, `This discards the quantity and reservation for ${discard.display}.`) : t('将丢弃实际术式选择、全部耗材与补录依据，且不能恢复。', 'This discards the procedure selection, all materials and the record basis.')}</AlertDialogDescription></AlertDialogHeader>
        {draft.failed ? <Alert variant="destructive"><AlertDescription>{t('未提交输入存储失败，尚未完成丢弃。请重试或继续编辑。', 'Draft storage failed. Discarding did not finish; retry or keep editing.')}</AlertDescription></Alert> : null}
        <AlertDialogFooter><AlertDialogCancel>{t('继续编辑', 'Keep editing')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={blocked} onClick={() => {
          const saved = discard?.kind === 'remove' ? draft.save({ ...value, rows: value.rows.filter(row => row.materialId !== discard.id) }, { keepCurrentOnFailure: true }) : discard?.kind === 'clear' && draft.clear()
          if (saved) setDiscard(null)
        }}>{discard?.kind === 'remove' ? t('确认移除', 'Remove material') : t('确认清空', 'Discard draft')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
    </DialogContent>
  </Dialog>
}
