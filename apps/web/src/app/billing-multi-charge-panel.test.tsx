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

it.each(['completed', 'missing'] as const)('预览响应丢失后刷新查询原回执，%s时保持原键原意图', async receipt => {
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
  render(panel())
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  await user.click(await screen.findByRole('button', { name: '查询原预览结果' }))
  await screen.findByRole('region', { name: '合并收费预览' })
  expect(requests).toHaveLength(receipt === 'completed' ? 1 : 2)
  for (const request of requests) expect(request).toEqual({ key: requests[0]!.key, body: {
    expectedVersions: { 'ChargeItem/lab': '1', 'ChargeItem/imaging': '2' },
    input: { caseId: 'case', chargeItemIds: ['lab', 'imaging'], simulatorRule: 'success' },
  } })
})

it('取消后的迟到预览不覆盖草稿，余额变化撤销已显示的冻结预览', async () => {
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
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await act(async () => { release(Response.json(previewResponse())); await delayed })
  await user.click(screen.getByRole('button', { name: '选择多项收费' }))
  expect(screen.queryByRole('region', { name: '合并收费预览' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '预览合并收费' }))
  await screen.findByRole('region', { name: '合并收费预览' })
  view.rerender(panel({ ...bill, charges: bill.charges.map(charge => charge.chargeItemId === 'lab' ? { ...charge, paidFen: 300, remainingFen: 500, chargeVersion: 2 } : charge) }))
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
  await user.click(screen.getByRole('button', { name: '重试保存草稿' }))
  expect(screen.queryByText('草稿存储不可用')).toBeNull()
  expect(screen.getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('false')
})
