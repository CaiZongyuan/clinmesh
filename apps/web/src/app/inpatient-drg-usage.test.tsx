// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { ModelUsageAttempt } from '@clinmesh/contracts/model-usage'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgFollowupPanel } from './inpatient-drg-followup.tsx'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { usageAttempt, usageOverview, usageSession } from './model-usage.test-fixture.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
const session: SessionContext = { ...usageSession, actor: { ...usageSession.actor, roleCode: 'inpatient-doctor' } }
const admission: InpatientAdmission = { id: 'admission-one', patientId: 'patient-one', patientName: '合成用量患者', inpatientNumber: 'ZY-1',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', bedId: 'bed-1', status: 'admitted',
  financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-10-27T09:00:00+08:00', admittedAt: '2026-10-27T09:10:00+08:00',
  depositFen: 100000, chargesFen: 0, versionId: '2' }
const task = { id: 'followup-one', admissionId: admission.id, status: 'active', version: 1,
  startedAt: '2026-10-27T01:00:00Z', updatedAt: '2026-10-27T01:00:00Z', reason: null, ruleStatus: 'pending',
  fingerprint: null, simulation: null, errorCode: null, exceptionAlert: 'unknown', modelRequests: 0 }

function Harness({ currentAdmission = admission, currentSession = session }: { currentAdmission?: InpatientAdmission; currentSession?: SessionContext }) {
  const write = useInpatientWriteIntent(currentSession, () => undefined)
  return <InpatientDrgFollowupPanel admission={currentAdmission} session={currentSession} locale="zh-CN" write={write} active />
}

it('病例用量摘要与展开明细保持任务筛选，未知消费不显示为零或累加缓存分项', async () => {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if (url.pathname.endsWith('/drg/followup')) return Response.json({ admissionId: admission.id, encounterVersion: '2', task })
    if (url.pathname === '/api/model-usage/overview') return Response.json({ ...usageOverview,
      stages: [{ stage: 'preoperative-generation', requests: 3, inFlight: 1, unknownRequests: 1, knownTokens: 120,
        knownInputTokens: 120, knownOutputTokens: 0, unknownInputTokenRequests: 1, unknownOutputTokenRequests: 2,
        unknownTokenRequests: 2, unpricedRequests: 3, cny: null }] })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.pathname === '/api/model-usage/requests') return Response.json({ total: 1, items: [{ ...usageAttempt,
      feature: 'inpatient_drg_recommendation', context: { ...usageAttempt.context, taskId: task.id, caseId: admission.id,
        encounterId: admission.id, stage: 'preoperative-generation', sources: [
          { kind: 'document', id: 'InpatientPciSelection/selection-one/version/2', relationship: 'trigger' },
          { kind: 'document', id: 'InpatientSurgeryMaterial/use-one', relationship: 'trigger' },
          { kind: 'document', id: 'DrgBasis/changed-basis', relationship: 'trigger' },
        ] } }] })
    throw new Error(`Unexpected URL ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  const panel = await screen.findByRole('region', { name: "本次住院AI用量" })
  expect((await within(panel).findByLabelText("实际AI请求数")).textContent).toBe('3')
  expect(within(panel).getByLabelText('已知输入 Token').textContent).toBe('120')
  expect(within(panel).getByLabelText('已知输出 Token').textContent).toBe('未知')
  expect(within(panel).getByLabelText('已知总 Token').textContent).toBe('120')
  expect(within(panel).getByLabelText('估算人民币费用').textContent).toBe('未知')
  expect(panel.textContent).toContain("尚无术中AI调用")
  expect(panel.textContent).toContain("尚无术后AI调用")
  await userEvent.setup().click(within(panel).getByRole('button', { name: "展开AI请求明细" }))
  const table = await within(panel).findByRole('table', { name: "本次住院AI请求明细" })
  expect(table.textContent).toContain('术前生成')
  expect(table.textContent).toContain('自动')
  expect(table.textContent).toContain('选型参数更新')
  expect(table.textContent).toContain('实际耗材使用更新')
  expect(table.textContent).toContain('分组或费用依据更新')
  expect(table.textContent).toContain('InpatientPciSelection/selection-one/version/2')
  expect(table.textContent).toContain('historical-actual-model')
  expect(table.textContent).toContain('格式纠错')
  expect(table.textContent).toContain('未配置价格')
  expect(within(table).queryByRole('button', { name: '查看计量核对' })).toBeNull()
  expect(panel.textContent).toContain('90 天')
  for (const url of requests.filter(item => item.pathname === '/api/model-usage/overview' || item.pathname === '/api/model-usage/requests')) {
    expect(url.searchParams.get('taskId')).toBe(task.id)
    expect(url.searchParams.get('caseId')).toBe(admission.id)
  }
})

it('具有管理员资格的当前病例岗位可在任务明细中核对未知消费，提交不携带客户端权限声明', async () => {
  const qualified: SessionContext = { ...session, availableRoles: [...session.availableRoles, {
    code: 'administrator', id: 'role-administrator', practitionerId: 'administrator', practitionerName: '合成管理员',
    organizationId: 'hospital', locationId: 'management',
  }] }
  let item: ModelUsageAttempt = { ...usageAttempt, feature: 'inpatient_drg_recommendation',
    context: { ...usageAttempt.context, taskId: task.id, caseId: admission.id, encounterId: admission.id, stage: 'preoperative-generation' } }
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/drg/followup')) return Response.json({ admissionId: admission.id, encounterVersion: '2', task })
    if (url.pathname === '/api/model-usage/overview') return Response.json(usageOverview)
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.pathname === '/api/model-usage/requests') return Response.json({ items: [item], total: 1 })
    if (url.pathname.endsWith(`/${item.id}/reconcile`)) {
      writes.push(JSON.parse(String(init?.body)))
      item = { ...item, accounting: { totalTokens: 150, cny: 0.3 }, effectiveCost: { ...item.cost, status: 'priced', cny: 0.3, cnyMicro: 300000 },
        corrections: [{ revision: 1, at: '2026-10-27T03:00:00Z', actorId: 'synthetic-admin', evidence: 'synthetic-correction',
          kind: 'reconcile', totalTokens: 150, cny: 0.3, priceSnapshot: null, cost: null }] }
      return Response.json(item)
    }
    throw new Error(`Unexpected URL ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><Harness currentSession={qualified} /></QueryClientProvider>)
  const panel = await screen.findByRole('region', { name: "本次住院AI用量" })
  const user = userEvent.setup()
  await user.click(await within(panel).findByRole('button', { name: "展开AI请求明细" }))
  await user.click(await within(panel).findByRole('button', { name: '查看计量核对' }))
  await user.click(within(panel).getByRole('button', { name: '核对待确认用量' }))
  const dialog = screen.getByRole('dialog', { name: '核对待确认用量' })
  await user.type(within(dialog).getByLabelText('依据引用'), 'synthetic-correction')
  await user.type(within(dialog).getByLabelText('总 Token'), '150')
  await user.type(within(dialog).getByLabelText('人民币费用'), '0.3')
  await user.click(within(dialog).getByRole('button', { name: '确认核对' }))
  await waitFor(() => expect(writes).toEqual([{ expectedRevision: 0, evidence: 'synthetic-correction', totalTokens: 150, cny: 0.3 }]))
})

