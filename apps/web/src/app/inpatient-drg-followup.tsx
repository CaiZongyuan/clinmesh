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
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active: boolean }

export function InpatientDrgFollowupPanel({ admission, session, locale, write, active }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [reason, setReason] = useState('')
  const query = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch,
    session.actor.practitionerRoleId, admission.id, 'drg-followup'], enabled: active,
  queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/followup`, inpatientDrgFollowupSchema, signal),
  refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const task = query.data?.task, doctor = session.actor.roleCode === 'inpatient-doctor'
  const status = task ? { active: t('正在跟进', 'Active'), stopped: t('已停止', 'Stopped'),
    'authorization-lost': t('授权已失效，待交接', 'Authorization lost; handoff pending'), archived: t('已归档，停止临床分析', 'Archived; analysis ended') }[task.status] : t('尚未开启', 'Not started')
  const start = () => {
    if (!query.data) return
    write.mutation.mutate({ operation: 'inpatient.drg.followup.start', input: { admissionId: admission.id,
      encounterVersion: query.data.encounterVersion, expectedTaskVersion: task?.version ?? 0 } }, { onSuccess: () => { void query.refetch() } })
  }
  const stop = () => {
    if (!query.data || !task) return
    write.mutation.mutate({ operation: 'inpatient.drg.followup.stop', input: { admissionId: admission.id,
      encounterVersion: query.data.encounterVersion, expectedTaskVersion: task.version, reason: reason.trim() } },
    { onSuccess: () => { setReason(''); void query.refetch() } })
  }
  return <section aria-label={t('住院后台跟进', 'Inpatient background follow-up')} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{t('住院后台跟进', 'Inpatient background follow-up')}</h4><Badge variant="secondary">{status}</Badge></div>
    <p className="text-sm text-muted-foreground">{t('医生主动开启后，关闭页面仍按本次住院的有效岗位授权核对分组与正式费用。规则核对本次未调用模型。', 'After activation, grouping and posted charges are checked under this admission’s current authorization, even with the page closed. This rule check made no model request.')}</p>
    {query.isPending ? <p role="status">{t('正在读取跟进状态', 'Loading follow-up')}</p> : null}
    {query.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {task?.reason ? <p role="status">{task.reason}</p> : null}
    {task?.status === 'active' && (task.ruleStatus === 'pending' || task.ruleStatus === 'stale') ? <p role="status">{t('依据正在重新核对，旧规则结果暂不可作为当前结论。', 'Rechecking sources; the previous rule result is stale.')}</p> : null}
    {task?.ruleStatus === 'incomplete' ? <p role="status">{task.errorCode === 'DRG_RULES_NOT_CONFIGURED'
      ? t('分组规则尚未配置，无法完成规则评估。', 'Grouping rules are not configured; evaluation is incomplete.')
      : task.errorCode === 'DRG_PAYMENT_REFERENCE_MISSING' ? t('当前病组缺少有效正支付参考额，无法判断特例提醒。', 'A positive payment reference is missing; the alert cannot be assessed.')
        : t('分组依据不完整，无法完成规则评估。', 'Grouping sources are incomplete.')}</p> : null}
    {task?.simulation && (task.ruleStatus === 'complete' || task.ruleStatus === 'incomplete') ? <p>{task.status === 'active' ? t('后台正式收费 ', 'Background posted charges ') : t('历史规则收费 ', 'Historical rule charges ')}{formatFen(task.simulation.formal.chargesFen, locale)} · {t('正式病组 ', 'Formal group ')}{task.simulation.grouping.formal.drgCode ?? t('未确定', 'Undetermined')}</p> : null}
    {task?.exceptionAlert === 'triggered' ? <Alert><AlertDescription>{t('已发生正式收费净额严格超过当前 DRG 支付参考额的 3 倍。建议本次住院诊疗结束后由医保办人工评估特例单议申请；此提醒不阻断出院，不自动申请、不调整分组或核定，也不预测补付。', 'Net posted charges exceed three times the current DRG payment reference. After inpatient care ends, the insurance office should assess an exceptional-case application. This advisory does not block discharge or change grouping or payment.')}</AlertDescription></Alert> : null}
    {doctor && query.data && admission.recordStatus !== 'archived' ? task?.status === 'active' ? <>
      <Field><FieldLabel htmlFor={`drg-followup-stop-${admission.id}`}>{t('停止跟进理由', 'Reason for stopping')}</FieldLabel><Input id={`drg-followup-stop-${admission.id}`} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></Field>
      <Button variant="outline" disabled={write.blocked || reason.trim().length === 0} onClick={stop}>{t('停止本次跟进', 'Stop follow-up')}</Button>
    </> : admission.status === 'admitted' ? <Button disabled={write.blocked} onClick={start}>{task ? t('重新开启本次跟进', 'Restart follow-up') : t('开启本次住院跟进', 'Start admission follow-up')}</Button> : null : null}
  </section>
}
