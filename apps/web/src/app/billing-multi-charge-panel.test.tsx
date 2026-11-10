// @vitest-environment jsdom
import { billingCaseSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { signOut } from './api-client.ts'
import { BillingMultiChargePanel } from './billing-multi-charge-panel.tsx'
import { clearMultiChargeDrafts } from './billing-multi-charge-draft.ts'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals()
  clearMultiChargeDrafts(); sessionStorage.clear()
})
const session: SessionContext = {
  actor: { actorId: 'cashier', epoch: 'epoch', locationId: 'cashier', organizationId: 'hospital',
    practitionerId: 'cashier', practitionerRoleId: 'cashier-role', roleCode: 'cashier', scenarioRunId: 'run', workspaceId: 'workspace' },
  availableRoles: [], user: { id: 'cashier', email: 'cashier@example.test', name: '合成收费员' },
}
const bill = billingCaseSchema.parse({
  accountId: 'account', caseId: 'case', encounterId: 'encounter',
  patient: { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' },
  charges: [
    { amountFen: 800, category: 'laboratory', chargeItemId: 'lab', chargeVersion: 1, descriptionEn: 'Laboratory', descriptionZh: '合成检验', paidFen: 0, remainingFen: 800, status: 'billable' },
    { amountFen: 8000, category: 'imaging', chargeItemId: 'imaging', chargeVersion: 2, descriptionEn: 'Imaging', descriptionZh: '合成放射', paidFen: 0, remainingFen: 8000, status: 'billable' },
  ], payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, paidFen: 0, totalFen: 8800, remainingFen: 8800,
})
function panel(value = bill, auth = session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return <QueryClientProvider client={client}><BillingMultiChargePanel key={`${auth.actor.epoch}:${value.caseId}`} bill={value} session={auth} locale="zh-CN" blocked={false} onRefresh={() => undefined} /></QueryClientProvider>
}

function previewResponse() {
  return { auditId: 'audit-preview', effects: [], requestId: 'request-preview', warnings: [], data: {
    amountFen: 8800, caseId: 'case', patientId: 'patient', encounterId: 'encounter',
    charges: bill.charges.map(charge => ({ chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion, category: charge.category,
      descriptionZh: charge.descriptionZh, descriptionEn: charge.descriptionEn, amountFen: charge.amountFen, paidFen: 0, insuranceFen: 0,
      remainingFen: charge.remainingFen, collectionAmountFen: charge.remainingFen })),
    channel: 'synthetic-payment', commitToken: 'synthetic-token', expectedOutcome: 'success',
    expiresAt: new Date(Date.now() + 300_000).toISOString(), previewId: 'preview-multi',
    totalFen: 8800, paidFen: 0, insuranceFen: 0, remainingFen: 8800, tenders: [{ method: 'cash', amountFen: 8800 }],
  } }
}

it('显式现金与银行卡组合的字段顺序不影响成功预览显示', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(session)
    if (url.pathname.endsWith('/preview-multi-charge')) {
      expect(JSON.parse(String(options?.body))).toMatchObject({ input: { tenders: [
        { amountFen: 2800, method: 'cash' }, { amountFen: 6000, method: 'bank-card' },
      ] } })
      const response = previewResponse()
      return Response.json({ ...response, data: { ...response.data, tenders: [
        { amountFen: 2800, method: 'cash' }, { amountFen: 6000, method: 'bank-card' },
      ] } })
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
  await user.type(screen.getByLabelText('合成现金'), '28.00')
  await user.type(screen.getByLabelText('合成银行卡'), '60.00')
  await user.click(screen.getByRole('button', { name: '预览合并收费' }))
  await screen.findByRole('region', { name: '合并收费预览' })
  expect(screen.getByText('合成现金 ¥28.00 + 合成银行卡 ¥60.00')).toBeTruthy()
  expect(screen.queryByText('已找到原预览，费用或草稿已变化，请重新预览。')).toBeNull()
})

it.each([
  ['completed', false], ['missing', false], ['completed', true], ['missing', true],
] as const)('预览响应丢失后刷新查询原回执，%s、草稿损坏=%s时保持原键原意图', async (receipt, corruptDraft) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let originalKey = ''
  const requests: Array<{ key: string; body: unknown }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(session)
    if (url.pathname.endsWith('/preview-multi-charge')) {
      originalKey = new Headers(options?.headers).get('idempotency-key') ?? ''
      requests.push({ key: originalKey, body: JSON.parse(String(options?.body)) })
      if (requests.length === 2) return Response.json(previewResponse())
      throw new TypeError('synthetic lost response')
    }
    if (url.pathname === '/api/his/v1/command-receipts') {
      expect(url.searchParams.get('operationId')).toBe('payment.multi-charge.preview')
      expect(url.searchParams.get('idempotencyKey')).toBe(originalKey)
      if (receipt === 'missing') return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '原回执尚未创建' } }, { status: 404 })
      return Response.json({ status: 'completed', operationId: 'payment.multi-charge.preview', idempotencyKey: originalKey, response: previewResponse() })
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
  await user.click(screen.getByRole('button', { name: '预览合并收费' }))
  await screen.findByText('操作失败')
  cleanup()
  if (corruptDraft) {
    for (const key of Object.keys(sessionStorage).filter(key => key.startsWith('clinmesh.multi-charge-draft:'))) sessionStorage.setItem(key, '{damaged-draft')
  }
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  const recovery = await screen.findByRole('button', { name: '查询原预览结果' })
  expect(recovery.hasAttribute('disabled')).toBe(false)
  await user.click(recovery)
  if (corruptDraft) {
    await screen.findByText('已找到原预览，费用或草稿已变化，请重新预览。')
    expect(screen.queryByRole('region', { name: '合并收费预览' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查询原预览结果' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '重试读取草稿' }))
    expect(screen.getByText('草稿存储不可用')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '丢弃草稿' }))
    await user.click(screen.getByRole('button', { name: '确认丢弃草稿' }))
    expect(screen.queryByText('草稿存储不可用')).toBeNull()
  } else await screen.findByRole('region', { name: '合并收费预览' })
  expect(requests).toHaveLength(receipt === 'completed' ? 1 : 2)
  for (const request of requests) expect(request).toEqual({ key: requests[0]!.key, body: {
    expectedVersions: { 'ChargeItem/lab': '1', 'ChargeItem/imaging': '2' },
    input: { caseId: 'case', chargeItemIds: ['lab', 'imaging'], simulatorRule: 'success' },
  } })
})

