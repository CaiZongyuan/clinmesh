// @vitest-environment jsdom
import { pharmacyQueueSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { PharmacyWorkspace } from './pharmacy-workspace.tsx'
import { AgentPageRegistryProvider, useAgentPageRegistration } from './agent-page-context.tsx'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })
const session: SessionContext = {
  actor: { actorId: 'pharmacist', epoch: 'pagination-epoch', locationId: 'pharmacy', organizationId: 'hospital',
    practitionerId: 'pharmacist', practitionerRoleId: 'pharmacist-role', roleCode: 'pharmacist', scenarioRunId: 'run', workspaceId: 'workspace' },
  availableRoles: [{ code: 'pharmacist', id: 'pharmacist-role', locationId: 'pharmacy', organizationId: 'hospital', practitionerId: 'pharmacist', practitionerName: '合成药师' }],
  user: { id: 'pharmacist', email: 'pharmacist@example.test', name: '合成药师' },
}

function PharmacyWriteState() {
  const page = useAgentPageRegistration()
  const [attempt, setAttempt] = useState('idle')
  return <><output aria-label="药房工具可写状态">{JSON.stringify(Object.fromEntries(
    ['pharmacy.review.propose', 'pharmacy.dispense.propose', 'pharmacy.review.draft.set', 'pharmacy.dispense.draft.set'].map(id => [id, page?.actions[id]?.enabled ?? false]),
  ))}</output><output aria-label="药房当前处方绑定">{JSON.stringify(page?.claim.selection ?? null)}</output>
    <button onClick={() => { void Promise.resolve().then(() => page?.actions['pharmacy.dispense.draft.set']?.execute({ selections: [
      { medicationRequestId: 'medication-request-1', lotId: 'lot-1', quantity: 1 },
    ] }, new AbortController().signal)).then(() => setAttempt('allowed'), () => setAttempt('blocked')) }}>尝试过期发药草稿工具</button>
    <output aria-label="过期发药草稿结果">{attempt}</output></>
}

function recoveryPrescription(index = 1, reviewed = true) {
  return pharmacyQueueSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{
    allergyWarnings: [], authoredBy: 'synthetic-doctor', caseId: `case-${index}`, encounterId: `encounter-${index}`,
    encounterStatus: 'completed', encounterVersion: '1',
    medications: [{ doseText: '一片', dispensedQuantity: 0, frequencyCode: 'BID',
      lots: [{ expiresOn: '2027-12-31', id: `lot-${index}`, locationId: 'pharmacy', lotNumber: `SYN-RECOVERY-${index}`, quantityOnHand: 1000, version: 1 }],
      medicationId: 'medication', medicationRequestId: `medication-request-${index}`, medicationRequestVersion: '1',
      nameEn: 'Synthetic medication', nameZh: '合成药品', quantity: 10, remainingQuantity: 10, unitPriceFen: 100 }],
    patient: { id: `patient-${index}`, identifier: `SYN-RECOVERY-${index}`, name: `恢复患者${index}`, synthetic: true, versionId: '1' },
    prescriptionId: `prescription-${index}`, prescriptionNumber: `CM-RX-RECOVERY-${index}`, prescriptionStatus: 'paid', prescriptionVersion: reviewed ? 2 : 1,
    ...(reviewed ? { review: { note: '合成审核已通过', reviewId: `review-${index}`, reviewedAt: '2026-11-03T09:00:00+08:00', reviewedBy: 'pharmacist' } } : {}),
    status: reviewed ? 'awaiting-dispense' : 'awaiting-review',
  }] }).items[0]!
}

