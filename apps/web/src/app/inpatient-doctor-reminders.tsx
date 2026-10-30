import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { cn } from '@clinmesh/ui/lib/utils'

type OrderState = { id: string; state: string }
type ExecutionState = { id: string; status: string }
type SurgeryRequestState = {
  id: string
  status: string
  plannedProcedure: { coding: { display: string } }
  preopCheck?: unknown
  consentConfirmation?: unknown
}

export type DoctorReminderTone = 'crit' | 'warn' | 'info'
export type DoctorReminder = { key: string; tone: DoctorReminderTone; text: string }

/** 医生站右栏提醒聚合：只汇总平台既有事实（欠费、术前准备缺口、待校对与待执行医嘱），不生成建议。 */
export function aggregateDoctorReminders(input: {
  outstandingFen: InpatientAdmission['outstandingFen']
  orders?: readonly OrderState[] | undefined
  executions?: readonly ExecutionState[] | undefined
  surgeryRequests?: readonly SurgeryRequestState[] | undefined
  locale: WorkspaceLocale
}): DoctorReminder[] {
  const zh = input.locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const reminders: DoctorReminder[] = []
  if (input.outstandingFen === null) reminders.push({ key: 'funding-pending', tone: 'warn', text: t(
    '资金或医保结果待收费员确认，请先核对原记录。', 'Funding or insurance is pending; ask the cashier to verify the original records.') })
  else if (input.outstandingFen === undefined) reminders.push({ key: 'funding-unavailable', tone: 'info', text: t(
    '当前待收摘要暂不可用，请刷新后核对。', 'The current balance summary is unavailable; refresh to verify.') })
  else if (input.outstandingFen > 0) {
    reminders.push({ key: 'arrears', tone: 'crit', text: t(
      `当前尚应收 ${formatFen(input.outstandingFen, input.locale)}，请与收费员核对补缴。`,
      `Outstanding balance ${formatFen(input.outstandingFen, input.locale)}; check with the cashier.`) })
  }
  for (const request of input.surgeryRequests ?? []) {
    if (!['requested', 'ready'].includes(request.status)) continue
    const missing = [request.preopCheck === null || request.preopCheck === undefined ? t('术前检查未核对', 'preoperative checks unverified') : null,
      request.consentConfirmation === null || request.consentConfirmation === undefined ? t('知情同意未确认', 'consent unconfirmed') : null]
      .filter((item): item is string => item !== null)
    if (missing.length === 0) continue
    reminders.push({ key: `surgery-${request.id}`, tone: 'warn',
      text: `${request.plannedProcedure.coding.display}：${missing.join(t(' · ', ' · '))}` })
  }
  const signed = (input.orders ?? []).filter(order => order.state === 'signed').length
  if (signed > 0) reminders.push({ key: 'orders-signed', tone: 'info',
    text: t(`待校对医嘱 ${signed} 条。`, `${signed} order(s) awaiting verification.`) })
  const open = (input.executions ?? []).filter(execution => ['pending', 'dispensed'].includes(execution.status)).length
  if (open > 0) reminders.push({ key: 'executions-open', tone: 'info',
    text: t(`待执行或给药医嘱 ${open} 条。`, `${open} execution(s) pending or awaiting administration.`) })
  return reminders
}

const toneClassName: Record<DoctorReminderTone, string> = {
  crit: 'border-l-destructive text-destructive',
  warn: 'border-l-warning text-warning',
  info: 'border-l-foreground/50 text-foreground',
}

/** 住院医生站右栏：按当前患者聚合真实待办；无待办显示空态，不显示虚构建议。 */
export function InpatientDoctorReminders({ admission, admissions, session, locale }: {
  admission: InpatientAdmission
  admissions: readonly InpatientAdmission[]
  session: SessionContext
  locale: WorkspaceLocale
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = inpatientScopeKey(session)
  const careOpen = admission.recordStatus !== 'archived'
  const clinical = useQuery({ queryKey: [...scope, admission.id, 'clinical'], enabled: careOpen,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, inpatientFullClinicalSchema, signal) })
  const surgeries = useQuery({ queryKey: [...scope, admission.id, 'surgeries'], enabled: careOpen,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const item = admissions.find(entry => entry.id === admission.id) ?? admission
  const loading = clinical.isPending || surgeries.isPending
  const failed = clinical.error !== null || surgeries.error !== null
  const reminders = aggregateDoctorReminders({ outstandingFen: item.outstandingFen,
    orders: careOpen ? clinical.data?.orders : undefined, executions: careOpen ? clinical.data?.executions : undefined,
    surgeryRequests: careOpen ? surgeries.data?.requests : undefined, locale })
  return <section aria-label={t('临床提醒', 'Clinical reminders')} data-inpatient-doctor-reminders className="flex flex-col gap-2 p-3">
    <h3 className="text-sm font-semibold">{t('临床提醒', 'Clinical reminders')}</h3>
    {!careOpen ? <p className="text-sm text-muted-foreground">{t('病案已归档，诊疗写入关闭。', 'The record is archived; care writes are closed.')}</p> : null}
    {reminders.length > 0 ? <ul className="flex flex-col gap-2">
      {reminders.map(reminder => <li key={reminder.key} className={cn('border-l-2 py-0.5 ps-2 text-sm', toneClassName[reminder.tone])}>{reminder.text}</li>)}
    </ul> : null}
    {careOpen && <>
      {loading ? <p className="text-sm text-muted-foreground">{t('正在读取诊疗记录…', 'Loading care records…')}</p>
        : failed ? <p className="text-sm text-muted-foreground">{t('部分提醒数据暂时不可读。', 'Some reminder data is temporarily unavailable.')}</p>
        : reminders.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂待办提醒。', 'No pending reminders.')}</p> : null}
    </>}
  </section>
}
