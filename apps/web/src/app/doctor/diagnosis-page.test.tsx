// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema, doctorRecommendationStateSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import type { DiagnosisState } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render as testingRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DiagnosisPage } from './diagnosis-page.tsx'

function props(overrides: Partial<ComponentProps<typeof DiagnosisPage>> = {}): ComponentProps<typeof DiagnosisPage> {
  return {
    actions: {
      confirm: { error: null, onSubmit: vi.fn(), pending: false },
      save: { error: null, onSubmit: vi.fn(), pending: false, savedRevision: undefined, success: false },
    },
    caseId: 'synthetic-case', catalog: [1, 2].map(id => ({
      id: `diagnosis-${id}`, code: `SYN-${id}`, nameZh: `合成诊断${id}`, nameEn: `Synthetic diagnosis ${id}`,
      system: 'https://clinmesh.example.com/icd-10', version: 1,
    })), elementId: 'diagnosis', locale: 'zh-CN',
    messages: getWorkspaceMessages('zh-CN'), readOnly: false, state: undefined,
    referenceSearch: {
      data: { items: [1, 2].map(id => ({
        id: `diagnosis-${id}`, code: `SYN-${id}`, display: `合成诊断${id}`, domain: 'diagnosis',
        sourceLocator: 'synthetic:test', system: 'https://clinmesh.example.com/icd-10', version: '1', status: 'active',
      })), page: 1, pageSize: 20, total: 2, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    },
    ...overrides,
  }
}

const queryClients: QueryClient[] = []

function render(element: React.JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  queryClients.push(client)
  const result = testingRender(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
  return { ...result, rerender: (next: React.JSX.Element) => result.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) }
}

function recommendationState(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return {
    caseId: 'synthetic-case', kind: 'diagnosis', encounterId: 'synthetic-encounter', encounterVersion: '1',
    inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, stale: false,
    items: [], guidelines: [], caseEvidence: [], missingInformation: [], ...overrides,
  }
}

function diagnosisSuggestionState(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return doctorRecommendationStateSchema.parse(recommendationState({
    items: [{
      id: 'suggestion-diagnosis-3', kind: 'diagnosis', role: 'primary', catalogItemId: 'diagnosis-3', label: '合成建议诊断3',
      rationale: '需要结合本次记录继续核实。', supportingInformation: ['本次症状支持该候选。'],
      opposingInformation: ['当前报告存在不符合信息。'], missingInformation: ['尚需核实病程。'],
      guidelineEvidenceIds: ['synthetic-guideline'], caseEvidenceIds: ['synthetic-case-source'],
      referenceConcept: {
        id: 'diagnosis-3', code: 'SYN-3', display: '合成建议诊断3',
        system: 'https://clinmesh.example.com/icd-10', version: '1', sourceLocator: 'synthetic:reference-diagnosis',
      },
    }],
    guidelines: [{
      id: 'synthetic-guideline', title: '合成诊疗依据', publisher: '合成发布机构', documentType: 'official-protocol',
      version: '2026', url: 'https://clinmesh.example.com/synthetic-guideline', locator: '第1节',
      scope: '合成病例', text: '仅用于验证建议引用的合成条款。', sourceHash: 'b'.repeat(64),
    }],
    caseEvidence: [{ id: 'synthetic-case-source', kind: 'consultation', label: '合成问诊来源', text: '当前病例的合成患者自述。' }],
    ...overrides,
  }))
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(recommendationState()), {
    headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  cleanup()
  for (const client of queryClients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

function savedState(confirmed = false): DiagnosisState {
  const entries: DiagnosisState['draft'] = { entries: [
    { catalogItemId: 'diagnosis-1', role: 'primary', note: '第一条保存备注' },
    { catalogItemId: 'diagnosis-2', role: 'secondary', note: '第二条保存备注' },
  ] }
  return {
    draft: entries, draftVersion: 1,
    ...(confirmed ? { confirmation: {
      confirmedAt: '2026-10-10T10:00:00+08:00', id: 'synthetic-confirmation', provenanceId: 'synthetic-provenance',
      revisionNumber: 1, entries: entries.entries.map((entry, index) => ({
        ...entry, code: `SYN-${index + 1}`, display: `合成诊断${index + 1}`, conditionId: `condition-${index + 1}`,
        conditionVersion: '1', system: 'https://clinmesh.example.com/icd-10',
      })),
    } } : {}),
  }
}

describe('diagnosis workspace', () => {
  it('shows diagnosis suggestions separately from the editable draft', () => {
    render(<DiagnosisPage {...props()} />)
    expect(screen.getByRole('region', { name: '待确认诊断' })).toBeTruthy()
  })
  it('confirms prepared diagnoses together with current manual roles and an unsaved note in one narrow request', async () => {
    const source = diagnosisSuggestionState()
    const recommendations = diagnosisSuggestionState({ items: source.items.map(item => item.kind === 'diagnosis' ? { ...item, role: 'secondary' } : item) })
    const confirmations: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) {
        confirmations.push(confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body))))
        return Response.json(confirmDoctorPreparationResponseSchema.parse({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
          data: { kind: 'diagnosis', draftVersion: 2, encounterVersion: '1', recordIds: ['condition-1', 'condition-2', 'condition-3'] } }))
      }
      return Response.json(recommendations)
    }))
    const referenceConcept = { id: 'diagnosis-1', code: 'SYN-1', display: '合成诊断1',
      system: 'https://clinmesh.example.com/icd-10', version: '1', sourceLocator: 'synthetic:reference-diagnosis' }
    const saved = savedState()
    if (saved.draft === undefined) throw new Error('Expected saved diagnosis draft')
    const page = props({ state: { ...saved, draft: { entries: saved.draft.entries.map((entry, index) => index === 0
      ? { ...entry, referenceConcept } : entry) } } })
    render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: page.messages.diagnosisNote }), ' · 医生刚补充')
    const panel = within(screen.getByRole('region', { name: '待确认诊断' }))
    await panel.findByRole('checkbox', { name: '选择合成建议诊断3' })
    expect(panel.getByRole('checkbox', { name: '选择合成诊断1' }).getAttribute('aria-checked')).toBe('true')
    expect(panel.getByRole('checkbox', { name: '选择合成诊断2' }).getAttribute('aria-checked')).toBe('true')
    await user.click(panel.getByRole('button', { name: /^确认选中诊断/ }))
    await waitFor(() => expect(confirmations).toEqual([{ expectedVersions: { 'Encounter/synthetic-encounter': '1' }, input: {
      generation: 1, inputFingerprint: 'a'.repeat(64), expectedDraftVersion: 1,
      selections: [
        { source: 'manual', kind: 'diagnosis', catalogItemId: 'diagnosis-1', role: 'primary', note: '第一条保存备注 · 医生刚补充', referenceConcept },
        { source: 'manual', kind: 'diagnosis', catalogItemId: 'diagnosis-2', role: 'secondary', note: '第二条保存备注' },
        { source: 'agent', suggestionId: 'suggestion-diagnosis-3', kind: 'diagnosis', catalogItemId: 'diagnosis-3', role: 'secondary' },
      ],
    } }]))
    expect(screen.getByRole('textbox', { name: page.messages.diagnosisNote })).toHaveProperty('value', '第一条保存备注 · 医生刚补充')
    expect(page.actions.confirm.onSubmit).not.toHaveBeenCalled()
  })
  it('keeps the original manual role and note when an automatic candidate names the same diagnosis', async () => {
    const source = diagnosisSuggestionState()
    const candidate = source.items[0]!
    if (candidate.kind !== 'diagnosis') throw new Error('Expected diagnosis')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(diagnosisSuggestionState({ items: [{ ...candidate, catalogItemId: 'diagnosis-1' }] }))))
    const page = props({ state: savedState() })
    render(<DiagnosisPage {...page} />)
    const panel = within(screen.getByRole('region', { name: '待确认诊断' }))
    await panel.findByRole('checkbox', { name: '选择合成诊断1' })
    expect(panel.getAllByRole('checkbox')).toHaveLength(2)
    expect(panel.queryByRole('checkbox', { name: '选择合成建议诊断3' })).toBeNull()
    expect(screen.getByRole('textbox', { name: page.messages.diagnosisNote })).toHaveProperty('value', '第一条保存备注')
    expect(screen.getByRole('button', { name: page.messages.primaryDiagnosis }).getAttribute('aria-pressed')).toBe('true')
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it.each(['save', 'confirm'] as const)('blocks prepared diagnosis confirmation while manual %s is pending', async operation => {
    const page = props({ state: savedState() })
    page.actions[operation].pending = true
    render(<DiagnosisPage {...page} />)
    const panel = within(screen.getByRole('region', { name: '待确认诊断' }))
    await panel.findByRole('checkbox', { name: '选择合成诊断1' })
    expect(panel.getByRole('button', { name: /^确认选中诊断/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('textbox', { name: page.messages.diagnosisNote })).toHaveProperty('value', '第一条保存备注')
  })
  it('does not allow prepared diagnosis confirmation once the draft already contains eight diagnoses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(diagnosisSuggestionState()), {
      headers: { 'content-type': 'application/json' },
    })))
    const page = props({ state: { draftVersion: 1, draft: { entries: [
      ...savedState().draft!.entries,
      ...[4, 5, 6, 7, 8, 9].map(id => ({ catalogItemId: `diagnosis-${id}`, role: 'secondary' as const })),
    ] } } })
    render(<DiagnosisPage {...page} />)
    await within(screen.getByRole('region', { name: '待确认诊断' })).findByRole('checkbox', { name: '选择合成建议诊断3' })
    const confirmPrepared = within(screen.getByRole('region', { name: '待确认诊断' })).getByRole('button', { name: /^确认选中诊断/ })
    expect(confirmPrepared.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(page.messages.recommendationDiagnosisLimit)).toBeTruthy()
    await userEvent.setup().click(confirmPrepared)
    expect(within(screen.getByRole('group', { name: '已选诊断' })).getAllByRole('button')).toHaveLength(8)
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('disables a local candidate when its diagnosis is removed from the currently available catalog', async () => {
    const source = diagnosisSuggestionState()
    const candidate = source.items[0]!
    if (candidate.kind !== 'diagnosis') throw new Error('Expected the synthetic diagnosis candidate')
    const recommendations = diagnosisSuggestionState({ items: [{
      ...candidate, catalogItemId: 'diagnosis-2', label: '合成诊断2', referenceConcept: {
        id: 'diagnosis-2', code: 'SYN-2', display: '合成诊断2',
        system: 'https://clinmesh.example.com/icd-10', version: '1', sourceLocator: 'operational:diagnosis_catalog',
      },
    }] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(recommendations), {
      headers: { 'content-type': 'application/json' },
    })))
    const page = props()
    const { rerender } = render(<DiagnosisPage {...page} />)
    await within(screen.getByRole('region', { name: '待确认诊断' })).findByRole('checkbox', { name: '选择合成诊断2' })
    const confirmPrepared = within(screen.getByRole('region', { name: '待确认诊断' })).getByRole('button', { name: /^确认选中诊断/ })
    expect(confirmPrepared.hasAttribute('disabled')).toBe(false)
    rerender(<DiagnosisPage {...page} catalog={[page.catalog[0]!]} />)
    expect(confirmPrepared.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(page.messages.recommendationDiagnosisUnavailable)).toBeTruthy()
    await userEvent.setup().click(confirmPrepared)
    expect(screen.queryByRole('group', { name: '已选诊断' })).toBeNull()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('disables a reference candidate that the current directory marks inactive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(diagnosisSuggestionState()), {
      headers: { 'content-type': 'application/json' },
    })))
    const page = props()
    const activeSearch = { ...page.referenceSearch, data: {
      ...page.referenceSearch.data!, total: 3, items: [...page.referenceSearch.data!.items, {
        id: 'diagnosis-3', code: 'SYN-3', display: '合成建议诊断3', domain: 'diagnosis' as const,
        sourceLocator: 'synthetic:reference-diagnosis', system: 'https://clinmesh.example.com/icd-10', version: '1', status: 'active' as const,
      }],
    } }
    const { rerender } = render(<DiagnosisPage {...page} referenceSearch={activeSearch} />)
    await within(screen.getByRole('region', { name: '待确认诊断' })).findByRole('checkbox', { name: '选择合成建议诊断3' })
    const confirmPrepared = within(screen.getByRole('region', { name: '待确认诊断' })).getByRole('button', { name: /^确认选中诊断/ })
    expect(confirmPrepared.hasAttribute('disabled')).toBe(false)
    rerender(<DiagnosisPage {...page} referenceSearch={{ ...activeSearch, data: { ...activeSearch.data,
      items: activeSearch.data.items.map(item => item.id === 'diagnosis-3' ? { ...item, status: 'inactive' as const } : item),
    } }} />)
    expect(confirmPrepared.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(page.messages.recommendationDiagnosisUnavailable)).toBeTruthy()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('keeps manual diagnoses and an unsaved note when refreshing suggestions', async () => {
    let recommendations = diagnosisSuggestionState()
    const candidate = recommendations.items[0]!
    if (candidate.kind !== 'diagnosis') throw new Error('Expected the synthetic diagnosis candidate')
    const refreshed = diagnosisSuggestionState({ generation: 2, items: [{
      ...candidate, id: 'suggestion-diagnosis-4', catalogItemId: 'diagnosis-4', label: '合成新候选4',
      referenceConcept: { ...candidate.referenceConcept!, id: 'diagnosis-4', code: 'SYN-4', display: '合成新候选4' },
    }] })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        recommendations = refreshed
        return new Response(JSON.stringify({ data: refreshed, auditId: 'synthetic-audit',
          effects: [], requestId: 'synthetic-refresh', warnings: [] }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(recommendations), { headers: { 'content-type': 'application/json' } })
    }))
    const page = props({ state: savedState() })
    render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待确认诊断' }))
    await panel.findByRole('checkbox', { name: '选择合成建议诊断3' })
    await user.type(screen.getByRole('textbox', { name: page.messages.diagnosisNote }), '医生核实后保留')
    await user.click(panel.getByRole('button', { name: '刷新' }))
    await panel.findByRole('checkbox', { name: '选择合成新候选4' })
    const selected = within(screen.getByRole('group', { name: '已选诊断' }))
    expect(selected.getAllByRole('button')).toHaveLength(2)
    expect(selected.getByRole('button', { name: '合成诊断1' })).toBeTruthy()
    expect(selected.queryByRole('button', { name: '合成新候选4' })).toBeNull()
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注医生核实后保留')
    expect(page.actions.confirm.onSubmit).not.toHaveBeenCalled()
  })
  it.each([
    { scenario: 'the case changes', nextCaseId: 'new-synthetic-case' },
    { scenario: 'the identity scope changes', nextCaseId: 'synthetic-case' },
  ])('does not expose a late recommendation response when $scenario', async ({ nextCaseId }) => {
    const old = diagnosisSuggestionState()
    const candidate = old.items[0]!
    if (candidate.kind !== 'diagnosis') throw new Error('Expected the synthetic diagnosis candidate')
    const current = diagnosisSuggestionState({
      caseId: nextCaseId, encounterId: nextCaseId === old.caseId ? old.encounterId : 'new-synthetic-encounter',
      items: [{ ...candidate, label: '当前病例候选', referenceConcept: { ...candidate.referenceConcept!, display: '当前病例候选' } }],
    })
    let finishPrevious: (response: Response) => void = () => { throw new Error('Previous query has not started') }
    const pendingPrevious = new Promise<Response>(resolve => { finishPrevious = resolve })
    let reads = 0
    const fetch = vi.fn(async () => reads++ === 0
      ? await pendingPrevious
      : new Response(JSON.stringify(current), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const page = props({ recommendationScope: 'previous-actor' })
    const { rerender } = render(<DiagnosisPage {...page} key="previous-case" />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    rerender(<DiagnosisPage {...page} caseId={current.caseId} key="new-case" recommendationScope="current-actor" />)
    const panel = within(screen.getByRole('region', { name: '待确认诊断' }))
    await panel.findByRole('checkbox', { name: '选择当前病例候选' })
    await act(async () => { finishPrevious(new Response(JSON.stringify(old), { headers: { 'content-type': 'application/json' } })) })
    expect(panel.queryByRole('checkbox', { name: '选择合成建议诊断3' })).toBeNull()
    expect(panel.getByRole('button', { name: /^确认选中诊断/ }).hasAttribute('disabled')).toBe(false)
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('starts with an inline directory and waits for an explicit diagnosis selection', () => {
    const page = props()
    render(<DiagnosisPage {...page} />)
    expect(screen.getByRole('textbox', { name: '搜索疾病目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('textbox', { name: page.messages.diagnosisNote })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(page.referenceSearch.onSearch).toHaveBeenCalledExactlyOnceWith('', 1)
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
  })
  it('adds only explicitly chosen diagnoses and keeps notes when switching the selected entry', async () => {
    const page = props()
    render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' }))
    const firstNote = screen.getByRole('textbox', { name: page.messages.diagnosisNote })
    await user.type(firstNote, '第一条的备注')
    expect(screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: '选择 合成诊断2 SYN-2' }))
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` }) as HTMLTextAreaElement).value).toBe('')
    const selected = within(screen.getByRole('group', { name: '已选诊断' }))
    await user.click(selected.getByRole('button', { name: /合成诊断1/ }))
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条的备注')
    expect(selected.getAllByRole('button')).toHaveLength(2)
  })
  it('restores a saved draft inline and enters an editable list and detail view only after formal confirmation', async () => {
    const page = props({ state: savedState() })
    const { rerender } = render(<DiagnosisPage {...page} />)
    expect(screen.getByRole('textbox', { name: '搜索疾病目录' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注')
    expect(screen.queryByRole('region', { name: '诊断列表' })).toBeNull()
    rerender(<DiagnosisPage {...page} state={savedState(true)} />)
    const list = within(screen.getByRole('region', { name: '诊断列表' }))
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
    await userEvent.setup().click(list.getByRole('button', { name: /合成诊断2/ }))
    const editor = within(screen.getByRole('region', { name: '诊断详情' }))
    const note = editor.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` })
    expect((note as HTMLTextAreaElement).value).toBe('第二条保存备注')
    await userEvent.setup().type(note, ' · 已修订')
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
    expect(list.getAllByRole('button', { name: /合成诊断/ })).toHaveLength(2)
  })
  it('filters and returns to the list without deleting diagnoses or losing their notes', async () => {
    const page = props({ state: savedState(true) })
    render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    const list = within(screen.getByRole('region', { name: '诊断列表' }))
    const search = list.getByRole('textbox', { name: '搜索本次诊断' })
    await user.type(search, '不存在的诊断')
    expect(list.getByText('没有匹配的诊断')).toBeTruthy()
    expect(list.queryByRole('button', { name: /合成诊断/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
    await user.click(list.getByRole('button', { name: '查看全部诊断' }))
    expect(list.getAllByRole('button', { name: /合成诊断/ })).toHaveLength(2)
    await user.click(list.getByRole('button', { name: page.messages.secondaryDiagnosis }))
    expect(list.queryByRole('button', { name: /合成诊断1/ })).toBeNull()
    await user.click(list.getByRole('button', { name: /合成诊断2/ }))
    expect(document.activeElement).toBe(within(screen.getByRole('region', { name: '诊断详情' })).getByRole('heading', { name: '合成诊断2' }))
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` }) as HTMLTextAreaElement).value).toBe('第二条保存备注')
    await user.click(screen.getByRole('button', { name: '返回诊断列表' }))
    await waitFor(() => expect(document.activeElement).toBe(search))
    await user.click(list.getByRole('button', { name: /合成诊断2/ }))
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` }) as HTMLTextAreaElement).value).toBe('第二条保存备注')
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('adds a diagnosis in the shared directory and editor dialog and keeps its changes after finishing selection', async () => {
    const page = props({ state: savedState(true) })
    render(<DiagnosisPage {...page} referenceSearch={{ ...page.referenceSearch, data: {
      ...page.referenceSearch.data!, items: [...page.referenceSearch.data!.items, {
        ...page.referenceSearch.data!.items[0]!, id: 'diagnosis-3', code: 'SYN-3', display: '合成诊断3',
      }], total: 3,
    } }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    const dialog = within(screen.getByRole('dialog', { name: '添加诊断' }))
    expect(dialog.getByRole('textbox', { name: '搜索疾病目录' })).toBeTruthy()
    expect(screen.getAllByRole('region', { name: '诊断详情' })).toHaveLength(1)
    await user.click(dialog.getByRole('button', { name: '选择 合成诊断3 SYN-3' }))
    await user.type(dialog.getByRole('textbox', { name: `${page.messages.diagnosisNote} 3` }), '新添加的备注')
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 3` }) as HTMLTextAreaElement).value).toBe('新添加的备注')
    expect(within(screen.getByRole('region', { name: '诊断列表' })).getAllByRole('button', { name: /合成诊断/ })).toHaveLength(3)
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
  })
  it('keeps edited notes after autosave failure and retries the same draft before allowing whole-group confirmation', async () => {
    const page = props({ state: savedState() })
    const { rerender } = render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: page.messages.diagnosisNote }), ' · 补充')
    const editedEntries = [
      { catalogItemId: 'diagnosis-1', role: 'primary' as const, note: '第一条保存备注 · 补充' },
      { catalogItemId: 'diagnosis-2', role: 'secondary' as const, note: '第二条保存备注' },
    ]
    await waitFor(() => expect(page.actions.save.onSubmit).toHaveBeenCalledExactlyOnceWith(editedEntries), { timeout: 2000 })
    const failed = { ...page.actions, save: { ...page.actions.save, error: new Error('synthetic save failure') } }
    rerender(<DiagnosisPage {...page} actions={failed} />)
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注 · 补充')
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: '重试保存' }))
    expect(page.actions.save.onSubmit).toHaveBeenCalledTimes(2)
    expect(page.actions.save.onSubmit).toHaveBeenLastCalledWith(editedEntries)
    const saved = { ...page.actions, save: { ...page.actions.save, success: true, savedRevision: JSON.stringify(editedEntries) } }
    rerender(<DiagnosisPage {...page} actions={saved} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(false))
    rerender(<DiagnosisPage {...page} actions={{ ...saved, save: { ...saved.save, pending: true } }} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
    rerender(<DiagnosisPage {...page} actions={saved} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    await user.click(screen.getByRole('button', { name: page.messages.confirmDiagnosis }))
    const review = within(screen.getByRole('alertdialog', { name: '确认诊断版本' }))
    expect(review.getByText(/SYN-1/)).toBeTruthy()
    expect(review.getByText(/SYN-2/)).toBeTruthy()
    expect(review.getByText('第一条保存备注 · 补充')).toBeTruthy()
    rerender(<DiagnosisPage {...page} actions={{ ...saved, save: { ...saved.save, pending: true } }} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    expect(review.getByRole('button', { name: '确认诊断版本' }).hasAttribute('disabled')).toBe(true)
    rerender(<DiagnosisPage {...page} actions={saved} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    await user.click(review.getByRole('button', { name: '确认诊断版本' }))
    expect(page.actions.confirm.onSubmit).toHaveBeenCalledOnce()
  })
  it('shows confirmed diagnoses in a searchable read-only list and detail view without exposing draft edits', async () => {
    const state = savedState(true)
    const page = props({ readOnly: true, state: { ...state, draft: { entries: [
      { catalogItemId: 'diagnosis-1', role: 'primary', note: '未确认的草稿内容' },
    ] } } })
    render(<DiagnosisPage {...page} />)
    const list = within(screen.getByRole('region', { name: '诊断列表' }))
    expect(list.getByRole('textbox', { name: '搜索本次诊断' })).toBeTruthy()
    expect(list.getAllByRole('button', { name: /合成诊断/ })).toHaveLength(2)
    expect(screen.getByText('第一条保存备注')).toBeTruthy()
    expect(screen.queryByText('未确认的草稿内容')).toBeNull()
    await userEvent.setup().click(list.getByRole('button', { name: /合成诊断2/ }))
    expect(screen.getByText('第二条保存备注')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /诊断备注/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更换诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: /移除诊断/ })).toBeNull()
    expect(screen.queryByRole('button', { name: page.messages.confirmDiagnosis })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
    expect(screen.queryByRole('region', { name: '待确认诊断' })).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('replaces a confirmed diagnosis from the local fallback catalog while keeping its role and note', async () => {
    const { draft: _draft, ...confirmed } = savedState(true)
    const page = props({ state: confirmed })
    render(<DiagnosisPage {...page} catalog={[...page.catalog, {
      id: 'diagnosis-3', code: 'SYN-3', nameZh: '合成诊断3', nameEn: 'Synthetic diagnosis 3',
      system: 'https://clinmesh.example.com/icd-10', version: 1,
    }]} referenceSearch={{ ...page.referenceSearch, isError: true, error: new Error('synthetic catalog failure') }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '更换诊断' }))
    const dialog = within(screen.getByRole('dialog', { name: '选择诊断' }))
    expect(dialog.getByRole('button', { name: '选择 合成诊断2 SYN-2' }).hasAttribute('disabled')).toBe(true)
    await user.click(dialog.getByRole('button', { name: '选择 合成诊断3 SYN-3' }))
    await user.click(dialog.getByRole('button', { name: '加入诊断' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const editor = within(screen.getByRole('region', { name: '诊断详情' }))
    expect(editor.getByRole('heading', { name: '合成诊断3' })).toBeTruthy()
    expect(editor.getByText('SYN-3')).toBeTruthy()
    expect((editor.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注')
    expect(editor.getByRole('button', { name: page.messages.primaryDiagnosis }).getAttribute('aria-pressed')).toBe('true')
  })
})
