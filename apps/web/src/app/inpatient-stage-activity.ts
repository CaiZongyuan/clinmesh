import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import type { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import type { InpatientStage } from '@clinmesh/contracts/agent'
import type { z } from 'zod'
import type { WorkspaceFlowStep, WorkspaceTabItem } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export interface InpatientActivity {
  admission: InpatientAdmission
  role: string
  clinical?: z.infer<typeof inpatientFullClinicalSchema> | undefined
  investigations?: z.infer<typeof inpatientInvestigationsSchema> | undefined
  surgery?: z.infer<typeof inpatientSurgerySchema> | undefined
  virtualTime?: string | undefined
}

export function inpatientPending(input: InpatientActivity): Record<InpatientStage, number> {
  const { admission, role, clinical, investigations, surgery } = input
  const nurse = role === 'ward-nurse', doctor = role === 'inpatient-doctor'
  const now = input.virtualTime === undefined ? undefined : Date.parse(input.virtualTime)
  const result = { admission: 0, orders: 0, investigations: 0, surgery: 0, transfer: 0, fees: 0, discharge: 0, record: 0, drg: 0 }
  if (admission.recordStatus === 'archived') return result
  if (nurse && admission.status === 'registered') result.admission = 1
  if (nurse) {
    result.orders = (clinical?.orders.filter(order => ['signed', 'stop-requested'].includes(order.state)).length ?? 0)
      + (clinical?.executions.filter(execution => {
        const order = clinical.orders.find(order => order.id === execution.orderId)
        return order?.state === 'verified' && now !== undefined && Date.parse(execution.scheduledFor) <= now
          && (execution.status === 'dispensed' || execution.status === 'pending' && order.kind === 'service')
      }).length ?? 0)
    result.investigations = [...investigations?.laboratoryRequests ?? [], ...investigations?.imagingRequests ?? []]
      .filter(request => request.status === 'issued' && !investigations?.sent.some(sent => sent.requestId === request.id)).length
    result.surgery = surgery?.requests.filter(request => ['requested', 'ready'].includes(request.status) && !request.preopCheck).length ?? 0
    result.discharge = admission.status === 'discharge-pending' || admission.status === 'departed' && admission.financialStatus === 'settled' ? 1 : 0
  }
  if (doctor) {
    result.orders = admission.status === 'admitted' && clinical?.diagnosis.entries.length === 0 ? 1 : 0
    result.investigations = [...investigations?.laboratoryRequests ?? [], ...investigations?.imagingRequests ?? []]
      .filter(request => request.status === 'reported').length
    result.surgery = surgery?.requests.filter(request => request.status === 'ready' || request.status === 'requested' && !request.consentConfirmation).length ?? 0
    result.surgery += surgery?.inProgress.length ?? 0
    result.record = admission.status === 'cleared' && admission.recordStatus === 'open' ? 1 : 0
  }
  if (role === 'cashier') result.discharge = admission.status === 'departed' && admission.financialStatus === 'open' ? 1 : 0
  return result
}

export function inpatientStageTabs(input: InpatientActivity, allowTransfers: boolean, locale: WorkspaceLocale): WorkspaceTabItem[] {
  const zh = locale === 'zh-CN', nurse = input.role === 'ward-nurse', doctor = input.role === 'inpatient-doctor'
  const clinical = nurse || doctor, archived = input.admission.recordStatus === 'archived'
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
    { value: 'record', zh: '病案', en: 'Medical record', group: 3 },
  ]
  return stages.filter(stage => {
    if (stage.value === 'admission') return true
    if (stage.value === 'record') return clinical || input.role === 'medical-records'
    if (stage.value === 'drg') return doctor
    if (stage.value === 'fees' || stage.value === 'discharge') return input.role === 'cashier' || clinical && !archived
    return clinical && !archived && (stage.value !== 'transfer' || allowTransfers)
  }).map(stage => {
    const missing = stage.value === 'surgery' && input.surgery?.requests.length === 0
      || stage.value === 'investigations' && input.investigations !== undefined
        && input.investigations.laboratoryRequests.length + input.investigations.imagingRequests.length === 0
    const readonly = stage.value === 'admission' && !nurse || stage.value === 'fees' && input.role !== 'cashier'
      || stage.value === 'record' && nurse
    return { value: stage.value, label: `${zh ? stage.zh : stage.en}${missing ? zh ? ' · 未发生' : ' · Not started' : ''}`,
      group: (zh ? ['入院', '在院', '出院', '病案'] : ['Admission', 'In care', 'Discharge', 'Record'])[stage.group]!,
      count: counts[stage.value], more: readonly || missing, status: counts[stage.value] > 0 ? 'current' : 'pending' }
  })
}

export function inpatientDefaultStage(input: InpatientActivity, tabs: readonly WorkspaceTabItem[]): InpatientStage {
  const counts = inpatientPending(input)
  const pending = tabs.find(tab => counts[tab.value as InpatientStage] > 0)
  if (pending) return pending.value as InpatientStage
  if ((input.admission.recordStatus === 'archived' || input.role === 'medical-records') && tabs.some(tab => tab.value === 'record')) return 'record'
  if (input.role === 'cashier') return ['departed', 'cleared'].includes(input.admission.status) ? 'discharge' : 'fees'
  if (input.role === 'ward-nurse' && input.admission.status === 'cleared') return 'record'
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
