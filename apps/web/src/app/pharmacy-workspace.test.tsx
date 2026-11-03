// @vitest-environment jsdom
import { pharmacyQueueSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PharmacyWorkspace } from './pharmacy-workspace.tsx'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })
const session: SessionContext = {
  actor: { actorId: 'pharmacist', epoch: 'pagination-epoch', locationId: 'pharmacy', organizationId: 'hospital',
    practitionerId: 'pharmacist', practitionerRoleId: 'pharmacist-role', roleCode: 'pharmacist', scenarioRunId: 'run', workspaceId: 'workspace' },
  availableRoles: [{ code: 'pharmacist', id: 'pharmacist-role', locationId: 'pharmacy', organizationId: 'hospital', practitionerId: 'pharmacist', practitionerName: '合成药师' }],
  user: { id: 'pharmacist', email: 'pharmacist@example.test', name: '合成药师' },
}

it('keeps approved review evidence and allergy risks compact while dispensing controls belong to their medication row', async () => {
  const item = pharmacyQueueSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{
    allergyWarnings: [{ display: '青霉素过敏，曾发生呼吸困难；需要完整核对风险', code: 'penicillin' }],
    authoredBy: 'synthetic-doctor', caseId: 'case', encounterId: 'encounter', encounterStatus: 'completed', encounterVersion: '1',
    medications: [{ doseText: '一片', dispensedQuantity: 4, frequencyCode: 'BID',
      lots: [{ expiresOn: '2027-12-31', id: 'lot', locationId: 'pharmacy', lotNumber: 'SYN-LOT-APPROVED', quantityOnHand: 996, version: 2 }],
      medicationId: 'medication', medicationRequestId: 'medication-request', medicationRequestVersion: '1',
      nameEn: 'Synthetic medication', nameZh: '合成药品', quantity: 10, remainingQuantity: 6, unitPriceFen: 100 }],
    patient: { id: 'patient', identifier: 'SYN-APPROVED', name: '合成审核患者', synthetic: true, versionId: '1' },
    prescriptionId: 'prescription', prescriptionNumber: 'CM-RX-APPROVED', prescriptionStatus: 'paid', prescriptionVersion: 3,
    review: { note: '已核对既往过敏和本次用药', reviewId: 'review', reviewedAt: '2026-11-03T09:00:00+08:00', reviewedBy: 'historical-pharmacist' },
    status: 'partially-dispensed',
  }] }).items[0]!
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ page: 1, pageSize: 20, total: 1, items: [item] })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><PharmacyWorkspace locale="zh-CN" session={session} /></QueryClientProvider>)
  const quantity = await screen.findByLabelText('本次发放数量 · 合成药品')
  const row = within(screen.getByRole('row', { name: /合成药品/ }))
  expect(row.getByLabelText('本次发放数量 · 合成药品')).toBe(quantity)
  expect(row.getByRole('combobox', { name: '库存批次 · 合成药品' })).toBeTruthy()
  expect(screen.getAllByText(/SYN-LOT-APPROVED/)).toHaveLength(1)
  const review = within(screen.getByRole('status', { name: '处方审核结论' }))
  expect(review.getByText('处方审核通过')).toBeTruthy()
  expect(review.getByText('已核对既往过敏和本次用药')).toBeTruthy()
  expect(review.getByText(/2026\/11\/3.*09:00:00/)).toBeTruthy()
  expect(screen.queryByText('historical-pharmacist')).toBeNull()
  expect(screen.queryByText('合成药师', { exact: true })).toBeNull()
  expect(screen.getByRole('note', { name: '过敏提示' }).textContent).toContain('青霉素过敏，曾发生呼吸困难；需要完整核对风险')
})

