// @vitest-environment jsdom
import { billingCaseSchema } from '@clinmesh/contracts/his'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BillingCasePanel } from './billing-case-panel.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

afterEach(cleanup)

it('shows one accounting total row with outpatient charges, received funds and outstanding balance', () => {
  const bill = billingCaseSchema.parse({
    accountId: 'account', caseId: 'case', encounterId: 'encounter',
    patient: { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' },
    charges: [
      { category: 'registration', chargeItemId: 'registration', chargeVersion: 1, descriptionZh: '挂号费', descriptionEn: 'Registration', amountFen: 2000, paidFen: 0, remainingFen: 2000, status: 'billable' },
      { category: 'laboratory', chargeItemId: 'laboratory', chargeVersion: 2, descriptionZh: '合成检验', descriptionEn: 'Synthetic laboratory', amountFen: 6800, paidFen: 2000, remainingFen: 4800, status: 'billable' },
    ], payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, totalFen: 8800, paidFen: 2000, remainingFen: 6800,
  })
  render(<BillingCasePanel bill={bill} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')} onRefresh={vi.fn()} />)
  const totals = within(screen.getByRole('row', { name: '合计 ¥68.00 ¥20.00 ¥48.00' }))
  expect(totals.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['合计', '¥68.00', '¥20.00', '¥48.00'])
  expect(screen.getAllByText('累计到账', { exact: true })).toHaveLength(1)
  expect(screen.getAllByText('未收金额', { exact: true })).toHaveLength(1)
  expect(screen.queryByText('¥88.00')).toBeNull()
  expect(screen.queryByText('¥68.00', { selector: 'dd' })).toBeNull()
  expect(screen.getByText('挂号费已在挂号处收取，不计入本页待收。')).toBeTruthy()
})
