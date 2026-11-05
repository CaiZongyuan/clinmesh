import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { expect, it } from 'vitest'
import { inpatientStageTabs } from './inpatient-stage-activity.ts'

const admission: InpatientAdmission = { id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-1', admissionRoute: 'direct',
  wardId: 'ward-general', organizationId: 'org-1', bedId: 'bed-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  admittedAt: '2026-08-24T09:00:00+08:00', registeredAt: '2026-08-24T08:00:00+08:00', depositFen: 100000, chargesFen: 126800, versionId: '1' }
const tabs = (role: string, input: Partial<InpatientAdmission> = {}, transfers = false) => inpatientStageTabs({ admission: { ...admission, ...input }, role,
  ...(transfers ? { transfers: { transfers: [] } as never } : {}) }, transfers, 'zh-CN')

it('住院页签按原型分主页签与「更多」，不带状态图标，次级页签有真实摘要', () => {
  const doctor = tabs('inpatient-doctor')
  expect(doctor.filter(tab => !tab.more).map(tab => tab.label)).toEqual(['诊断医嘱', '检查检验', '手术', 'DRG 预分组', '出院', '病案'])
  expect(doctor.filter(tab => tab.more).map(tab => [tab.label, tab.summary])).toEqual([['入科', '已完成'], ['费用', '¥1,268.00']])
  expect(doctor.every(tab => tab.status === undefined)).toBe(true)
  const nurse = tabs('ward-nurse')
  expect(nurse.filter(tab => !tab.more).map(tab => tab.label)).toEqual(['入科', '诊断医嘱', '检查检验', '手术', '出院'])
  expect(nurse.filter(tab => tab.more).map(tab => [tab.label, tab.summary])).toEqual([['费用', '¥1,268.00'], ['病案', '出院后']])
  expect(tabs('cashier').map(tab => [tab.label, tab.more ?? false])).toEqual([['入科', true], ['费用', false], ['出院', false]])
  expect(tabs('medical-records', { status: 'cleared', financialStatus: 'settled' }).map(tab => tab.label)).toEqual(['病案'])
  expect(tabs('ward-nurse', { status: 'registered' })[0]).toMatchObject({ label: '入科', count: 1 })
})

it('没有待交接的转科时「转科交接」收进更多', () => {
  expect(tabs('inpatient-doctor', {}, true).find(tab => tab.value === 'transfer')).toMatchObject({ more: true, summary: '无进行中转科' })
})
