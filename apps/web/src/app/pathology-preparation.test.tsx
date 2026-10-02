// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathologyCoveragePanel, PatientPathologyPreparation } from './pathology-preparation.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const catalog = { hash: 'a'.repeat(64), packId: 'clinmesh-pathology-test', ruleVersion: 1 }
const luminalProfile = 'breast-er-pos-pr-pos-her2-neg-ln-pos-t2'
const fact = (name: string, value: string, code: string) => ({
  code,
  fact: name,
  sourceReference: `urn:uuid:${name}`,
  value,
  valueCode: '10828004',
})

function casePreparation(revision: number) {
  return {
    bindings: [{
      assetId: 'synthetic-slide-luminal',
      boundAt: '2026-10-02T02:00:00.000Z',
      examCode: 'breast-slide-consultation',
      matchingProfileId: luminalProfile,
      preparationRevision: revision,
      reportRevision: 1,
      sourceProcedureReference: 'urn:uuid:procedure-0',
    }],
    caseId: 'synthetic-case-1',
    preparation: {
      caseId: 'synthetic-case-1',
      catalog,
      createdAt: '2026-10-02T02:00:00.000Z',
      exams: [{
        evidence: {
          conditions: [{ code: '254837009', display: '乳腺恶性肿瘤', sourceReference: 'urn:uuid:breast-cancer' }],
          facts: [
            fact('estrogen-receptor', 'positive', '85337-4'),
            fact('progesterone-receptor', 'positive', '85339-0'),
            fact('her2', 'negative', '85319-2'),
            fact('lymph-nodes', 'positive', '21906-3'),
            fact('tumor-category', 'T2', '21905-5'),
          ],
        },
        examCode: 'breast-slide-consultation',
        matchingProfileId: luminalProfile,
        sourceProcedures: [{
          assetId: 'synthetic-slide-luminal',
          code: '392021009',
          display: '乳房肿块切除术',
          performedAt: '2022-04-01T08:00:00+08:00',
          reportRevision: 1,
          sourceReference: 'urn:uuid:procedure-0',
          supplements: [{ fact: 'histologic-type', value: '浸润性导管癌' }],
        }],
        status: 'ready',
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

describe('administrator pathology preparation panels', () => {
  it('loads a case preparation only when expanded and re-prepares that case on request', async () => {
    const requests: Array<{ body: unknown; method: string; path: string }> = []
    let revision = 1
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      requests.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), method: init?.method ?? 'GET', path })
      if (path === '/api/sim/v1/admin/pathology-preparations') {
        revision = 2
        return Response.json(commandResponse({ prepared: [casePreparation(2)], remaining: 0 }))
      }
      return Response.json(casePreparation(revision))
    }))
    const user = userEvent.setup()
    renderWithQueries(<PatientPathologyPreparation caseId="synthetic-case-1" locale="zh-CN" />)

    const toggle = screen.getByText('病理准备')
    expect(requests).toEqual([])
    await user.click(toggle)

    const exam = (await screen.findByText('乳腺切片病理会诊')).closest('li')!
    expect(requests[0]?.path).toBe('/api/sim/v1/admin/synthetic-cases/synthetic-case-1/pathology-preparation')
    expect(within(exam).getByText('已就绪')).toBeTruthy()
    expect(within(exam).getByText(/来源诊断：乳腺恶性肿瘤（254837009）/)).toBeTruthy()
    expect(within(exam).getByText(/来源固定事实：ER 阳性 · PR 阳性 · HER2 阴性 · 淋巴结 阳性 · T 类别 T2/)).toBeTruthy()
    expect(within(exam).getByText(/可送检手术：乳房肿块切除术（392021009） · 2022-04-01/)).toBeTruthy()
    // 素材补充的事实与来源事实分开显示。
    expect(within(exam).getByText('synthetic-slide-luminal')).toBeTruthy()
    expect(within(exam).getByText(/报告修订 1 · 素材补充的组织学类型：浸润性导管癌/)).toBeTruthy()
    expect(screen.getByText(/准备修订 1/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '按当前清单重新准备' }))
    expect(await screen.findByText(/准备修订 2/)).toBeTruthy()
    expect(requests.find(request => request.method === 'POST')).toMatchObject({
      body: { input: { caseIds: ['synthetic-case-1'] } },
      path: '/api/sim/v1/admin/pathology-preparations',
    })
  })

  it('shows derived profiles, assets lacking facts and library results, previews a slide and prepares the next batch', async () => {
    const requests: Array<{ body: unknown; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      requests.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), method: init?.method ?? 'GET' })
      if (path === '/api/sim/v1/admin/pathology-preparations') {
        return Response.json(commandResponse({ prepared: [casePreparation(1)], remaining: 3 }))
      }
      if (path === '/api/sim/v1/admin/pathology-assets/synthetic-slide-luminal') {
        return Response.json({
          assetId: 'synthetic-slide-luminal',
          clinical: { histologicType: 'Infiltrating Ductal Carcinoma', pathologicN: 'N1' },
          facts: { 'estrogen-receptor': 'positive' },
          publication: { publishedRevisions: [], reasons: [{ code: 'REVIEW_MISSING', revision: 1 }] },
          reports: [{
            checkIssues: [],
            diagnosis: '乳腺浸润性导管癌。原始资料未提供组织学分级。',
            immunohistochemistry: '以下结果引自原始病理资料。ER：阳性；PR：阳性；HER2：阴性。',
            microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌。',
            note: '本次会诊切片为原发灶组织。',
            revision: 1,
          }],
          study: { available: false, examCode: 'breast-slide-consultation', series: [], studyId: 'synthetic-slide-luminal' },
        })
      }
      return Response.json({
        cases: {
          exams: [{
            conflict: 1,
            examCode: 'breast-slide-consultation',
            ready: 2,
            unsupported: [{ count: 4, reason: 'NO_APPLICABLE_RULE' }, { count: 1, reason: 'FACT_UNKNOWN' }],
          }],
          prepared: 8,
          total: 10,
        },
        catalog,
        gaps: [{ assetId: 'synthetic-slide-node-unknown', blockers: [], installed: true, missing: ['lymph-nodes'], published: true }],
        profiles: [{
          assets: [{ assetId: 'synthetic-slide-luminal', blockers: ['REVIEW_MISSING'], installed: false, published: false }],
          examCode: 'breast-slide-consultation',
          facts: {
            'estrogen-receptor': 'positive',
            'her2': 'negative',
            'lymph-nodes': 'positive',
            'progesterone-receptor': 'positive',
            'tumor-category': 'T2',
          },
          id: luminalProfile,
          label: '乳腺切片会诊：ER 阳性 · PR 阳性 · HER2 阴性 · 淋巴结阳性 · T2',
        }],
      })
    }))
    const user = userEvent.setup()
    renderWithQueries(<PathologyCoveragePanel locale="zh-CN" />)

    expect(requests).toEqual([])
    await user.click(screen.getByText('病理覆盖清单'))

    const profile = (await screen.findByText('乳腺切片会诊：ER 阳性 · PR 阳性 · HER2 阴性 · 淋巴结阳性 · T2')).closest('li')!
    expect(within(profile).getByText(/未发布：尚未复核/)).toBeTruthy()
    expect(within(profile).getByText(/未安装/)).toBeTruthy()
    const gap = screen.getByText('缺少：淋巴结').closest('li')!
    expect(within(gap).getByText(/synthetic-slide-node-unknown/)).toBeTruthy()
    expect(within(gap).getByText(/已发布 · 已安装/)).toBeTruthy()
    expect(screen.getByText(/已准备 8 \/ 10 例/)).toBeTruthy()
    expect(screen.getByText(/乳腺切片病理会诊：已就绪 2 · 待处理 1 · 未覆盖 5/)).toBeTruthy()
    expect(screen.getByText(/来源没有可用依据 4/)).toBeTruthy()

    // 复核预览：阅片入口旁给出来源临床字段、报告草稿、自动检查结果与签署命令。
    await user.click(within(profile).getByRole('button', { name: '复核预览' }))
    expect(await within(profile).findByText(/镜下所见：送检切片为 HE 染色乳腺组织，见浸润性癌。/)).toBeTruthy()
    expect(within(profile).getByText(/病理诊断：乳腺浸润性导管癌。原始资料未提供组织学分级。/)).toBeTruthy()
    expect(within(profile).getByText(/自动一致性检查通过 · 尚未发布/)).toBeTruthy()
    expect(within(profile).getByText(/pnpm pathology:review --asset synthetic-slide-luminal/)).toBeTruthy()
    expect(within(profile).getByText(/Infiltrating Ductal Carcinoma/)).toBeTruthy()
    expect(within(profile).getByText(/影像暂不可用/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '准备下一批病例' }))
    expect(await screen.findByText(/本批准备 1 例，还有 3 例待准备/)).toBeTruthy()
    expect(requests.find(request => request.method === 'POST')).toMatchObject({ body: { input: {} } })
  })
})
