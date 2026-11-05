import { describe, expect, it } from 'vitest'
import { formatLaboratoryPrice, formatShanghaiMinute } from './workspace-format.ts'

describe('workspace price formatting', () => {
  it('distinguishes an unpriced laboratory service from a free service', () => {
    expect(formatLaboratoryPrice(0, 'zh-CN')).toBe('未计价')
    expect(formatLaboratoryPrice(0, 'en-US')).toBe('Not priced')
    expect(formatLaboratoryPrice(2_500, 'zh-CN')).toBe('¥25.00')
  })
})

describe('formatShanghaiMinute', () => {
  it('按上海时区显示到分钟，跨日换算正确', () => {
    expect(formatShanghaiMinute('2026-08-24T09:00:59+08:00')).toBe('2026-08-24 09:00')
    expect(formatShanghaiMinute('2026-08-24T16:30:00Z')).toBe('2026-08-25 00:30')
  })
})
