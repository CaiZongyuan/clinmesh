import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import type { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import type { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import type { inpatientTransfersSchema } from '@clinmesh/contracts/inpatient-transfer'
import type { InpatientStage } from '@clinmesh/contracts/agent'
import type { z } from 'zod'
import type { WorkspaceFlowStep, WorkspaceTabItem } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

export interface InpatientActivity {
  admission: InpatientAdmission
  role: string
  clinical?: z.infer<typeof inpatientFullClinicalSchema> | undefined
  investigations?: z.infer<typeof inpatientInvestigationsSchema> | undefined
  surgery?: z.infer<typeof inpatientSurgerySchema> | undefined
  review?: z.infer<typeof inpatientDrgReviewSchema> | undefined
  transfers?: z.infer<typeof inpatientTransfersSchema> | undefined
  record?: z.infer<typeof inpatientRecordSchema> | undefined
  virtualTime?: string | undefined
}

function recordSubmissionPending(record: z.infer<typeof inpatientRecordSchema> | undefined): boolean {
  if (!record) return true
  if (record.archive) return false
  if (!record.revision) return true
  const review = record.reviews.find(item => item.revision === record.revision?.revision && item.sourcesHash === record.revision?.sourcesHash)
  if (review?.outcome === 'returned') return true
  if (record.revision.sourcesHash !== record.sourcesHash) return true
  return false
}

export function inpatientInvestigationWaiting(data: InpatientActivity['investigations'], locale: WorkspaceLocale, failed = false, role?: string): string {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if (failed) return t('检查检验资料读取失败，请重试后核对报告状态。', 'Investigation data failed to load. Retry before checking report status.')
  if (!data) return t('正在读取检查检验与报告状态。', 'Loading investigations and report status.')
  const requests = [...data.laboratoryRequests, ...data.imagingRequests]
  if (requests.length === 0) return role === 'ward-nurse'
    ? t('等住院医生开立检查检验', 'Waiting for the inpatient doctor to order investigations')
    : t('尚无检查检验申请，可按诊疗需要开立', 'No investigations requested; order as clinically needed')
  const active = requests.filter(request => request.status !== 'cancelled')
  if (active.length === 0) return t('检查检验申请已全部取消。', 'All investigation requests have been cancelled.')
  const unread = active.filter(request => request.status === 'reported').length
  if (unread > 0) return t('还有 ' + unread + ' 份报告待住院医生已阅。', unread + ' reports await acknowledgement by the inpatient doctor.')
  if (active.every(request => request.status === 'acknowledged')) return t('报告已全部已阅', 'All reports have been acknowledged')
  if (active.some(request => request.status === 'generation-failed')) {
    const failedCount = active.filter(request => request.status === 'generation-failed').length
    return role === 'inpatient-doctor'
      ? t('轮到你：处理生成失败的检验（' + failedCount + ' 项）', 'Your turn: handle failed investigations (' + failedCount + ')')
      : t('仍有检查检验结果生成失败，待住院医生重试或取消。', 'Some investigation results failed. The inpatient doctor retries or cancels them.')
  }
  if (active.some(request => request.status === 'issued' && !data.sent.some(item => item.requestId === request.id))) {
    const unsentCount = active.filter(request => request.status === 'issued' && !data.sent.some(item => item.requestId === request.id)).length
    return role === 'ward-nurse'
      ? t('轮到你：校对并送检 ' + unsentCount + ' 项', 'Your turn: verify and send ' + unsentCount + ' item(s)')
      : t('仍有检查检验待病区护士校对并送检。', 'Some investigations await ward nurse verification and dispatch.')
  }
  return t('仍有检查检验未出报告，等医技科室处理。', 'Some investigation reports are pending. Waiting for investigation staff.')
}

export function inpatientPending(input: InpatientActivity): Record<InpatientStage, number> {
  const { admission, role, clinical, investigations, surgery } = input
  const nurse = role === 'ward-nurse', doctor = role === 'inpatient-doctor'
  const now = input.virtualTime === undefined ? undefined : Date.parse(input.virtualTime)
  const result = { admission: 0, orders: 0, investigations: 0, surgery: 0, transfer: 0, fees: 0, discharge: 0, record: 0, drg: 0 }
  if (admission.recordStatus === 'archived') return result
  if (nurse && admission.status === 'registered') result.admission = 1
  if (nurse) {
    const careAvailable = admission.status === 'admitted' && admission.financialStatus === 'open'
    const stopAvailable = ['admitted', 'discharge-pending'].includes(admission.status) && admission.financialStatus === 'open'
    result.orders = (clinical?.orders.filter(order => order.state === 'signed' && careAvailable
      || order.state === 'stop-requested' && stopAvailable).length ?? 0)
      + (careAvailable ? clinical?.executions.filter(execution => {
        const order = clinical.orders.find(order => order.id === execution.orderId)
        return order?.state === 'verified' && now !== undefined && Date.parse(execution.scheduledFor) <= now
          && (execution.status === 'dispensed' || execution.status === 'pending' && order.kind === 'service')
      }).length ?? 0 : 0)
    result.investigations = [...investigations?.laboratoryRequests ?? [], ...investigations?.imagingRequests ?? []]
      .filter(request => request.status === 'issued' && !investigations?.sent.some(sent => sent.requestId === request.id)).length
    result.surgery = surgery?.requests.filter(request => ['requested', 'ready'].includes(request.status) && !request.preopCheck).length ?? 0
    result.transfer = input.transfers?.transfers.filter(transfer => transfer.status === 'requested').length ?? 0
    result.discharge = admission.status === 'discharge-pending' || admission.status === 'departed' && admission.financialStatus === 'settled' ? 1 : 0
  }
  if (doctor) {
    result.orders = admission.status === 'admitted' && clinical?.diagnosis.entries.length === 0 ? 1 : 0
    result.investigations = [...investigations?.laboratoryRequests ?? [], ...investigations?.imagingRequests ?? []]
      .filter(request => request.status === 'reported' || request.status === 'generation-failed').length
    result.surgery = surgery?.requests.filter(request => request.status === 'ready' && !surgery.inProgress.some(execution => execution.requestId === request.id)
      || request.status === 'requested' && !request.consentConfirmation).length ?? 0
    result.surgery += surgery?.inProgress.length ?? 0
    result.surgery += input.review?.todos.filter(todo => todo.ownerRole === role && (todo.status === 'pending' || todo.status === 'in-progress')).length ?? 0
    result.record = admission.financialStatus === 'settled' && admission.recordStatus === 'open' && recordSubmissionPending(input.record) ? 1 : 0
    result.discharge = admission.status === 'discharge-pending' ? clinical?.orders.filter(order => order.state === 'signed' || order.state === 'verified').length ?? 0 : 0
  }
  if (role === 'cashier') result.discharge = admission.status === 'departed' && admission.financialStatus === 'open' ? 1 : 0
  return result
}

export function inpatientStageTabs(input: InpatientActivity, allowTransfers: boolean, locale: WorkspaceLocale): WorkspaceTabItem[] {
  const zh = locale === 'zh-CN', nurse = input.role === 'ward-nurse', doctor = input.role === 'inpatient-doctor'
  const clinical = nurse || doctor
  const counts = inpatientPending(input)
  const stages: Array<{ value: InpatientStage; zh: string; en: string; group: number }> = [
    { value: 'admission', zh: '入科', en: 'Admission', group: 0 },
    { value: 'orders', zh: '诊断医嘱', en: 'Diagnoses & orders', group: 1 },
    { value: 'investigations', zh: '检查检验', en: 'Investigations', group: 1 },
    { value: 'surgery', zh: '手术', en: 'Surgery', group: 1 },
    { value: 'transfer', zh: '转科交接', en: 'Transfer', group: 1 },
    { value: 'drg', zh: 'DRG 预分组', en: 'DRG pre-grouping', group: 1 },
    { value: 'fees', zh: '费用', en: 'Charges', group: 1 },
    { value: 'discharge', zh: '出院', en: 'Discharge', group: 2 },
    { value: 'record', zh: input.role === 'medical-records' ? '病案首页' : '病案', en: 'Medical record', group: 3 },
  ]
  return stages.filter(stage => {
    if (nurse && input.admission.status === 'registered') return stage.value === 'admission'
    if (doctor && input.admission.recordStatus === 'archived') return stage.value === 'record'
    if (stage.value === 'admission') return input.role !== 'medical-records'
    if (stage.value === 'record') return clinical || input.role === 'medical-records'
    if (stage.value === 'drg') return doctor
    if (stage.value === 'fees' || stage.value === 'discharge') return input.role === 'cashier' || clinical
    return clinical && (stage.value !== 'transfer' || allowTransfers)
  }).map(stage => {
    const { admission } = input
    const transferring = input.transfers?.transfers.some(transfer => transfer.status === 'requested') ?? false
    // 原型把本岗位只读的环节和没有进行中转科的交接固定收进「更多」。
    const more = stage.value === 'admission' && !nurse || stage.value === 'fees' && input.role !== 'cashier'
      || stage.value === 'record' && nurse || stage.value === 'transfer' && !transferring
    const summary = stage.value === 'admission' ? admission.status === 'registered' ? zh ? '待入科' : 'Not admitted' : zh ? '已完成' : 'Completed'
      : stage.value === 'fees' ? formatFen(admission.chargesFen, locale)
        : stage.value === 'record' ? admission.recordStatus === 'archived' ? zh ? '已归档' : 'Archived' : admission.recordStatus === 'reviewed' ? zh ? '审核通过' : 'Approved'
          : ['departed', 'cleared'].includes(admission.status) ? zh ? '待提交首页' : 'Awaiting submission' : zh ? '出院后' : 'After discharge'
          : stage.value === 'transfer' && !transferring ? zh ? '无进行中转科' : 'No active transfer' : undefined
    return { value: stage.value, label: zh ? stage.zh : stage.en,
      group: (zh ? ['入院', '在院', '出院', '病案'] : ['Admission', 'In care', 'Discharge', 'Record'])[stage.group]!,
      count: counts[stage.value], ...(more ? { more } : {}), ...(summary === undefined ? {} : { summary }) }
  })
}

export function inpatientDefaultStage(input: InpatientActivity, tabs: readonly WorkspaceTabItem[]): InpatientStage {
  const counts = inpatientPending(input)
  const pending = tabs.find(tab => counts[tab.value as InpatientStage] > 0)
  if (pending) return pending.value as InpatientStage
  if ((input.admission.recordStatus === 'archived' || input.role === 'medical-records') && tabs.some(tab => tab.value === 'record')) return 'record'
  if (input.role === 'cashier') return ['departed', 'cleared'].includes(input.admission.status) ? 'discharge' : 'fees'
  if (input.role === 'ward-nurse' && ['departed', 'cleared'].includes(input.admission.status)) return 'discharge'
  return input.admission.status === 'registered' ? 'admission' : 'orders'
}

export function inpatientFlow(admission: InpatientAdmission | undefined, locale: WorkspaceLocale): WorkspaceFlowStep[] {
  const zh = locale === 'zh-CN'
  const labels = zh ? ['住院登记', '入科分床', '在院诊疗', '办理出院', '结算', '清床', '病案归档', '医保核定']
    : ['Registration', 'Admission', 'Inpatient care', 'Discharge', 'Settlement', 'Bed clearance', 'Archive', 'Insurance']
  const index = !admission ? -1 : admission.recordStatus === 'archived' ? 7 : admission.status === 'cleared' ? 6
    : admission.financialStatus === 'settled' ? 5 : admission.status === 'departed' ? 4
      : admission.status === 'discharge-pending' ? 3 : admission.status === 'admitted' ? 2 : 1
  return labels.map((label, value) => ({ value: String(value), label,
    status: value === index ? 'current' : value < index ? 'completed' : 'pending' }))
}
