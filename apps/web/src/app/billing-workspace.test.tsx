// @vitest-environment jsdom
import { billingQueueSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { BillingWorkspace } from './billing-workspace.tsx'
import { multiChargeDraftStorage } from './billing-multi-charge-draft.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
  ['completed', false, 'ambiguous'], ['missing', false, 'ambiguous'], ['completed', true, 'ambiguous'], ['missing', true, 'ambiguous'],
  ['completed', true, 'success'], ['missing', true, 'success'],
  ['normal-late', true, 'success'],
] as const)('整笔确认响应丢失后按原回执恢复：%s，另一个患者已选中=%s，结果=%s', async (receipt, otherSelected, outcome) => {
  sessionStorage.clear()
  const session: SessionContext = { actor: { actorId: 'cashier', epoch: `money-recovery-${receipt}-${otherSelected}-${outcome}`, locationId: 'cashier', organizationId: 'hospital',
    practitionerId: 'cashier', practitionerRoleId: 'cashier-role', roleCode: 'cashier', scenarioRunId: 'run', workspaceId: 'workspace' },
    availableRoles: [], user: { id: 'cashier', email: 'cashier@example.test', name: '合成收费员' } }
  const patient = { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' }
  const item = billingQueueSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{ accountId: 'account', amountFen: 800,
    caseId: 'case', category: 'laboratory', chargeItemId: 'lab', chargeVersion: 1, descriptionEn: 'Laboratory', descriptionZh: '合成检验', encounterId: 'encounter',
    lines: [{ descriptionEn: 'Laboratory', descriptionZh: '合成检验', quantity: 1, sourceReference: 'ServiceRequest/synthetic', subtotalFen: 800, unitPriceFen: 800 }], patient, status: 'billable' }] }).items[0]!
  const otherItem = { ...item, caseId: 'other-case', chargeItemId: 'other-charge', encounterId: 'other-encounter',
    patient: { ...patient, id: 'other-patient', name: '合成另一患者', identifier: 'SYN-OTHER' } }
  const charges = ['lab', 'lab2'].map(chargeItemId => ({ amountFen: 800, category: 'laboratory', chargeItemId, chargeVersion: 1,
    descriptionZh: `合成检验${chargeItemId}`, descriptionEn: 'Laboratory', paidFen: 0, insuranceFen: 0, remainingFen: 800, status: 'billable' }))
  const preview = { auditId: 'preview', effects: [], requestId: 'preview', warnings: [], data: { amountFen: 1600, caseId: 'case', patientId: 'patient', encounterId: 'encounter',
    charges: charges.map(charge => ({ ...charge, status: undefined, collectionAmountFen: 800 })), channel: 'synthetic-payment', commitToken: 'synthetic-token-multi',
    expectedOutcome: outcome, expiresAt: new Date(Date.now() + 300_000).toISOString(), previewId: 'preview', totalFen: 1600, paidFen: 0,
    insuranceFen: 0, remainingFen: 1600, tenders: [{ method: 'cash', amountFen: 1600 }] } }
  const confirmed = { auditId: 'confirm', effects: [], requestId: 'confirm', warnings: [], data: { kind: 'multi-charge', paymentId: 'payment', version: 1,
    caseId: 'case', patientId: 'patient', encounterId: 'encounter', amountFen: 1600, outcome, tenders: [{ method: 'cash', amountFen: 1600 }],
    allocations: charges.map(charge => ({ chargeItemId: charge.chargeItemId, amountFen: 800, chargeVersion: 2,
      remainingFen: outcome === 'success' ? 0 : 800, status: outcome === 'success' ? 'paid' : outcome })) } }
  const originalStorage = multiChargeDraftStorage(session, { caseId: 'case', patientId: 'patient', encounterId: 'encounter' })
  const otherStorage = multiChargeDraftStorage(session, { caseId: otherItem.caseId, patientId: otherItem.patient.id, encounterId: otherItem.encounterId })
  const otherActorStorage = multiChargeDraftStorage({ ...session, actor: { ...session.actor, practitionerRoleId: 'another-cashier-role' } },
    { caseId: 'case', patientId: 'patient', encounterId: 'encounter' })
  const originalDraft = { selectedChargeIds: ['lab', 'lab2', 'remaining-charge'], simulatorRule: 'success' as const,
    tenderAmounts: { cash: '20.00' }, filter: '原患者剩余私稿', page: 3 }
  const otherDraft = { selectedChargeIds: ['other-charge', 'other-second'], simulatorRule: 'decline' as const,
    tenderAmounts: { 'bank-card': '8.00' }, filter: '另一患者私稿', page: 2 }
  const sends: Array<{ key: string; body: unknown }> = []
  let releaseConfirm: (response: Response) => void = () => undefined
  const deferredConfirm = new Promise<Response>(resolve => { releaseConfirm = resolve })
  let otherBillRead = false
  let visible = true
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(session)
    if (url.pathname === '/api/his/v1/billing/queue') {
      const items = visible ? (receipt === 'normal-late' ? [item, otherItem] : [item]) : otherSelected ? [otherItem] : []
      return Response.json({ page: 1, pageSize: 20, total: items.length, items })
    }
    if (url.pathname === '/api/his/v1/billing/cases/other-case') {
      otherBillRead = true
      return Response.json({ ...otherItem, charges: [{ ...charges[0], chargeItemId: 'other-charge' }],
        payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, paidFen: 0, totalFen: 800, remainingFen: 800 })
    }
    if (url.pathname === '/api/his/v1/billing/cases/case') return Response.json({ accountId: 'account', caseId: 'case', encounterId: 'encounter', patient, charges,
      payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, paidFen: 0, totalFen: 1600, remainingFen: 1600 })
    if (url.pathname.endsWith('/preview-multi-charge')) return Response.json(preview)
    if (url.pathname.endsWith('/confirm-multi-charge')) {
      sends.push({ key: new Headers(options?.headers).get('idempotency-key')!, body: JSON.parse(String(options?.body)) })
      visible = false
      if (receipt === 'normal-late') return deferredConfirm
      if (sends.length === 1) throw new TypeError('synthetic lost confirmation')
      return Response.json(confirmed)
    }
    if (url.pathname === '/api/his/v1/command-receipts') {
      expect(url.searchParams.get('operationId')).toBe('payment.multi-charge.confirm')
      expect(url.searchParams.get('idempotencyKey')).toBe(sends[0]!.key)
      return receipt === 'missing' ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '原回执尚未创建' } }, { status: 404 })
        : Response.json({ status: 'completed', operationId: 'payment.multi-charge.confirm', idempotencyKey: sends[0]!.key, response: confirmed })
    }
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成次要资料暂不可读' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const user = userEvent.setup()
    const view = () => <QueryClientProvider client={client}><BillingWorkspace locale="zh-CN" session={session} /></QueryClientProvider>
    render(view())
    await user.click(await screen.findByRole('button', { name: '选择多项收费' }))
    const collectionDialog = within(screen.getByRole('dialog'))
    await user.click(collectionDialog.getByRole('button', { name: '全选本页可收费项目' }))
    await user.click(collectionDialog.getByRole('button', { name: '预览合并收费' }))
    await user.click(await collectionDialog.findByRole('button', { name: '确认合并收款' }))
    if (receipt === 'normal-late') {
      await waitFor(() => expect(sends).toHaveLength(1))
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } else {
      await within(screen.getByRole('dialog')).findByText('操作失败')
      cleanup(); client.clear()
    }
    if (outcome === 'success') {
      originalStorage.save(originalDraft)
      otherStorage.save(otherDraft)
      otherActorStorage.save(originalDraft)
    } else {
      for (const key of Object.keys(sessionStorage).filter(key => key.startsWith('clinmesh.multi-charge-draft:'))) sessionStorage.setItem(key, '{damaged-draft')
    }
    if (receipt === 'normal-late') {
      await user.click(screen.getByRole('listitem', { name: `${getWorkspaceMessages('zh-CN').selectCharge} 合成另一患者` }))
      await waitFor(() => expect(otherBillRead).toBe(true))
      await act(async () => { releaseConfirm(Response.json(confirmed)); await deferredConfirm })
    } else {
      render(view())
      if (otherSelected) await screen.findAllByText('合成另一患者')
      await user.click(await screen.findByRole('button', { name: '查询原合并收款操作' }))
    }
    if (otherSelected) {
      await waitFor(() => expect(screen.queryByRole('button', { name: '查询原合并收款操作' })).toBeNull())
      expect(screen.queryByText('合并收款结果待确认')).toBeNull()
      expect(screen.queryByText('合并收款成功')).toBeNull()
      expect(screen.getByRole('tab', { name: getWorkspaceMessages('zh-CN').pendingPayment }).getAttribute('aria-selected')).toBe('true')
      expect(screen.getAllByText('合成另一患者').length).toBeGreaterThan(0)
    } else await screen.findByText('合并收款结果待确认')
    expect(sends).toHaveLength(receipt === 'missing' ? 2 : 1)
    if (sends.length === 2) expect(sends[1]).toEqual(sends[0])
    if (outcome === 'success') {
      expect(originalStorage.load()).toEqual({ failed: false, draft: { ...originalDraft, selectedChargeIds: ['remaining-charge'], tenderAmounts: {} } })
      expect(otherStorage.load()).toEqual({ failed: false, draft: otherDraft })
      expect(otherActorStorage.load()).toEqual({ failed: false, draft: originalDraft })
      const selectCharges = screen.getByRole('button', { name: '选择多项收费' })
      await waitFor(() => expect(selectCharges.hasAttribute('disabled')).toBe(false))
      await user.click(selectCharges)
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByLabelText('筛选费用')).toHaveProperty('value', otherDraft.filter)
      expect(within(dialog).getByLabelText('合成银行卡')).toHaveProperty('value', '8.00')
      await user.keyboard('{Escape}')
    }
    await user.click(screen.getByRole('tab', { name: getWorkspaceMessages('zh-CN').pendingPayment }))
  } finally { client.clear(); sessionStorage.clear() }
})

