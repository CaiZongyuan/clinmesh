// @vitest-environment jsdom
import type { CaseLaboratoryCatalogSearch, DoctorCaseDetail, LaboratoryReport, LaboratoryRequest } from '@clinmesh/contracts/his'
import type { DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render as renderView, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { LaboratoryPage } from './laboratory-page.tsx'

const service: CaseLaboratoryCatalogSearch['items'][number] = {
  allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: [], doctorOrderable: true,
  executingDepartmentId: 'laboratory', id: 'synthetic-laboratory-service', localCode: 'SYN-LAB',
  nameEn: 'Synthetic laboratory test', nameZh: '合成检验项目', priceFen: 2500,
  referenceConcept: { id: 'synthetic-reference', code: 'SYN-1', display: '合成检验项目',
    system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test' },
  referenceReleaseId: 'synthetic-release', reportDefinition: {
    conclusionTemplate: '合成检验结果。', results: [{
      referenceConcept: { id: 'synthetic-reference', code: 'SYN-1', display: '合成指标',
        system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test' },
      alternateCodings: [], referenceRange: { low: 0, high: 10, text: '0–10' },
      unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, valueType: 'quantity',
    }],
  }, specimen: { code: 'blood', display: '静脉血' }, serviceKind: 'laboratory', tatMinutes: 180, version: 1,
}
const detail: DoctorCaseDetail = {
  allergies: [], caseId: 'synthetic-case', consultation: { turns: [], version: 1 },
  encounter: { id: 'synthetic-encounter', versionId: '1' },
  laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
  patient: { id: 'synthetic-patient', identifier: 'SYN-1', name: '合成患者', synthetic: true, versionId: '1' },
  presentation: null, priorFacts: [], status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
}
function report(conclusion: string, id: string): LaboratoryReport {
  return {
    conclusion, diagnosticReportId: id, diagnosticReportVersion: '1', issuedAt: '2026-10-10T10:00:00+08:00',
    revisionNumber: 1, specimenId: 'synthetic-specimen', status: 'final', results: [{
      code: 'SYN-1', display: '合成指标', interpretation: 'high', observationId: `observation-${id}`,
      referenceRange: { low: 0, high: 10, text: '0–10' },
      unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, value: 12,
    }],
  }
}
function request(id: string, name: string, conclusion: string): LaboratoryRequest {
  return {
    catalogItemId: service.id, id, indicationCode: 'clinical-evaluation', laboratoryService: { ...service, nameZh: name },
    previousReports: [], report: report(conclusion, `report-${id}`),
    serviceRequestId: `service-request-${id}`, serviceRequestVersion: '1', status: 'reported',
    taskId: `task-${id}`, taskVersion: '1', version: 1,
  }
}
function props(overrides: Partial<ComponentProps<typeof LaboratoryPage>> = {}): ComponentProps<typeof LaboratoryPage> {
  return {
    actions: {
      acknowledge: { error: null, onSubmit: vi.fn(), pending: false },
      cancel: { error: null, onSubmit: vi.fn(), pending: false },
      correct: { allowed: false, error: null, onSubmit: vi.fn(), pending: false },
      deleteDraft: { error: null, onSubmit: vi.fn(), pending: false },
      issue: { error: null, onSubmit: vi.fn(), pending: false },
      retry: { error: null, onSubmit: vi.fn(), pending: false },
      save: { error: null, onSubmit: vi.fn(), pending: false },
    }, catalogError: null, catalogPending: false, detail, elementId: 'laboratory', indicationCode: '',
    issueLegacyOrderError: null, issueLegacyOrderPending: false, laboratoryCatalog: [], laboratoryItemId: '',
    locale: 'zh-CN', messages: getWorkspaceMessages('zh-CN'), onIndicationChange: vi.fn(),
    onIssueLegacyOrder: vi.fn(), onLaboratoryItemChange: vi.fn(), readOnly: false,
    referenceSearch: { data: { items: [service], page: 1, pageSize: 20, total: 1 },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }, showCorrection: false,
    ...overrides,
  }
}
function render(element: Parameters<typeof renderView>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderView(element, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
function recommendations(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return {
    caseId: detail.caseId, kind: 'laboratory', encounterId: detail.encounter.id, encounterVersion: '1',
    inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, missingInformation: [], stale: false,
    guidelines: [{ id: 'synthetic-guideline', title: '合成检验指南', publisher: '合成发布机构',
      documentType: 'official-protocol', version: '1', url: 'https://example.test/synthetic-guideline',
      locator: '检查章节', scope: '合成成人病例', text: '结合已知病情核对检验指征。', sourceHash: 'b'.repeat(64) }],
    caseEvidence: [{ id: 'synthetic-case-evidence', kind: 'consultation', label: '患者回答', text: '已核实的合成症状' }],
    items: [{ id: 'synthetic-laboratory-suggestion', kind: 'laboratory', label: service.nameZh,
      catalogItemId: service.id, indicationCode: 'clinical-evaluation', rationale: '依据当前病例核对检验项目。',
      supportingInformation: ['已核实的合成症状'], opposingInformation: [], missingInformation: [],
      guidelineEvidenceIds: ['synthetic-guideline'], caseEvidenceIds: ['synthetic-case-evidence'],
    }],
    ...overrides,
  }
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendations({ items: [] })))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('laboratory investigation workspace', () => {
  it('adopts a recommended hospital service into the editable request without opening it formally', async () => {
    const recommendationState = recommendations()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')
        ? Response.json({ items: [service], page: 1, pageSize: 20, total: 1 })
        : Response.json(recommendationState)
    )))
    const page = props({ detail: { ...detail, laboratoryRequests: { draftVersion: 0, reportingSupported: true,
      requests: [request('first', '已有合成申请', '已有合成报告')] } } })
    page.referenceSearch = { ...page.referenceSearch, data: { items: [], page: 1, pageSize: 20, total: 0 } }
    function ControlledPage() {
      const [itemId, setItemId] = useState('')
      const [indication, setIndication] = useState('')
      return <LaboratoryPage {...page} laboratoryItemId={itemId} indicationCode={indication}
        onLaboratoryItemChange={setItemId} onIndicationChange={setIndication} />
    }
    render(<ControlledPage />)

    expect(await screen.findByText('依据当前病例核对检验项目。')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: /采纳/ }))
    const editor = within(await screen.findByRole('dialog', { name: '追加申请' }))
    const draft = within(editor.getByRole('region', { name: '检验申请' }))
    expect(draft.getByText('合成检验项目')).toBeTruthy()
    expect(draft.getByText('临床评估')).toBeTruthy()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    { change: 'generation', latest: recommendations({ generation: 2 }) },
    { change: 'input fingerprint', latest: recommendations({ inputFingerprint: 'c'.repeat(64) }) },
    { change: 'stale sources', latest: recommendations({ stale: true }) },
    { change: 'pending generation', latest: recommendations({ status: 'pending' }) },
    { change: 'missing evidence', latest: recommendations({ status: 'missing-evidence', items: [] }) },
    { change: 'failed generation', latest: recommendations({ status: 'failed', items: [] }) },
    { change: 'case identity', latest: recommendations({ caseId: 'other-case' }) },
    { change: 'recommendation kind', latest: recommendations({ kind: 'diagnosis', items: [] }) },
    { change: 'suggestion removal', latest: recommendations({ items: [] }) },
    { change: 'suggestion content', latest: recommendations({ items: [{ ...recommendations().items[0]!, rationale: '当前检验建议已经更正。' }] }) },
  ])('does not adopt after the backend changes the $change while its catalog lookup is pending', async ({ latest }) => {
    let resolveCatalog: (response: Response) => void = () => undefined
    const catalogResponse = new Promise<Response>(resolve => { resolveCatalog = resolve })
    let catalogRequested = false
    let current = recommendations()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')) {
        catalogRequested = true
        return catalogResponse
      }
      return Response.json(current)
    }))
    const page = props()
    render(<LaboratoryPage {...page} />)
    const adopt = await screen.findByRole('button', { name: '采纳 合成检验项目' })
    await userEvent.setup().click(adopt)
    await waitFor(() => expect(catalogRequested).toBe(true))
    current = latest
    await act(async () => { resolveCatalog(Response.json({ items: [service], page: 1, pageSize: 20, total: 1 })) })
    await waitFor(() => expect(adopt.hasAttribute('disabled')).toBe(false))
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the draft empty when a manual refresh replaces the generation during a pending catalog lookup', async () => {
    let resolveCatalog: (response: Response) => void = () => undefined
    const catalogResponse = new Promise<Response>(resolve => { resolveCatalog = resolve })
    let catalogRequested = false
    let current = recommendations()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')) {
        catalogRequested = true
        return catalogResponse
      }
      if (init?.method === 'POST') {
        current = recommendations({ generation: 2, items: [{ ...current.items[0]!, rationale: '手动刷新后的检验建议。' }] })
        return Response.json({ data: current, auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-request', warnings: [] })
      }
      return Response.json(current)
    }))
    const page = props()
    render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    const adopt = await screen.findByRole('button', { name: '采纳 合成检验项目' })
    await user.click(adopt)
    await waitFor(() => expect(catalogRequested).toBe(true))
    const refresh = screen.getByRole('button', { name: '刷新建议' })
    await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false))
    await user.click(refresh)
    await screen.findByText('手动刷新后的检验建议。')
    await act(async () => { resolveCatalog(Response.json({ items: [service], page: 1, pageSize: 20, total: 1 })) })
    await waitFor(() => expect(adopt.hasAttribute('disabled')).toBe(false))
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the draft empty and reports a failed final recommendation check', async () => {
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')) {
        return Response.json({ items: [service], page: 1, pageSize: 20, total: 1 })
      }
      if (++reads === 3) return Response.json({ error: { code: 'MODEL_UNAVAILABLE', message: '合成最终核对失败。' } }, { status: 503 })
      return Response.json(recommendations())
    }))
    const page = props()
    render(<LaboratoryPage {...page} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: '采纳 合成检验项目' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(screen.getByText('尚未选择检验项目')).toBeTruthy()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    { bindingField: 'recommendationScope', stage: 'catalog' },
    { bindingField: 'recommendationRevision', stage: 'catalog' },
    { bindingField: 'recommendationScope', stage: 'recommendation check' },
    { bindingField: 'recommendationRevision', stage: 'recommendation check' },
  ] as const)('does not resume a pending $stage after $bindingField changes and returns', async ({ bindingField, stage }) => {
    let resolvePending: (response: Response) => void = () => undefined
    const pendingResponse = new Promise<Response>(resolve => { resolvePending = resolve })
    const catalog = { items: [service], page: 1, pageSize: 20, total: 1 }
    let pendingRequested = false
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')) {
        if (stage !== 'catalog') return Response.json(catalog)
      } else if (stage !== 'recommendation check' || ++reads !== 3) {
        return Response.json(recommendations())
      }
      pendingRequested = true
      return pendingResponse
    }))
    const page = props()
    const binding = { recommendationScope: 'synthetic-role-first', recommendationRevision: '1' }
    const { rerender } = render(<LaboratoryPage {...page} {...binding} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /采纳/ }))
    await waitFor(() => expect(pendingRequested).toBe(true))
    rerender(<LaboratoryPage {...page} {...binding} {...{ [bindingField]: 'next' }} />)
    rerender(<LaboratoryPage {...page} {...binding} />)
    await act(async () => { resolvePending(Response.json(stage === 'catalog' ? catalog : recommendations())) })

    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(screen.getByText('尚未选择检验项目')).toBeTruthy()
  })

  it.each(['catalog', 'recommendation check'] as const)('keeps an examination selected manually while the %s is pending', async stage => {
    let resolvePending: (response: Response) => void = () => undefined
    const pendingResponse = new Promise<Response>(resolve => { resolvePending = resolve })
    const catalog = { items: [service], page: 1, pageSize: 20, total: 1 }
    let pendingRequested = false
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')) {
        if (stage !== 'catalog') return Response.json(catalog)
      } else if (stage !== 'recommendation check' || ++reads !== 3) {
        return Response.json(recommendations())
      }
      pendingRequested = true
      return pendingResponse
    }))
    const manualService = { ...service, id: 'synthetic-manual-service', nameZh: '人工选择的合成项目' }
    function ControlledPage() {
      const [itemId, setItemId] = useState('')
      const [indication, setIndication] = useState('')
      const page = props()
      return <LaboratoryPage {...page} laboratoryItemId={itemId} indicationCode={indication}
        onLaboratoryItemChange={setItemId} onIndicationChange={setIndication}
        referenceSearch={{ ...page.referenceSearch, data: { items: [manualService], page: 1, pageSize: 20, total: 1 } }} />
    }
    render(<ControlledPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /采纳/ }))
    await waitFor(() => expect(pendingRequested).toBe(true))
    await user.click(screen.getByRole('button', { name: '选择 人工选择的合成项目 SYN-1' }))
    await act(async () => { resolvePending(Response.json(stage === 'catalog' ? catalog : recommendations())) })

    const draft = within(screen.getByRole('region', { name: '检验申请' }))
    expect(draft.getByText('人工选择的合成项目')).toBeTruthy()
    expect(draft.queryByText('合成检验项目')).toBeNull()
  })

  it.each(['catalog', 'recommendation check'] as const)('does not write a pending %s back through the parent after the editor unmounts', async stage => {
    let resolvePending: (response: Response) => void = () => undefined
    const pendingResponse = new Promise<Response>(resolve => { resolvePending = resolve })
    const catalog = { items: [service], page: 1, pageSize: 20, total: 1 }
    let pendingRequested = false
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')) {
        if (stage !== 'catalog') return Response.json(catalog)
      } else if (stage !== 'recommendation check' || ++reads !== 3) {
        return Response.json(recommendations())
      }
      pendingRequested = true
      return pendingResponse
    }))
    const page = props()
    const { unmount } = render(<LaboratoryPage {...page} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /采纳/ }))
    await waitFor(() => expect(pendingRequested).toBe(true))
    unmount()
    await act(async () => { resolvePending(Response.json(stage === 'catalog' ? catalog : recommendations())) })
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
  })

  it.each(['saved', 'unsaved'] as const)('requires the doctor to resolve the current %s draft before another adoption', async mode => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendations())))
    const page = props({ laboratoryItemId: service.id, indicationCode: 'clinical-evaluation',
      detail: { ...detail, laboratoryRequests: { draftVersion: mode === 'saved' ? 1 : 0,
        reportingSupported: true, requests: [], ...(mode === 'saved' ? {
          draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
        } : {}),
      } },
    })
    render(<LaboratoryPage {...page} />)
    expect((await screen.findByRole('button', { name: /采纳/ })).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(page.messages.recommendationDraftNeedsResolution)).toBeTruthy()
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
  })

  it('keeps the draft empty when the recommended item is no longer in the hospital catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(
      new URL(String(input), 'http://localhost').pathname.endsWith('/reference-catalogs/laboratory')
        ? { items: [], page: 1, pageSize: 20, total: 0 } : recommendations(),
    )))
    const page = props()
    render(<LaboratoryPage {...page} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /采纳/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(screen.getByText('尚未选择检验项目')).toBeTruthy()
  })

  it('shows the searchable directory without selecting an item or an empty report area when no request exists', () => {
    const page = props()
    render(<LaboratoryPage {...page} />)
    expect(screen.getByRole('textbox', { name: '搜索检验目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择 合成检验项目 SYN-1' }).getAttribute('aria-pressed')).toBe('false')
    expect(page.referenceSearch.onSearch).toHaveBeenCalledExactlyOnceWith('', 1)
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(screen.queryByText(page.messages.noLaboratoryRequests)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('shows only the selected current report when requests exist and switches it from the request list', async () => {
    const page = props({ detail: { ...detail, laboratoryRequests: { draftVersion: 0, reportingSupported: true,
      requests: [request('first', '合成第一项', '第一份结论'), request('second', '合成第二项', '第二份结论')] } } })
    render(<LaboratoryPage {...page} />)
    expect(screen.getByText('第一份结论')).toBeTruthy()
    expect(screen.queryByText('第二份结论')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /合成第二项/ }))
    expect(screen.getByText('第二份结论')).toBeTruthy()
    expect(screen.queryByText('第一份结论')).toBeNull()
  })
  it('starts with all report indicators and can filter to abnormal indicators without hiding their values', async () => {
    const current = request('first', '合成第一项', '第一份结论')
    current.report = { ...report('第一份结论', 'report-first'), results: [
      ...report('第一份结论', 'report-first').results,
      { code: 'SYN-2', display: '合成正常指标', interpretation: 'normal', observationId: 'normal-observation',
        referenceRange: { low: 0, high: 10, text: '0–10' },
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, value: 5 },
    ] }
    render(<LaboratoryPage {...props({ detail: { ...detail, laboratoryRequests: { draftVersion: 0,
      reportingSupported: true, requests: [current] } } })} />)
    expect(screen.getByText('合成正常指标')).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /仅异常/ }))
    expect(screen.queryByText('合成正常指标')).toBeNull()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('mg/L')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '全部指标' }))
    expect(screen.getByText('合成正常指标')).toBeTruthy()
  })
  it('keeps previous reports collapsed until requested and opens a report reached through historical navigation', async () => {
    const current = request('first', '合成第一项', '当前结论')
    current.previousReports = [report('历史结论', 'historical-report')]
    current.report = { ...report('当前结论', 'current-report'), revisionNumber: 2,
      revisionOfDiagnosticReportId: 'historical-report', revisionReason: '更正合成指标' }
    const page = props({ detail: { ...detail, laboratoryRequests: { draftVersion: 0,
      reportingSupported: true, requests: [current] } } })
    const { rerender } = render(<LaboratoryPage {...page} />)
    const history = screen.getByText(page.messages.laboratoryReportHistory).closest('details')
    expect(history?.open).toBe(false)
    await userEvent.setup().click(screen.getByText(page.messages.laboratoryReportHistory))
    expect(history?.open).toBe(true)
    expect(within(history!).getByText('历史结论')).toBeTruthy()
    await userEvent.setup().click(screen.getByText(page.messages.laboratoryReportHistory))
    expect(history?.open).toBe(false)
    rerender(<LaboratoryPage {...page} selectedReportId="historical-report" />)
    expect(history?.open).toBe(true)
  })
  it('shows the selected hospital service specimen, turnaround, price and allowed indication beside the directory', async () => {
    function Page() {
      const [itemId, setItemId] = useState('')
      return <LaboratoryPage {...props({ laboratoryItemId: itemId, onLaboratoryItemChange: setItemId })} />
    }
    render(<Page />)
    await userEvent.setup().click(screen.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    const editor = within(screen.getByRole('region', { name: '检验申请' }))
    expect(editor.getByText('静脉血')).toBeTruthy()
    expect(editor.getByText('180 min')).toBeTruthy()
    expect(editor.getByText(/25/)).toBeTruthy()
    expect(editor.getByText('临床评估')).toBeTruthy()
    expect(editor.queryByRole('button', { name: '开具检验申请' })).toBeNull()
  })
  it('preserves the selected request information while searching the inline directory for another project', async () => {
    const page = props()
    function Page() {
      const [itemId, setItemId] = useState('')
      return <LaboratoryPage {...page} laboratoryItemId={itemId} onLaboratoryItemChange={setItemId} />
    }
    render(<Page />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    await user.type(screen.getByRole('textbox', { name: '搜索检验目录' }), '另一个项目')
    await waitFor(() => expect(page.referenceSearch.onSearch).toHaveBeenCalledWith('另一个项目', 1))
    expect(within(screen.getByRole('region', { name: '检验申请' })).getByText('合成检验项目')).toBeTruthy()
  })
  it('keeps a saved draft in the append dialog through autosave and issue failures, then selects the issued request', async () => {
    const current = request('first', '合成第一项', '第一份结论')
    const state = { draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
      draftVersion: 1, reportingSupported: true, requests: [current] }
    const page = props({ detail: { ...detail, laboratoryRequests: state }, laboratoryItemId: service.id,
      indicationCode: 'clinical-evaluation' })
    const { rerender } = render(<LaboratoryPage {...page} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '追加申请' }))
    const dialog = screen.getByRole('dialog', { name: '追加申请' })
    rerender(<LaboratoryPage {...page} detail={{ ...detail, laboratoryRequests: { ...state, draftVersion: 2 } }} />)
    expect(screen.getByRole('dialog', { name: '追加申请' })).toBe(dialog)
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, save: { ...page.actions.save, pending: true } }} />)
    expect(within(dialog).getByRole('button', { name: '开具检验申请' }).hasAttribute('disabled')).toBe(true)
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, issue: { ...page.actions.issue, error: new Error('synthetic failure') } }} />)
    expect(within(dialog).getByRole('alert')).toBeTruthy()
    await userEvent.setup().click(within(dialog).getByRole('button', { name: '开具检验申请' }))
    expect(page.actions.issue.onSubmit).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog', { name: '追加申请' })).toBe(dialog)
    const issued = { ...request('new', '合成新项目', ''), status: 'issued' as const }
    delete issued.report
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, issue: { ...page.actions.issue, successRequestId: 'new' } }}
      detail={{ ...detail, laboratoryRequests: { draftVersion: 3, reportingSupported: true, requests: [issued, current] } }} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('region', { name: '合成新项目' })).toBeTruthy()
    expect(screen.queryByText('第一份结论')).toBeNull()
  })
  it('keeps read-only requests readable without exposing catalog or append controls', () => {
    render(<LaboratoryPage {...props({ readOnly: true, detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [request('first', '合成第一项', '第一份结论')] } } })} />)
    expect(screen.getByText('第一份结论')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '追加申请' })).toBeNull()
    expect(screen.queryByRole('button', { name: /确认已阅/ })).toBeNull()
  })
  it('keeps cancelled records in management when a request search or progress filter has no matches', async () => {
    const cancelled: LaboratoryRequest = { ...request('cancelled', '已取消合成项目', ''), status: 'cancelled' }
    delete cancelled.report
    render(<LaboratoryPage {...props({ detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [cancelled] } } })} />)
    const user = userEvent.setup()
    const list = within(screen.getByRole('region', { name: '申请列表' }))
    expect(list.getByRole('button', { name: /已取消合成项目/ })).toBeTruthy()
    await user.click(list.getByRole('button', { name: '进行中' }))
    expect(list.getByText('没有匹配的申请')).toBeTruthy()
    expect(screen.getByRole('button', { name: '追加申请' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    await user.click(list.getByRole('button', { name: '查看全部申请' }))
    await user.type(list.getByRole('textbox', { name: '搜索申请' }), '没有这个项目')
    expect(list.getByText('没有匹配的申请')).toBeTruthy()
    await user.click(list.getByRole('button', { name: '查看全部申请' }))
    expect(list.getByRole('button', { name: /已取消合成项目/ })).toBeTruthy()
    expect(list.getByRole('textbox', { name: '搜索申请' }).getAttribute('value')).toBe('')
  })
  it('keeps the first saved request recoverable after issue failure and enters management only when the issued record arrives', async () => {
    const state = { draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
      draftVersion: 1, reportingSupported: true, requests: [] }
    const onSelectRequest = vi.fn()
    const page = props({ detail: { ...detail, laboratoryRequests: state }, laboratoryItemId: service.id,
      indicationCode: 'clinical-evaluation', onSelectRequest })
    const { rerender } = render(<LaboratoryPage {...page} />)
    const editor = within(screen.getByRole('region', { name: '检验申请' }))
    expect(screen.getByRole('textbox', { name: '搜索检验目录' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '申请列表' })).toBeNull()
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, issue: { ...page.actions.issue, pending: true } }} />)
    expect(editor.getByRole('button', { name: '开具检验申请' }).hasAttribute('disabled')).toBe(true)
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, issue: { ...page.actions.issue,
      error: new Error('synthetic issue failure') } }} />)
    expect(editor.getByRole('alert')).toBeTruthy()
    expect(editor.getByText('合成检验项目')).toBeTruthy()
    await userEvent.setup().click(editor.getByRole('button', { name: '开具检验申请' }))
    expect(page.actions.issue.onSubmit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: '申请列表' })).toBeNull()
    const successActions = { ...page.actions, issue: { ...page.actions.issue, successRequestId: 'first-issued' } }
    rerender(<LaboratoryPage {...page} actions={successActions} />)
    expect(screen.getByRole('textbox', { name: '搜索检验目录' })).toBeTruthy()
    const issued: LaboratoryRequest = { ...request('first-issued', '合成新申请', ''), status: 'issued' }
    delete issued.report
    rerender(<LaboratoryPage {...page} actions={successActions} laboratoryItemId="" indicationCode=""
      detail={{ ...detail, laboratoryRequests: { draftVersion: 2, reportingSupported: true, requests: [issued] } }} />)
    expect(screen.getByRole('region', { name: '申请列表' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '合成新申请' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    await waitFor(() => expect(onSelectRequest).toHaveBeenCalledWith('first-issued'))
  })
  it('acknowledges the current report and can return to all requests after the last unread report is acknowledged', async () => {
    const current = request('first', '合成第一项', '当前结论')
    current.previousReports = [report('历史结论', 'historical-report')]
    const page = props({ detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [current] } } })
    const { rerender } = render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    const list = within(screen.getByRole('region', { name: '申请列表' }))
    await user.click(list.getByRole('button', { name: '待阅' }))
    await user.click(screen.getByRole('button', { name: '确认已阅 合成第一项' }))
    expect(page.actions.acknowledge.onSubmit).toHaveBeenCalledExactlyOnceWith(current)
    const acknowledged: LaboratoryRequest = { ...current, status: 'acknowledged', report: {
      ...current.report!, acknowledgement: { id: 'synthetic-acknowledgement', acknowledgedBy: 'synthetic-doctor',
        acknowledgedAt: '2026-10-10T10:30:00+08:00' } } }
    rerender(<LaboratoryPage {...page} detail={{ ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [acknowledged] } }} />)
    expect(screen.getByText('共 1 份申请 · 0 份待阅')).toBeTruthy()
    expect(list.getByText('没有匹配的申请')).toBeTruthy()
    expect(screen.getByText('当前结论')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认已阅 合成第一项' })).toBeNull()
    await user.click(list.getByRole('button', { name: '查看全部申请' }))
    expect(list.getByRole('button', { name: /合成第一项/ }).getAttribute('aria-pressed')).toBe('true')
  })
  it('pages the inline directory, retries a failed page and resets to page one for an unmatched search', async () => {
    const page = props()
    const firstSearch = { ...page.referenceSearch, data: { items: [service], page: 1, pageSize: 1, total: 2 } }
    const { rerender } = render(<LaboratoryPage {...page} referenceSearch={firstSearch} />)
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: '下一页' }))
    expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('', 2)
    rerender(<LaboratoryPage {...page} referenceSearch={{ ...firstSearch, error: new Error('synthetic catalog failure'), isError: true }} />)
    expect(screen.getByRole('alert').textContent).toContain('无法加载本院检验目录')
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('', 2)
    const secondSearch = { ...firstSearch, data: { items: [{ ...service, id: 'second-service', nameZh: '合成第二页项目' }],
      page: 2, pageSize: 1, total: 2 } }
    rerender(<LaboratoryPage {...page} referenceSearch={secondSearch} />)
    expect(screen.getByRole('button', { name: '选择 合成第二页项目 SYN-1' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
    await user.type(screen.getByRole('textbox', { name: '搜索检验目录' }), '没有这个项目')
    await waitFor(() => expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('没有这个项目', 1))
    rerender(<LaboratoryPage {...page} referenceSearch={{ ...firstSearch,
      data: { items: [], page: 1, pageSize: 1, total: 0 } }} />)
    expect(screen.getByText('没有匹配记录')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('table')).toBeNull()
  })
})
