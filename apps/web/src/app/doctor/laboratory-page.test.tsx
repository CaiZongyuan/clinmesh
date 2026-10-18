// @vitest-environment jsdom
import type { CaseLaboratoryCatalogSearch, DoctorCaseDetail, LaboratoryReport, LaboratoryRequest } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
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
  it.each(['zh-CN', 'en-US'] as const)('lets a doctor cancel incompatible truth without offering a retry in %s', async locale => {
    const failed: LaboratoryRequest = {
      ...request('failed', '不兼容合成检验', ''), status: 'generation-failed',
      generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE', message: 'Synthetic truth unit mismatch' },
    }
    delete failed.report
    const page = props({ locale, messages: getWorkspaceMessages(locale), detail: {
      ...detail, laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [failed] },
    } })
    render(<LaboratoryPage {...page} />)
    expect(screen.getByText(locale === 'zh-CN'
      ? '该病例的合成检验真值与申请的结果定义或单位不兼容，无法生成结果。请取消此申请。'
      : 'This case’s synthetic laboratory truth is incompatible with the requested result definition or unit. Cancel this request.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /重试结果生成|Retry result generation/ })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `${page.messages.cancelLaboratoryRequest} ${locale === 'zh-CN' ? '不兼容合成检验' : service.nameEn}` }))
    const confirmation = within(screen.getByRole('alertdialog', { name: page.messages.cancelLaboratoryRequestTitle }))
    expect(confirmation.getByText(page.messages.laboratoryRequestStatus_generationFailed)).toBeTruthy()
    expect(page.actions.cancel.onSubmit).not.toHaveBeenCalled()
    await user.click(confirmation.getByRole('button', { name: page.messages.confirmCancelLaboratoryRequest }))
    expect(page.actions.cancel.onSubmit).toHaveBeenCalledExactlyOnceWith(failed)
    expect(page.actions.retry.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['INVESTIGATION_OUTPUT_INVALID', 'AI_TIMEOUT', 'AI_REQUEST_FAILED', 'INVESTIGATION_UNSUPPORTED'])(
    'offers cancellation alongside the existing recovery for %s', async code => {
      const failed: LaboratoryRequest = { ...request('failed', '失败合成检验', ''), status: 'generation-failed',
        generationError: { code, message: 'Synthetic failure' } }
      delete failed.report
      const page = props({ detail: { ...detail, laboratoryRequests: {
        draftVersion: 0, reportingSupported: true, requests: [failed],
      } } })
      render(<LaboratoryPage {...page} />)
      expect(screen.getByRole('button', { name: '取消检验申请 失败合成检验' })).toBeTruthy()
      const retry = screen.queryByRole('button', { name: '重试结果生成 失败合成检验' })
      if (code === 'INVESTIGATION_UNSUPPORTED') expect(retry).toBeNull()
      else {
        await userEvent.setup().click(retry!)
        expect(page.actions.retry.onSubmit).toHaveBeenCalledExactlyOnceWith(failed)
      }
    },
  )

  it.each(['cancel', 'retry'] as const)('blocks both recovery actions while %s is pending', async action => {
    const failed: LaboratoryRequest = { ...request('failed', '失败合成检验', ''), status: 'generation-failed',
      generationError: { code: 'INVESTIGATION_OUTPUT_INVALID', message: 'Synthetic output error' } }
    delete failed.report
    const page = props({ detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [failed],
    } } })
    page.actions[action].pending = true
    render(<LaboratoryPage {...page} />)
    const cancel = screen.getByRole('button', { name: '取消检验申请 失败合成检验' }) as HTMLButtonElement
    const retry = screen.getByRole('button', { name: '重试结果生成 失败合成检验' }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    expect(retry.disabled).toBe(true)
    await userEvent.setup().click(cancel)
    await userEvent.setup().click(retry)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(page.actions.cancel.onSubmit).not.toHaveBeenCalled()
    expect(page.actions.retry.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    { readOnly: true, status: 'generation-failed' as const },
    { readOnly: false, status: 'in-progress' as const },
    { readOnly: false, status: 'accepted' as const },
  ])('keeps recovery actions unavailable with %o', ({ readOnly, status }) => {
    const current: LaboratoryRequest = { ...request('current', '合成检验', ''), status }
    delete current.report
    render(<LaboratoryPage {...props({ readOnly, detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [current],
    } } })} />)
    expect(screen.queryByRole('button', { name: /取消检验申请|重试结果生成/ })).toBeNull()
  })

  it('confirms prepared laboratory orders directly with the current draft version without changing the manual editor', async () => {
    const confirmations: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) {
        confirmations.push(confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body))))
        return Response.json(confirmDoctorPreparationResponseSchema.parse({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
          data: { kind: 'laboratory', draftVersion: 3, encounterVersion: '1', recordIds: ['request-new'] } }))
      }
      return Response.json(recommendations())
    }))
    const page = props({ detail: { ...detail, laboratoryRequests: { draftVersion: 2, requests: [], reportingSupported: true } } })
    render(<LaboratoryPage {...page} />)
    const panel = within(screen.getByRole('region', { name: '待开具检验' }))
    await panel.findByRole('checkbox', { name: '选择合成检验项目' })
    await userEvent.setup().click(panel.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(confirmations).toEqual([{ expectedVersions: { 'Encounter/synthetic-encounter': '1' }, input: {
      generation: 1, inputFingerprint: 'a'.repeat(64), expectedDraftVersion: 2,
      selections: [{ source: 'agent', suggestionId: 'synthetic-laboratory-suggestion', kind: 'laboratory', catalogItemId: service.id, indicationCode: 'clinical-evaluation' }],
    } }]))
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
  })
  it.each(['WORKFLOW_CONFLICT', 'CATALOG_CONFLICT'] as const)('keeps the manual editor unchanged when final confirmation rejects %s', async code => {
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      paths.push(path)
      if (path.endsWith('/actions/confirm')) {
        confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body)))
        return Response.json({ error: { code, message: 'Synthetic final validation rejected the changed source or catalog' } }, { status: 409 })
      }
      return Response.json(recommendations())
    }))
    const page = props()
    render(<LaboratoryPage {...page} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /^开具选中项目/ }))
    await screen.findByText('更新或提交未完成，草稿已保留，可重试。')
    expect(paths.some(path => path.endsWith('/actions/confirm'))).toBe(true)
    expect(paths.some(path => path.includes('/reference-catalogs/'))).toBe(false)
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: '添加检验' }))
    expect(screen.getByText('尚未选择检验项目')).toBeTruthy()
  })

  it('keeps an explicitly selected manual examination when a delayed preparation response arrives', async () => {
    let resolvePending: (response: Response) => void = () => undefined
    const pending = new Promise<Response>(resolve => { resolvePending = resolve })
    let requested = false
    vi.stubGlobal('fetch', vi.fn(async () => { requested = true; return pending }))
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
    await waitFor(() => expect(requested).toBe(true))
    await userEvent.setup().click(screen.getByRole('button', { name: '添加检验' }))
    await userEvent.setup().click(screen.getByRole('button', { name: '选择 人工选择的合成项目 SYN-1' }))
    await act(async () => { resolvePending(Response.json(recommendations())) })
    const draft = within(screen.getByRole('region', { name: '检验申请' }))
    expect(draft.getByText('人工选择的合成项目')).toBeTruthy()
    expect(draft.queryByText('合成检验项目')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '返回待开具列表' }))
    expect(screen.getByRole('checkbox', { name: '选择人工选择的合成项目' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择合成检验项目' })).toBeTruthy()
  })

  it('does not write a delayed preparation response back through the parent after the editor unmounts', async () => {
    let resolvePending: (response: Response) => void = () => undefined
    const pending = new Promise<Response>(resolve => { resolvePending = resolve })
    let requested = false
    vi.stubGlobal('fetch', vi.fn(async () => { requested = true; return pending }))
    const page = props()
    const { unmount } = render(<LaboratoryPage {...page} />)
    await waitFor(() => expect(requested).toBe(true))
    unmount()
    await act(async () => { resolvePending(Response.json(recommendations())) })
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['saved', 'unsaved'] as const)('includes the current %s manual draft in the single order list', async mode => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
          data: { kind: 'laboratory', draftVersion: 2, encounterVersion: '1', recordIds: ['new'] } })
      }
      return Response.json(recommendations())
    }))
    const page = props({ laboratoryItemId: service.id, indicationCode: 'clinical-evaluation',
      detail: { ...detail, laboratoryRequests: { draftVersion: mode === 'saved' ? 1 : 0,
        reportingSupported: true, requests: [], ...(mode === 'saved' ? {
          draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
        } : {}),
      } },
    })
    render(<LaboratoryPage {...page} />)
    await screen.findByRole('checkbox', { name: '选择合成检验项目' })
    expect(screen.getAllByRole('checkbox', { name: '选择合成检验项目' })).toHaveLength(1)
    await userEvent.setup().click(screen.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ input: { expectedDraftVersion: mode === 'saved' ? 1 : 0,
      ...(mode === 'saved' ? { resolveExistingDraft: true } : {}),
      selections: [{ source: 'manual', kind: 'laboratory', catalogItemId: service.id, indicationCode: 'clinical-evaluation' }] } })
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps a saved manual item selected alongside a different automatic item for one submission', async () => {
    const other = { ...service, id: 'manual-service', nameZh: '人工检验项目' }
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
          data: { kind: 'laboratory', draftVersion: 2, encounterVersion: '1', recordIds: ['manual-new', 'auto-new'] } })
      }
      return Response.json(recommendations())
    }))
    const page = props({ laboratoryItemId: other.id, indicationCode: 'clinical-evaluation', detail: { ...detail,
      laboratoryRequests: { draftVersion: 1, reportingSupported: true, requests: [],
        draft: { catalogItemId: other.id, indicationCode: 'clinical-evaluation', laboratoryService: other } } } })
    render(<LaboratoryPage {...page} />)
    await screen.findByRole('checkbox', { name: '选择合成检验项目' })
    expect(screen.getByRole('checkbox', { name: '选择人工检验项目' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.setup().click(screen.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ input: { expectedDraftVersion: 1, resolveExistingDraft: true, selections: [
      { source: 'manual', kind: 'laboratory', catalogItemId: other.id, indicationCode: 'clinical-evaluation' },
      { source: 'agent', suggestionId: 'synthetic-laboratory-suggestion', kind: 'laboratory', catalogItemId: service.id, indicationCode: 'clinical-evaluation' },
    ] } })
  })

  it.each([true, false])('preserves manual A when Reference B is adjusted, even when its directory page is loaded=%s', async directoryLoaded => {
    const manualService = { ...service, id: 'manual-service', nameZh: '人工检验项目' }
    const referenceService = { ...service, allowedIndicationCodes: ['clinical-evaluation', 'fever'] }
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
          data: { kind: 'laboratory', draftVersion: 2, encounterVersion: '1', recordIds: ['manual-new', 'adjusted-new'] } })
      }
      return Response.json(recommendations())
    }))
    const page = props({ detail: { ...detail, laboratoryRequests: { draftVersion: 1, reportingSupported: true, requests: [],
      draft: { catalogItemId: manualService.id, indicationCode: 'clinical-evaluation', laboratoryService: manualService } } },
      referenceSearch: { ...props().referenceSearch, data: { items: directoryLoaded ? [referenceService] : [], page: 1, pageSize: 20, total: directoryLoaded ? 1 : 0 } },
    })
    function ControlledPage() {
      const [itemId, setItemId] = useState(manualService.id)
      const [indication, setIndication] = useState('clinical-evaluation')
      return <LaboratoryPage {...page} laboratoryItemId={itemId} indicationCode={indication}
        onLaboratoryItemChange={setItemId} onIndicationChange={setIndication} />
    }
    render(<ControlledPage />)
    const user = userEvent.setup()
    await screen.findByRole('checkbox', { name: '选择合成检验项目' })
    await user.click(screen.getAllByRole('button', { name: '调整' })[1]!)
    const dialog = screen.getByRole('dialog', { name: '调整项目' })
    await user.click(within(dialog).getByRole('combobox', { name: '检查目的' }))
    await user.click(await screen.findByRole('option', { name: '发热' }))
    await user.click(within(dialog).getByRole('button', { name: '保留本次调整' }))
    expect(screen.getByRole('checkbox', { name: '选择人工检验项目' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择合成检验项目' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    expect(within(screen.getByRole('dialog', { name: '添加检验' })).getByRole('region', { name: '检验申请' }).textContent).toContain('人工检验项目')
    await user.click(screen.getByRole('button', { name: '返回待开具列表' }))
    await user.click(screen.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ input: { expectedDraftVersion: 1, resolveExistingDraft: true, selections: [
      { source: 'manual', kind: 'laboratory', catalogItemId: manualService.id, indicationCode: 'clinical-evaluation' },
      { source: 'manual', kind: 'laboratory', catalogItemId: service.id, indicationCode: 'fever' },
    ] } })
  })

  it.each(['save', 'issue', 'deleteDraft'] as const)('does not confirm prepared orders while manual %s is pending', async operation => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendations())))
    const page = props()
    page.actions[operation].pending = true
    render(<LaboratoryPage {...page} />)
    await screen.findByRole('checkbox', { name: '选择合成检验项目' })
    expect(screen.getByRole('button', { name: /^开具选中项目/ })).toHaveProperty('disabled', true)
  })

  it('opens manual laboratory entry from the unified list without a second issue action', async () => {
    const page = props()
    render(<LaboratoryPage {...page} />)
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = screen.getByRole('dialog', { name: '添加检验' })
    expect(within(dialog).getByRole('textbox', { name: '搜索检验目录' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '开具检验申请' })).toBeNull()
    expect(screen.getByRole('button', { name: '选择 合成检验项目 SYN-1' }).getAttribute('aria-pressed')).toBe('false')
    expect(page.referenceSearch.onSearch).toHaveBeenCalledExactlyOnceWith('', 1)
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(screen.queryByText(page.messages.noLaboratoryRequests)).toBeNull()
    expect(within(dialog).getByRole('button', { name: '返回待开具列表' })).toBeTruthy()
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
    await userEvent.setup().click(screen.getByRole('button', { name: '添加检验' }))
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
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    await user.click(screen.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    await user.type(screen.getByRole('textbox', { name: '搜索检验目录' }), '另一个项目')
    await waitFor(() => expect(page.referenceSearch.onSearch).toHaveBeenCalledWith('另一个项目', 1))
    expect(within(screen.getByRole('region', { name: '检验申请' })).getByText('合成检验项目')).toBeTruthy()
  })
  it('does not replace a saved manual laboratory draft from a different catalog selection', async () => {
    const other = { ...service, id: 'other-service', nameZh: '另一个合成项目' }
    const page = props({ laboratoryItemId: service.id, indicationCode: 'clinical-evaluation', detail: { ...detail,
      laboratoryRequests: { draftVersion: 1, reportingSupported: true, requests: [],
        draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service } } },
      referenceSearch: { ...props().referenceSearch, data: { items: [service, other], page: 1, pageSize: 20, total: 2 } },
    })
    render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    await user.click(screen.getByRole('button', { name: '选择 另一个合成项目 SYN-1' }))
    expect(screen.getByRole('alert').textContent).toContain('请先开具或删除已有检验草稿')
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
  })

  it('keeps the saved draft in its manual dialog through save failures and returns to the same list', async () => {
    const state = { draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
      draftVersion: 1, reportingSupported: true, requests: [request('first', '合成第一项', '第一份结论')] }
    const page = props({ detail: { ...detail, laboratoryRequests: state }, laboratoryItemId: service.id, indicationCode: 'clinical-evaluation' })
    const { rerender } = render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = screen.getByRole('dialog', { name: '添加检验' })
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, save: { ...page.actions.save, error: new Error('synthetic failure') } }} />)
    expect(within(dialog).getByRole('alert')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: '重试保存' }))
    expect(page.actions.save.onSubmit).toHaveBeenCalledOnce()
    expect(within(dialog).queryByRole('button', { name: '开具检验申请' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: '返回待开具列表' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('checkbox', { name: '选择合成检验项目' })).toBeTruthy()
    expect(screen.getByText('第一份结论')).toBeTruthy()
  })

  it('keeps read-only requests readable without exposing catalog or append controls', () => {
    render(<LaboratoryPage {...props({ readOnly: true, detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [request('first', '合成第一项', '第一份结论')] } } })} />)
    expect(screen.getByText('第一份结论')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加检验' })).toBeNull()
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
    expect(screen.getByRole('button', { name: '添加检验' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索检验目录' })).toBeNull()
    await user.click(list.getByRole('button', { name: '查看全部申请' }))
    await user.type(list.getByRole('textbox', { name: '搜索申请' }), '没有这个项目')
    expect(list.getByText('没有匹配的申请')).toBeTruthy()
    await user.click(list.getByRole('button', { name: '查看全部申请' }))
    expect(list.getByRole('button', { name: /已取消合成项目/ })).toBeTruthy()
    expect(list.getByRole('textbox', { name: '搜索申请' }).getAttribute('value')).toBe('')
  })
  it('keeps a failed unified confirmation recoverable without a second issue action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/actions/confirm')
      ? Response.json({ error: { code: 'CATALOG_CONFLICT', message: 'Synthetic issue failure' } }, { status: 409 })
      : Response.json(recommendations())))
    const page = props({ laboratoryItemId: service.id, indicationCode: 'clinical-evaluation', detail: { ...detail,
      laboratoryRequests: { draftVersion: 1, reportingSupported: true, requests: [],
        draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service } } } })
    render(<LaboratoryPage {...page} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /^开具选中项目/ }))
    expect(await screen.findByText('更新或提交未完成，草稿已保留，可重试。')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择合成检验项目' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '开具检验申请' })).toBeNull()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
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
    await user.click(screen.getByRole('button', { name: '添加检验' }))
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