it.each(['completed', 'missing'] as const)('共享资金门禁在刷新后仍允许原患者查询多项预览，回执%s保留原键', async receipt => {
  sessionStorage.clear()
  const session: SessionContext = {
    actor: { actorId: 'cashier', epoch: `multi-recovery-${receipt}`, locationId: 'cashier', organizationId: 'hospital',
      practitionerId: 'cashier', practitionerRoleId: 'cashier-role', roleCode: 'cashier', scenarioRunId: 'run', workspaceId: 'workspace' },
    availableRoles: [], user: { id: 'cashier', email: 'cashier@example.test', name: '合成收费员' },
  }
  const item = billingQueueSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{
    accountId: 'account', amountFen: 800, caseId: 'case', category: 'laboratory', chargeItemId: 'lab', chargeVersion: 1,
    descriptionEn: 'Laboratory', descriptionZh: '合成检验', encounterId: 'encounter',
    lines: [{ descriptionEn: 'Laboratory', descriptionZh: '合成检验', quantity: 1, sourceReference: 'ServiceRequest/synthetic', subtotalFen: 800, unitPriceFen: 800 }],
    patient: { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' }, status: 'billable',
  }] }).items[0]!
  const charges = [{ ...item, paidFen: 0, insuranceFen: 0, remainingFen: 800 },
    { ...item, chargeItemId: 'imaging', chargeVersion: 2, category: 'imaging', descriptionZh: '合成放射', descriptionEn: 'Imaging', amountFen: 8000, paidFen: 0, insuranceFen: 0, remainingFen: 8000 }]
  const response = { auditId: 'audit-preview', effects: [], requestId: 'request-preview', warnings: [], data: {
    amountFen: 8800, caseId: 'case', patientId: 'patient', encounterId: 'encounter',
    charges: charges.map(charge => ({ chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion, category: charge.category, descriptionZh: charge.descriptionZh, descriptionEn: charge.descriptionEn,
      amountFen: charge.amountFen, paidFen: 0, insuranceFen: 0, remainingFen: charge.remainingFen, collectionAmountFen: charge.remainingFen })),
    channel: 'synthetic-payment', commitToken: 'synthetic-token', expectedOutcome: 'success', expiresAt: new Date(Date.now() + 300_000).toISOString(), previewId: 'preview-multi',
    totalFen: 8800, paidFen: 0, insuranceFen: 0, remainingFen: 8800, tenders: [{ method: 'cash', amountFen: 8800 }],
  } }
  const requests: Array<{ key: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(session)
    if (url.pathname === '/api/his/v1/billing/queue') return Response.json({ page: 1, pageSize: 20, total: 1, items: [item] })
    if (url.pathname === '/api/his/v1/billing/cases/case') return Response.json({ ...item, charges, payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, paidFen: 0, totalFen: 8800, remainingFen: 8800 })
    if (url.pathname.endsWith('/preview-multi-charge')) {
      requests.push({ key: new Headers(options?.headers).get('idempotency-key') ?? '', body: JSON.parse(String(options?.body)) })
      if (requests.length === 1) throw new TypeError('synthetic lost response')
      return Response.json(response)
    }
    if (url.pathname === '/api/his/v1/command-receipts') {
      expect(url.searchParams.get('operationId')).toBe('payment.multi-charge.preview')
      expect(url.searchParams.get('idempotencyKey')).toBe(requests[0]!.key)
      return receipt === 'missing' ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '原回执尚未创建' } }, { status: 404 })
        : Response.json({ status: 'completed', operationId: 'payment.multi-charge.preview', idempotencyKey: requests[0]!.key, response })
    }
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成次要资料暂不可读' } }, { status: 503 })
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const user = userEvent.setup()
    const view = () => <QueryClientProvider client={client}><BillingWorkspace locale="zh-CN" session={session} /></QueryClientProvider>
    render(view())
    await user.click(await screen.findByRole('button', { name: '选择多项收费' }))
    await user.click(screen.getByRole('button', { name: '全选本页可收费项目' }))
    await user.click(screen.getByRole('button', { name: '预览合并收费' }))
    await screen.findByText('操作失败')
    cleanup()
    render(view())
    await user.click(await screen.findByRole('button', { name: '选择多项收费' }))
    const dialog = await screen.findByRole('dialog', { name: '选择多项收费' })
    expect(within(dialog).getByRole('button', { name: '预览合并收费' }).hasAttribute('disabled')).toBe(true)
    await user.click(within(dialog).getByRole('button', { name: '查询原预览结果' }))
    await within(dialog).findByRole('region', { name: '合并收费预览' })
    expect(requests).toHaveLength(receipt === 'completed' ? 1 : 2)
    if (requests.length === 2) expect(requests[1]).toEqual(requests[0])
  } finally { client.clear(); sessionStorage.clear() }
})

