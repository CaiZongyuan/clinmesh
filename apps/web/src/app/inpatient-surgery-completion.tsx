import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { inpatientSurgeryCompletionPreviewSchema, type inpatientSurgeryCompletionReviewInputSchema,
  type inpatientSurgeryCatalogSchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Input } from '@clinmesh/ui/components/input'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { completionQuantities, completionReviewNote } from './inpatient-surgery-notes.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { apiGet, ApiClientError, apiMutation, getSession } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { surgeryDraftScope, useSurgeryDraft } from './inpatient-surgery-draft.ts'
import { completionDraftSchema, initialCompletionDraft, remainingAfterCompletion, validFinalQuantity, type CompletionDraftRow } from './inpatient-surgery-completion-draft.ts'
import { SurgeryFinalMaterialList } from './inpatient-surgery-final-list.tsx'
import { SurgeryFinalMaterialPicker } from './inpatient-surgery-final-picker.tsx'
import { SurgeryReleasePicker } from './inpatient-surgery-release-picker.tsx'

type Props = { admission: InpatientAdmission; session: SessionContext; active?: boolean; dataReady: boolean;
  execution: z.infer<typeof inpatientSurgeryExecutionSchema>; request: z.infer<typeof inpatientSurgeryRequestSchema>;
  catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; reservations: InpatientMaterialReservation[];
  write: ReturnType<typeof useInpatientWriteIntent>; locale: WorkspaceLocale; refresh: () => Promise<unknown>; summary?: string }

export function InpatientSurgeryCompletion(props: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ownerKey = JSON.stringify(surgeryDraftScope({ session: props.session, patientId: props.admission.patientId, admissionId: props.admission.id,
    requestId: props.request.id, executionId: props.execution.id, action: 'complete' }))
  useEffect(() => { if (props.active === false) setOpen(false) }, [props.active])
  const t = (cn: string, en: string) => props.locale === 'zh-CN' ? cn : en
  const action = <Button disabled={props.write.blocked || props.active === false} onClick={() => setOpen(true)}>{t('核实最终耗材并完成手术', 'Review final materials and complete surgery')}</Button>
  return <>
    <InpatientPrimaryAction stage="surgery" priority={50} fallback={action}><WorkspaceActionBar summary={props.execution.actualProcedure.coding.display}
      reason={props.summary} action={action} /></InpatientPrimaryAction>
    <Dialog open={open && props.active !== false} pending={props.write.mutation.isPending} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100%-2rem)] sm:max-w-[900px]" showCloseButton={!props.write.mutation.isPending}>
        <DialogHeader><DialogTitle>{t('核实最终耗材并完成手术', 'Review final materials and complete surgery')}</DialogTitle><DialogDescription>{props.execution.actualProcedure.coding.display} · {t('默认采用术中已登记量；有出入时可改数量。', 'Recorded quantities are used by default; edit them if needed.')}</DialogDescription></DialogHeader>
        {open && props.active !== false ? <CompletionEditor key={ownerKey} {...props} onClose={() => { if (!props.write.mutation.isPending) setOpen(false) }} /> : null}
      </DialogContent>
    </Dialog>
  </>
}