it('keeps the last-page dispense result while offering the first remaining prescription on the previous page', async () => {
  let completed = false
  let historyAvailable = false
  let dispensePosts = 0
  const completedReads: number[] = []
  const pendingReadsAfterCompletion: number[] = []
  const items = pharmacyQueueSchema.parse({ page: 1, pageSize: 20, total: 21, items: Array.from({ length: 21 }, (_, index) => ({
    allergyWarnings: [], authoredBy: 'synthetic-doctor', caseId: `case-${index + 1}`, encounterId: `encounter-${index + 1}`,
    encounterStatus: 'completed', encounterVersion: '1',
    medications: [{ doseText: '一片', dispensedQuantity: 0, frequencyCode: 'BID',
      lots: [{ expiresOn: '2027-12-31', id: `lot-${index + 1}`, locationId: 'pharmacy', lotNumber: 'SYN-LOT', quantityOnHand: 1000, version: 1 }],
      medicationId: 'medication', medicationRequestId: `medication-request-${index + 1}`, medicationRequestVersion: '1',
      nameEn: 'Synthetic medication', nameZh: '合成药品', quantity: 10, remainingQuantity: 10, unitPriceFen: 100 }],
    patient: { id: `patient-${index + 1}`, identifier: `SYN-PAGINATION-${index + 1}`, name: `分页患者${String(index + 1).padStart(2, '0')}`, synthetic: true, versionId: '1' },
    prescriptionId: `prescription-${index + 1}`, prescriptionNumber: `CM-RX-${index + 1}`, prescriptionStatus: 'paid', prescriptionVersion: 2,
    review: { note: '合成审核已通过', reviewId: `review-${index + 1}`, reviewedAt: '2026-11-03T09:00:00+08:00', reviewedBy: 'pharmacist' },
    status: 'awaiting-dispense',
  })) }).items
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/pharmacy/queue') {
      const page = Number(url.searchParams.get('page') ?? 1)
      if (url.searchParams.get('status') === 'completed') {
        completedReads.push(page)
        return historyAvailable ? Response.json({ page, pageSize: 20, total: 1, items: [{ ...items[20]!, status: 'completed',
          medications: items[20]!.medications.map(item => ({ ...item, remainingQuantity: 0, dispensedQuantity: 10,
            lots: item.lots.map(lot => ({ ...lot, lotNumber: 'UNRELATED-CURRENT-STOCK' })) })) }] }) : Response.json({ message: '历史列表暂不可读' }, { status: 503 })
      }
      if (completed) pendingReadsAfterCompletion.push(page)
      const remaining = completed ? items.slice(0, 20) : items
      return Response.json({ page, pageSize: 20, total: remaining.length, items: remaining.slice((page - 1) * 20, page * 20) })
    }
    if (url.pathname.endsWith('/prescriptions/prescription-21/actions/dispense') && init?.method === 'POST') {
      dispensePosts += 1; completed = true
      return Response.json({ data: { medicationDispenseIds: ['dispense-21'], prescriptionId: 'prescription-21', prescriptionVersion: 3,
        scenarioStatus: 'completed', status: 'completed' }, auditId: 'audit', requestId: 'request', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected pharmacy request: ${url.pathname}`)
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><PharmacyWorkspace locale="zh-CN" session={session} /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '下一页' }))
  await screen.findByRole('heading', { name: '分页患者21' })
  const action = within(screen.getByRole('region', { name: '当前操作' }))
  await user.click(action.getByRole('button', { name: '审阅发药' }))
  await user.click(action.getByRole('button', { name: '确认发药' }))
  await screen.findByText('20 张处方', { exact: true })
  expect(screen.queryByText('待发队列已清空。', { exact: true })).toBeNull()
  const next = await screen.findByRole('button', { name: '下一位：分页患者01' })
  expect(completedReads).toEqual([])
  expect(next).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: '查看其他待发处方' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '分页患者21' })).toBeTruthy()
  expect(screen.getByText('本次发药', { exact: true })).toBeTruthy()
  await user.click(next)
  await screen.findByRole('heading', { name: '分页患者01' })
  await waitFor(() => expect(pendingReadsAfterCompletion).toContain(1))
  expect(dispensePosts).toBe(1)
  historyAvailable = true
  await user.click(screen.getByRole('tab', { name: '已发药' }))
  await screen.findByRole('heading', { name: '分页患者21' })
  expect(completedReads).toEqual([1])
  expect(screen.queryByText('UNRELATED-CURRENT-STOCK')).toBeNull()
  expect(screen.queryByText(/可用库存批次/)).toBeNull()
  expect(screen.queryByRole('combobox', { name: /批次/ })).toBeNull()
})
