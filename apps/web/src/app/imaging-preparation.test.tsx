// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImagingCoveragePanel, PatientImagingPreparation } from './imaging-preparation.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const catalog = { hash: 'a'.repeat(64), packId: 'clinmesh-imaging-test', ruleVersion: 1 }
const lungCancerFact = { code: '254637007', display: '非小细胞肺癌', scope: 'index', sourceReference: 'urn:uuid:index-fact-0' }

function casePreparation(revision: number) {
  return {
    bindings: [{
      assetId: 'synthetic-mass-ct',
      boundAt: '2026-10-01T02:00:00.000Z',
      examCode: 'chest-ct-plain',
      matchingProfileId: 'lung-mass-male',
      preparationRevision: revision,
      reportRevision: 1,
    }],
    caseId: 'synthetic-case-1',
    preparation: {
      caseId: 'synthetic-case-1',
      catalog,
      createdAt: '2026-10-01T02:00:00.000Z',
      exams: [{
        assetId: 'synthetic-mass-ct',
        evidence: { facts: [lungCancerFact], sourceExams: [] },
        examCode: 'chest-ct-plain',
        matchingProfileId: 'lung-mass-male',
        reportRevision: 1,
        status: 'ready',
      }, {
        evidence: {
          facts: [lungCancerFact],
          sourceExams: [{ code: '399208008', display: '胸部 X 线平片', sourceReference: 'urn:uuid:index-fact-1' }],
        },
        examCode: 'chest-radiograph',
        matchingProfileId: 'lung-mass-male',
        reason: 'PROFILE_LACKS_EXAM',
        status: 'unsupported',
      }],
      profileId: 'synthetic-patient-profile-1',
      profileRevision: 1,
      revision,
      sourceHash: 'b'.repeat(64),
    },
    started: false,
  }
}

function commandResponse(data: unknown) {
  return { auditId: 'audit-1', data, effects: [], requestId: 'request-1', warnings: [] }
}

