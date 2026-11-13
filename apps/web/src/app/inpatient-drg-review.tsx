import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgReviewSchema, inpatientDrgReviewResponseSchema, type inpatientDrgReviewTodoSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { postoperativeDispositionNote } from './inpatient-surgery-notes.ts'
import { apiGet } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { InpatientMaterialPlanBasisDetails } from './inpatient-material-plan.tsx'
import { InpatientDrgIssueDetails, type DrgRecordTarget } from './inpatient-drg-record-checks.tsx'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active?: boolean; compact?: boolean; requestId?: string | undefined; onOpenRecord?: ((target: DrgRecordTarget) => void) | undefined }

/** 折叠保留处置稿；患者或行动上下文变化必须换编辑器实例。 */
export function InpatientDrgReviewDisclosure(props: Props): React.JSX.Element {
  const [open, setOpen] = useState(false), [visited, setVisited] = useState(false)
  const actor = props.session.actor
  const editorKey = JSON.stringify([props.session.user.id, actor.actorId, actor.workspaceId, actor.epoch, actor.scenarioRunId,
    actor.practitionerRoleId, actor.roleCode, actor.organizationId, actor.locationId, actor.practitionerId, props.admission.id])
  const financial = actor.roleCode === 'cashier', zh = props.locale === 'zh-CN'
  return <details className="clinmesh-inpatient-disclosure" open={open} onToggle={event => {
    setOpen(event.currentTarget.open)
    if (event.currentTarget.open) setVisited(true)
  }}><summary>{financial ? zh ? '费用差异核对' : 'Charge differences' : zh ? '术后核查与责任交接' : 'Postoperative review and handoff'}</summary>
    {visited ? <InpatientDrgReviewPanel key={editorKey} {...props} active={props.active !== false && open} /> : null}
  </details>
}

