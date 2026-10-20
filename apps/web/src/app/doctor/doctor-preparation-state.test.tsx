// @vitest-environment jsdom
import { doctorRecommendationKindSchema, doctorRecommendationStateSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorPreparationProvider, useDoctorPreparation, useDoctorPreparationJob } from './doctor-preparation-state.tsx'

function state(overrides: Partial<DoctorRecommendationState> = {}) {
  return doctorRecommendationStateSchema.parse({
    caseId: 'case-preparation', encounterId: 'encounter-preparation', encounterVersion: '1', kind: 'diagnosis',
    generation: 2, inputFingerprint: 'a'.repeat(64), status: 'ready', stale: false,
    items: [{ id: 'synthetic-diagnosis', kind: 'diagnosis', catalogItemId: 'diagnosis-fever', role: 'primary',
      label: '合成发热候选', rationale: '合成来源支持待确认候选。', supportingInformation: [], opposingInformation: [],
      missingInformation: [], guidelineEvidenceIds: ['synthetic-source'], caseEvidenceIds: ['synthetic-case'] }],
    guidelines: [{ id: 'synthetic-source', title: '合成指南', publisher: '合成机构', documentType: 'official-protocol',
      version: '1', publishedAt: '2026-01-01', locator: '合成条款', scope: '合成测试', text: '合成症状可供医生评估。',
      url: 'https://example.org/synthetic-guideline', sourceHash: 'b'.repeat(64) }],
    caseEvidence: [{ id: 'synthetic-case', kind: 'consultation', label: '合成患者陈述', text: '合成患者自述发热。' }],
    missingInformation: [], ...overrides,
  })
}

function Job({ revision = '1' }: { revision?: string }) {
  const job = useDoctorPreparationJob({ caseId: 'case-preparation', kind: 'diagnosis', enabled: true, paused: false, scope: 'workspace:epoch:doctor:case-preparation', inputRevision: revision })
  return <><p role="status">{job.pending ? '更新中' : '已结束'}</p>
    <p>当前：{job.state?.items.map(item => item.label).join('、') || '无'}</p>
    <p>保留：{job.previous?.items.map(item => item.label).join('、') || '无'}</p>
    <button onClick={job.refresh}>刷新</button><button onClick={job.continueOriginal}>继续原任务</button></>
}
function SubmissionControls() {
  const preparation = useDoctorPreparation()!
  const key = JSON.stringify(['workspace:epoch:doctor:case-preparation', 'diagnosis'])
  return <><p>{preparation.submitting('diagnosis') ? '正在确认' : '可继续'}</p>
    <button onClick={() => preparation.setSubmitting(key, 'request-old', true)}>开始原请求</button>
    <button onClick={() => preparation.setSubmitting(key, 'request-new', true)}>开始新请求</button>
    <button onClick={() => preparation.setSubmitting(key, 'request-old', false)}>原请求结束</button>
    <button onClick={() => preparation.setSubmitting(key, 'request-new', false)}>新请求结束</button></>
}
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = render(<QueryClientProvider client={client}><Job /></QueryClientProvider>)
  return { ...view, client, revise: (revision: string) => view.rerender(<QueryClientProvider client={client}><Job revision={revision} /></QueryClientProvider>) }
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

