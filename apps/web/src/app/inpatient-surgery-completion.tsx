import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { z } from 'zod'
import { inpatientSurgeryCompletionPreviewSchema, type inpatientSurgeryCompletionReviewInputSchema,
  type inpatientSurgeryCatalogSchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Input } from '@clinmesh/ui/components/input'
import { ApiClientError, apiMutation, getSession } from './api-client.ts'
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
    {open && props.active !== false ? <section role="dialog" aria-label={t('核实最终耗材并完成手术', 'Review final materials and complete surgery')} className="flex max-h-[min(80svh,900px)] min-h-0 flex-col rounded-lg border bg-card shadow-sm">
      <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-3">
        <h4 className="text-sm font-semibold">{t('核实最终耗材并完成手术', 'Review final materials and complete surgery')}</h4>
        <p className="text-xs text-muted-foreground">{t('按真实最终总量填写；最多100项，只补登或冲减与已登记的差额。剩余预留默认保留，可选择需要释放的余量。', 'Enter true final totals, up to 100 items; only the differences are posted. Remaining reservations are kept unless selected for release.')}</p>
      </div>
      <CompletionEditor key={ownerKey} {...props} onClose={() => { if (!props.write.mutation.isPending) setOpen(false) }} />
    </section> : null}
  </>
}