it('预览在途禁止关闭与丢弃，结果未知后可退出并保留输入和原预览恢复入口', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let release: (response: Response) => void = () => undefined
  const delayed = new Promise<Response>(resolve => { release = resolve })
  let sent = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/auth/context')) return Response.json(session)
    if (String(input).endsWith('/preview-multi-charge')) { sent++; return delayed }
    throw new Error('Unexpected request')
  }))
  const user = userEvent.setup()
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
  await user.type(screen.getByLabelText('合成现金'), '88.00')
  await user.click(screen.getByRole('button', { name: '丢弃草稿' }))
  await user.click(screen.getByRole('button', { name: '预览合并收费' }))
  await waitFor(() => expect(sent).toBe(1))
  try {
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '选择多项收费' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '确认丢弃草稿' })).toHaveProperty('disabled', true)
    await act(async () => { release(Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成结果未知' } }, { status: 503 })); await delayed })
    await waitFor(() => expect(screen.getByRole('button', { name: '查询原预览结果' })).toHaveProperty('disabled', false))
    expect(screen.getByRole('button', { name: '确认丢弃草稿' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: '确认丢弃草稿' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择多项收费' })).toBeNull())
    await user.click(screen.getByRole('button', { name: '选择多项收费' }))
    expect(screen.getByRole('button', { name: '查询原预览结果' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '选择收费：合成放射' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('合成现金')).toHaveProperty('value', '88.00')
    expect(sent).toBe(1)
  } finally {
    await act(async () => { release(Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成结果未知' } }, { status: 503 })); await delayed })
  }
})

it('卸载后的迟到预览不覆盖草稿，余额变化撤销已显示的冻结预览', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let release: (response: Response) => void = () => undefined
  const delayed = new Promise<Response>(resolve => { release = resolve })
  let sent = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/auth/context')) return Response.json(session)
    if (String(input).endsWith('/preview-multi-charge')) { sent++; return sent === 1 ? delayed : Response.json(previewResponse()) }
    throw new Error('Unexpected request')
  }))
  const user = userEvent.setup()
  const view = render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
  await user.click(screen.getByRole('button', { name: '预览合并收费' }))
  await waitFor(() => expect(sent).toBe(1))
  view.unmount()
  await act(async () => { release(Response.json(previewResponse())); await delayed })
  const restored = render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.queryByRole('region', { name: '合并收费预览' })).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: '预览合并收费' })).toHaveProperty('disabled', false))
  await user.click(screen.getByRole('button', { name: '预览合并收费' }))
  await screen.findByRole('region', { name: '合并收费预览' })
  restored.rerender(panel({ ...bill, charges: bill.charges.map(charge => charge.chargeItemId === 'lab' ? { ...charge, paidFen: 300, remainingFen: 500, chargeVersion: 2 } : charge) }))
  expect(screen.queryByRole('region', { name: '合并收费预览' })).toBeNull()
  expect(screen.getByText('预览已失效，请重新预览。')).toBeTruthy()
})

