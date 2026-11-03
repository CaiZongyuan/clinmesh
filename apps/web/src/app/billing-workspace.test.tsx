// @vitest-environment jsdom
import { billingQueueSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BillingWorkspace } from './billing-workspace.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps the collection guidance in the action bar while retaining all four payment inputs', async () => {
  const session: SessionContext = {
    actor: { actorId: 'cashier', epoch: 'billing-layout', locationId: 'cashier', organizationId: 'hospital',
      practitionerId: 'cashier', practitionerRoleId: 'cashier-role', roleCode: 'cashier', scenarioRunId: 'run', workspaceId: 'workspace' },
    availableRoles: [], user: { id: 'cashier', email: 'cashier@example.test', name: '合成收费员' },
  }
  const item = billingQueueSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{
    accountId: 'account', amountFen: 6800, caseId: 'case', category: 'laboratory', chargeItemId: 'charge', chargeVersion: 1,
    descriptionEn: 'Synthetic laboratory', descriptionZh: '合成检验', encounterId: 'encounter',
    lines: [{ descriptionEn: 'Synthetic laboratory', descriptionZh: '合成检验', quantity: 1, sourceReference: 'ServiceRequest/synthetic', subtotalFen: 6800, unitPriceFen: 6800 }],
    patient: { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' }, status: 'billable',
  }] }).items[0]!
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/billing/queue') return Response.json({ page: 1, pageSize: 20, total: 1, items: [item] })
    if (url.pathname === '/api/his/v1/billing/cases/case') return Response.json({ ...item, charges: [{ ...item, paidFen: 0, remainingFen: 6800 }],
      payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, paidFen: 0, totalFen: 6800, remainingFen: 6800 })
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成次要资料暂不可读' } }, { status: 503 })
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    render(<QueryClientProvider client={client}><BillingWorkspace locale="zh-CN" session={session} /></QueryClientProvider>)
    await screen.findByLabelText('合成现金')
    const hint = getWorkspaceMessages('zh-CN').installmentHint
    expect(screen.getAllByText(hint)).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: '当前操作' })).getByText(hint)).toBeTruthy()
    for (const label of ['合成银行卡', '合成移动支付', '支付处理结果']) expect(screen.getByLabelText(label)).toBeTruthy()
  } finally { client.clear() }
})
