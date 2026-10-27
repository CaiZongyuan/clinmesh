// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { InvestigationBilling, InvestigationPrice } from './investigation-billing.tsx'

const price = { id: 'synthetic-price', version: 1, priceFen: 2500, currency: 'CNY' as const,
  unit: '项目', source: 'synthetic-outpatient-investigation-2026-10-26-v1', effectiveOn: '2026-08-24' }

afterEach(cleanup)

describe('outpatient investigation price', () => {
  it('makes a missing hospital price explicit while preserving the draft option', () => {
    render(<InvestigationPrice locale="zh-CN" />)
    expect(screen.getByText('未配置本院门诊价格，可保存草稿，暂不能正式开立。')).toBeTruthy()
    expect(screen.queryByText('¥0.00')).toBeNull()
  })

  it('shows the original fee, remaining amount and refund responsibility after cancellation', () => {
    render(<InvestigationBilling locale="zh-CN" billing={{ chargeItemId: 'original-charge', price, quantity: 1,
      status: 'cancelled', paidFen: 1000, insuranceFen: 0, remainingFen: 0 }} />)
    expect(screen.getByText('已取消，原付款由收费员按原交易退款。')).toBeTruthy()
    expect(screen.getByText('original-charge')).toBeTruthy()
    expect(screen.getByText('¥10.00')).toBeTruthy()
    expect(screen.getByText('合成门诊价目')).toBeTruthy()
    expect(screen.getByText(/2026-10-26-v1/)).toBeTruthy()
  })

  it('preserves the financial release fact while showing a new outstanding balance', () => {
    render(<InvestigationBilling locale="zh-CN" billing={{ chargeItemId: 'original-charge', price, quantity: 1,
      status: 'pending', paidFen: 0, insuranceFen: 0, remainingFen: 2500, releasedAt: '2026-08-24T09:05:00+08:00' }} />)
    expect(screen.getByText('待缴费')).toBeTruthy()
    expect(screen.getByText('¥25.00')).toBeTruthy()
    expect(screen.getByText(/^已财务放行 · /)).toBeTruthy()
  })
})