it('完整Actor或患者就诊变化隔离私稿，回到原范围恢复人工输入', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const user = userEvent.setup()
  const view = render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('checkbox', { name: '选择收费：合成检验' }))
  await user.type(screen.getByLabelText('合成现金'), '8.00')
  const otherActor = { ...session, actor: { ...session.actor, locationId: 'other-location' } }
  view.rerender(panel(bill, otherActor))
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('false')
  expect((screen.getByLabelText('合成现金') as HTMLInputElement).value).toBe('')
  view.rerender(panel({ ...bill, caseId: 'other-case', encounterId: 'other-encounter', patient: { ...bill.patient, id: 'other-patient' } }))
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('false')
  view.rerender(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('true')
  expect((screen.getByLabelText('合成现金') as HTMLInputElement).value).toBe('8.00')
})

it('临时读取失败只允许重读或明确丢弃，恢复读取保留原选择和付款方式', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const user = userEvent.setup()
  const view = render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
  await user.type(screen.getByLabelText('合成现金'), '88.00')
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.multi-charge-draft:'))!
  const original = sessionStorage.getItem(key)
  view.unmount()
  const getItem = Storage.prototype.getItem
  let denied = true
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, storageKey: string) {
    if (storageKey === key && denied) throw new DOMException('合成读取失败', 'SecurityError')
    return getItem.call(this, storageKey)
  })
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.getByText('草稿存储不可用')).toBeTruthy()
  denied = false
  expect(screen.getByLabelText('合成现金')).toHaveProperty('disabled', true)
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '重试读取草稿' }))
  expect(screen.queryByText('草稿存储不可用')).toBeNull()
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('checkbox', { name: '选择收费：合成放射' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByLabelText('合成现金')).toHaveProperty('value', '88.00')
  expect(sessionStorage.getItem(key)).toBe(original)
})

it('保存失败保留当前输入，恢复存储后可重试保存并重新挂载恢复', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const user = userEvent.setup()
  const view = render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
  const setItem = Storage.prototype.setItem
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith('clinmesh.multi-charge-draft:')) throw new DOMException('合成保存失败', 'QuotaExceededError')
    setItem.call(this, key, value)
  })
  await user.type(screen.getByLabelText('合成现金'), '88.00')
  expect(screen.getByLabelText('合成现金')).toHaveProperty('value', '88.00')
  expect(screen.getByRole('button', { name: '预览合并收费' })).toHaveProperty('disabled', true)
  denied.mockRestore()
  await user.click(screen.getByRole('button', { name: '重试保存草稿' }))
  expect(screen.queryByText('草稿存储不可用')).toBeNull()
  view.unmount()
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('checkbox', { name: '选择收费：合成放射' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByLabelText('合成现金')).toHaveProperty('value', '88.00')
})

it('受限存储不阻止成功退出，同次重登隐藏未清理旧稿直到恢复存储', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  const user = userEvent.setup()
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(screen.getByRole('checkbox', { name: '选择收费：合成检验' }))
  const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('restricted storage') })
  await expect(signOut()).resolves.toBeUndefined()
  cleanup()
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByText('草稿存储不可用')).toBeTruthy()
  denied.mockRestore()
  await user.click(screen.getByRole('button', { name: '重试读取草稿' }))
  expect(screen.queryByText('草稿存储不可用')).toBeNull()
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('false')
})
