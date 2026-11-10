// @vitest-environment jsdom
import { billingCaseSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
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