function renderWithQueries(element: React.JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

describe('administrator imaging preparation panels', () => {
  it('loads a case preparation only when expanded and re-prepares that case on request', async () => {
    const requests: Array<{ body: unknown; method: string; path: string }> = []
    let revision = 1
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      requests.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), method: init?.method ?? 'GET', path })
      if (path === '/api/sim/v1/admin/imaging-preparations') {
        revision = 2
        return Response.json(commandResponse({ prepared: [casePreparation(2)], remaining: 0 }))
      }
      return Response.json(casePreparation(revision))
    }))
    const user = userEvent.setup()
    renderWithQueries(<PatientImagingPreparation caseId="synthetic-case-1" locale="zh-CN" />)

    const toggle = screen.getByText('影像准备')
    expect(requests).toEqual([])
    await user.click(toggle)

    const ct = (await screen.findByText('胸部 CT 平扫')).closest('li')!
    expect(within(ct).getByText('已就绪')).toBeTruthy()
    expect(within(ct).getByText(/synthetic-mass-ct/)).toBeTruthy()
    const radiograph = screen.getByText('胸片').closest('li')!
    expect(within(radiograph).getByText('未覆盖')).toBeTruthy()
    expect(within(radiograph).getByText('适配条目没有该检查的素材')).toBeTruthy()
    expect(within(radiograph).getByText(/来源检查：胸部 X 线平片（399208008）/)).toBeTruthy()
    expect(screen.getAllByText(/本次病例：非小细胞肺癌（254637007）/).length).toBe(2)
    expect(screen.getByText(/准备修订 1/)).toBeTruthy()
    expect(screen.getByText(/病例尚未开始，素材跟随最新一次准备/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '按当前清单重新准备' }))
    expect(await screen.findByText(/准备修订 2/)).toBeTruthy()
    expect(requests.find(request => request.method === 'POST')).toMatchObject({
      body: { input: { caseIds: ['synthetic-case-1'] } },
      path: '/api/sim/v1/admin/imaging-preparations',
    })
  })

  it('shows coverage rules, explicit gaps and library results, and prepares the next batch', async () => {
    const requests: Array<{ body: unknown; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      requests.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), method: init?.method ?? 'GET' })
      if (path === '/api/sim/v1/admin/imaging-preparations') {
        return Response.json(commandResponse({ prepared: [casePreparation(1)], remaining: 3 }))
      }
      if (path === '/api/sim/v1/admin/imaging-assets/synthetic-mass-ct') {
        return Response.json({
          annotation: { kind: 'lidc-ct', nodules: [] },
          assetId: 'synthetic-mass-ct',
          publication: { publishedRevisions: [], reasons: [{ code: 'REVIEW_MISSING', revision: 1 }] },
          reports: [{
            checkIssues: [],
            findings: '双肺未见明确结节。',
            impression: '胸部 CT 平扫未见明确肺结节。',
            revision: 1,
            technique: '胸部 CT 平扫，轴位。',
          }],
          study: { available: false, examCode: 'chest-ct-plain', series: [], studyId: 'synthetic-mass-ct' },
        })
      }
      return Response.json({
        cases: {
          exams: [{
            conflict: 1,
            examCode: 'chest-ct-plain',
            ready: 2,
            unsupported: [{ count: 4, reason: 'NO_APPLICABLE_RULE' }, { count: 1, reason: 'UNCOVERED_CONDITION' }],
          }],
          prepared: 8,
          total: 10,
        },
        catalog,
        exams: [{
          examCode: 'chest-ct-plain',
          profiles: [{
            ageRange: [40, 79],
            asset: { assetId: 'synthetic-mass-ct', blockers: ['REVIEW_MISSING'], installed: false, published: false },
            conditionCodes: ['254637007'],
            finding: 'positive',
            id: 'lung-mass-male',
            label: '肺部单发肿块（成年男性）',
            sex: 'male',
          }, {
            ageRange: [18, 89],
            asset: null,
            conditionCodes: ['10509002'],
            finding: 'negative',
            id: 'no-nodule',
            label: '未见肺结节（急性支气管炎就诊）',
          }],
        }],
        uncovered: [{ codes: ['233604007'], id: 'pneumonia', label: '肺炎' }],
      })
    }))
    const user = userEvent.setup()
    renderWithQueries(<ImagingCoveragePanel locale="zh-CN" />)

    expect(requests).toEqual([])
    await user.click(screen.getByText('影像覆盖清单'))

    const mass = (await screen.findByText('肺部单发肿块（成年男性）')).closest('li')!
    expect(within(mass).getByText(/男性 · 40–79 岁/)).toBeTruthy()
    expect(within(mass).getByText(/未发布：尚未复核/)).toBeTruthy()
    expect(within(mass).getByText(/未安装/)).toBeTruthy()
    expect(within(screen.getByText('未见肺结节（急性支气管炎就诊）').closest('li')!).getByText('没有该检查的素材')).toBeTruthy()
    expect(screen.getByText(/肺炎（233604007）/)).toBeTruthy()
    expect(screen.getByText(/已准备 8 \/ 10 例/)).toBeTruthy()
    expect(screen.getByText(/已就绪 2 · 待处理 1 · 未覆盖 5/)).toBeTruthy()
    expect(screen.getByText(/来源没有可用依据 4/)).toBeTruthy()

    // 复核预览：阅片入口旁给出报告草稿、自动检查结果与签署命令。
    await user.click(within(mass).getByRole('button', { name: '复核预览' }))
    expect(await within(mass).findByText('双肺未见明确结节。')).toBeTruthy()
    expect(within(mass).getByText(/自动一致性检查通过 · 尚未发布/)).toBeTruthy()
    expect(within(mass).getByText(/pnpm imaging:review --asset synthetic-mass-ct/)).toBeTruthy()
    expect(within(mass).getByText(/影像暂不可用/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '准备下一批病例' }))
    expect(await screen.findByText(/本批准备 1 例，还有 3 例待准备/)).toBeTruthy()
    expect(requests.find(request => request.method === 'POST')).toMatchObject({ body: { input: {} } })
  })
})