it('retains the successful dispense receipt and blocks stale cached writes or next-patient selection until a current queue is read', async () => {
  const first = recoveryPrescription(), next = recoveryPrescription(2)
  let reads: 'initial' | 'failure' | 'stale' | 'current' = 'initial'
  let writes = 0, historicalReads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/pharmacy/queue') {
      if (url.searchParams.get('status') === 'completed') historicalReads += 1
      if (reads === 'failure') return Response.json({ message: '合成队列投影暂不可读' }, { status: 503 })
      return Response.json({ page: 1, pageSize: 20, total: reads === 'current' ? 1 : 2, items: reads === 'current' ? [next] : [first, next] })
    }
    if (url.pathname.endsWith('/prescriptions/prescription-1/actions/dispense') && init?.method === 'POST') {
      writes += 1; reads = 'failure'
      return Response.json({ data: { medicationDispenseIds: ['dispense'], prescriptionId: first.prescriptionId, prescriptionVersion: 3,
        scenarioStatus: 'active', status: 'completed' }, auditId: 'audit', requestId: 'request', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected pharmacy request: ${url.pathname}`)
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const { rerender } = render(<QueryClientProvider client={client}><AgentPageRegistryProvider><PharmacyWorkspace locale="zh-CN" session={session} /><PharmacyWriteState /></AgentPageRegistryProvider></QueryClientProvider>)
  const user = userEvent.setup()
  const action = within(await screen.findByRole('region', { name: '当前操作' }))
  await user.click(await action.findByRole('button', { name: '审阅发药' }))
  await user.click(action.getByRole('button', { name: '确认发药' }))
  await screen.findByRole('button', { name: '重试发药队列' })
  await screen.findByText('本次发药', { exact: true })
  expect(action.queryByRole('button', { name: '审阅发药' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: /^本次发放数量/ })).toBeNull()
  expect(action.getByRole('button', { name: '下一位' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/SYN-RECOVERY-1.*本次.*10/)).toBeTruthy()
  expect(JSON.parse(screen.getByLabelText('药房当前处方绑定').textContent ?? 'null')).toEqual({ kind: 'prescription', id: first.prescriptionId, version: '3' })
  await waitFor(() => expect(JSON.parse(screen.getByLabelText('药房工具可写状态').textContent ?? '{}')).toEqual({
    'pharmacy.review.propose': false, 'pharmacy.dispense.propose': false, 'pharmacy.review.draft.set': false, 'pharmacy.dispense.draft.set': false,
  }))
  await user.click(screen.getByRole('button', { name: '尝试过期发药草稿工具' }))
  await waitFor(() => expect(screen.getByLabelText('过期发药草稿结果').textContent).toBe('blocked'))
  reads = 'stale'
  await user.click(screen.getByRole('button', { name: '重试发药队列' }))
  await waitFor(() => expect(writes).toBe(1))
  expect(action.queryByRole('button', { name: '审阅发药' })).toBeNull()
  expect(action.getByRole('button', { name: '下一位' })).toHaveProperty('disabled', true)
  reads = 'current'
  await user.click(screen.getByRole('button', { name: '重试发药队列' }))
  await user.click(await action.findByRole('button', { name: '下一位：恢复患者2' }))
  await screen.findByRole('heading', { name: '恢复患者2' })
  expect(writes).toBe(1)
  expect(historicalReads).toBe(0)
  reads = 'initial'
  const otherSession = { ...session, actor: { ...session.actor, epoch: 'other-recovery-epoch' } }
  rerender(<QueryClientProvider client={client}><AgentPageRegistryProvider><PharmacyWorkspace locale="zh-CN" session={otherSession} /><PharmacyWriteState /></AgentPageRegistryProvider></QueryClientProvider>)
  await screen.findByRole('heading', { name: '恢复患者1' })
  expect(screen.getByRole('button', { name: '审阅发药' })).toHaveProperty('disabled', false)
  expect(screen.queryByText('本次发药', { exact: true })).toBeNull()
  expect(JSON.parse(screen.getByLabelText('药房当前处方绑定').textContent ?? 'null')).toEqual({ kind: 'prescription', id: first.prescriptionId, version: '2' })
})

it('does not repeat an approved review or allow dispensing until the receipt version is projected', async () => {
  const original = recoveryPrescription(1, false)
  const approved = recoveryPrescription()
  let reads: 'initial' | 'failure' | 'stale' | 'current' = 'initial', writes = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/pharmacy/queue') {
      if (reads === 'failure') return Response.json({ message: '合成审核投影暂不可读' }, { status: 503 })
      return Response.json({ page: 1, pageSize: 20, total: 1, items: [reads === 'current' ? approved : original] })
    }
    if (url.pathname.endsWith('/prescriptions/prescription-1/actions/review') && init?.method === 'POST') {
      writes += 1; reads = 'failure'
      expect(JSON.parse(String(init.body))).toMatchObject({ input: { expectedPrescriptionVersion: 1, note: '人审冻结审核意见' } })
      return Response.json({ data: { prescriptionId: original.prescriptionId, prescriptionVersion: 2, reviewId: 'review-1', status: 'awaiting-dispense' },
        auditId: 'audit', requestId: 'request', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected pharmacy request: ${url.pathname}`)
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><AgentPageRegistryProvider><PharmacyWorkspace locale="zh-CN" session={session} /><PharmacyWriteState /></AgentPageRegistryProvider></QueryClientProvider>)
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('审核意见'), '人审冻结审核意见')
  await user.click(screen.getByRole('button', { name: '审核处方' }))
  await user.click(screen.getByRole('button', { name: '审核通过' }))
  await screen.findByRole('button', { name: '重试发药队列' })
  expect(screen.getByRole('heading', { name: '恢复患者1' })).toBeTruthy()
  expect(screen.getByText('人审冻结审核意见', { exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '审核处方' })).toBeNull()
  expect(screen.queryByRole('button', { name: '审阅发药' })).toBeNull()
  expect(screen.queryByLabelText('审核意见')).toBeNull()
  expect(screen.queryByRole('spinbutton')).toBeNull()
  await waitFor(() => expect(JSON.parse(screen.getByLabelText('药房工具可写状态').textContent ?? '{}')).toEqual({
    'pharmacy.review.propose': false, 'pharmacy.dispense.propose': false, 'pharmacy.review.draft.set': false, 'pharmacy.dispense.draft.set': false,
  }))
  reads = 'stale'
  await user.click(screen.getByRole('button', { name: '重试发药队列' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '重试发药队列' })).toHaveProperty('disabled', false))
  expect(screen.queryByLabelText('审核意见')).toBeNull()
  expect(screen.queryByRole('spinbutton')).toBeNull()
  reads = 'current'
  await user.click(screen.getByRole('button', { name: '重试发药队列' }))
  expect(await screen.findByRole('spinbutton')).toHaveProperty('value', '10')
  expect(screen.getByRole('button', { name: '审阅发药' })).toHaveProperty('disabled', false)
  expect(writes).toBe(1)
})