it('多项私稿恢复选择和方式，清空选择与确认丢弃分开', async () => {
  sessionStorage.clear()
  const session: SessionContext = {
    actor: { actorId: 'cashier', epoch: 'billing-multi-draft', locationId: 'cashier', organizationId: 'hospital',
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
    const user = userEvent.setup()
    const view = () => <QueryClientProvider client={client}><BillingWorkspace locale="zh-CN" session={session} /></QueryClientProvider>
    render(view())
    await user.click(await screen.findByRole('button', { name: '选择多项收费' }))
    const dialog = await screen.findByRole('dialog', { name: '选择多项收费' })
    await user.click(within(dialog).getByRole('checkbox', { name: '选择收费：合成检验' }))
    await user.type(within(dialog).getByLabelText('合成现金'), '68.00')
    await user.click(within(dialog).getByRole('button', { name: '清空选择' }))
    expect((within(dialog).getByLabelText('合成现金') as HTMLInputElement).value).toBe('68.00')
    expect(within(dialog).getByRole('button', { name: '预览合并收费' }).hasAttribute('disabled')).toBe(true)
    await user.click(within(dialog).getByRole('checkbox', { name: '选择收费：合成检验' }))
    cleanup()
    render(view())
    await user.click(await screen.findByRole('button', { name: '选择多项收费' }))
    const restored = await screen.findByRole('dialog', { name: '选择多项收费' })
    expect(within(restored).getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('true')
    expect((within(restored).getByLabelText('合成现金') as HTMLInputElement).value).toBe('68.00')
    await user.click(within(restored).getByRole('button', { name: '丢弃草稿' }))
    expect(within(restored).getByRole('checkbox', { name: '选择收费：合成检验' }).getAttribute('aria-checked')).toBe('true')
    await user.click(within(restored).getByRole('button', { name: '确认丢弃草稿' }))
    expect((within(restored).getByLabelText('合成现金') as HTMLInputElement).value).toBe('')
  } finally { client.clear(); sessionStorage.clear() }
})

it('displays medication lines only from a successful current queue and removes cached lines after a failed refresh', async () => {
  const session: SessionContext = {
    actor: { actorId: 'cashier', epoch: 'billing-medication-lines', locationId: 'cashier', organizationId: 'hospital',
      practitionerId: 'cashier', practitionerRoleId: 'cashier-role', roleCode: 'cashier', scenarioRunId: 'run', workspaceId: 'workspace' },
    availableRoles: [], user: { id: 'cashier', email: 'cashier@example.test', name: '合成收费员' },
  }
  const item = billingQueueSchema.parse({ page: 1, pageSize: 20, total: 1, items: [{
    accountId: 'account', amountFen: 1500, caseId: 'case', category: 'medication', chargeItemId: 'charge', chargeVersion: 1,
    descriptionEn: 'Outpatient medication', descriptionZh: '门诊药品', encounterId: 'encounter',
    lines: [{ descriptionEn: 'Synthetic medication', descriptionZh: '待核对合成药品', quantity: 3, sourceReference: 'MedicationRequest/synthetic', subtotalFen: 1500, unitPriceFen: 500 }],
    patient: { id: 'patient', identifier: 'SYN-BILL', name: '合成收费患者', synthetic: true, versionId: '1' }, status: 'billable',
  }] }).items[0]!
  let queueAvailable = true
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/billing/queue') {
      if (!queueAvailable) return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成收费队列暂不可读' } }, { status: 503 })
      return Response.json({ page: 1, pageSize: 20, total: url.searchParams.get('category') === 'medication' ? 1 : 0,
        items: url.searchParams.get('category') === 'medication' ? [item] : [] })
    }
    if (url.pathname === '/api/his/v1/billing/cases/case') return Response.json({ ...item, charges: [{ ...item, paidFen: 0, remainingFen: 1500 }],
      payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 0 }, paidFen: 0, totalFen: 1500, remainingFen: 1500 })
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成次要资料暂不可读' } }, { status: 503 })
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    render(<QueryClientProvider client={client}><BillingWorkspace locale="zh-CN" session={session} /></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: '费用类别' }))
    await user.click(await screen.findByRole('option', { name: '药品费用' }))
    await screen.findByText('待核对合成药品', { exact: true })
    queueAvailable = false
    await user.click(screen.getByRole('button', { name: '刷新账单' }))
    await screen.findByText('尚未取得该项药品明细。')
    expect(screen.queryByText('待核对合成药品', { exact: true })).toBeNull()
    expect(screen.getByRole('row', { name: '合计 ¥15.00 ¥0.00 ¥15.00' })).toBeTruthy()
  } finally { client.clear() }
})

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