it('切换病例时迟到的旧任务用量不显示在新病例，也不把规则等待伪装成模型消费', async () => {
  let releaseOld!: (response: Response) => void
  const oldResponse = new Promise<Response>(resolve => { releaseOld = resolve })
  let oldRequested = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/drg/followup')) {
      const current = url.pathname.includes('admission-two') ? 'admission-two' : admission.id
      return Response.json({ admissionId: current, encounterVersion: '2', task: { ...task,
        id: current === admission.id ? task.id : 'followup-two', admissionId: current } })
    }
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.searchParams.get('caseId') === admission.id) { oldRequested = true; return oldResponse }
    return Response.json({ ...usageOverview, totals: { requests: 0, inFlight: 0, unknownRequests: 0, knownTokens: 0,
      knownInputTokens: 0, knownOutputTokens: 0, unknownInputTokenRequests: 0, unknownOutputTokenRequests: 0,
      unknownTokenRequests: 0, unpricedRequests: 0, cny: null }, trend: [], features: [], stages: [] })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  await waitFor(() => expect(oldRequested).toBe(true))
  view.rerender(<QueryClientProvider client={client}><Harness currentAdmission={{ ...admission, id: 'admission-two', patientName: '另一合成患者' }} /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByLabelText("实际AI请求数").textContent).toBe('0'))
  await act(async () => { releaseOld(Response.json({ ...usageOverview, totals: { ...usageOverview.totals, requests: 99 } })) })
  expect(screen.getByLabelText("实际AI请求数").textContent).toBe('0')
  expect(screen.getByText("本次跟进尚无AI请求")).toBeDefined()
  expect(screen.queryByText(/节省.*Token/)).toBeNull()
})

it('用量读取失权时显示病例权限错误，不显示零消费或旧汇总', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/drg/followup')) return Response.json({ admissionId: admission.id, encounterVersion: '2', task })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: null, version: 1, compactedRequests: 0, lastCompactedAt: null })
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Synthetic denied case access' } }, { status: 404 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  await screen.findByText("当前岗位无权读取本次住院AI用量，或该病例已不可访问。")
  expect(screen.queryByLabelText("实际AI请求数")).toBeNull()
  expect(screen.queryByText("本次跟进尚无AI请求")).toBeNull()
})

it('明确配置的零费用保留零金额，与未计价的未知费用区别显示', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/drg/followup')) return Response.json({ admissionId: admission.id, encounterVersion: '2', task })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    return Response.json({ ...usageOverview, totals: { ...usageOverview.totals, cny: 0, unpricedRequests: 0 } })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByLabelText('估算人民币费用').textContent).toBe('¥0.00'))
})

it('手术预计复用任务用量筛选并显示轮次及计划来源，不展示持续跟进阶段', async () => {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if (url.pathname === '/api/model-usage/overview') return Response.json({ ...usageOverview, stages: [] })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.pathname === '/api/model-usage/requests') return Response.json({ total: 1, items: [{ ...usageAttempt,
      context: { ...usageAttempt.context, taskId: 'estimate-one', caseId: admission.id, encounterId: admission.id,
        stage: 'estimate-2-verification', sources: [{ kind: 'document', id: 'ServiceRequest/plan-one', relationship: 'trigger' }] } }] })
    throw new Error(`Unexpected URL ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><InpatientDrgUsagePanel admissionId={admission.id} taskId="estimate-one"
    session={session} locale="zh-CN" active taskKind="estimate" /></QueryClientProvider>)
  const panel = await screen.findByRole('region', { name: "本次住院AI用量" })
  await userEvent.setup().click(await within(panel).findByRole('button', { name: "展开AI请求明细" }))
  const table = await within(panel).findByRole('table', { name: "本次住院AI请求明细" })
  expect(table.textContent).toContain('第 2 轮预计核验')
  expect(table.textContent).toContain('手术计划更新')
  expect(panel.textContent).not.toMatch(/尚无术前|尚无术中|尚无术后|本次跟进/)
  for (const url of requests.filter(item => item.pathname !== '/api/model-usage/retention')) {
    expect(url.searchParams.get('taskId')).toBe('estimate-one')
    expect(url.searchParams.get('caseId')).toBe(admission.id)
  }
})
