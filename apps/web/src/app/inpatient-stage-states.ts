import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'

export type InpatientStageId = 'admission' | 'orders' | 'investigations' | 'surgery' | 'transfer' | 'fees' | 'discharge' | 'record' | 'drg'
export type InpatientStageState = 'done' | 'current' | 'todo' | 'closed'

// 从住院登记的状态字段推导阶段主线状态。登记上没有检查、手术、转科的发生事实，
// 出院后这些环节标为 closed（已关闭）而不是 done，不把未发生的事标成已完成。
export function inpatientStageStates(admission: Pick<InpatientAdmission, 'status' | 'financialStatus' | 'recordStatus'>): Record<InpatientStageId, InpatientStageState> {
  const { status, financialStatus, recordStatus } = admission
  const archived = recordStatus === 'archived'
  const departedCare = ['discharge-pending', 'departed', 'cleared'].includes(status)
  const settled = financialStatus === 'settled' || archived
  return {
    admission: status === 'registered' ? 'current' : 'done',
    orders: departedCare || archived ? 'done' : status === 'admitted' ? 'current' : 'todo',
    investigations: archived ? 'done' : departedCare ? 'closed' : 'todo',
    surgery: archived ? 'done' : departedCare ? 'closed' : 'todo',
    transfer: archived ? 'done' : departedCare ? 'closed' : 'todo',
    fees: settled ? 'done' : 'todo',
    discharge: archived || status === 'cleared' ? 'done' : ['discharge-pending', 'departed'].includes(status) ? 'current' : 'todo',
    record: archived ? 'done' : status === 'cleared' ? 'current' : 'todo',
    drg: archived ? 'done' : 'todo',
  }
}