it('retains a partial dispense snapshot without inventing remaining quantity and resumes using the new server versions', async () => {
  const original = recoveryPrescription()
  const current = { ...original, prescriptionVersion: 3, status: 'partially-dispensed', medications: original.medications.map(item => ({
    ...item, dispensedQuantity: 4, remainingQuantity: 6, lots: item.lots.map(lot => ({ ...lot, quantityOnHand: 996, version: 2 })),
  })) }
  let reads: 'initial' | 'failure' | 'stale' | 'current' | 'completed' = 'initial', writes = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/pharmacy/queue') {
      if (reads === 'failure') return Response.json({ message: '合成部分发药投影暂不可读' }, { status: 503 })
      return Response.json({ page: 1, pageSize: 20, total: reads === 'completed' ? 0 : 1,
        items: reads === 'completed' ? [] : [reads === 'current' ? current : original] })
    }
    if (url.pathname.endsWith('/prescriptions/prescription-1/actions/dispense') && init?.method === 'POST') {
      writes += 1
      expect(JSON.parse(String(init.body))).toMatchObject({ input: { expectedPrescriptionVersion: writes === 1 ? 2 : 3,
        lotSelections: [{ lotId: 'lot-1', expectedVersion: writes === 1 ? 1 : 2, quantity: writes === 1 ? 4 : 6 }] } })
      reads = writes === 1 ? 'failure' : 'completed'
      return Response.json({ data: { medicationDispenseIds: [`dispense-${writes}`], prescriptionId: original.prescriptionId, prescriptionVersion: writes === 1 ? 3 : 4,
        scenarioStatus: 'active', status: writes === 1 ? 'partial' : 'completed' }, auditId: 'audit', requestId: 'request', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected pharmacy request: ${url.pathname}`)
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><AgentPageRegistryProvider><PharmacyWorkspace locale="zh-CN" session={session} /><PharmacyWriteState /></AgentPageRegistryProvider></QueryClientProvider>)
  const user = userEvent.setup()
  await user.clear(await screen.findByRole('spinbutton'))
  await user.type(screen.getByRole('spinbutton'), '4')
  await user.click(screen.getByRole('button', { name: '审阅发药' }))
  await user.click(screen.getByRole('button', { name: '确认发药' }))
  await screen.findByRole('button', { name: '重试发药队列' })
  expect(screen.getByText(/SYN-RECOVERY-1.*本次.*4/)).toBeTruthy()
  expect(within(screen.getByRole('list', { name: '办理流程' })).getByRole('listitem', { name: '发药' }).getAttribute('aria-current')).toBe('step')
  expect(screen.queryByRole('spinbutton')).toBeNull()
  expect(screen.queryByRole('button', { name: '审阅发药' })).toBeNull()
  expect(screen.getByRole('button', { name: '下一位' })).toHaveProperty('disabled', true)
  await waitFor(() => expect(JSON.parse(screen.getByLabelText('药房工具可写状态').textContent ?? '{}')).toEqual({
    'pharmacy.review.propose': false, 'pharmacy.dispense.propose': false, 'pharmacy.review.draft.set': false, 'pharmacy.dispense.draft.set': false,
  }))
  reads = 'stale'
  await user.click(screen.getByRole('button', { name: '重试发药队列' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '重试发药队列' })).toHaveProperty('disabled', false))
  expect(screen.queryByRole('spinbutton')).toBeNull()
  reads = 'current'
  await user.click(screen.getByRole('button', { name: '重试发药队列' }))
  expect(await screen.findByRole('spinbutton')).toHaveProperty('value', '6')
  await user.click(screen.getByRole('button', { name: '审阅发药' }))
  await user.click(screen.getByRole('button', { name: '确认发药' }))
  await screen.findByText('待发队列已清空。', { exact: true })
  expect(writes).toBe(2)
})

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
  expect(review.getByText(/11-03 09:00/)).toBeTruthy()
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