function CompletionEditor(props: Props & { onClose: () => void }): React.JSX.Element {
  const { execution, request, catalog, reservations, write, locale, refresh, onClose, session, admission, active, dataReady } = props
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = surgeryDraftScope({ session, patientId: admission.patientId, admissionId: admission.id, requestId: request.id, executionId: execution.id, action: 'complete' })
  const scopeKey = JSON.stringify(scope)
  const draft = useSurgeryDraft({ scope, schema: completionDraftSchema, initial: initialCompletionDraft(execution, reservations, request.id) })
  const { rows, note, releases } = draft.value
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
  const refreshBasis = useMutation({ retry: false, mutationFn: refresh, onSuccess: () => { preview.reset(); if (isCurrent()) setRefreshCount(value => value + 1) } })
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
  const blocked = write.blocked || preview.isPending || refreshBasis.isPending || draft.failed || active === false
  const materialList = <SurgeryFinalMaterialList rows={rows} catalog={catalog} reservations={reservations} requestId={request.id}
    locale={locale} disabled={blocked} rowProblem={rowProblem} onChange={setRows} />
  const hint = validation ?? (!note.trim() ? t('还差：核实说明', 'Enter the review note') : reviewed ? t('确认后补登差额并计入术式费，手术结束', 'Confirmation posts the differences and procedure fee and completes surgery') : t('先预览差额，再确认完成', 'Preview the differences before completing'))
  const confirm = () => {
    if (!isCurrent() || blocked || !valid || !reviewed || !preview.data) return
    const command = { operation: 'inpatient.surgery.complete' as const, input: {
      admissionId: input.admissionId, requestId: input.requestId, executionId: input.executionId, expectedRequestVersion: input.expectedRequestVersion, note: input.note,
      reconciliation: { finalMaterials: input.finalMaterials, releaseReservations: input.releaseReservations, expectedFingerprint: preview.data.fingerprint },
    } }
    if (draft.prepareSubmission(command)) write.mutation.mutate({ ...command, isCurrent: () => isCurrent() && current.current.dataReady })
  }
  const actions = <>
    {reviewed && preview.data ? <Button type="button" variant="ghost" disabled={blocked} onClick={() => preview.reset()}>{t('改数量', 'Edit quantities')}</Button>
      : <Button type="button" variant="outline" disabled={write.mutation.isPending} onClick={onClose}>{t('取消', 'Cancel')}</Button>}
    {reviewed && preview.data ? <Button type="button" disabled={blocked || !valid} onClick={confirm}>{t('确认完成手术', 'Complete surgery')}</Button>
      : <Button type="button" disabled={blocked || !valid} onClick={() => { if (isCurrent() && valid && !blocked) preview.mutate({ input, basis }) }}>{preview.isPending ? t('正在预览差额', 'Previewing differences') : t('预览本次差额', 'Preview differences')}</Button>}
  </>
  return <form className="flex min-h-0 flex-1 flex-col p-0" onSubmit={event => event.preventDefault()}>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    <FieldSet disabled={blocked}><FieldGroup>
      {materialList}
      <SurgeryReleasePicker reservations={originalReservations} rows={rows} selected={releases} locale={locale} disabled={blocked} onChange={next => draft.save({ ...draft.value, releases: next }, { keepCurrentOnFailure: next.length < releases.length })} />
      <SurgeryFinalMaterialPicker catalog={catalog} locale={locale} count={rows.length} disabled={blocked} onAdd={item => { if (rows.length < 100) setRows(previous => [...previous, {
            key: crypto.randomUUID(), materialId: item.id, catalogVersion: item.version, quantity: '1', materialUseIds: [], previousQuantity: 0, display: item.display,
            unit: item.chargeDefinition.unit, priceFen: item.chargeDefinition.priceFen,
          }]) }}>{materialList}</SurgeryFinalMaterialPicker>
      <Field><FieldLabel htmlFor={`final-note-${execution.id}`}>{t('核实说明', 'Review note')}</FieldLabel><Input id={`final-note-${execution.id}`} maxLength={2000} value={note} onChange={event => draft.save({ ...draft.value, note: event.target.value })} /></Field>
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
    <AlertDialog open={clearOpen} onOpenChange={setClearOpen}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{t('丢弃本次核实输入？', 'Discard this review draft?')}</AlertDialogTitle>
      <AlertDialogDescription>{t('将丢弃未提交的最终数量、新增耗材、核实说明及释放选择，重新带入当前已登记用量；不会删除已保存记录。', 'Discard unsaved final quantities, added materials, review note and release selections, then reload recorded use. Saved records remain.')}</AlertDialogDescription>
      </AlertDialogHeader>{clearFailed ? <Alert variant="destructive"><AlertDescription>{t('清空未提交输入失败，原内容仍保留。请检查浏览器存储后重试。', 'The draft could not be cleared. Its contents are retained. Check browser storage and retry.')}</AlertDescription></Alert> : null}
      <AlertDialogFooter><Button type="button" variant="outline" onClick={() => setClearOpen(false)}>{t('保留未提交输入', 'Keep draft')}</Button>
      <Button type="button" variant="destructive" disabled={write.blocked} onClick={() => { if (!isCurrent()) return; if (draft.clear()) { preview.reset(); setClearOpen(false) } else setClearFailed(true) }}>{t('确认丢弃并重新带入', 'Discard and reload')}</Button>
    </AlertDialogFooter></AlertDialogContent></AlertDialog>
    {preview.data && !reviewed ? <Alert><AlertDescription>{t('输入或依据已变化，请重新预览后确认。', 'Inputs or sources changed. Preview again before confirming.')}</AlertDescription></Alert> : null}
    {reviewed && preview.data ? <section aria-label={t('本次差额', 'Differences')} className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
      {preview.data.materials.map((row, index) => <div key={index} className="flex flex-col gap-1">
        {row.deltaQuantity !== 0 ? <p className="flex gap-3"><span className="flex-1">{row.item.display} {row.deltaQuantity > 0 ? t('补登', 'add') : t('冲减', 'reduce')} {Math.abs(row.deltaQuantity)} {row.item.chargeDefinition.unit}</span>{' '}<b className="tabular-nums">{formatFen(row.deltaFen, locale)}</b></p> : null}
        {rows[index] && (rows[index]!.priceFen !== row.item.chargeDefinition.priceFen || rows[index]!.unit !== row.item.chargeDefinition.unit)
          ? <Alert><AlertDescription>{t('计价依据已变化，请按本次预览的单价及单位重新核实数量。', 'Pricing changed. Review quantities using the price and unit in this preview.')}</AlertDescription></Alert> : null}
      </div>)}
      {releases.map(item => <p key={item.reservationId} className="flex gap-3"><span className="flex-1">{t('释放预留', 'Release reservation')} · {item.display}</span><b>—</b></p>)}
      {preview.data.retainedReservations.map(item => <p key={item.id} className="flex gap-3"><span className="flex-1">{t('保留预留', 'Keep reservation')} · {item.materialDisplay}</span><b>—</b></p>)}
      <p className="flex gap-3"><span className="flex-1">{t('耗材差额合计', 'Material difference')}</span>{' '}<b className="tabular-nums">{formatFen(preview.data.materialDeltaFen, locale)}</b></p>
      <p className="flex gap-3"><span className="flex-1">{t('术式费', 'Procedure fee')} · {execution.actualProcedure.coding.display}</span>{' '}<b className="tabular-nums">{formatFen(preview.data.procedureAmountFen, locale)}</b></p>
      <p className="flex gap-3 border-t pt-1.5 font-semibold"><span className="flex-1">{t('本次新增费用', 'New charges')}</span>{' '}<b className="tabular-nums">{formatFen(preview.data.totalDeltaFen, locale)}</b></p>
    </section> : null}
    </div>
    <InpatientPrimaryAction stage="surgery" priority={60} fallback={actions}>
      <WorkspaceActionBar
        tone={!valid ? 'blocked' : reviewed ? 'confirm' : 'normal'}
        summary={execution.actualProcedure.coding.display}
        reason={hint}
        busy={preview.isPending ? t('正在预览差额', 'Previewing differences') : undefined}
        action={actions}
      />
    </InpatientPrimaryAction>
  </form>
}