export function InpatientDrgReviewPanel({ admission, session, locale, write, active = true, compact = false, onOpenRecord, requestId }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const financial = session.actor.roleCode === 'cashier', [notes, setNotes] = useState<Record<string, string>>({}), [handoff, setHandoff] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false), [sourceId, setSourceId] = useState<string | null>(null)
  useLayoutEffect(() => { if (!active) { setHistoryOpen(false); setSourceId(null) } }, [active])
  const review = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-review'], enabled: active,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/review`, inpatientDrgReviewSchema, signal),
    refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const raw = review.error === null ? review.data : undefined
  const data = raw && requestId ? { ...raw, todos: raw.todos.filter(item => item.requestId === requestId), resolvedTodos: raw.resolvedTodos.filter(item => item.requestId === requestId),
    comparisons: raw.comparisons.filter(item => item.requestId === requestId), planBases: raw.planBases.filter(item => item.requestId === requestId) } : raw
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const doctor = session.actor.roleCode === 'inpatient-doctor'
  const surgeries = useQuery({ queryKey: [...scope, 'surgeries'], enabled: active && doctor, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const reservations = useQuery({ queryKey: [...scope, 'drg-reservations'], enabled: active && doctor, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const noteFor = (todo: z.infer<typeof inpatientDrgReviewTodoSchema>) => notes[todo.id] ?? (doctor
    ? postoperativeDispositionNote(todo, surgeries.data?.executions ?? [], reservations.data?.reservations ?? [], locale) : '')
  const [batching, setBatching] = useState(false), [actionError, setActionError] = useState<unknown>(null)
  const ownerKey = JSON.stringify([session.user.id, session.actor, admission.id, requestId]), currentOwner = useRef(ownerKey), mounted = useRef(true)
  currentOwner.current = active ? ownerKey : ''
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const readonly = !active || admission.recordStatus === 'archived'
  const roleName = (role: string) => ({ 'inpatient-doctor': t('住院医生', 'Inpatient doctor'), cashier: t('收费员', 'Cashier'), 'medical-records': t('病案人员', 'Medical records') })[role] ?? role
  const statusName = (status: string) => ({ pending: t('待核实', 'Pending'), 'in-progress': t('处理中', 'In progress'), resolved: t('已按记录解决', 'Resolved by facts'), dismissed: t('人工无需处理', 'Dismissed with reason') })[status] ?? status
  const blockedReason = (code: string | null) => ({ MODEL_DISABLED: t('AI功能已停用。', 'AI processing is disabled.'), MODEL_REQUEST_LIMIT: t('本次分析的请求额度不足。', 'The request allowance is insufficient.'), MODEL_TOKEN_LIMIT: t('本次分析的用量额度不足。', 'The usage allowance is insufficient.'), MODEL_CNY_LIMIT: t('本次分析的费用额度不足。', 'The cost allowance is insufficient.'), MODEL_METERING_UNAVAILABLE: t('暂时无法确认本次分析的用量，请联系管理员。', 'Usage cannot be confirmed. Contact an administrator.'), MODEL_RETRY_DISABLED: t('当前不允许自动重试。', 'Automatic retries are disabled.'), MODEL_LEDGER_UNAVAILABLE: t('分析用量暂时无法读取。', 'Analysis usage is temporarily unavailable.') })[code ?? ''] ?? t('分析暂不可用，请联系管理员。', 'Analysis is unavailable. Contact an administrator.')
  const submit = async (todo: z.infer<typeof inpatientDrgReviewTodoSchema>, action: 'in-progress' | 'dismiss' | 'recheck', fingerprint: string, note: string) => {
    const result = await write.mutation.mutateAsync({ operation: 'inpatient.drg.review.todo.act', input: { admissionId: admission.id, todoId: todo.id,
      expectedTodoVersion: todo.version, expectedFingerprint: fingerprint, action, note: note.trim() } })
    return inpatientDrgReviewResponseSchema.parse(result.response).data
  }
  const act = async (todoId: string, action: 'in-progress' | 'dismiss' | 'recheck') => {
    const todo = data?.todos.find(item => item.id === todoId)
    if (readonly || batching || write.blocked || !data?.fingerprint || !todo || !noteFor(todo).trim()) return
    setActionError(null)
    try { await submit(todo, action, data.fingerprint, noteFor(todo)); await review.refetch() }
    catch (error) { if (mounted.current && currentOwner.current === ownerKey) setActionError(error) }
  }
  const confirmAll = async () => {
    if (readonly || batching || write.blocked || !data?.fingerprint) return
    const selected = data.todos.filter(todo => todo.ownerRole === session.actor.roleCode).map(todo => ({ todo, note: noteFor(todo) }))
    if (selected.some(item => !item.note.trim())) return
    setBatching(true); setActionError(null)
    let latest = data
    try {
      for (const item of selected) {
        if (!mounted.current || currentOwner.current !== ownerKey) break
        const todo = latest.todos.find(todo => todo.id === item.todo.id)
        if (!todo || !latest.fingerprint) break
        latest = await submit(todo, 'dismiss', latest.fingerprint, item.note)
      }
      if (mounted.current && currentOwner.current === ownerKey) await review.refetch()
    } catch (error) {
      if (mounted.current && currentOwner.current === ownerKey) { setActionError(error); await review.refetch() }
    } finally { if (mounted.current) setBatching(false) }
  }
  return <section aria-label={financial ? t('费用差异核对', 'Charge differences') : t('术后核查与责任交接', 'Postoperative review and handoff')} className="flex flex-col gap-3">
    <h4 className="font-medium">{financial ? t('费用差异核对', 'Charge differences') : t('术后核查与责任交接', 'Postoperative review and handoff')}</h4>
    {!compact ? <p className="text-sm text-muted-foreground">{financial ? t('核对实际收费与应计费用。发现差异时先查看费用原记录，完成更正后再复查。', 'Compare posted and expected charges. Check the original charge and recheck after correction.') : t('核对术前计划与实际用量。发现差异时先查看手术原记录，填写处理说明后复查或交接。', 'Compare the preoperative plan with actual use. Check the surgery record, then record the disposition and recheck or hand over.')}</p> : null}
    {actionError ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(actionError instanceof Error ? actionError : new Error(String(actionError)), getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {review.isPending ? <p role="status">{t('正在读取核查结果', 'Loading review')}</p> : null}
    {review.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(review.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {data ? <>
      {data.status === 'waiting-surgery' ? <p>{t('等待相关手术完成后进行计划与实际核查。', 'The related surgery must finish before comparison.')}</p> : null}
      {data.status === 'inactive' ? <p>{t('尚无已完成手术的核查结果。手术完成后可在此核对。', 'No completed surgery is available for review. Return here after surgery.')}</p> : null}
      {data.freezeReason ? <p role="status">{data.freezeReason}</p> : null}
      {data.summary.formalChargesFen !== null ? <p>{t('阶段正式收费 ', 'Posted charges at review ')}{formatFen(data.summary.formalChargesFen, locale)}{financial ? '' : ` · ${t('阶段 DRG ', 'Stage DRG ')}${data.summary.formalDrgCode ?? t('未确定', 'Undetermined')}`}</p> : null}
      {!financial && data.summary.projectedTotalFen !== null ? <p>{t('含医生已有后续治疗计划的费用预计 ', 'Projection including existing treatment plans ')}{formatFen(data.summary.projectedTotalFen, locale)}</p> : null}
      {data.missing.length > 0 && data.status !== 'waiting-surgery' && data.status !== 'inactive' ? <p role="status">{t('核查不完整：', 'Incomplete review: ')}{data.missing.join(' · ')}</p> : null}
      {compact ? <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogTrigger render={<Button type="button" variant="outline" className="self-start" />}>{t('核查依据与历史', 'Review evidence and history')}</DialogTrigger>
        <DialogContent className="sm:max-w-[800px]"><DialogHeader><DialogTitle>{t('核查依据与历史', 'Review evidence and history')}</DialogTitle><DialogDescription>{admission.patientName}</DialogDescription></DialogHeader>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            {data.planBases.map(basis => <InpatientMaterialPlanBasisDetails key={basis.requestId} basis={basis} locale={locale} procedureDisplay={data.comparisons.find(item => item.requestId === basis.requestId)?.procedureDisplay ?? data.todos.find(item => item.requestId === basis.requestId)?.procedureDisplay} />)}
            {data.comparisons.map(item => <p key={`${item.executionId ?? ''}:${item.materialId}@${item.catalogVersion}`}>{item.display} · {t('术前确认 ', 'Confirmed ')}{item.plannedQuantity ?? t('未知', 'Unknown')} · {t('实际 ', 'Actual ')}{item.actualQuantity}</p>)}
            {data.model?.observations.map(item => <p key={item.key}>{item.explanation}</p>)}
            {data.resolvedTodos.map(todo => <p key={todo.id}>{todo.display} · {statusName(todo.status)} · {todo.reason}</p>)}
            {data.actions.map((action, index) => <p key={index}>{roleName(action.role)} · {action.note} · {new Date(action.at).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</p>)}
          </div><DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{t('关闭', 'Close')}</DialogClose></DialogFooter>
        </DialogContent></Dialog> : <>
        {!financial ? data.planBases.map(basis => <InpatientMaterialPlanBasisDetails key={basis.requestId} basis={basis} locale={locale} procedureDisplay={data.comparisons.find(item => item.requestId === basis.requestId)?.procedureDisplay ?? data.todos.find(item => item.requestId === basis.requestId)?.procedureDisplay} />) : null}
        {data.comparisons.length > 0 ? <Table><TableHeader><TableRow><TableHead>{t('耗材产品', 'Material')}</TableHead><TableHead>{t('术前确认数量', 'Confirmed preoperative quantity')}</TableHead><TableHead>{t('实际使用', 'Actual use')}</TableHead></TableRow></TableHeader><TableBody>{data.comparisons.map(item => <TableRow key={`${item.executionId ?? ""}:${item.materialId}@${item.catalogVersion}`}><TableCell>{item.display}{item.executionId ? <p className="text-sm text-muted-foreground">{item.procedureDisplay ?? t('实际手术记录', 'Performed procedure record')}</p> : null}</TableCell><TableCell>{item.plannedQuantity ?? t('未知', 'Unknown')}</TableCell><TableCell>{item.actualQuantity}</TableCell></TableRow>)}</TableBody></Table> : null}
      </>}
      {data.model ? <>
        <p role="status">{data.model.current ? t('术后分析已就绪，可展开查看核对依据。', 'Postoperative analysis is ready. Open its supporting explanation.')
          : data.model.status === 'unknown' ? t('AI请求结果未知，保留待核查，不自动重发。', 'AI outcome unknown; awaiting investigation without automatic resubmission.')
            : data.model.status === 'blocked' ? `${t('术后分析未完成：', 'Postoperative analysis incomplete: ')}${blockedReason(data.model.failureCode)}`
              : data.model.status === 'failed' ? t('术后分析未完成，请按已有核查结果继续处理待办。', 'Postoperative analysis is incomplete. Continue with the available findings and tasks.')
              : data.status === 'frozen' ? t('本轮已停止新分析，保留最后结果与未完成状态。', 'New analysis ended; prior results and unfinished states are retained.')
                : data.status === 'complete' || data.status === 'incomplete' ? '' : ''}</p>
        {!compact && data.model.observations.length > 0 ? <details><summary>{data.model.current ? t('查看已核验解释', 'Verified explanations') : t('查看保留的历史解释', 'Retained historical explanations')}</summary>{data.model.observations.map(item => <p key={item.key}>{item.explanation}</p>)}</details> : null}
      </> : null}
      {data.todos.length === 0 && data.status !== 'waiting-surgery' && data.status !== 'inactive' ? <p>{t('当前没有未解决核查待办。', 'No unresolved review tasks.')}</p> : null}
      {doctor && !readonly && data.todos.some(todo => todo.ownerRole === session.actor.roleCode) ? <Button type="button" variant="outline" className="self-start" disabled={batching || write.blocked || data.todos.filter(todo => todo.ownerRole === session.actor.roleCode).some(todo => !noteFor(todo).trim())} onClick={() => { void confirmAll() }}>{batching ? t('正在逐项确认', 'Confirming each task') : t('一次全部确认', 'Confirm all')}</Button> : null}
      {data.todos.map(todo => <article key={todo.id} className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{todo.display}</h5><Badge variant="secondary">{statusName(todo.status)}</Badge><span>{t('负责岗位：', 'Responsible: ')}{roleName(todo.ownerRole)}</span></div>
        <p>{todo.explanation}</p>{compact ? <Dialog open={sourceId === todo.id} onOpenChange={open => setSourceId(open ? todo.id : null)}><DialogTrigger render={<Button type="button" variant="link" className="self-start" />}>{t('查看来源与原记录', 'View sources and original records')}</DialogTrigger>
          <DialogContent className="sm:max-w-[720px]"><DialogHeader><DialogTitle>{todo.display}</DialogTitle><DialogDescription>{t('核查来源与恢复入口', 'Review sources and recovery actions')}</DialogDescription></DialogHeader><div className="min-h-0 overflow-y-auto p-4"><InpatientDrgIssueDetails issue={todo} locale={locale} financial={financial} onOpenRecord={onOpenRecord ? target => { setSourceId(null); onOpenRecord(target) } : undefined} /></div><DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{t('关闭', 'Close')}</DialogClose></DialogFooter></DialogContent>
        </Dialog> : <InpatientDrgIssueDetails issue={todo} locale={locale} financial={financial} onOpenRecord={onOpenRecord} />}{todo.reason ? <p>{t('处置依据：', 'Disposition reason: ')}{todo.reason}</p> : null}
        {!readonly && todo.ownerRole === session.actor.roleCode ? <>
          <Field><FieldLabel htmlFor={`drg-todo-${todo.id}`}>{t('待办处理说明', 'Task disposition reason')}</FieldLabel><Input id={`drg-todo-${todo.id}`} value={noteFor(todo)} onChange={event => setNotes(previous => ({ ...previous, [todo.id]: event.target.value }))} maxLength={2000} /></Field>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={batching || write.blocked || !(noteFor(todo)).trim()} onClick={() => { void act(todo.id, 'in-progress') }}>{doctor ? t('需要跟进', 'Follow up') : t('标记处理中', 'Start processing')}</Button><Button variant="outline" disabled={batching || write.blocked || !(noteFor(todo)).trim()} onClick={() => { void act(todo.id, 'dismiss') }}>{doctor ? t('按此说明确认', 'Confirm this note') : t('人工判断无需处理', 'Dismiss with reason')}</Button><Button variant="outline" disabled={batching || write.blocked || !(noteFor(todo)).trim() || data.status === 'frozen'} onClick={() => { void act(todo.id, 'recheck') }}>{t('复查最新业务记录', 'Recheck business facts')}</Button></div>
        </> : null}
      </article>)}
      {!compact && data.resolvedTodos.length > 0 ? <details><summary>{t('已按记录解决的待办', 'Tasks resolved by facts')}</summary>{data.resolvedTodos.map(todo => <p key={todo.id}>{todo.display} · {statusName(todo.status)} · {todo.reason}</p>)}</details> : null}
      {!compact && data.actions.length > 0 ? <details><summary>{t('查看人工处置历史', 'Disposition history')}</summary>{data.actions.map((action, index) => <p key={index}>{roleName(action.role)} · {action.note} · {new Date(action.at).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</p>)}</details> : null}
      {data.handedOver ? <p>{t('本轮已交接：', 'Handoff completed: ')}{data.handedOver.note}</p> : !readonly && data.status === 'frozen' && ['inpatient-doctor', 'medical-records'].includes(session.actor.roleCode) ? <>
        <Field><FieldLabel htmlFor={`drg-handoff-${admission.id}`}>{t('本轮交接说明', 'Handoff note')}</FieldLabel><Input id={`drg-handoff-${admission.id}`} value={handoff} onChange={event => setHandoff(event.target.value)} maxLength={2000} /></Field>
        <p>{t('交接保留未解决待办的负责岗位，不自动解决问题，也不恢复临床分析。', 'Handoff retains responsibility for unresolved tasks and does not restart analysis.')}</p>
        <Button disabled={write.blocked || !handoff.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.drg.review.handoff', input: { admissionId: admission.id, expectedVersion: data.version, note: handoff.trim() } }, { onSuccess: () => { void review.refetch() } })}>{t('确认交接并保留未解决责任', 'Confirm handoff and unresolved responsibility')}</Button>
      </> : null}
    </> : null}
  </section>
}
