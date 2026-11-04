// @vitest-environment jsdom
import { billingCaseSchema, billingQueueSchema } from '@clinmesh/contracts/his'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BillingCasePanel } from './billing-case-panel.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

afterEach(cleanup)

function medicationBill() {
  return billingCaseSchema.parse({
    accountId: 'account', caseId: 'case', encounterId: 'encounter',
    patient: { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' },
    charges: [
      { category: 'medication', chargeItemId: 'prescription-charge-1', chargeVersion: 4, descriptionZh: '门诊药品', descriptionEn: 'Outpatient medication', amountFen: 6000, paidFen: 2000, insuranceFen: 1000, remainingFen: 3000, status: 'billable' },
      { category: 'medication', chargeItemId: 'prescription-charge-2', chargeVersion: 2, descriptionZh: '门诊药品', descriptionEn: 'Outpatient medication', amountFen: 1200, paidFen: 1200, insuranceFen: 0, remainingFen: 0, status: 'paid' },
    ], payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, totalFen: 7200, paidFen: 3200, remainingFen: 3000,
  })
}

function medicationDetails() {
  const bill = medicationBill()
  return billingQueueSchema.parse({ page: 1, pageSize: 20, total: 2, items: bill.charges.map((charge, index) => ({
    ...charge, accountId: bill.accountId, caseId: bill.caseId, encounterId: bill.encounterId, patient: bill.patient,
    lines: [{ descriptionZh: index === 0 ? '合成奥司他韦胶囊' : '合成维生素片', descriptionEn: index === 0 ? 'Synthetic oseltamivir' : 'Synthetic vitamin',
      quantity: index === 0 ? 10 : 3, unitPriceFen: index === 0 ? 760 : 400, subtotalFen: index === 0 ? 7600 : 1200,
      sourceReference: `MedicationRequest/request-${index + 1}` }],
  })) }).items
}

it('keeps both prescription item lists in the single bill without replacing adjusted amounts or balances with original subtotals', () => {
  render(<BillingCasePanel bill={medicationBill()} chargeDetails={medicationDetails()} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')} onRefresh={vi.fn()} />)
  const lists = screen.getAllByRole('list', { name: '原处方明细' })
  expect(lists).toHaveLength(2)
  const first = within(lists[0]!), second = within(lists[1]!)
  expect(first.getByText('合成奥司他韦胶囊')).toBeTruthy()
  expect(first.getByText('数量 10')).toBeTruthy()
  expect(first.getByText('原单价 ¥7.60')).toBeTruthy()
  expect(first.getByText('原小计 ¥76.00')).toBeTruthy()
  expect(second.getByText('合成维生素片')).toBeTruthy()
  expect(second.getByText('数量 3')).toBeTruthy()
  expect(second.getByText('原单价 ¥4.00')).toBeTruthy()
  expect(second.getByText('原小计 ¥12.00')).toBeTruthy()
  expect(screen.getAllByRole('table')).toHaveLength(1)
  expect(screen.getByRole('row', { name: '合计 ¥72.00 ¥32.00 ¥30.00' })).toBeTruthy()
  expect(screen.queryByText(/MedicationRequest\//)).toBeNull()
})

it('does not attach another case or another charge version to a prescription charge', () => {
  const details = [...medicationDetails().map((item, index) => index === 0 ? { ...item, caseId: 'another-case' } : { ...item, chargeVersion: 1 }),
    { ...medicationDetails()[0]!, chargeItemId: 'unrelated-charge' }]
  render(<BillingCasePanel bill={medicationBill()} chargeDetails={details} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')} onRefresh={vi.fn()} />)
  expect(screen.queryByText('合成奥司他韦胶囊')).toBeNull()
  expect(screen.queryByText('合成维生素片')).toBeNull()
  expect(screen.getAllByText('尚未取得该项药品明细。')).toHaveLength(2)
  expect(screen.getByRole('row', { name: '合计 ¥72.00 ¥32.00 ¥30.00' })).toBeTruthy()
})

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
