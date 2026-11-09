import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientServiceSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { OrderComposerFooter, OrderComposerLayout } from './doctor/order-composer-layout.tsx'
import { InpatientOrderPicker, type InpatientOrderPick } from './inpatient-order-picker.tsx'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { newIdempotencyKey } from './api-client.ts'
import { InpatientCommandRejection, type useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import { orderBatchLimit, orderDose, orderDraftKey, orderDraftSchema, orderSelection, type OrderAttempt, type OrderDraft, type OrderDraftRow } from './inpatient-order-drafts.ts'
import { InpatientOrderRowEstimate } from './inpatient-order-row-estimate.tsx'

const emptyDraft = (): OrderDraft => ({ rows: [], successes: [] })
type Props = {
  open: boolean; onOpenChange(open: boolean): void; active: boolean; session: SessionContext; admission: InpatientAdmission
  encounterVersion: string; diagnosed: boolean; services: Array<z.infer<typeof inpatientServiceSchema>>
  surgeries: z.infer<typeof inpatientSurgerySchema>['executions']; locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>; loading: boolean; catalogError: Error | null; onReload(): void
}

/** 仅编排同次住院的单项开立；原 Command 独占临床校验、回执与审计。 */
export function InpatientOrderComposer(props: Props) {
  const { open, onOpenChange, session, admission, encounterVersion, diagnosed, services, surgeries, locale, write, loading, catalogError, onReload } = props
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en, messages = getWorkspaceMessages(locale), formId = useId()
  const draftKey = orderDraftKey(session, admission)
  const [loaded] = useState(() => {
    try {
      const raw = sessionStorage.getItem(draftKey), draft = raw === null ? emptyDraft() : orderDraftSchema.parse(JSON.parse(raw))
      if (draft.rows.some(row => row.attempt && row.attempt.input.admissionId !== admission.id)) throw new Error('Draft admission mismatch')
      return { draft, error: false }
    } catch { return { draft: emptyDraft(), error: true } }
  })
  const [draft, setDraft] = useState(loaded.draft), current = useRef(draft)
  const [storageError, setStorageError] = useState(loaded.error), [running, setRunning] = useState(false), busy = useRef(false)
  const mounted = useRef(true), latest = useRef(props); latest.current = props
  const lifecycle = useRef({ visible: props.active && open, revision: 0 })
  if (lifecycle.current.visible !== (props.active && open)) lifecycle.current = { visible: props.active && open, revision: lifecycle.current.revision + 1 }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const isCurrent = () => mounted.current && latest.current.active && latest.current.open && latest.current.admission.id === admission.id && latest.current.admission.status === 'admitted' && latest.current.admission.recordStatus !== 'archived'
  const [confirmClear, setConfirmClear] = useState(false), [notice, setNotice] = useState('')
  const [readyEstimates, setReadyEstimates] = useState<Record<string, string | undefined>>({})
  const estimateReady = useCallback((id: string, fingerprint: string | undefined) => setReadyEstimates(previous => previous[id] === fingerprint ? previous : { ...previous, [id]: fingerprint }), [])
  const save = useCallback((next: OrderDraft) => {
    try {
      const valid = orderDraftSchema.parse(next)
      current.current = valid; setDraft(valid)
      sessionStorage.setItem(draftKey, JSON.stringify(valid)); setStorageError(false)
      return true
    } catch { setStorageError(true); return false }
  }, [draftKey])
  const update = useCallback((id: string, patch: Partial<OrderDraftRow>) => save({ ...current.current, rows: current.current.rows.map(row => row.id === id ? { ...row, ...patch } : row) }), [save])
  const locked = write.blocked || running || storageError || admission.status !== 'admitted' || admission.recordStatus === 'archived' || draft.rows.some(row => row.attempt)
  const selected = draft.rows.filter(row => row.selected && !row.attempt)
  const problem = (row: OrderDraftRow) => {
    if (row.pick.kind === 'medication' && !diagnosed) return t('请先确认住院诊断', 'Confirm inpatient diagnoses first')
    if (!orderSelection(row)) return t('请核对每次剂量和频次', 'Check the dose and frequency')
    if (row.pick.kind === 'service' && !services.some(item => item.id === row.pick.item.id && item.version === row.pick.item.version)) return t('目录已变化，请移除后重新选择', 'Catalog changed; remove and select again')
    if (row.surgeryExecutionId && !surgeries.some(item => item.id === row.surgeryExecutionId)) return t('关联手术已变化，请重新核对', 'Review the linked procedure')
    if (row.estimate && (row.estimate.stale || !row.estimate.fingerprint || readyEstimates[row.id] !== row.estimate.fingerprint)) return t('请完成费用预计或重新预计', 'Complete or refresh the charge estimate')
    return undefined
  }
  const add = (pick: InpatientOrderPick | null) => {
    if (!pick || locked) return
    if (current.current.rows.some(row => row.pick.kind === pick.kind && row.pick.item.id === pick.item.id)) { setNotice(t('该项目已在待开清单，请直接修改原行', 'This item is already in the draft list; edit that row')); return }
    if (current.current.rows.length >= orderBatchLimit) { setNotice(t(`最多保留 ${orderBatchLimit} 项，请先办理或移除项目`, `Keep at most ${orderBatchLimit} items; process or remove an item first`)); return }
    save({ ...current.current, rows: [...current.current.rows, { id: newIdempotencyKey(), pick, duration: 'long', selected: true,
      doseText: pick.kind === 'medication' ? pick.item.doses[0]?.doseText ?? '' : '',
      ...(pick.kind === 'medication' && pick.item.frequencyCodes[0] ? { frequencyCode: pick.item.frequencyCodes[0] } : {}) }] }); setNotice('')
  }
  const complete = (row: OrderDraftRow) => save({ rows: current.current.rows.filter(item => item.id !== row.id).map(item => item.estimate ? { ...item, estimate: { ...item.estimate, generation: newIdempotencyKey(), stale: true } } : item),
    successes: [...current.current.successes, { id: row.id, display: row.pick.item.display }].slice(-orderBatchLimit) })
  const run = async (recover?: OrderDraftRow) => {
    if (busy.current || storageError || !isCurrent() || (recover === undefined && (locked || loading || catalogError || selected.length === 0 || selected.some(problem)))) return
    const revision = lifecycle.current.revision
    const currentView = () => isCurrent() && lifecycle.current.revision === revision
    busy.current = true; setRunning(true); setNotice('')
    try {
      for (const id of recover ? [recover.id] : selected.map(row => row.id)) {
        if (!currentView()) break
        const row = current.current.rows.find(item => item.id === id)
        if (!row || (!recover && problem(row))) break
        const selection = orderSelection(row)
        if (!selection) break
        const attempt: OrderAttempt = row.attempt ?? { idempotencyKey: newIdempotencyKey(), input: { admissionId: admission.id, encounterVersion,
          duration: row.duration, selection, ...(row.surgeryExecutionId ? { surgeryExecutionId: row.surgeryExecutionId } : {}),
          ...(row.estimate?.fingerprint ? { expectedDrgFingerprint: row.estimate.fingerprint } : {}) } }
        const beforeAttempt = current.current
        if (!update(row.id, { attempt, error: undefined })) {
          current.current = beforeAttempt; setDraft(beforeAttempt)
          break
        }
        try {
          await write.mutation.mutateAsync({ operation: 'inpatient.order.issue', ...attempt, isCurrent: currentView, ...(recover ? { recoverOriginal: true } : {}) })
          if (!mounted.current || !complete(row) || !currentView()) break
        } catch (cause) {
          if (!mounted.current) break
          const definite = cause instanceof InpatientCommandRejection
          const reason = definite && cause.code === 'CATALOG_CONFLICT' ? cause.message : getWorkspaceErrorMessage(cause instanceof Error ? cause : new Error(), messages)
          update(row.id, { attempt: definite ? undefined : attempt, error: `${reason} · ${definite ? t('请核对信息后重试', 'Review before retrying') : t('结果待确认，请恢复原操作', 'Result unconfirmed; recover the original operation')}`,
            ...(definite && row.estimate ? { estimate: { ...row.estimate, stale: true } } : {}) })
          if (!definite) break
        }
      }
    } finally { busy.current = false; if (mounted.current) setRunning(false) }
  }
  if (!open) return null
  return <>
    <Dialog open={open} onOpenChange={next => { if (!busy.current) onOpenChange(next) }}>
      <DialogContent className="flex h-[min(800px,calc(100svh-2.5rem))] flex-col sm:max-w-5xl" showCloseButton={!running}>
        <DialogHeader><DialogTitle>{t('开立医嘱', 'Issue order')}</DialogTitle><DialogDescription>{t(`连续添加药品和护理治疗，逐条核对后集中开立；最多 ${orderBatchLimit} 项，关闭后保留。开立后仍须护士校对，不代表已经执行。`, `Add and review medications and nursing items, then issue together. Keep up to ${orderBatchLimit} drafts after closing. Nurse verification and actual execution remain separate.`)}</DialogDescription></DialogHeader>
        <OrderComposerLayout locale={locale} catalog={<InpatientOrderPicker id={`${formId}-item`} inline session={session} locale={locale} services={services} diagnosed={diagnosed} disabled={locked} picked={null} onPick={add} />}>
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm font-medium">{t(`待开 ${draft.rows.length} 项 · 已选 ${selected.length} 项`, `${draft.rows.length} draft items · ${selected.length} selected`)}</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked} onClick={() => save({ ...current.current, rows: current.current.rows.map(row => !row.attempt && !problem(row) ? { ...row, selected: true } : row) })}>{t('全选本页可办理项目', 'Select eligible items on this page')}</Button><Button size="sm" variant="outline" disabled={locked} onClick={() => save({ ...current.current, rows: current.current.rows.map(row => ({ ...row, selected: false })) })}>{t('清空选择', 'Clear selection')}</Button><Button size="sm" variant="outline" disabled={running || draft.rows.some(row => row.attempt)} onClick={() => setConfirmClear(true)}>{t('清空待开清单', 'Discard drafts')}</Button></div>
            <p className="text-xs text-muted-foreground">{t(`完整已选清单：${selected.map(row => row.pick.item.display).join('、') || '未选择'}`, `All selected: ${selected.map(row => row.pick.item.display).join(', ') || 'None'}`)}</p>
            {draft.rows.map(row => {
              const dose = orderDose(row)
              const edit = (patch: Partial<OrderDraftRow>) => update(row.id, { ...patch, estimate: undefined, error: undefined })
              return <section key={row.id} aria-label={t(`待开：${row.pick.item.display}`, `Draft: ${row.pick.item.display}`)} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
                <div className="flex items-start gap-2"><Checkbox aria-label={t(`选择待开${row.pick.item.display}`, `Select draft ${row.pick.item.display}`)} checked={row.selected} disabled={locked} onCheckedChange={selected => update(row.id, { selected })} /><strong className="min-w-0 flex-1 text-sm wrap-anywhere">{row.pick.item.display}</strong><Button size="sm" variant="ghost" disabled={locked} onClick={() => save({ ...current.current, rows: current.current.rows.filter(item => item.id !== row.id) })}>{t('移除项目', 'Remove item')}</Button></div>
                <Field><FieldLabel>{t('医嘱时效', 'Order duration')}</FieldLabel><ToggleGroup aria-label={t('医嘱时效', 'Order duration')} disabled={locked} value={[row.duration]} variant="outline" onValueChange={values => { if (values[0] === 'long' || values[0] === 'temporary') edit({ duration: values[0] }) }}><ToggleGroupItem value="long">{t('长期', 'Long')}</ToggleGroupItem><ToggleGroupItem value="temporary">{t('临时', 'Temporary')}</ToggleGroupItem></ToggleGroup></Field>
                {row.pick.kind === 'medication' ? <>
                  <Field><FieldLabel htmlFor={`${formId}-${row.id}-dose`}>{t('每次剂量', 'Dose per execution')}</FieldLabel><Input id={`${formId}-${row.id}-dose`} disabled={locked} value={row.doseText} maxLength={120} aria-invalid={dose !== undefined && 'reason' in dose} onChange={event => edit({ doseText: event.currentTarget.value })} />{dose && 'quantity' in dose ? <span className="text-xs text-muted-foreground">= {dose.quantity} {row.pick.item.unit}</span> : <p className="text-xs text-destructive">{dose && 'reason' in dose ? doseError(dose.reason, locale) : ''}</p>}</Field>
                  <Field><FieldLabel htmlFor={`${formId}-${row.id}-frequency`}>{t('医嘱频次', 'Order frequency')}</FieldLabel><WorkspaceSelect id={`${formId}-${row.id}-frequency`} disabled={locked} value={row.frequencyCode ?? null} items={row.pick.item.frequencyCodes.map(code => ({ value: code, label: inpatientFrequencyLabel(code, locale) }))} onValueChange={value => edit({ frequencyCode: value ?? undefined })} /></Field>
                </> : <p className="text-xs text-muted-foreground">{t('每次 1 次 · 频次不适用', 'One per execution · frequency not applicable')}</p>}
                <Field><FieldLabel htmlFor={`${formId}-${row.id}-surgery`}>{t('术后医嘱关联手术', 'Postoperative procedure')}</FieldLabel><WorkspaceSelect id={`${formId}-${row.id}-surgery`} disabled={locked || !surgeries.length} value={row.surgeryExecutionId ?? ''} items={[{ value: '', label: t('不关联（普通医嘱）', 'None (regular order)') }, ...surgeries.map(item => ({ value: item.id, label: `${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}` }))]} onValueChange={value => edit({ surgeryExecutionId: value || undefined })} /></Field>
                <Button size="sm" variant="outline" disabled={locked || !orderSelection(row)} onClick={() => update(row.id, { estimate: row.estimate ? undefined : { generation: newIdempotencyKey(), stale: false } })}>{row.estimate ? t('收起费用预计', 'Hide estimate') : t('费用预计', 'Estimate charges')}</Button>
                {row.estimate ? <InpatientOrderRowEstimate row={row} session={session} admissionId={admission.id} locale={locale} enabled={!locked && props.active} onUpdate={update} onReady={estimateReady} /> : null}
                {problem(row) ? <p className="text-xs text-destructive">{problem(row)}</p> : null}
                {row.error ? <p role="alert" className="text-xs text-destructive">{row.error}</p> : null}
                {row.attempt ? <Button size="sm" disabled={running} onClick={() => void run(row)}>{t(`恢复原开立：${row.pick.item.display}`, `Recover original order: ${row.pick.item.display}`)}</Button> : null}
              </section>
            })}
            {draft.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无待开医嘱，请从目录连续添加', 'No draft orders; add items from the catalog')}</p> : null}
            {draft.successes.length > 0 ? <div role="status" className="text-sm"><p>{t(`已成功开立 ${draft.successes.length} 项`, `${draft.successes.length} items issued successfully`)}</p>{draft.successes.map(result => <p key={result.id}>{result.display} · {t('待护士校对', 'Awaiting nurse verification')}</p>)}</div> : null}
          </div>
        </OrderComposerLayout>
        {loading || catalogError ? <Alert><AlertDescription>{loading ? t('正在读取护理目录', 'Loading nursing catalog') : getWorkspaceErrorMessage(catalogError!, messages)}<Button size="sm" variant="outline" onClick={onReload}>{t('重试加载', 'Retry loading')}</Button></AlertDescription></Alert> : null}
        {storageError || notice ? <Alert variant="destructive"><AlertDescription>{storageError ? t('待开清单无法保存或读取，已停止开立。请确认后清空待开清单再试。', 'Draft storage unavailable; ordering stopped. Confirm discarding drafts to retry.') : notice}</AlertDescription></Alert> : null}
        <OrderComposerFooter hint={running ? t('正在逐项开立，请稍候…', 'Issuing each item…') : write.blocked ? t('请先恢复原住院操作', 'Recover the original inpatient operation first') : selected.some(problem) ? t('还差：请修正所选医嘱的问题', 'Complete: fix the selected orders') : t(`本次仅开立所选 ${selected.length} 项，成功后仍待护士校对`, `Issue only ${selected.length} selected items; nurse verification follows`)}>
          <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>{t('关闭', 'Close')}</Button><Button disabled={locked || loading || !!catalogError || selected.length === 0 || selected.some(problem)} onClick={() => void run()}>{t(`开立所选医嘱（${selected.length}）`, `Issue selected orders (${selected.length})`)}</Button>
        </OrderComposerFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('丢弃全部未提交待开清单？', 'Discard all unsubmitted drafts?')}</AlertDialogTitle><AlertDialogDescription>{t('将删除本次住院未提交的医嘱输入，已开立医嘱不受影响。', 'Discard unsubmitted order inputs for this admission. Issued orders remain.')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('保留待开清单', 'Keep drafts')}</AlertDialogCancel><AlertDialogAction onClick={() => { save(emptyDraft()); setConfirmClear(false) }}>{t('确认清空', 'Confirm discard')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}

function doseError(reason: string, locale: WorkspaceLocale) {
  const messages: Record<string, [string, string]> = {
    'invalid-dose': ['请填写有效的每次剂量和单位', 'Enter a valid dose and unit'],
    'missing-conversion': ['缺少该剂量单位的明确换算关系，可按制剂单位填写', 'No confirmed conversion; use preparation units'],
    'unit-mismatch': ['本次剂量单位与已声明的换算不匹配', 'Dose unit does not match the declared conversion'],
    'fractional-quantity': ['本次用量无法换算为完整制剂数量', 'Dose does not convert to whole preparation units'],
    'dose-limit': ['本次用量超过已声明的每次上限', 'Dose exceeds the declared per-execution limit'],
  }
  return messages[reason]?.[locale === 'zh-CN' ? 0 : 1]
}
