// @vitest-environment jsdom
import { doctorRecommendationStateSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDoctorPreparationJob } from './doctor-preparation-state.tsx'

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

function Job() {
  const job = useDoctorPreparationJob({ caseId: 'case-preparation', kind: 'diagnosis', enabled: true, paused: false, scope: 'workspace:epoch:doctor:case-preparation', inputRevision: '1' })
  return <><p role="status">{job.pending ? '更新中' : '已结束'}</p>
    <p>当前：{job.state?.items.map(item => item.label).join('、') || '无'}</p>
    <p>保留：{job.previous?.items.map(item => item.label).join('、') || '无'}</p>
    <button onClick={job.refresh}>刷新</button></>
}
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = render(<QueryClientProvider client={client}><Job /></QueryClientProvider>)
  return { ...view, client }
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

describe('background clinical preparation', () => {
  it('honors an explicit source removal even when its generation is older than the cached ready result', async () => {
    let current = state()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    const { client } = mount()
    await screen.findByText('当前：合成发热候选')
    current = state({ generation: 1, status: 'missing-evidence', stale: false, items: [], hidePreviousResults: true })
    await act(async () => { await client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
    expect(screen.getByText('当前：无')).toBeTruthy()
    expect(screen.getByText('保留：无')).toBeTruthy()
  })
})
