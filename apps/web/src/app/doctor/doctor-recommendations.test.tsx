// @vitest-environment jsdom
import { doctorRecommendationStateSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorRecommendationsPanel } from './doctor-recommendations.tsx'

function state(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return doctorRecommendationStateSchema.parse({
    caseId: 'case-fever', kind: 'diagnosis', encounterId: 'encounter-fever', encounterVersion: '2',
    inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, stale: false, missingInformation: [],
    items: [{
      id: 'recommendation-fever', kind: 'diagnosis', role: 'primary', catalogItemId: 'diagnosis-fever', label: '发热，未特指',
      rationale: '现有资料支持症状性候选，仍须核实病因。', supportingInformation: ['合成患者自述发热伴咳嗽。'],
      opposingInformation: ['尚无病原学检查结果。'], missingInformation: ['待核实病原学资料。'],
      guidelineEvidenceIds: ['nhc-influenza-2025-diagnosis'], caseEvidenceIds: ['patient-statement-fever'],
      referenceConcept: { id: 'diagnosis-fever', code: 'R50.9', display: '发热，未特指',
        sourceLocator: 'operational:diagnosis_catalog', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' },
    }],
    guidelines: [{
      id: 'nhc-influenza-2025-diagnosis', title: '流行性感冒诊疗方案（2025 年版）',
      publisher: '国家卫生健康委办公厅、国家中医药局综合司', documentType: 'official-protocol', version: '2025',
      publishedAt: '2025-01-20', locator: '第六节“诊断”，印刷第 5 页',
      scope: '流感诊疗；需结合流行病学、临床表现和病原学资料。',
      text: '主要结合流行病学史、临床表现和病原学检查进行诊断。',
      url: 'https://www.nhc.gov.cn/ylyjs/zcwj/202501/f8fcecca59a048bebc4a71847ce57594/files/1741764832851_94226.pdf',
      sourceHash: 'd19f8cba72af08fd11fe17c0d6c3614c9aaac8d8c77fa803e7e9b999abea1125',
    }],
    caseEvidence: [{ id: 'patient-statement-fever', kind: 'consultation', label: '合成患者回答',
      text: '合成患者自述发热伴咳嗽三天，近期接触流感病例，尚无病原学结果。' }],
    ...overrides,
  })
}

function props(overrides: Partial<ComponentProps<typeof DoctorRecommendationsPanel>> = {}): ComponentProps<typeof DoctorRecommendationsPanel> {
  return { caseId: 'case-fever', kind: 'diagnosis', enabled: true, scope: 'workspace-demo:epoch-1:doctor:case-fever',
    inputRevision: 'case-source-1', onAdopt: vi.fn(), ...overrides }
}

const clients: QueryClient[] = []
function mount(panelProps: ComponentProps<typeof DoctorRecommendationsPanel>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const rendered = render(<QueryClientProvider client={client}><DoctorRecommendationsPanel {...panelProps} /></QueryClientProvider>)
  return { ...rendered, client,
    rerenderPanel: (next: ComponentProps<typeof DoctorRecommendationsPanel>) => rendered.rerender(
      <QueryClientProvider client={client}><DoctorRecommendationsPanel {...next} /></QueryClientProvider>,
    ),
  }
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

function deferredResponse() {
  let complete: (response: Response) => void = () => { throw new Error('The response has not started') }
  const response = new Promise<Response>(resolve => { complete = resolve })
  return { response, complete }
}

describe('doctor recommendation panel current version checks', () => {
  it('requires the doctor to resolve two primary diagnoses without rewriting either selection', async () => {
    const first = state().items[0]!
    if (first.kind !== 'diagnosis') throw new Error('Expected the synthetic diagnosis fixture')
    const current = state({ items: [first, { ...first, id: 'second', catalogItemId: 'second-diagnosis', label: '合成第二诊断' }] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props())
    await screen.findByText('合成第二诊断')
    expect(screen.getByRole('button', { name: /确认选中诊断/ })).toHaveProperty('disabled', true)
    expect(screen.getAllByText('主诊断')).toHaveLength(2)
  })

  it('does not invent primary roles when reading an older diagnosis result', async () => {
    const base = state()
    const current = state({ items: base.items.map(item => item.kind === 'diagnosis' ? { ...item, role: undefined } : item) })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props())
    await screen.findByText(current.items[0]!.label)
    expect(screen.getByRole('checkbox', { name: `选择${current.items[0]!.label}` }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('button', { name: /确认选中诊断/ })).toHaveProperty('disabled', true)
  })

  it('shows executable pending items first and keeps clinical explanations behind one button', async () => {
    const current = state()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props())
    await screen.findByText(current.items[0]!.label)
    expect(screen.getByRole('checkbox', { name: `选择${current.items[0]!.label}` }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(current.items[0]!.rationale)).toBeNull()
    expect(screen.queryByText(current.guidelines[0]!.text)).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
    expect(within(screen.getByRole('dialog')).getByText(current.items[0]!.rationale)).toBeTruthy()
  })

  it.each(['zh-CN', 'en-US'] as const)('distinguishes system limitations from patient information without repeating legacy flat notes in %s', async locale => {
    const current = state({
      notices: [
        { category: 'guideline', message: '当前指南未覆盖本项检查。' },
        { category: 'catalog', message: '院内目录暂未开展该检查。' },
        { category: 'verification', message: '流感候选未通过核验：引用未支持诊断限定语。' },
        { category: 'processing', message: '本次无法完整读取历史资料。' },
      ],
      missingInformation: ['旧版未分类缺项长清单，不应重复显示。'],
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props({ locale }))
    for (const [category, message] of (locale === 'zh-CN' ? [
      ['指南覆盖', '当前指南未覆盖本项检查。'], ['院内目录', '院内目录暂未开展该检查。'],
      ['核验未通过', '流感候选未通过核验：引用未支持诊断限定语。'], ['系统处理限制', '本次无法完整读取历史资料。'],
    ] as const : [
      ['Guideline coverage', '当前指南未覆盖本项检查。'], ['Hospital catalog', '院内目录暂未开展该检查。'],
      ['Verification not passed', '流感候选未通过核验：引用未支持诊断限定语。'], ['Processing limitations', '本次无法完整读取历史资料。'],
    ] as const)) {
      const notice = await screen.findByRole('alert', { name: category })
      expect(within(notice).getByText(message)).toBeTruthy()
    }
    expect(screen.queryByText(current.missingInformation[0]!)).toBeNull()
  })

  it('labels unclassified legacy notes as additional notes without blaming missing patient information', async () => {
    const current = state({ status: 'missing-evidence', items: [], missingInformation: ['旧版未分类说明。'] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props())
    const note = within(await screen.findByRole('alert', { name: '补充说明' }))
    expect(note.getByText('旧版未分类说明。')).toBeTruthy()
    expect(screen.getByText('本轮未发布建议，请查看上方说明，并结合病例继续评估。')).toBeTruthy()
    expect(screen.queryByText('指南或病例资料不足时，先补充信息再刷新。')).toBeNull()
  })

  it('keeps adoptable suggestions separate from read-only considerations', async () => {
    const current = state({ considerations: [{
      id: 'consideration-assessment', label: '核实上呼吸道感染的可能性', rationale: '围绕本次症状补充评估。',
      supportingInformation: ['自述发热伴咳嗽。'], opposingInformation: [], missingInformation: ['核实症状起始时间。'],
      caseEvidenceIds: ['patient-statement-fever'],
    }] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props())
    const adoptable = within(await screen.findByRole('region', { name: '可采纳建议' }))
    expect(adoptable.getByRole('button', { name: '采纳 发热，未特指' })).toBeTruthy()
    expect(adoptable.queryByText('核实上呼吸道感染的可能性')).toBeNull()
    const thoughts = within(screen.getByRole('region', { name: '待核实思路' }))
    expect(thoughts.getByText('核实上呼吸道感染的可能性')).toBeTruthy()
    expect(thoughts.queryByRole('button')).toBeNull()
    await userEvent.setup().click(adoptable.getByText('查看依据'))
    expect(adoptable.getByText(current.guidelines[0]!.text)).toBeTruthy()
    expect(adoptable.getByText(current.caseEvidence[0]!.text)).toBeTruthy()
  })

  it.each(['diagnosis', 'laboratory', 'imaging', 'pathology'] as const)('shows case-based %s reasoning with its sources and no adoption action when guidance is absent', async kind => {
    const consideration = {
      id: 'consideration-fever', label: '考虑流感相关评估', rationale: '结合发热感与接触情况，先评估流感的可能性。',
      supportingInformation: ['患者自述发热伴咳嗽。'], opposingInformation: ['分诊测得37℃，未记录发热时最高体温。'],
      missingInformation: ['核对发病时间，以判断检测是否影响处置。'], caseEvidenceIds: ['patient-statement-fever'],
    }
    const current = state({ kind, status: 'missing-evidence', items: [], guidelines: [], considerations: [consideration], notices: [] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    const page = props({ kind })
    mount(page)
    const thoughts = within(await screen.findByRole('region', { name: '待核实思路' }))
    const entry = within(thoughts.getByRole('article', { name: consideration.label }))
    for (const text of [consideration.rationale, ...consideration.supportingInformation, ...consideration.opposingInformation,
      ...consideration.missingInformation, current.caseEvidence[0]!.text]) expect(entry.getByText(text)).toBeTruthy()
    expect(entry.getByText('病例依据').closest('details')).toBeNull()
    expect(entry.queryByRole('button')).toBeNull()
    expect(screen.queryByText('暂无可采纳的建议')).toBeNull()
    expect(page.onAdopt).not.toHaveBeenCalled()
  })

  it.each([
    { documentType: 'product-information', label: '药品说明书', locale: 'zh-CN' },
    { documentType: 'health-standard', label: '卫生行业标准', locale: 'zh-CN' },
    { documentType: 'product-information', label: 'Product information', locale: 'en-US' },
    { documentType: 'health-standard', label: 'Health industry standard', locale: 'en-US' },
  ] as const)('shows the evidence document type as $label', async ({ documentType, label, locale }) => {
    const source = state()
    const current = state({ guidelines: [{ ...source.guidelines[0]!, documentType }] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    mount(props({ locale }))
    const panel = within(screen.getByRole('region', { name: locale === 'zh-CN' ? '诊断建议' : 'Diagnosis suggestions' }))
    await userEvent.setup().click(await panel.findByText(locale === 'zh-CN' ? '查看依据' : 'View evidence'))
    expect(panel.getByText(label)).toBeTruthy()
  })

  it('rechecks the server before adoption and does not apply a cached ready suggestion after its sources become stale', async () => {
    let current = state()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ data: current, auditId: 'audit-refresh',
        effects: [], requestId: 'request-refresh', warnings: [] })
      return Response.json(current)
    }))
    const page = props()
    mount(page)
    const panel = within(screen.getByRole('region', { name: '诊断建议' }))
    const adopt = await panel.findByRole('button', { name: '采纳 发热，未特指' })
    current = state({ inputFingerprint: 'b'.repeat(64), stale: true, missingInformation: ['当前病例资料已更新，等待重新生成。'] })
    await userEvent.setup().click(adopt)
    expect(page.onAdopt).not.toHaveBeenCalled()
    await panel.findByText('当前病例资料已更新，等待重新生成。')
    await waitFor(() => expect(adopt.hasAttribute('disabled')).toBe(true))
  })

  it.each([
    { change: 'input fingerprint', current: state({ inputFingerprint: 'b'.repeat(64) }) },
    { change: 'generation', current: state({ generation: 2 }) },
    { change: 'pending generation', current: state({ status: 'pending' }) },
    { change: 'failed generation', current: state({ status: 'failed' }) },
    { change: 'missing evidence', current: state({ status: 'missing-evidence' }) },
    { change: 'removed suggestion', current: state({ items: [] }) },
    { change: 'case identity', current: state({ caseId: 'case-other' }) },
    { change: 'recommendation kind', current: state({ kind: 'prescription', items: [] }) },
  ])('rejects adoption when the fresh server check changes the $change', async ({ current }) => {
    const check = deferredResponse()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? Response.json(state()) : await check.response))
    const page = props()
    mount(page)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 发热，未特指' }))
    await screen.findByText('正在核对建议…')
    await act(async () => { check.complete(Response.json(current)) })
    await waitFor(() => expect(screen.queryByText('正在核对建议…')).toBeNull())
    expect(page.onAdopt).not.toHaveBeenCalled()
  })

  it.each([
    { change: 'acting identity', next: { scope: 'actor-b' } },
    { change: 'input revision', next: { inputRevision: 'case-source-2' } },
    { change: 'selected case', next: { caseId: 'case-other' } },
    { change: 'enabled page', next: { enabled: false } },
  ])('does not adopt an old check after the $change changes from A to B and back to A', async ({ next }) => {
    const check = deferredResponse()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 2 ? await check.response : Response.json(state())))
    const page = props({ scope: 'actor-a' })
    const mounted = mount(page)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 发热，未特指' }))
    await waitFor(() => expect(reads).toBe(2))
    mounted.rerenderPanel({ ...page, ...next })
    mounted.rerenderPanel(page)
    await act(async () => { check.complete(Response.json(state())) })
    await waitFor(() => expect(screen.queryByText('正在核对建议…')).toBeNull())
    expect(page.onAdopt).not.toHaveBeenCalled()
  })

  it('does not let a delayed generation one response replace a newer generation already read from the server', async () => {
    const post = deferredResponse()
    const readAfterPost = deferredResponse()
    const initial = state()
    const newer = state({ generation: 2, items: [{ ...initial.items[0]!, rationale: '第二轮的核对结果仍须医生确认。' }] })
    let reads = 0
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts++; return post.response }
      reads++
      if (reads === 1) return Response.json(initial)
      if (reads === 2) return Response.json(newer)
      return readAfterPost.response
    }))
    const mounted = mount(props())
    await screen.findByRole('button', { name: '采纳 发热，未特指' })
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新建议' }))
    await waitFor(() => expect(posts).toBe(1))
    await act(async () => { await mounted.client.refetchQueries({ type: 'active' }) })
    await screen.findByText('第二轮的核对结果仍须医生确认。')
    await act(async () => { post.complete(Response.json({ data: initial, auditId: 'audit-old-generation',
      effects: [], requestId: 'request-old-generation', warnings: [] })) })
    await waitFor(() => expect(reads).toBe(3))
    try {
      expect(screen.getByText('第二轮的核对结果仍须医生确认。')).toBeTruthy()
      expect(screen.queryByText(initial.items[0]!.rationale)).toBeNull()
    } finally {
      await act(async () => { readAfterPost.complete(Response.json(newer)) })
    }
  })

  it.each(['ready', 'missing-evidence', 'failed'] as const)('keeps a %s result when its delayed generation response still reports the same generation as pending', async status => {
    const post = deferredResponse()
    const readAfterPost = deferredResponse()
    const initial = state()
    const completed = state({ generation: 2, status,
      items: status === 'ready' ? [{ ...initial.items[0]!, rationale: '第二轮已经完成，等待医生核对。' }] : [],
      missingInformation: ['第二轮已核对，保留当前完成说明。'],
    })
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return post.response
      reads++
      if (reads === 1) return Response.json(initial)
      if (reads === 2) return Response.json(completed)
      return readAfterPost.response
    }))
    const mounted = mount(props())
    await screen.findByRole('button', { name: '采纳 发热，未特指' })
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新建议' }))
    await screen.findByText('正在生成建议…')
    await act(async () => { await mounted.client.refetchQueries({ type: 'active' }) })
    await screen.findByText('第二轮已核对，保留当前完成说明。')
    await act(async () => {
      post.complete(Response.json({ data: state({ generation: 2, status: 'pending', items: [] }),
        auditId: 'audit-pending', effects: [], requestId: 'request-pending', warnings: [] }))
    })
    await waitFor(() => expect(reads).toBe(3))
    try {
      expect(screen.getByText('第二轮已核对，保留当前完成说明。')).toBeTruthy()
      expect(screen.queryByText('正在生成建议…')).toBeNull()
      expect(screen.getByRole('button', { name: '刷新建议' }).hasAttribute('disabled')).toBe(false)
    } finally {
      await act(async () => { readAfterPost.complete(Response.json(completed)) })
    }
  })

  it.each(['generation', 'adoption'] as const)('does not expose an old scope %s request or its failure in the new scope', async operation => {
    const request = deferredResponse()
    const initial = state()
    const current = state({ items: [{ ...initial.items[0]!, rationale: '当前医生上下文的建议。' }] })
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return request.response
      reads++
      if (operation === 'adoption' && reads === 2) return request.response
      return Response.json(reads === 1 ? initial : current)
    }))
    const page = props({ scope: 'actor-a' })
    const mounted = mount(page)
    await screen.findByRole('button', { name: '采纳 发热，未特指' })
    await userEvent.setup().click(screen.getByRole('button', {
      name: operation === 'generation' ? '刷新建议' : '采纳 发热，未特指',
    }))
    await screen.findByText(operation === 'generation' ? '正在生成建议…' : '正在核对建议…')
    mounted.rerenderPanel({ ...page, scope: 'actor-b' })
    await screen.findByText('当前医生上下文的建议。')
    expect(screen.getByRole('button', { name: '采纳 发热，未特指' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => {
      request.complete(Response.json({ error: { code: 'MODEL_UNAVAILABLE', message: '合成旧请求失败。' } }, { status: 503 }))
    })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(screen.queryByText('建议暂不可用。现有草稿已保留，可刷新重试。')).toBeNull()
    expect(screen.getByText('当前医生上下文的建议。')).toBeTruthy()
    expect(page.onAdopt).not.toHaveBeenCalled()
  })

  it('does not replace the current view with a generation response from an earlier visit to the same scope', async () => {
    const post = deferredResponse()
    const initial = state()
    const current = state({ generation: 2, items: [{ ...initial.items[0]!, rationale: '身份往返后读取的当前建议。' }] })
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return post.response
      return Response.json(++reads === 1 ? initial : current)
    }))
    const page = props({ scope: 'actor-a' })
    const mounted = mount(page)
    await screen.findByRole('button', { name: '采纳 发热，未特指' })
    await userEvent.setup().click(screen.getByRole('button', { name: '刷新建议' }))
    await screen.findByText('正在生成建议…')
    mounted.rerenderPanel({ ...page, scope: 'actor-b' })
    mounted.rerenderPanel(page)
    await screen.findByText('身份往返后读取的当前建议。')
    await act(async () => {
      post.complete(Response.json({ data: state({ generation: 3 }), auditId: 'audit-old-scope',
        effects: [], requestId: 'request-old-scope', warnings: [] }))
    })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(screen.getByText('身份往返后读取的当前建议。')).toBeTruthy()
    expect(screen.queryByText(initial.items[0]!.rationale)).toBeNull()
  })

  it('does not adopt a check that completes after the panel unmounts', async () => {
    const check = deferredResponse()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? Response.json(state()) : await check.response))
    const page = props()
    const mounted = mount(page)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 发热，未特指' }))
    await screen.findByText('正在核对建议…')
    mounted.unmount()
    await act(async () => { check.complete(Response.json(state())) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(page.onAdopt).not.toHaveBeenCalled()
  })

  it.each([false, true])('uses the latest editor permission and callback while a check is pending (can adopt: %s)', async permitted => {
    const check = deferredResponse()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 2 ? await check.response : Response.json(state())))
    const previousAdopt = vi.fn()
    const latestAdopt = vi.fn()
    const page = props({ canAdopt: () => true, onAdopt: previousAdopt })
    const mounted = mount(page)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 发热，未特指' }))
    await waitFor(() => expect(reads).toBe(2))
    mounted.rerenderPanel({ ...page, canAdopt: () => permitted, onAdopt: latestAdopt })
    const verified = state({ missingInformation: ['采纳前已完成本次核对。'] })
    await act(async () => { check.complete(Response.json(verified)) })
    await waitFor(() => expect(screen.queryByText('正在核对建议…')).toBeNull())
    expect(previousAdopt).not.toHaveBeenCalled()
    if (permitted) expect(latestAdopt).toHaveBeenCalledExactlyOnceWith(verified.items[0], verified)
    else expect(latestAdopt).not.toHaveBeenCalled()
  })

  it('rejects a changed suggestion even when the case fingerprint and generation still match', async () => {
    let current = state()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
    const page = props()
    mount(page)
    const adopt = await screen.findByRole('button', { name: '采纳 发热，未特指' })
    current = state({ items: [{ ...current.items[0]!, rationale: '服务端已修正候选依据，医生需要重新核对。' }] })
    await userEvent.setup().click(adopt)
    await screen.findByText('服务端已修正候选依据，医生需要重新核对。')
    expect(page.onAdopt).not.toHaveBeenCalled()
  })

  it('keeps a replacement visible and does not adopt an old check that arrives after a same-generation refresh', async () => {
    const check = deferredResponse()
    const initial = state()
    const replacement = state({ items: [{ ...initial.items[0]!, rationale: '当前可见候选已经更正，请重新核对。' }] })
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads++
      if (reads === 1) return Response.json(initial)
      if (reads === 2) return check.response
      return Response.json(replacement)
    }))
    const page = props()
    const mounted = mount(page)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 发热，未特指' }))
    await waitFor(() => expect(reads).toBe(2))
    await act(async () => { await mounted.client.refetchQueries({ type: 'active' }) })
    await screen.findByText('当前可见候选已经更正，请重新核对。')
    await act(async () => { check.complete(Response.json(initial)) })
    await waitFor(() => expect(screen.queryByText('正在核对建议…')).toBeNull())
    expect(page.onAdopt).not.toHaveBeenCalled()
    expect(screen.getByText('当前可见候选已经更正，请重新核对。')).toBeTruthy()
    expect(screen.queryByText(initial.items[0]!.rationale)).toBeNull()
  })

  it('does not adopt a check after a background read has removed the visible case suggestion', async () => {
    const check = deferredResponse()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads++
      if (reads === 1) return Response.json(state())
      if (reads === 2) return check.response
      return Response.json(state({ caseId: 'case-other' }))
    }))
    const page = props()
    const mounted = mount(page)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 发热，未特指' }))
    await screen.findByText('正在核对建议…')
    await act(async () => { await mounted.client.refetchQueries({ type: 'active' }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: '采纳 发热，未特指' })).toBeNull())
    await act(async () => { check.complete(Response.json(state())) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(page.onAdopt).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '采纳 发热，未特指' })).toBeNull()
  })
})