describe('background clinical preparation', () => {
  it('polls a manually continued generation until completion without automatically retrying its unknown state', async () => {
    const held = deferred()
    let current = state({ status: 'failed', items: [], recovery: { status: 'unknown', requestCount: 2, extraRequestCount: 0,
      maxRequestsPerUnit: 3, maxExtraRequests: 4, canContinue: true, units: [] } })
    const posts: unknown[] = []
    let resumedReads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        current = state({ status: 'pending', items: [], recovery: { ...current.recovery!, status: 'pending', canContinue: false } })
        return Response.json({ data: current, auditId: 'continue-audit', effects: [], requestId: 'continue-request', warnings: [] })
      }
      if (posts.length && ++resumedReads > 1) return held.promise
      return Response.json(current)
    }))
    mount()
    await screen.findByText('已结束')
    expect(posts).toEqual([])
    await userEvent.setup().click(screen.getByRole('button', { name: '继续原任务' }))
    await screen.findByText('更新中')
    expect(posts).toEqual([expect.objectContaining({ input: { expectedInputFingerprint: current.inputFingerprint, refresh: false, continueGeneration: 2 } })])
    // The continued task retains generation 2, so completion depends on polling that same generation.
    await waitFor(() => expect(resumedReads).toBeGreaterThan(1), { timeout: 2500 })
    await act(async () => { held.resolve(Response.json(state())) })
    await screen.findByText('当前：合成发热候选')
    await screen.findByText('已结束')
    expect(posts).toHaveLength(1)
  })

  it('coalesces consecutive source updates and blocks cached automatic items immediately', async () => {
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => { reads += 1; return Response.json(state()) }))
    const view = mount()
    await screen.findByText('当前：合成发热候选')
    view.revise('2')
    expect(screen.getByText('更新中')).toBeTruthy()
    expect(reads).toBe(1)
    view.revise('3')
    await waitFor(() => expect(reads).toBe(2))
    await screen.findByText('已结束')
  })

  it('keeps the latest confirmation disabled until its own request settles', async () => {
    const client = new QueryClient()
    clients.push(client)
    render(<QueryClientProvider client={client}><DoctorPreparationProvider detail={undefined} enabled={false}
      scope="workspace:epoch:doctor:case-preparation" inputRevision="1"><SubmissionControls /></DoctorPreparationProvider></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '开始原请求' }))
    await user.click(screen.getByRole('button', { name: '开始新请求' }))
    await user.click(screen.getByRole('button', { name: '原请求结束' }))
    expect(screen.getByText('正在确认')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '新请求结束' }))
    expect(screen.getByText('可继续')).toBeTruthy()
  })

  it('prepares every clinical kind without mounting an order page', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const kind = doctorRecommendationKindSchema.parse(path.split('/recommendations/')[1]?.split('/')[0])
      calls.push(`${init?.method ?? 'GET'}:${kind}`)
      const current = state({ kind, status: init?.method === 'POST' ? 'missing-evidence' : 'idle', items: [] })
      return init?.method === 'POST'
        ? Response.json({ data: current, auditId: `audit-${kind}`, effects: [], requestId: `request-${kind}`, warnings: [] })
        : Response.json(current)
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const view = (revision: string) => <QueryClientProvider client={client}><DoctorPreparationProvider detail={undefined}
      caseId="case-preparation" enabled scope="workspace:epoch:doctor:case-preparation" inputRevision={revision}><p>问诊正文</p></DoctorPreparationProvider></QueryClientProvider>
    const rendered = render(view('1'))
    await waitFor(() => expect(calls.filter(call => call.startsWith('POST:')).sort()).toEqual([
      'POST:diagnosis', 'POST:imaging', 'POST:laboratory', 'POST:pathology', 'POST:prescription',
    ]))
    rendered.rerender(view('1'))
    expect(calls.filter(call => call.startsWith('POST:'))).toHaveLength(5)
    expect(screen.queryByText(/三类待办|暂停自动准备|项待确认|项待开具/)).toBeNull()
  })

  it('clears archived automatic items when the generation response removes access to their sources', async () => {
    let hidden = false
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') hidden = true
      const current = hidden ? state({ status: 'missing-evidence', items: [], hidePreviousResults: true }) : state()
      return init?.method === 'POST'
        ? Response.json({ data: current, auditId: 'audit-source', effects: [], requestId: 'request-source', warnings: [] })
        : Response.json(current)
    }))
    mount()
    await screen.findByText('保留：合成发热候选')
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('当前：无')
    expect(screen.getByText('保留：无')).toBeTruthy()
  })

  it('marks cached automatic items as updating while a new server check is in flight', async () => {
    const held = deferred()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? Response.json(state()) : held.promise))
    const { client } = mount()
    await screen.findByText('当前：合成发热候选')
    act(() => { void client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
    try {
      await waitFor(() => expect(reads).toBe(2))
      await screen.findByText('更新中')
      expect(screen.getByText('当前：合成发热候选')).toBeTruthy()
    } finally { await act(async () => { held.resolve(Response.json(state())) }) }
  })

  it('honors an explicit source removal even when its generation is older than the cached ready result', async () => {
    let current = state()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    const { client } = mount()
    await screen.findByText('当前：合成发热候选')
    current = state({ generation: 1, status: 'missing-evidence', stale: false, items: [], hidePreviousResults: true })
    await act(async () => { await client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
    await screen.findByText('当前：无')
    expect(screen.getByText('保留：无')).toBeTruthy()
  })
})
