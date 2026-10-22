import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { describe, expect, it } from 'vitest'
import { inpatientStageStates, type InpatientStageId } from './inpatient-stage-states.ts'

const base = {
  id: 'admission-1', patientId: 'patient-1', patientName: '李淑芬', inpatientNumber: 'ZY-0001',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient',
  registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 100000, chargesFen: 5000, versionId: '2',
} as Omit<InpatientAdmission, 'status' | 'financialStatus' | 'recordStatus'>

const admission = (overrides: Partial<Pick<InpatientAdmission, 'status' | 'financialStatus' | 'recordStatus'>>): InpatientAdmission =>
  ({ ...base, status: 'registered', financialStatus: 'open', recordStatus: 'open', ...overrides }) as InpatientAdmission

const ids: InpatientStageId[] = ['admission', 'orders', 'investigations', 'surgery', 'transfer', 'fees', 'discharge', 'record']

describe('inpatientStageStates', () => {
  it('待入科时入科分床进行中，其余环节待办', () => {
    const states = inpatientStageStates(admission({ status: 'registered' }))
    expect(states.admission).toBe('current')
    for (const id of ids.filter(id => id !== 'admission')) expect(states[id]).toBe('todo')
  })

  it('在院时诊疗进行中、入院已完成', () => {
    const states = inpatientStageStates(admission({ status: 'admitted' }))
    expect(states.admission).toBe('done')
    expect(states.orders).toBe('current')
    expect(states.discharge).toBe('todo')
    expect(states.record).toBe('todo')
  })

  it('出院医嘱已开后在院诊疗收口，未发生的可选环节关闭而非完成，出院结算进行中', () => {
    const states = inpatientStageStates(admission({ status: 'discharge-pending' }))
    expect(states.orders).toBe('done')
    expect(states.investigations).toBe('closed')
    expect(states.surgery).toBe('closed')
    expect(states.transfer).toBe('closed')
    expect(states.fees).toBe('todo')
    expect(states.discharge).toBe('current')
  })

  it('已出区未结算时出院结算仍进行中，结算完成但未清床同样如此', () => {
    expect(inpatientStageStates(admission({ status: 'departed', financialStatus: 'open' })).discharge).toBe('current')
    expect(inpatientStageStates(admission({ status: 'departed', financialStatus: 'settled' })).discharge).toBe('current')
  })

  it('清床后病案进行中，归档后全部收口且没有进行中环节', () => {
    const cleared = inpatientStageStates(admission({ status: 'cleared', financialStatus: 'settled', recordStatus: 'open' }))
    expect(cleared.discharge).toBe('done')
    expect(cleared.fees).toBe('done')
    expect(cleared.record).toBe('current')
    const archived = inpatientStageStates(admission({ status: 'cleared', recordStatus: 'archived' }))
    for (const id of ids) expect(archived[id]).toBe('done')
  })

  it('审核通过但未归档时病案仍未收口', () => {
    expect(inpatientStageStates(admission({ status: 'cleared', recordStatus: 'reviewed' })).record).toBe('current')
  })

  it('任意状态组合下至多一个环节进行中', () => {
    for (const status of ['registered', 'admitted', 'discharge-pending', 'departed', 'cleared'] as const) {
      for (const financialStatus of ['open', 'settled'] as const) {
        for (const recordStatus of ['open', 'reviewed', 'archived'] as const) {
          const states = inpatientStageStates(admission({ status, financialStatus, recordStatus }))
          const currents = ids.filter(id => states[id] === 'current')
          expect(currents.length, `${status}/${financialStatus}/${recordStatus}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})
