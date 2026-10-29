import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active?: boolean }

export function InpatientDrgReviewPanel({ admission, session, locale, write, active = true }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const financial = session.actor.roleCode === 'cashier', [notes, setNotes] = useState<Record<string, string>>({}), [handoff, setHandoff] = useState('')
  const review = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-review'], enabled: active,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/review`, inpatientDrgReviewSchema, signal),
    refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const data = review.error === null ? review.data : undefined
  const roleName = (role: string) => ({ 'inpatient-doctor': t('住院医生', 'Inpatient doctor'), cashier: t('收费员', 'Cashier'), 'medical-records': t('病案人员', 'Medical records') })[role] ?? role
  const statusName = (status: string) => ({ pending: t('待核实', 'Pending'), 'in-progress': t('处理中', 'In progress'), resolved: t('已按事实解决', 'Resolved by facts'), dismissed: t('人工无需处理', 'Dismissed with reason') })[status] ?? status
  const blockedReason = (code: string | null) => ({ MODEL_DISABLED: t('模型功能已停用。', 'Model processing is disabled.'), MODEL_REQUEST_LIMIT: t('实际请求次数额度不足。', 'The request allowance is exhausted.'), MODEL_TOKEN_LIMIT: t('无法满足当前 token 额度及可信上界。', 'The token allowance or trusted bound is insufficient.'), MODEL_CNY_LIMIT: t('无法满足当前费用额度及可信计价上界。', 'The cost allowance or trusted pricing bound is insufficient.'), MODEL_METERING_UNAVAILABLE: t('当前模型入口缺少所需的可信计量能力。', 'Required trusted metering is unavailable.'), MODEL_RETRY_DISABLED: t('当前不允许自动重试。', 'Automatic retries are disabled.'), MODEL_LEDGER_UNAVAILABLE: t('模型用量账暂不可用。', 'The model usage ledger is unavailable.') })[code ?? ''] ?? t('模型配置或用量控制尚未满足。', 'Model configuration or usage control is not ready.')
  const act = (todoId: string, action: 'in-progress' | 'dismiss' | 'recheck') => {
    const todo = data?.todos.find(item => item.id === todoId)
    if (!data?.fingerprint || !todo) return
    write.mutation.mutate({ operation: 'inpatient.drg.review.todo.act', input: { admissionId: admission.id, todoId,
      expectedTodoVersion: todo.version, expectedFingerprint: data.fingerprint, action, note: (notes[todoId] ?? '').trim() } },
    { onSuccess: () => { void review.refetch() } })
  }
  return <section aria-label={financial ? t('住院费用核查待办', 'Inpatient billing review tasks') : t('术后核查与责任交接', 'Postoperative review and handoff')} className="flex flex-col gap-3">
    <h4 className="font-medium">{financial ? t('住院费用核查待办', 'Inpatient billing review tasks') : t('术后核查与责任交接', 'Postoperative review and handoff')}</h4>
    <p className="text-sm text-muted-foreground">{t('待办不增加出院门禁。正式记录或账务更正后按最新事实复查，关闭提示或模型声明不能证明问题已解决。', 'Tasks do not block discharge. Recheck formal records and charges after correction; closing an alert or a model claim does not prove resolution.')}</p>
    {review.isPending ? <p role="status">{t('正在读取核查结果', 'Loading review')}</p> : null}
    {review.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(review.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {data ? <>
      {data.status === 'waiting-surgery' ? <p>{t('等待相关手术完成后进行计划与实际核查。', 'The related surgery must finish before comparison.')}</p> : null}
      {data.status === 'inactive' ? <p>{t('尚未开启本次住院跟进。', 'Follow-up has not started for this admission.')}</p> : null}
      {data.freezeReason ? <p role="status">{data.freezeReason}</p> : null}
      {data.summary.formalChargesFen !== null ? <p>{t('阶段正式收费 ', 'Posted charges at review ')}{formatFen(data.summary.formalChargesFen, locale)}{financial ? '' : ` · ${t('阶段 DRG ', 'Stage DRG ')}${data.summary.formalDrgCode ?? t('未确定', 'Undetermined')}`}</p> : null}
      {!financial && data.summary.projectedTotalFen !== null ? <p>{t('含医生已有后续治疗计划的费用推演 ', 'Projection including existing treatment plans ')}{formatFen(data.summary.projectedTotalFen, locale)}</p> : null}
      {data.missing.length > 0 && data.status !== 'waiting-surgery' && data.status !== 'inactive' ? <p role="status">{t('核查不完整：', 'Incomplete review: ')}{data.missing.join(' · ')}</p> : null}
      {data.comparisons.length > 0 ? <Table><TableHeader><TableRow><TableHead>{t('耗材产品', 'Material')}</TableHead><TableHead>{t('术前人工计划', 'Confirmed preoperative plan')}</TableHead><TableHead>{t('实际使用', 'Actual use')}</TableHead></TableRow></TableHeader><TableBody>{data.comparisons.map(item => <TableRow key={`${item.executionId ?? ""}:${item.materialId}@${item.catalogVersion}`}><TableCell>{item.display}{item.executionId ? <p className="text-sm text-muted-foreground">{item.procedureDisplay} · {item.executionId.slice(-8)}</p> : null}</TableCell><TableCell>{item.plannedQuantity ?? t('未知', 'Unknown')}</TableCell><TableCell>{item.actualQuantity}</TableCell></TableRow>)}</TableBody></Table> : null}
      {data.model ? <>
        <p role="status">{data.model.current ? t('术后模型解释已完成独立核验。', 'Postoperative explanations passed independent verification.')
          : data.model.status === 'unknown' ? t('模型请求结果未知，保留待核查，不自动重发。', 'Model outcome unknown; awaiting investigation without automatic resubmission.')
            : data.model.status === 'blocked' ? `${t('模型分析未完成：', 'Model analysis incomplete: ')}${blockedReason(data.model.failureCode)}`
              : data.model.status === 'failed' ? t('生成或独立核验未通过，规则结果与待办继续保留。', 'Generation or verification failed; rule results and tasks are retained.')
              : data.status === 'frozen' ? t('本轮已停止新分析，保留最后结果与未完成状态。', 'New analysis ended; prior results and unfinished states are retained.')
                : data.status === 'complete' || data.status === 'incomplete' ? t('规则结果已保留，术后模型解释尚未完成核验。', 'Rule results are retained; postoperative explanations await verification.') : ''}</p>
        {data.model.observations.length > 0 ? <details><summary>{data.model.current ? t('查看已核验解释', 'Verified explanations') : t('查看保留的历史解释', 'Retained historical explanations')}</summary>{data.model.observations.map(item => <p key={item.key}>{item.explanation}</p>)}</details> : null}
      </> : null}
      {data.todos.length === 0 && data.status !== 'waiting-surgery' && data.status !== 'inactive' ? <p>{t('当前没有未解决核查待办。', 'No unresolved review tasks.')}</p> : null}
      {data.todos.map(todo => <article key={todo.id} className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{todo.display}</h5><Badge variant="secondary">{statusName(todo.status)}</Badge><span>{t('负责岗位：', 'Responsible: ')}{roleName(todo.ownerRole)}</span></div>
        <>{todo.executionId ? <p className="text-sm text-muted-foreground">{todo.procedureDisplay} · {todo.executionId.slice(-8)}</p> : null}</><p>{todo.explanation}</p>{todo.reason ? <p>{t('处置依据：', 'Disposition reason: ')}{todo.reason}</p> : null}
        <details><summary>{t('查看核查依据', 'Review sources')}</summary>{todo.evidence.map(source => <p key={source} className="break-all text-sm">{source}</p>)}</details>
        {todo.ownerRole === session.actor.roleCode ? <>
          <Field><FieldLabel htmlFor={`drg-todo-${todo.id}`}>{t('待办处理说明', 'Task disposition reason')}</FieldLabel><Input id={`drg-todo-${todo.id}`} value={notes[todo.id] ?? ''} onChange={event => setNotes(previous => ({ ...previous, [todo.id]: event.target.value }))} maxLength={2000} /></Field>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={write.blocked || !(notes[todo.id] ?? '').trim()} onClick={() => act(todo.id, 'in-progress')}>{t('标记处理中', 'Start processing')}</Button><Button variant="outline" disabled={write.blocked || !(notes[todo.id] ?? '').trim()} onClick={() => act(todo.id, 'dismiss')}>{t('人工判断无需处理', 'Dismiss with reason')}</Button><Button variant="outline" disabled={write.blocked || !(notes[todo.id] ?? '').trim() || data.status === 'frozen'} onClick={() => act(todo.id, 'recheck')}>{t('复查最新业务事实', 'Recheck business facts')}</Button></div>
        </> : null}
      </article>)}
      {data.resolvedTodos.length > 0 ? <details><summary>{t('已按事实解决的待办', 'Tasks resolved by facts')}</summary>{data.resolvedTodos.map(todo => <p key={todo.id}>{todo.display} · {statusName(todo.status)} · {todo.reason}</p>)}</details> : null}
      {data.actions.length > 0 ? <details><summary>{t('查看人工处置历史', 'Disposition history')}</summary>{data.actions.map((action, index) => <p key={index}>{roleName(action.role)} · {action.note} · {action.at}</p>)}</details> : null}
      {data.handedOver ? <p>{t('本轮已交接：', 'Handoff completed: ')}{data.handedOver.note}</p> : data.status === 'frozen' && ['inpatient-doctor', 'medical-records'].includes(session.actor.roleCode) ? <>
        <Field><FieldLabel htmlFor={`drg-handoff-${admission.id}`}>{t('本轮交接说明', 'Handoff note')}</FieldLabel><Input id={`drg-handoff-${admission.id}`} value={handoff} onChange={event => setHandoff(event.target.value)} maxLength={2000} /></Field>
        <p>{t('交接保留未解决待办的负责岗位，不自动解决问题，也不恢复临床分析。', 'Handoff retains responsibility for unresolved tasks and does not restart analysis.')}</p>
        <Button disabled={write.blocked || !handoff.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.drg.review.handoff', input: { admissionId: admission.id, expectedVersion: data.version, note: handoff.trim() } }, { onSuccess: () => { void review.refetch() } })}>{t('确认交接并保留未解决责任', 'Confirm handoff and unresolved responsibility')}</Button>
      </> : null}
    </> : null}
  </section>
}
