// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { modelUsageControlUpdateSchema } from '@clinmesh/contracts/model-usage'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelUsageWorkspace } from './model-usage-workspace.tsx'
import { usageAttempt, usageControl, usageOverview, usagePricing, usageSession } from './model-usage.test-fixture.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup(total = 1, mode: 'normal' | 'empty' | 'error' | 'deny-detail' | 'conflict' | 'known-usage' = 'normal', administrator = false) {
  const requests: URL[] = []
  const writes: RequestInit[] = []
  let control = structuredClone(usageControl)
  let attempt = structuredClone(usageAttempt)
  if (mode === 'known-usage') attempt.usage.totalTokens = 150
  if (!administrator) control.deployment = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if (mode === 'error' || (mode === 'deny-detail' && url.pathname.includes(usageAttempt.id))) {
      return Response.json({ error: { code: 'ROLE_NOT_ALLOWED', message: 'Synthetic denied read' } }, { status: 403 })
    }
    if (url.pathname === '/api/model-usage/overview') return Response.json(usageOverview)
    if (url.pathname === '/api/model-usage/pricing') return Response.json(usagePricing)
    if (url.pathname === '/api/model-usage/control') {
      if (init?.method === 'PUT') {
        writes.push(init)
        if (mode === 'conflict') return Response.json({ error: { code: 'VERSION_CONFLICT', message: 'Synthetic conflict' } }, { status: 409 })
        const { expectedVersion, ...policy } = modelUsageControlUpdateSchema.parse(JSON.parse(String(init.body)))
        control = { ...control, workspace: { ...control.workspace, ...policy, tokens: policy.tokens ?? null, cny: policy.cny ?? null, version: expectedVersion + 1,
          remaining: policy.requests }, effective: { enabled: policy.enabled, automaticRetries: false } }
      }
      return Response.json(control)
    }
    if (url.pathname.endsWith('/reconcile') || url.pathname.endsWith('/reprice')) {
      writes.push(init!)
      if (mode === 'conflict') return Response.json({ error: { code: 'VERSION_CONFLICT', message: 'Synthetic conflict' } }, { status: 409 })
      const body = JSON.parse(String(init?.body))
      const cost = url.pathname.endsWith('/reprice') ? { status: 'priced' as const, currency: 'USD', original: 0.00042, cny: 0.00294, originalMicro: 420, cnyMicro: 2940 } : null
      const snapshot = cost === null ? null : { provider: usagePricing.prices[0].provider, model: usagePricing.prices[0].model,
        price: { version: 'prices-v2', currency: 'USD', rates: usagePricing.prices[0].rates }, exchangeRate: { version: 'fx-v2', cnyPerUnit: 7 } }
      attempt = { ...attempt, accounting: { totalTokens: body.totalTokens ?? attempt.accounting?.totalTokens ?? attempt.usage.totalTokens,
        cny: body.cny ?? cost?.cny ?? attempt.accounting?.cny ?? null }, ...(cost === null ? {} : { effectiveCost: cost }),
        corrections: [...attempt.corrections, { revision: body.expectedRevision + 1, at: '2026-10-21T01:00:00.000Z', actorId: 'synthetic-admin',
          evidence: body.evidence, kind: cost === null ? 'reconcile' : 'reprice', totalTokens: body.totalTokens ?? null,
          cny: body.cny ?? cost?.cny ?? null, cost, priceSnapshot: snapshot }] }
      return Response.json(attempt)
    }
    if (url.pathname === '/api/model-usage/requests') return Response.json({ items: mode === 'empty' ? [] : [attempt], total: mode === 'empty' ? 0 : total })
    if (url.pathname === `/api/model-usage/requests/${usageAttempt.id}`) return Response.json(attempt)
    throw new Error(`Unexpected URL: ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const session = administrator ? { ...usageSession, actor: { ...usageSession.actor, roleCode: 'administrator' as const } } : usageSession
  render(<QueryClientProvider client={client}><ModelUsageWorkspace locale="zh-CN" session={session} /></QueryClientProvider>)
  return { requests, writes, user: userEvent.setup() }
}

it('shows known usage separately from unknown values and reads historical request detail', async () => {
  const { requests, user } = setup()
  const total = await screen.findByRole('region', { name: '已派发请求' })
  expect(total.textContent).toContain('3')
  expect(screen.getByRole('region', { name: '已知 Token' }).textContent).toContain('120')
  expect(screen.getByRole('region', { name: '人民币费用' }).textContent).toContain('未知')
  expect(screen.getByText(/已预占 Token: 200 \+ 1 次未决占用无可信上界/)).toBeTruthy()
  expect(screen.getByText(/已预占人民币: 0.12 \+ 1 次未决占用无可信上界/)).toBeTruthy()
  expect(screen.getByText(/已覆盖 Server 直接模型调用、经 DSH bridge 发起的调用及 Host 独立医生代问识别/)).toBeTruthy()
  expect(screen.getByText(/其他 DSH 原生会话及插件发起的调用不在覆盖范围/)).toBeTruthy()
  await user.click(await screen.findByRole('button', { name: '查看请求详情' }))
  const detail = await screen.findByRole('region', { name: '请求详情' })
  expect(document.activeElement).toBe(detail)
  expect(within(detail).getByText('已派发')).toBeTruthy()
  expect(within(detail).getByText('服务商原始 Token 计数')).toBeTruthy()
  expect(within(detail).getByText('缓存读取 Token')).toBeTruthy()
  expect(within(detail).getByText('缓存写入 Token')).toBeTruthy()
  expect(within(detail).getByText('historical-actual-model')).toBeTruthy()
  expect(within(detail).getByText('verification-2')).toBeTruthy()
  expect(within(detail).getByText('task-synthetic')).toBeTruthy()
  expect(within(detail).getByText('turn-a')).toBeTruthy()
  expect(within(detail).getByText('source-b')).toBeTruthy()
  expect(within(detail).getByText('document-c')).toBeTruthy()
  expect(requests.some(url => url.pathname === `/api/model-usage/requests/${usageAttempt.id}`)).toBe(true)
  await user.click(within(detail).getByRole('button', { name: '收起详情' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '查看请求详情' }))
})

it('lets administrators persist a zero request quota and switch back to unlimited without changing deployment policy', async () => {
  const { writes, user } = setup(1, 'normal', true)
  await user.click(screen.getByRole('tab', { name: '额度与策略' }))
  await user.click(await screen.findByRole('checkbox', { name: '请求次数无限' }))
  fireEvent.change(screen.getByLabelText('请求次数上限'), { target: { value: '-1' } })
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  expect(screen.getByRole('alert').textContent).toContain('请求次数必须是非负整数，或选择无限')
  const limit = screen.getByLabelText('请求次数上限')
  expect(limit.getAttribute('aria-invalid')).toBe('true')
  const errorId = screen.getByRole('alert').id
  expect(errorId).not.toBe('')
  expect(limit.getAttribute('aria-describedby')?.split(' ')).toContain(errorId)
  expect(limit.closest('[data-invalid]')?.contains(screen.getByRole('alert'))).toBe(true)
  expect(writes).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('请求次数上限'), { target: { value: '0' } })
  await user.click(screen.getByRole('checkbox', { name: '启用模型生成' }))
  await user.click(screen.getByRole('checkbox', { name: '允许自动重试' }))
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  expect(await screen.findByText('工作区策略已保存')).toBeTruthy()
  expect(JSON.parse(String(writes[0]?.body))).toEqual({ expectedVersion: 1, enabled: false, requests: 0, tokens: null, cny: null, automaticRetries: false })
  expect(new Headers(writes[0]?.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  expect(within(screen.getByRole('region', { name: '部署控制（只读）' })).getByText('6')).toBeTruthy()
  await user.click(screen.getByRole('checkbox', { name: '请求次数无限' }))
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(JSON.parse(String(writes[1]?.body))).toEqual({ expectedVersion: 2, enabled: false, requests: null, tokens: null, cny: null, automaticRetries: false })
})

it('saves independent Token and CNY limits and keeps explicit zero distinct from unlimited', async () => {
  const { writes, user } = setup(1, 'normal', true)
  await user.click(screen.getByRole('tab', { name: '额度与策略' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Token 无限' }))
  await user.click(screen.getByRole('checkbox', { name: '人民币费用无限' }))
  fireEvent.change(screen.getByLabelText('Token 上限'), { target: { value: '5000' } })
  fireEvent.change(screen.getByLabelText('人民币费用上限'), { target: { value: '0' } })
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  await screen.findByText('工作区策略已保存')
  expect(JSON.parse(String(writes[0]?.body))).toMatchObject({ requests: null, tokens: 5000, cny: 0 })
  expect(screen.getByText(/缺少可信 Token 上界/)).toBeTruthy()
  const deployment = screen.getByRole('region', { name: '部署控制（只读）' })
  expect(deployment.textContent).toContain('1 次未决占用无可信上界')
  expect(within(deployment).getAllByText('未知')).toHaveLength(2)
  await user.click(screen.getByRole('checkbox', { name: 'Token 无限' }))
  await user.click(screen.getByRole('checkbox', { name: '人民币费用无限' }))
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(JSON.parse(String(writes[1]?.body))).toMatchObject({ tokens: null, cny: null })
})

it('reconciles unknown dimensions separately with evidence and preserves original provider usage', async () => {
  const { user, writes } = setup(1, 'normal', true)
  await user.click(await screen.findByRole('button', { name: '查看请求详情' }))
  await user.click(screen.getByRole('button', { name: '核对待确认用量' }))
  const dialog = screen.getByRole('dialog', { name: '核对待确认用量' })
  await user.type(within(dialog).getByLabelText('依据引用'), 'bill:synthetic-1')
  await user.type(within(dialog).getByLabelText('总 Token'), '150')
  await user.click(within(dialog).getByRole('button', { name: '确认核对' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(String(writes[0]?.body))).toEqual({ expectedRevision: 0, evidence: 'bill:synthetic-1', totalTokens: 150 })
  expect(new Headers(writes[0]?.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  await user.click(screen.getByRole('button', { name: '核对待确认用量' }))
  const second = screen.getByRole('dialog', { name: '核对待确认用量' })
  expect(within(second).queryByLabelText('总 Token')).toBeNull()
  await user.type(within(second).getByLabelText('依据引用'), 'bill:synthetic-2')
  await user.type(within(second).getByLabelText('人民币费用'), '0')
  await user.click(within(second).getByRole('button', { name: '确认核对' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(String(writes[1]?.body))).toEqual({ expectedRevision: 1, evidence: 'bill:synthetic-2', cny: 0 })
  const detail = screen.getByRole('region', { name: '请求详情' })
  expect(within(detail).getByText('bill:synthetic-1')).toBeTruthy()
  expect(within(detail).getByText('bill:synthetic-2')).toBeTruthy()
  expect(within(detail).queryByRole('button', { name: '核对待确认用量' })).toBeNull()
  expect(within(detail).getByText('服务商原始 Token 计数').parentElement?.textContent).toContain('未知')
})

it('shows a read-only versioned price table and explicitly reprices a retained request', async () => {
  const { user, writes } = setup(1, 'known-usage', true)
  await user.click(await screen.findByRole('button', { name: '查看请求详情' }))
  await user.click(screen.getByRole('button', { name: '按当前价表补算' }))
  const dialog = screen.getByRole('dialog', { name: '按当前价表补算' })
  await user.type(within(dialog).getByLabelText('依据引用'), 'ticket:reprice-1')
  await user.click(within(dialog).getByRole('button', { name: '确认补算' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(String(writes[0]?.body))).toEqual({ expectedRevision: 0, evidence: 'ticket:reprice-1' })
  const detail = screen.getByRole('region', { name: '请求详情' })
  expect(within(detail).getByText('0.00042')).toBeTruthy()
  expect(within(detail).getByText('prices-v2')).toBeTruthy()
  expect(within(detail).getByText('fx-v2')).toBeTruthy()
  await user.click(screen.getByRole('tab', { name: '计价说明' }))
  expect(await screen.findByText('prices-v2')).toBeTruthy()
  expect(screen.getByText('fx-v2')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('keeps correction evidence after a revision conflict and never automatically repeats the write', async () => {
  const { user, writes } = setup(1, 'conflict', true)
  await user.click(await screen.findByRole('button', { name: '查看请求详情' }))
  await user.click(screen.getByRole('button', { name: '核对待确认用量' }))
  const dialog = screen.getByRole('dialog', { name: '核对待确认用量' })
  await user.click(within(dialog).getByRole('button', { name: '确认核对' }))
  expect(within(dialog).getByRole('alert').textContent).toContain('请填写有效依据引用')
  expect(writes).toHaveLength(0)
  await user.type(within(dialog).getByLabelText('依据引用'), 'bill:conflict')
  await user.type(within(dialog).getByLabelText('总 Token'), '150')
  await user.click(within(dialog).getByRole('button', { name: '确认核对' }))
  expect(await within(dialog).findByText('记录已被其他管理员修订，请刷新后核对。')).toBeTruthy()
  expect((within(dialog).getByLabelText('依据引用') as HTMLInputElement).value).toBe('bill:conflict')
  expect(writes).toHaveLength(1)
})

it('keeps the administrator draft and reports a version conflict without claiming the policy was saved', async () => {
  const { writes, user } = setup(1, 'conflict', true)
  await user.click(screen.getByRole('tab', { name: '额度与策略' }))
  await user.click(await screen.findByRole('checkbox', { name: '请求次数无限' }))
  fireEvent.change(screen.getByLabelText('请求次数上限'), { target: { value: '5' } })
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  expect(await screen.findByText('策略已被其他管理员修改，请刷新用量后重新编辑。')).toBeTruthy()
  expect(screen.queryByText('工作区策略已保存')).toBeNull()
  expect((screen.getByLabelText('请求次数上限') as HTMLInputElement).value).toBe('5')
  expect(writes).toHaveLength(1)
})

it('clears unapplied filters and blocks invalid date ranges before reading', async () => {
  const { requests, user } = setup()
  await screen.findByRole('region', { name: '已派发请求' })
  await user.click(screen.getByText('筛选用量'))
  await user.type(screen.getByLabelText('病例 ID'), 'not-yet-applied')
  await user.click(screen.getByRole('button', { name: '重置' }))
  expect((screen.getByLabelText('病例 ID') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-10-21' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-10-20' } })
  const before = requests.length
  await user.click(screen.getByRole('button', { name: '应用筛选' }))
  expect(screen.getByRole('alert').textContent).toContain('开始日期不能晚于结束日期')
  expect(requests).toHaveLength(before)
})

it('shows an empty state and read failures without inventing totals or unauthorized detail', async () => {
  const { user } = setup(1, 'deny-detail')
  await user.click(await screen.findByRole('button', { name: '查看请求详情' }))
  expect(await screen.findByText('请求详情读取失败或已无权访问')).toBeTruthy()
  expect(screen.queryByText('turn-a')).toBeNull()
  cleanup()
  setup(0, 'empty')
  expect(await screen.findByText('暂无模型调用')).toBeTruthy()
  cleanup()
  setup(0, 'error')
  expect((await screen.findAllByText('模型用量读取失败')).length).toBeGreaterThan(0)
  expect(screen.queryByRole('region', { name: '已派发请求' })).toBeNull()
})

it('applies filters to real overview and request queries, paginates, and keeps policy read-only', async () => {
  const { requests, user } = setup(51)
  await screen.findByRole('region', { name: '已派发请求' })
  await user.click(screen.getByText('筛选用量'))
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-10-19' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-10-20' } })
  await user.type(screen.getByLabelText('Provider'), 'synthetic-provider')
  await user.type(screen.getByLabelText('模型', { exact: true }), 'historical-actual-model')
  await user.type(screen.getByLabelText('病例 ID'), 'case-synthetic')
  await user.click(screen.getByRole('combobox', { name: '功能' }))
  await user.click(await screen.findByRole('option', { name: '诊疗建议核验' }))
  await user.click(screen.getByRole('combobox', { name: '结果' }))
  await user.click(await screen.findByRole('option', { name: '结果未知' }))
  await user.click(screen.getByRole('button', { name: '应用筛选' }))
  await waitFor(() => expect(requests.filter(url => url.searchParams.get('caseId') === 'case-synthetic')).toHaveLength(2))
  const parameters = Object.fromEntries(requests.at(-1)!.searchParams)
  expect(parameters).toMatchObject({ from: '2026-10-19', to: '2026-10-20', provider: 'synthetic-provider',
    model: 'historical-actual-model', caseId: 'case-synthetic', status: 'unknown', feature: 'doctor_recommendation_verification' })
  await user.click(screen.getByRole('tab', { name: '请求明细' }))
  await screen.findByRole('button', { name: '查看请求详情' })
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/requests') && url.searchParams.get('offset') === '25')).toBe(true))
  await user.click(screen.getByRole('tab', { name: '用量总览' }))
  await waitFor(() => expect(requests.at(-1)?.searchParams.get('offset')).toBe('0'))
  expect(requests.at(-1)?.searchParams.get('limit')).toBe('5')
  await user.click(screen.getByRole('tab', { name: '额度与策略' }))
  const workspace = await screen.findByRole('region', { name: '工作区控制' })
  expect(within(workspace).getAllByText('无限')).toHaveLength(6)
  expect(within(workspace).queryByRole('button', { name: '保存工作区策略' })).toBeNull()
  expect(screen.getByText('仅管理员可修改工作区控制。')).toBeTruthy()
  expect(screen.queryByRole('region', { name: '部署控制（只读）' })).toBeNull()
  expect(screen.getByText('部署已关闭自动重试')).toBeTruthy()
  expect(screen.getByRole('region', { name: '待办与恢复' }).textContent).toContain('2')
  await user.click(screen.getByRole('tab', { name: '计价说明' }))
  expect(screen.getByText(/未知金额不表示免费/)).toBeTruthy()
})
