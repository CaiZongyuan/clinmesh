// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { modelUsageControlUpdateSchema } from '@clinmesh/contracts/model-usage'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelUsageWorkspace } from './model-usage-workspace.tsx'
import { usageAttempt, usageControl, usageOverview, usageSession } from './model-usage.test-fixture.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup(total = 1, mode: 'normal' | 'empty' | 'error' | 'deny-detail' | 'conflict' = 'normal', administrator = false) {
  const requests: URL[] = []
  const writes: RequestInit[] = []
  let control = structuredClone(usageControl)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if (mode === 'error' || (mode === 'deny-detail' && url.pathname.includes(usageAttempt.id))) {
      return Response.json({ error: { code: 'ROLE_NOT_ALLOWED', message: 'Synthetic denied read' } }, { status: 403 })
    }
    if (url.pathname === '/api/model-usage/overview') return Response.json(usageOverview)
    if (url.pathname === '/api/model-usage/control') {
      if (init?.method === 'PUT') {
        writes.push(init)
        if (mode === 'conflict') return Response.json({ error: { code: 'VERSION_CONFLICT', message: 'Synthetic conflict' } }, { status: 409 })
        const { expectedVersion, ...policy } = modelUsageControlUpdateSchema.parse(JSON.parse(String(init.body)))
        control = { ...control, workspace: { ...control.workspace, ...policy, version: expectedVersion + 1,
          remaining: policy.requests }, effective: { enabled: policy.enabled, automaticRetries: false } }
      }
      return Response.json(control)
    }
    if (url.pathname === '/api/model-usage/requests') return Response.json({ items: mode === 'empty' ? [] : [usageAttempt], total: mode === 'empty' ? 0 : total })
    if (url.pathname === `/api/model-usage/requests/${usageAttempt.id}`) return Response.json(usageAttempt)
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
  expect(writes).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('请求次数上限'), { target: { value: '0' } })
  await user.click(screen.getByRole('checkbox', { name: '启用模型生成' }))
  await user.click(screen.getByRole('checkbox', { name: '允许自动重试' }))
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  expect(await screen.findByText('工作区策略已保存')).toBeTruthy()
  expect(JSON.parse(String(writes[0]?.body))).toEqual({ expectedVersion: 1, enabled: false, requests: 0, automaticRetries: false })
  expect(new Headers(writes[0]?.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  expect(within(screen.getByRole('region', { name: '部署控制（只读）' })).getByText('6')).toBeTruthy()
  await user.click(screen.getByRole('checkbox', { name: '请求次数无限' }))
  await user.click(screen.getByRole('button', { name: '保存工作区策略' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(JSON.parse(String(writes[1]?.body))).toEqual({ expectedVersion: 2, enabled: false, requests: null, automaticRetries: false })
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
  expect(within(workspace).getAllByText('无限')).toHaveLength(4)
  expect(within(workspace).queryByRole('button', { name: '保存工作区策略' })).toBeNull()
  expect(screen.getByText('仅管理员可修改工作区控制。')).toBeTruthy()
  const deployment = screen.getByRole('region', { name: '部署控制（只读）' })
  expect(within(deployment).getByText('6')).toBeTruthy()
  expect(screen.getByText('部署已关闭自动重试')).toBeTruthy()
  expect(screen.getByRole('region', { name: '待办与恢复' }).textContent).toContain('2')
  await user.click(screen.getByRole('tab', { name: '计价说明' }))
  expect(screen.getByText(/未知金额不表示免费/)).toBeTruthy()
})
