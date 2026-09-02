import { describe, expect, it } from 'vitest'
import { formatLaboratoryPrice } from './workspace-format.ts'

describe('workspace price formatting', () => {
  it('distinguishes an unpriced laboratory service from a free service', () => {
    expect(formatLaboratoryPrice(0, 'zh-CN')).toBe('未计价')
    expect(formatLaboratoryPrice(0, 'en-US')).toBe('Not priced')
    expect(formatLaboratoryPrice(2_500, 'zh-CN')).toBe('¥25.00')
  })
})