function CompletionEditor(props: Props & { onClose: () => void }): React.JSX.Element {
  const { execution, request, catalog, reservations, write, locale, refresh, onClose, session, admission, active, dataReady } = props
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = surgeryDraftScope({ session, patientId: admission.patientId, admissionId: admission.id, requestId: request.id, executionId: execution.id, action: 'complete' })
  const scopeKey = JSON.stringify(scope)
  const draft = useSurgeryDraft({ scope, schema: completionDraftSchema, initial: initialCompletionDraft(execution, reservations, request.id) })
  const { rows, releases } = draft.value
  const [editing, setEditing] = useState(false)
  const attemptedPreview = useRef('')
  const estimates = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'material-estimates'],
    enabled: active !== false, retry: false, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/material-estimates`, inpatientMaterialEstimatesSchema, signal) })
  const planBasis = estimates.data?.estimates.find(item => item.requestId === request.id)?.planBasis
  const plan = planBasis?.history.find(item => item.reference === planBasis.effectiveReference)
  const note = draft.value.noteSource === 'rule' ? completionReviewNote(rows, plan, execution, releases, locale, reservations) : draft.value.note
  const setRows = (change: (previous: CompletionDraftRow[]) => CompletionDraftRow[], discard = false) => draft.save({ ...draft.value, rows: change(rows) }, { keepCurrentOnFailure: discard })
  const [clearOpen, setClearOpen] = useState(false), [clearFailed, setClearFailed] = useState(false)
  const current = useRef({ scopeKey, active, dataReady }), mounted = useRef(true)
  current.current = { scopeKey, active, dataReady }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const isCurrent = () => mounted.current && current.current.scopeKey === scopeKey && current.current.active !== false
  const originalReservations = reservations.filter(item => item.requestId === request.id && item.status !== 'released')
  const finalMaterials = rows.map(({ materialId, catalogVersion, quantity, materialUseIds, reservationId, expectedReservationVersion }) => ({
    materialId, catalogVersion, quantity: Number(quantity), materialUseIds,
    ...(reservationId ? { reservationId, expectedReservationVersion } : {}),
  }))
  const input = { admissionId: execution.admissionId, requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id,
    note: note.trim(), finalMaterials, releaseReservations: releases.map(({ reservationId, expectedReservationVersion }) => ({ reservationId, expectedReservationVersion })) }
  const basis = JSON.stringify({ scope, execution, catalog, reservations })
  const preview = useMutation({ retry: false, mutationFn: async ({ input }: { input: z.infer<typeof inpatientSurgeryCompletionReviewInputSchema>; basis: string }) => {
    const fresh = await getSession()
    if (!isCurrent() || !current.current.dataReady || JSON.stringify(surgeryDraftScope({ session: fresh, patientId: admission.patientId, admissionId: admission.id, requestId: request.id, executionId: execution.id, action: 'complete' })) !== scopeKey)
      throw new ApiClientError(409, 'INPATIENT_INTENT_CONTEXT_CHANGED', '当前岗位或病例已变化，请返回当前手术重新核实')
    return apiMutation(`/api/his/v1/inpatient/admissions/${execution.admissionId}/surgeries/preview-completion`, inpatientSurgeryCompletionPreviewSchema,
      { input: { ...input, admissionId: undefined } })
  } })
  const failedCommand = write.mutation.variables
  const completeError = failedCommand?.operation === 'inpatient.surgery.complete' && failedCommand.input.executionId === execution.id ? write.mutation.error : null
  const reviewError = completeError instanceof ApiClientError && completeError.code === 'INPATIENT_SURGERY_REVIEW_CONFLICT' ? completeError : null
  const failedReview = reviewError !== null && failedCommand?.operation === 'inpatient.surgery.complete'
    && failedCommand.input.reconciliation?.expectedFingerprint === preview.data?.fingerprint
  const error = preview.error ?? completeError
  const reviewed = !failedReview && preview.isSuccess && preview.variables.basis === basis && JSON.stringify(preview.variables.input) === JSON.stringify(input)
  const [refreshCount, setRefreshCount] = useState(0)
  const refreshSnapshot = useRef(() => {})
  refreshSnapshot.current = () => {
    if (!isCurrent()) return
    draft.save({ ...draft.value, rows: rows.map(row => ({ ...row,
      ...(row.reservationId ? { expectedReservationVersion: reservations.find(item => item.id === row.reservationId)?.version } : {}) })),
    releases: releases.map(row => ({ ...row, expectedReservationVersion: reservations.find(item => item.id === row.reservationId)?.version ?? row.expectedReservationVersion })) })
  }
  useEffect(() => { if (refreshCount > 0) refreshSnapshot.current() }, [refreshCount])
  const refreshBasis = useMutation({ retry: false, mutationFn: refresh, onSuccess: () => { attemptedPreview.current = ''; preview.reset(); if (isCurrent()) setRefreshCount(value => value + 1) } })
  const rowProblem = (row: CompletionDraftRow) => {
    if (!validFinalQuantity(row.quantity)) return t('最终总量须为0至1000的整数', 'Final quantity must be an integer from 0 to 1000')
    const currentMaterial = catalog?.materials.find(item => item.id === row.materialId && item.version === row.catalogVersion)
    if (Number(row.quantity) > row.previousQuantity && (!currentMaterial || !('chargeDefinition' in currentMaterial))) return t('目录或依据已失效，请移除本项后重新选择', 'Catalog item or version changed; remove and select again')
    if (row.materialUseIds.some(id => !execution.materialHistory.some(use => use.id === id && use.correction === null))) return t('原使用已更正，请重新带入当前用量', 'Original use was corrected; reload current quantities')
    if (row.reservationId) {
      const item = reservations.find(item => item.id === row.reservationId)
      if (!item || item.materialId !== row.materialId || item.catalogVersion !== row.catalogVersion || item.requestId && item.requestId !== request.id) return t('原预留身份或手术归属已变化，请重新核对关联', 'Reservation identity or surgery changed; review the link')
      if (item.version !== row.expectedReservationVersion) return t('原预留依据已变化，请刷新核实依据', 'Reservation version changed; refresh review sources')
      const remaining = remainingAfterCompletion(item, rows)
      if (remaining !== null && (remaining < 0 || remaining > item.quantity)) return t('本预留合计最终用量超出范围，请核实各项数量', 'Combined final use exceeds this reservation; review quantities')
    }
    return null
  }
  const invalidRelease = releases.find(row => {
    const item = originalReservations.find(item => item.id === row.reservationId)
    return !item || item.releaseReason != null || item.version !== row.expectedReservationVersion || (remainingAfterCompletion(item, rows) ?? 0) <= 0
  })
  const unreviewedUses = execution.materials.filter(use => !rows.some(row => row.materialUseIds.includes(use.id)))
  const validation = !dataReady || !catalog ? t('手术耗材资料尚未就绪或读取失败，已填内容保留，请重试读取', 'Surgery material records are loading or unavailable. Input is retained; retry loading.')
    : rows.length > 100 || releases.length > 100 ? t('最终耗材与释放选择各最多100项，请移除超出项目', 'Final materials and release selections are each limited to 100 items')
      : unreviewedUses.length > 0 ? t(`新增实际使用：${unreviewedUses.map(use => use.item.display).join('、')}。未提交输入已保留，请重新带入当前用量后核实。`, `New recorded use: ${unreviewedUses.map(use => use.item.display).join(', ')}. Your draft is retained; reload current quantities and review.`)
        : rows.map(rowProblem).find(problem => problem !== null)
        ?? (invalidRelease ? t(`已选释放的 ${invalidRelease.display} 已无合法余量或依据变化，请取消选择或刷新核实`, `Selected release ${invalidRelease.display} changed or has no eligible remainder; deselect it or refresh sources`) : null)
  const valid = note.trim().length > 0 && validation == null
  const editingBlocked = write.blocked || refreshBasis.isPending || draft.failed || active === false
  const blocked = editingBlocked || preview.isPending
  const materialList = <SurgeryFinalMaterialList rows={rows} catalog={catalog} reservations={reservations} requestId={request.id}
    locale={locale} disabled={editingBlocked} rowProblem={rowProblem} onChange={setRows} />
  const hint = validation ?? (!note.trim() ? t('还差：核实说明', 'Enter the review note') : reviewed ? t('确认后补登差额并计入术式费，手术结束', 'Confirmation posts the differences and procedure fee and completes surgery') : t('正在核对差额，完成后可确认', 'Checking differences before confirmation'))
  const confirm = () => {
    if (!isCurrent() || blocked || !valid || !reviewed || !preview.data) return
    const command = { operation: 'inpatient.surgery.complete' as const, input: {
      admissionId: input.admissionId, requestId: input.requestId, executionId: input.executionId, expectedRequestVersion: input.expectedRequestVersion, note: input.note,
      reconciliation: { finalMaterials: input.finalMaterials, releaseReservations: input.releaseReservations, expectedFingerprint: preview.data.fingerprint },
    } }
    if (draft.prepareSubmission(command)) write.mutation.mutate({ ...command, isCurrent: () => isCurrent() && current.current.dataReady })
  }
  const previewKey = JSON.stringify({ input, basis })
  useEffect(() => {
    if (!valid || blocked || reviewed || attemptedPreview.current === previewKey) return
    const timer = setTimeout(() => {
      if (!isCurrent()) return
      attemptedPreview.current = previewKey
      preview.mutate({ input, basis })
    }, 250)
    return () => clearTimeout(timer)
  }, [previewKey, valid, blocked, reviewed])
  const actions = <>
    <Button type="button" variant="outline" disabled={write.mutation.isPending} onClick={onClose}>{t('取消', 'Cancel')}</Button>
    <Button type="button" disabled={blocked || !valid || !reviewed} onClick={confirm}>{t('确认完成手术', 'Complete surgery')}</Button>
  </>
  return <form className="flex min-h-0 flex-1 flex-col p-0" onSubmit={event => event.preventDefault()}>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    <FieldSet disabled={editingBlocked}><FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{t('已登记量默认作为最终用量', 'Recorded quantities are the default final quantities')}</span><Button type="button" variant="link" size="sm" disabled={editingBlocked} onClick={() => setEditing(value => !value)}>{editing ? t('收起数量编辑', 'Hide quantity editor') : t('有出入，改数量', 'Edit quantities if needed')}</Button></div>
      {!editing ? <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('计划', 'Planned')}</TableHead><TableHead>{t('最终用量', 'Final quantity')}</TableHead><TableHead>{t('与计划的差异', 'Difference from plan')}</TableHead></TableRow></TableHeader><TableBody>
        {completionQuantities(rows, plan).map(row => <TableRow key={row.key}><TableCell className="whitespace-normal">{row.display}</TableCell><TableCell>{row.planned ?? t('待核实', 'Unverified')} {row.unit}</TableCell><TableCell>{row.quantity} {row.unit}</TableCell><TableCell className={row.difference ? 'text-warning' : undefined}>{row.difference === null ? t('待核实', 'Unverified') : row.difference === 0 ? t('一致', 'Matches') : row.difference > 0 ? t(`多用 ${row.difference}`, `${row.difference} extra`) : t(`未用 ${-row.difference}`, `${-row.difference} unused`)}</TableCell></TableRow>)}
      </TableBody></Table> : <>
      {materialList}
      <SurgeryReleasePicker reservations={originalReservations} rows={rows} selected={releases} locale={locale} disabled={editingBlocked} onChange={next => draft.save({ ...draft.value, releases: next }, { keepCurrentOnFailure: next.length < releases.length })} />
      <SurgeryFinalMaterialPicker catalog={catalog} locale={locale} count={rows.length} disabled={editingBlocked} onAdd={item => { if (rows.length < 100) setRows(previous => [...previous, {
            key: crypto.randomUUID(), materialId: item.id, catalogVersion: item.version, quantity: '1', materialUseIds: [], previousQuantity: 0, display: item.display,
            unit: item.chargeDefinition.unit, priceFen: item.chargeDefinition.priceFen,
          }]) }}>{materialList}</SurgeryFinalMaterialPicker>
      </>}
      {originalReservations.some(item => (remainingAfterCompletion(item, rows) ?? 0) > 0) && !editing ? <div className="flex flex-col gap-2 text-sm"><span>{t('未用的预留', 'Unused reservations')}</span><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" className={releases.length === 0 ? 'border-info bg-info/10 text-info' : undefined} aria-pressed={releases.length === 0} onClick={() => draft.save({ ...draft.value, releases: [] })}>{t('保留预留', 'Keep reservations')}</Button><Button type="button" variant="outline" className={releases.length > 0 ? 'border-info bg-info/10 text-info' : undefined} aria-pressed={releases.length > 0} onClick={() => draft.save({ ...draft.value, releases: originalReservations.filter(item => item.releaseReason == null && (remainingAfterCompletion(item, rows) ?? 0) > 0).map(item => ({ reservationId: item.id, expectedReservationVersion: item.version, display: item.materialDisplay })) })}>{t('释放预留', 'Release reservations')}</Button></div></div> : null}
      {reviewed && preview.data ? <section aria-label={t('本次差额', 'Differences')} className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums"><span>{t('耗材差额合计 ', 'Material difference ')}<b>{formatFen(preview.data.materialDeltaFen, locale)}</b></span><span>{t('术式费 ', 'Procedure fee ')}<b>{formatFen(preview.data.procedureAmountFen, locale)}</b></span><span>{t('本次新增费用 ', 'New charges ')}<b>{formatFen(preview.data.totalDeltaFen, locale)}</b></span></div>
        {editing ? <details open className="clinmesh-inpatient-disclosure"><summary>{t('费用差额与预留明细', 'Charge differences and reservation details')}</summary><div className="flex flex-col gap-1 p-2">      {preview.data.materials.map((row, index) => <div key={index} className="flex flex-col gap-1">
        {row.deltaQuantity !== 0 ? <p className="flex gap-3"><span className="flex-1">{row.item.display} {row.deltaQuantity > 0 ? t('补登', 'add') : t('冲减', 'reduce')} {Math.abs(row.deltaQuantity)} {row.item.chargeDefinition.unit}</span>{' '}<b className="tabular-nums">{formatFen(row.deltaFen, locale)}</b></p> : null}
        {rows[index] && (rows[index]!.priceFen !== row.item.chargeDefinition.priceFen || rows[index]!.unit !== row.item.chargeDefinition.unit)
          ? <Alert><AlertDescription>{t('计价依据已变化，请按本次预览的单价及单位重新核实数量。', 'Pricing changed. Review quantities using the price and unit in this preview.')}</AlertDescription></Alert> : null}
      </div>)}
      {releases.map(item => <p key={item.reservationId} className="flex gap-3"><span className="flex-1">{t('释放预留', 'Release reservation')} · {item.display}</span><b>—</b></p>)}
      {preview.data.retainedReservations.map(item => <p key={item.id} className="flex gap-3"><span className="flex-1">{t('保留预留', 'Keep reservation')} · {item.materialDisplay}</span><b>—</b></p>)}
</div></details> : null}
      </section> : null}
      <Field><FieldLabel htmlFor={`final-note-${execution.id}`}>{t('核实说明', 'Review note')}</FieldLabel><Input id={`final-note-${execution.id}`} maxLength={2000} value={note} onChange={event => draft.save({ ...draft.value, note: event.target.value, noteSource: 'doctor' })} /></Field>
    </FieldGroup></FieldSet>
    {draft.failed ? <Alert variant="destructive"><AlertDescription>{t('未提交输入无法保存，已阻止提交。请检查浏览器存储后重试，已填内容仍保留。', 'The draft could not be saved, so submission is blocked. Check browser storage and retry; entered values are retained.')}
      <Button type="button" size="sm" variant="outline" disabled={write.blocked} onClick={() => draft.save(draft.value)}>{t('重试保存核实输入', 'Retry saving review draft')}</Button>
    </AlertDescription></Alert> : null}
    {validation ? <Alert variant="destructive"><AlertDescription>{validation}</AlertDescription></Alert> : null}
    {!dataReady ? <Button type="button" variant="outline" size="sm" disabled={refreshBasis.isPending} onClick={() => refreshBasis.mutate()}>{t('重试手术资料', 'Retry surgery records')}</Button> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error instanceof ApiClientError && error.code === 'INPATIENT_SURGERY_REVIEW_CONFLICT'
      ? t(error.message, 'Sources are inconsistent. Refresh and review the original records before previewing again.')
      : getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => refreshBasis.mutate()}>{t('刷新核实依据，保留编辑', 'Refresh sources and retain edits')}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={write.blocked || preview.isPending || refreshBasis.isPending} onClick={() => { setClearFailed(false); setClearOpen(true) }}>{t('清空输入并重新带入当前用量', 'Clear draft and reload current quantities')}</Button></div>
    <AlertDialog pending={false} open={clearOpen} onOpenChange={setClearOpen}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{t('丢弃本次核实输入？', 'Discard this review draft?')}</AlertDialogTitle>
      <AlertDialogDescription>{t('将丢弃未提交的最终数量、新增耗材、核实说明及释放选择，重新带入当前已登记用量；不会删除已保存记录。', 'Discard unsaved final quantities, added materials, review note and release selections, then reload recorded use. Saved records remain.')}</AlertDialogDescription>
      </AlertDialogHeader>{clearFailed ? <Alert variant="destructive"><AlertDescription>{t('清空未提交输入失败，原内容仍保留。请检查浏览器存储后重试。', 'The draft could not be cleared. Its contents are retained. Check browser storage and retry.')}</AlertDescription></Alert> : null}
      <AlertDialogFooter><AlertDialogCancel>{t('保留未提交输入', 'Keep draft')}</AlertDialogCancel>
      <Button type="button" variant="destructive" disabled={write.blocked} onClick={() => { if (!isCurrent()) return; if (draft.clear()) { attemptedPreview.current = ''; preview.reset(); setClearOpen(false) } else setClearFailed(true) }}>{t('确认丢弃并重新带入', 'Discard and reload')}</Button>
    </AlertDialogFooter></AlertDialogContent></AlertDialog>
    {preview.error ? <Button type="button" variant="outline" disabled={blocked || !valid} onClick={() => preview.mutate({ input, basis })}>{t('重试核对差额', 'Retry difference review')}</Button> : null}
    {preview.data && !reviewed ? <Alert><AlertDescription>{t('正在按当前输入与依据重新核对差额。', 'Rechecking differences against current inputs and sources.')}</AlertDescription></Alert> : null}

    </div>
    <OrderComposerFooter hint={hint}>{actions}</OrderComposerFooter>
  </form>
}
