import { describe, expect, it } from 'vitest'
import { aggregateDoctorReminders } from './inpatient-doctor-reminders.tsx'
import { inpatientCareDay } from './inpatient-scope.ts'

describe('aggregateDoctorReminders', () => {
  it('按当前尚应收提醒欠费，结清时为空', () => {
    const arrears = aggregateDoctorReminders({ outstandingFen: 20_500, locale: 'zh-CN' })
    expect(arrears).toHaveLength(1)
    expect(arrears[0]).toMatchObject({ key: 'arrears', tone: 'crit' })
    expect(arrears[0]!.text).toContain('¥205.00')
    expect(aggregateDoctorReminders({ outstandingFen: 0, locale: 'zh-CN' })).toEqual([])
  })

  it('未完成术前核对与知情同意的手术申请逐项提醒，已完成的不再提醒', () => {
    const reminders = aggregateDoctorReminders({
      outstandingFen: 0, locale: 'zh-CN',
      surgeryRequests: [
        { id: 's1', status: 'requested', plannedProcedure: { coding: { display: '腹腔镜胆囊切除术' } }, preopCheck: null, consentConfirmation: null },
        { id: 's2', status: 'ready', plannedProcedure: { coding: { display: '经皮冠状动脉介入治疗' } }, preopCheck: { note: '已核对' }, consentConfirmation: null },
        { id: 's3', status: 'completed', plannedProcedure: { coding: { display: '已实施手术' } }, preopCheck: null, consentConfirmation: null },
      ],
    })
    expect(reminders.map(item => item.key)).toEqual(['surgery-s1', 'surgery-s2'])
    expect(reminders.every(item => item.tone === 'warn')).toBe(true)
    expect(reminders[0]!.text).toContain("等病区护士完成术前核对")
    expect(reminders[0]!.text).toContain("等住院医生确认手术知情同意书已签")
    expect(reminders[1]!.text).not.toContain("等病区护士完成术前核对")
    expect(reminders[1]!.text).toContain("等住院医生确认手术知情同意书已签")
  })

  it('只统计待校对医嘱与待执行、待给药执行，其他状态不进提醒', () => {
    const reminders = aggregateDoctorReminders({
      outstandingFen: 0, locale: 'zh-CN',
      orders: [
        { id: 'o1', state: 'signed' }, { id: 'o2', state: 'signed' }, { id: 'o3', state: 'verified' },
      ],
      executions: [
        { id: 'e1', status: 'pending' }, { id: 'e2', status: 'dispensed' }, { id: 'e3', status: 'completed' }, { id: 'e4', status: 'cancelled' },
      ],
    })
    expect(reminders.map(item => item.key)).toEqual(['orders-signed', 'executions-open'])
    expect(reminders[0]!.text).toContain('2')
    expect(reminders[1]!.text).toContain('2')
  })

  it('英文语境输出英文文案', () => {
    const reminders = aggregateDoctorReminders({ outstandingFen: 1, locale: 'en-US' })
    expect(reminders[0]!.text).toContain('Outstanding balance')
  })
})

describe('inpatientCareDay', () => {
  it('入科当日为第 1 天，跨日递增，缺少时钟或入科时间时不可知', () => {
    expect(inpatientCareDay({ admittedAt: '2026-08-24T09:10:00+08:00' }, '2026-08-24T15:00:00+08:00')).toBe(1)
    expect(inpatientCareDay({ admittedAt: '2026-08-24T09:10:00+08:00' }, '2026-08-26T09:10:00+08:00')).toBe(3)
    expect(inpatientCareDay({ admittedAt: undefined }, '2026-08-24T15:00:00+08:00')).toBeUndefined()
    expect(inpatientCareDay({ admittedAt: '2026-08-24T09:10:00+08:00' }, undefined)).toBeUndefined()
  })
})
