import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active: boolean }

export function InpatientDrgFollowupPanel({ admission, session, locale, write, active, children }: Props & { children?: React.ReactNode }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [reason, setReason] = useState(''), [stopping, setStopping] = useState(false)
  const query = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch,
    session.actor.practitionerRoleId, admission.id, 'drg-followup'], enabled: active,
  queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/followup`, inpatientDrgFollowupSchema, signal),
  refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const task = query.data?.task, doctor = session.actor.roleCode === 'inpatient-doctor'
  const status = task ? { active: t('正在跟进', 'Active'), stopped: t('已停止', 'Stopped'),
    'authorization-lost': t('权限已失效，待交接', 'Authorization lost; handoff pending'), archived: t('已归档，停止临床分析', 'Archived; analysis ended') }[task.status] : t('尚未开启', 'Not started')
  const start = () => {
    if (!query.data) return
    write.mutation.mutate({ operation: 'inpatient.drg.followup.start', input: { admissionId: admission.id,
      encounterVersion: query.data.encounterVersion, expectedTaskVersion: task?.version ?? 0 } }, { onSuccess: () => { void query.refetch() } })
  }
  const stop = () => {
    if (!query.data || !task) return
    write.mutation.mutate({ operation: 'inpatient.drg.followup.stop', input: { admissionId: admission.id,
      encounterVersion: query.data.encounterVersion, expectedTaskVersion: task.version, reason: reason.trim() } },
    { onSuccess: () => { setReason(''); setStopping(false); void query.refetch() } })
  }
  const editable = doctor && query.data !== undefined && admission.recordStatus !== 'archived'
  const on = task?.status === 'active'
  const headerAction = !editable ? null : on ? stopping ? null : <Button variant="ghost" size="sm" onClick={() => setStopping(true)}>{t('停止跟进', 'Stop follow-up')}</Button>
    : admission.status === 'admitted' ? <Button size="sm" disabled={write.blocked} onClick={start}>{task ? t('重新开启本次跟进', 'Restart follow-up') : t('开启本次住院跟进', 'Start admission follow-up')}</Button> : null
  return <section aria-label={t('住院自动跟进', 'Inpatient background follow-up')} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{t('住院自动跟进', 'Inpatient background follow-up')}</h4><Badge variant="secondary">{status}</Badge><span className="flex-1" />{headerAction}</div>
    <p className="text-sm text-muted-foreground">{on ? t('诊断、手术或费用变化时自动重算并提醒你核对。参数就绪后生成耗材建议（调用 AI）。', 'Recalculates and alerts you when diagnoses, procedures or charges change. Material recommendations are generated when parameters are ready (calls the AI).')
      : t('开启后，诊断、手术或费用变化时自动重算并提醒你核对；关闭页面也继续。参数就绪后会生成耗材建议（调用 AI）。', 'After activation, recalculates and alerts you when diagnoses, procedures or charges change, even with the page closed. Material recommendations are generated when parameters are ready (calls the AI).')}</p>
    {query.isPending ? <p role="status">{t('正在读取跟进状态', 'Loading follow-up')}</p> : null}
    {query.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {task?.reason ? <p role="status">{task.reason}</p> : null}
    {task?.status === 'active' && (task.ruleStatus === 'pending' || task.ruleStatus === 'stale') ? <p role="status">{t('依据正在重新核对，旧规则结果暂不可作为当前结论。', 'Rechecking sources; the previous rule result is stale.')}</p> : null}
    {task?.ruleStatus === 'incomplete' ? <p role="status">{task.errorCode === 'DRG_RULES_NOT_CONFIGURED'
      ? t('分组规则尚未配置，无法完成规则评估。', 'Grouping rules are not configured; evaluation is incomplete.')
      : task.errorCode === 'DRG_PAYMENT_REFERENCE_MISSING' ? t('当前病组缺少有效正支付参考额，无法判断特例提醒。', 'A positive payment reference is missing; the alert cannot be assessed.')
        : t('分组依据不完整，无法完成规则评估。', 'Grouping sources are incomplete.')}</p> : null}
    {task?.exceptionAlert === 'triggered' ? <Alert><AlertDescription>{t('已发生正式收费合计严格超过当前 DRG 支付参考额的 3 倍。建议本次住院诊疗结束后由医保办人工评估特例单议申请；此提醒不阻断出院，不自动申请、不调整分组或核定，也不预测补付。', 'Net posted charges exceed three times the current DRG payment reference. After inpatient care ends, the insurance office should assess an exceptional-case application. This advisory does not block discharge or change grouping or payment.')}</AlertDescription></Alert> : null}
    {editable && on && stopping ? <>
      <Field><FieldLabel htmlFor={`drg-followup-stop-${admission.id}`}>{t('停止跟进理由', 'Reason for stopping')}</FieldLabel><Input id={`drg-followup-stop-${admission.id}`} required placeholder={t('例如：患者转科，交由新科室跟进', 'For example: transferred to another ward')} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></Field>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={write.blocked || reason.trim().length === 0} onClick={stop}>{t('确认停止跟进', 'Confirm stop')}</Button><Button variant="ghost" onClick={() => { setStopping(false); setReason('') }}>{t('取消', 'Cancel')}</Button></div>
    </> : null}
    {children}
    {task ? <InpatientDrgUsagePanel key={task.id} admissionId={admission.id} taskId={task.id} session={session} locale={locale} active={active} /> : null}
  </section>
}
