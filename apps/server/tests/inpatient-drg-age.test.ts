import { describe, expect, it } from 'vitest'
import { ageAt } from '../src/application/inpatient-drg.ts'

describe('DRG 评估年龄口径', () => {
  it('北京时间出生当天凌晨按第 0 天计算，UTC 与带时区的同一时点一致', () => {
    expect(ageAt('2026-10-25', '2026-10-25T01:00:00+08:00')).toEqual({ ageYears: 0, ageDays: 0 })
    expect(ageAt('2026-10-25', '2026-10-24T17:00:00Z')).toEqual({ ageYears: 0, ageDays: 0 })
  })

  it('日龄和未来出生日期以北京时间午夜为界', () => {
    expect(ageAt('2026-10-25', '2026-10-24T23:59:59+08:00')).toEqual({ ageYears: -1, ageDays: null })
    expect(ageAt('2026-10-25', '2026-10-25T00:00:00+08:00')).toEqual({ ageYears: 0, ageDays: 0 })
    expect(ageAt('2026-10-25', '2026-10-25T23:59:59+08:00')).toEqual({ ageYears: 0, ageDays: 0 })
    expect(ageAt('2026-10-25', '2026-10-26T00:00:00+08:00')).toEqual({ ageYears: 0, ageDays: 1 })
  })

  it('新生儿第 28 天至第 29 天按医院日期切换', () => {
    expect(ageAt('2026-09-26', '2026-10-24T23:59:59+08:00')).toEqual({ ageYears: 0, ageDays: 28 })
    expect(ageAt('2026-09-26', '2026-10-25T00:00:00+08:00')).toEqual({ ageYears: 0, ageDays: 29 })
  })

  it('70 岁生日与闰年满周岁均在北京时间午夜切换', () => {
    expect(ageAt('1956-03-01', '2026-02-28T15:59:59Z')).toEqual({ ageYears: 69, ageDays: null })
    expect(ageAt('1956-03-01', '2026-02-28T16:00:00Z')).toEqual({ ageYears: 70, ageDays: null })
    expect(ageAt('2023-03-01', '2024-02-29T23:59:59+08:00')).toEqual({ ageYears: 0, ageDays: 365 })
    expect(ageAt('2023-03-01', '2024-03-01T00:00:00+08:00')).toEqual({ ageYears: 1, ageDays: null })
  })

  it('整岁按日历周年计，生日当天满岁', () => {
    // 1956-03-01 出生、2026-03-01 评估：间隔含 17 个闰日，365.25 均摊口径在生日当天误判 69 岁。
    expect(ageAt('1956-03-01', '2026-03-01T00:00:00Z')).toEqual({ ageYears: 70, ageDays: null })
    expect(ageAt('1956-03-01', '2026-02-28T00:00:00Z')).toEqual({ ageYears: 69, ageDays: null })
    expect(ageAt('1956-03-01', '2026-03-02T00:00:00Z')).toEqual({ ageYears: 70, ageDays: null })
  })

  it('未满周岁按 0 岁计并保留天龄余数', () => {
    expect(ageAt('2026-03-01', '2026-03-01T00:00:00Z')).toEqual({ ageYears: 0, ageDays: 0 })
    expect(ageAt('2025-06-01', '2026-03-01T00:00:00Z')).toEqual({ ageYears: 0, ageDays: 273 })
    expect(ageAt('2023-03-01', '2024-02-29T00:00:00Z')).toEqual({ ageYears: 0, ageDays: 365 })
    expect(ageAt('2023-03-01', '2024-03-01T00:00:00Z')).toEqual({ ageYears: 1, ageDays: null })
  })

  it('无法解析或未来出生日期不能伪装为新生儿', () => {
    expect(ageAt('not-a-date', '2026-03-01T00:00:00Z')).toEqual({ ageYears: -1, ageDays: null })
    expect(ageAt('2027-01-01', '2026-03-01T00:00:00Z')).toEqual({ ageYears: -1, ageDays: null })
    expect(ageAt('2026-03-01', 'not-a-time')).toEqual({ ageYears: -1, ageDays: null })
  })

  it.each(['2026', '2026-01', '2026-02-30', '2026-02-29'])('不从不完整或不存在的出生日期 %s 推算日龄', birthDate => {
    expect(ageAt(birthDate, '2026-03-10T00:00:00Z')).toEqual({ ageYears: -1, ageDays: null })
  })
})
