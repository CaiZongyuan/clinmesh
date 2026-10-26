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
  outpatientBilling: { id: 'synthetic-price', version: 1, priceFen: 2500, currency: 'CNY', unit: '项目',
    source: 'synthetic-outpatient-investigation-2026-10-26-v1', effectiveOn: '2026-08-24' },
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
  registrationNumber: null,
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
  return { ...renderView(element, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }), client }
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
  it('keeps an unpriced test as a draft and blocks formal issuance with an explicit explanation', async () => {
    const { outpatientBilling: _price, ...unpriced } = service
    const page = props({ laboratoryItemId: service.id, indicationCode: 'clinical-evaluation',
      referenceSearch: { ...props().referenceSearch, data: { items: [unpriced], page: 1, pageSize: 20, total: 1 } } })
    render(<LaboratoryPage {...page} />)
    const pending = within(screen.getByRole('region', { name: '待开具检验' }))
    expect((pending.getByRole('button', { name: '开具选中项目（1）' }) as HTMLButtonElement).disabled).toBe(true)
    expect(pending.getAllByText('未配置本院门诊价格，可保存草稿，暂不能正式开立。').length).toBeGreaterThan(0)
  })

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
    await screen.findByText('更新或提交未完成，草稿已保留。')
    expect(paths.some(path => path.endsWith('/actions/confirm'))).toBe(true)
    expect(paths.some(path => path.includes('/reference-catalogs/'))).toBe(false)
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
    expect(page.actions.issue.onSubmit).not.toHaveBeenCalled()
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
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '选择 人工选择的合成项目 SYN-1' }))
    await user.click(dialog.getByRole('button', { name: '加入检验申请' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => { resolvePending(Response.json(recommendations())) })
    const draft = within(screen.getByRole('region', { name: '检验申请' }))
    expect(draft.getByText('人工选择的合成项目')).toBeTruthy()
    expect(draft.queryByText('合成检验项目')).toBeNull()
    expect(screen.getByRole('checkbox', { name: '选择人工选择的合成项目' })).toBeTruthy()
    expect(await screen.findByRole('checkbox', { name: '选择合成检验项目' })).toBeTruthy()
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
      laboratoryCatalog: [{ ...referenceService, nameEn: referenceService.nameEn ?? referenceService.nameZh, contraindicatedAllergyCodes: [] }],
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
    expect(screen.getByRole('region', { name: '检验申请' }).textContent).toContain('人工检验项目')
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

  it('shows the manual catalog and request fields inside one composer dialog before issuing', async () => {
    const page = props()
    render(<LaboratoryPage {...page} />)
    // 未打开弹窗时目录不在页面中，左主列只有入口按钮与空态提示。
    expect(document.querySelector('[data-agent-catalog="laboratory"]')).toBeNull()
    expect(screen.getByRole('region', { name: '检验申请' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加检验' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: '开具检验申请' })).toBeNull()
    expect(screen.queryByText(page.messages.noLaboratoryRequests)).toBeNull()
    expect(screen.getByRole('region', { name: '待开具检验' })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('textbox', { name: '搜索检验目录' })).toBeTruthy()
    expect(page.referenceSearch.onSearch).toHaveBeenCalledExactlyOnceWith('', 1)
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
  })
  it('shows only the selected current report when requests exist and switches it from the request list', async () => {
    const page = props({ detail: { ...detail, laboratoryRequests: { draftVersion: 0, reportingSupported: true,
      requests: [request('first', '合成第一项', '第一份结论'), request('second', '合成第二项', '第二份结论')] } } })
    render(<LaboratoryPage {...page} />)
    expect(screen.getByText('第一份结论')).toBeTruthy()
    expect(screen.queryByText('第二份结论')).toBeNull()
    expect(screen.getByRole('button', { name: '添加检验' })).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /合成第二项/ }))
    expect(screen.getByText('第二份结论')).toBeTruthy()
    expect(screen.queryByText('第一份结论')).toBeNull()
  })
  it.each(['all', 'first'] as const)('keeps two AI laboratory orders individually accessible after issuing %s of the pending list', async issued => {
    const secondService = { ...service, id: 'second-service', nameZh: '合成第二项检验' }
    const prepared = recommendations()
    const firstSuggestion = prepared.items[0]!
    if (firstSuggestion.kind !== 'laboratory') throw new Error('Expected a laboratory fixture')
    prepared.items = [firstSuggestion, { ...firstSuggestion, id: 'second-suggestion', catalogItemId: secondService.id, label: secondService.nameZh }]
    const confirmations: Array<ReturnType<typeof confirmDoctorPreparationRequestSchema.parse>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/actions/confirm')) return Response.json(prepared)
      const confirmation = confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body)))
      confirmations.push(confirmation)
      return Response.json(confirmDoctorPreparationResponseSchema.parse({ auditId: 'synthetic-audit', effects: [], requestId: `confirm-${confirmations.length}`, warnings: [],
        data: { kind: 'laboratory', draftVersion: confirmations.length, encounterVersion: '1', recordIds: confirmation.input.selections.map(value => value.kind === 'laboratory' && value.catalogItemId === secondService.id ? 'second' : 'first') } }))
    }))
    const page = props({ referenceSearch: { ...props().referenceSearch, data: { items: [service, secondService], page: 1, pageSize: 20, total: 2 } } })
    const { rerender, client } = render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    const pending = screen.getByRole('region', { name: '待开具检验' })
    await within(pending).findByRole('checkbox', { name: '选择合成第二项检验' })
    if (issued === 'first') await user.click(within(pending).getByRole('checkbox', { name: '选择合成第二项检验' }))
    await user.click(within(pending).getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(confirmations).toHaveLength(1))
    const first = request('first', service.nameZh, '第一份结论')
    const second = { ...request('second', secondService.nameZh, '第二份结论'), catalogItemId: secondService.id, laboratoryService: secondService }
    const requests = issued === 'all' ? [first, second] : [first]
    rerender(<LaboratoryPage {...page} detail={{ ...detail, laboratoryRequests: { draftVersion: 1, reportingSupported: true, requests } }} />)
    await waitFor(() => expect(within(pending).queryByRole('checkbox', { name: '选择合成检验项目' })).toBeNull())
    act(() => { client.setQueryData(['doctor-case', detail.caseId], { ...detail, laboratoryRequests: { draftVersion: 1, reportingSupported: true, requests } }) })
    // 开具后目录整体回到弹窗内，页面上不再出现常驻目录。
    expect(document.querySelector('[data-agent-catalog="laboratory"]')).toBeNull()
    expect(screen.getByText('第一份结论')).toBeTruthy()
    if (issued === 'first') {
      const remaining = within(pending).getByRole('checkbox', { name: '选择合成第二项检验' })
      await user.click(remaining)
      const issueNext = within(pending).getByRole('button', { name: /^开具选中项目/ })
      await waitFor(() => expect(issueNext).toHaveProperty('disabled', false))
      await user.click(issueNext)
      await waitFor(() => expect(confirmations).toHaveLength(2))
      expect(confirmations[1]).toMatchObject({ input: { expectedDraftVersion: 1, selections: [{ source: 'agent', suggestionId: 'second-suggestion', catalogItemId: secondService.id }] } })
      rerender(<LaboratoryPage {...page} detail={{ ...detail, laboratoryRequests: { draftVersion: 2, reportingSupported: true, requests: [first, second] } }} />)
    } else {
      expect(confirmations[0]!.input.selections).toHaveLength(2)
    }
    const records = within(screen.getByRole('region', { name: '申请列表' }))
    expect(records.getAllByRole('button', { name: /合成.*检验/ })).toHaveLength(2)
    await user.click(records.getByRole('button', { name: /合成第二项检验/ }))
    expect(screen.getByText('第二份结论')).toBeTruthy()
    expect(screen.queryByText('第一份结论')).toBeNull()
    await user.click(records.getByRole('button', { name: /合成检验项目/ }))
    expect(screen.getByText('第一份结论')).toBeTruthy()
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
  it('shows the selected hospital service specimen, turnaround, price and indication inside the composer', async () => {
    function Page() {
      const [itemId, setItemId] = useState('')
      return <LaboratoryPage {...props({ laboratoryItemId: itemId, onLaboratoryItemChange: setItemId })} />
    }
    render(<Page />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    expect(dialog.getByText('静脉血')).toBeTruthy()
    expect(dialog.getByText('180 min')).toBeTruthy()
    expect(dialog.getByText(/25/)).toBeTruthy()
    expect(dialog.getByText('临床评估')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '加入检验申请' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: '开具检验申请' })).toBeNull()
  })
  it('keeps the draft card while searching the composer catalog for another project', async () => {
    const page = props()
    function Page() {
      const [itemId, setItemId] = useState('')
      return <LaboratoryPage {...page} laboratoryItemId={itemId} onLaboratoryItemChange={setItemId} />
    }
    render(<Page />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    await user.click(dialog.getByRole('button', { name: '加入检验申请' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 条目点击用同一弹窗重开编辑：已选项目与适应证保留，检索另一个项目不影响草稿卡片。
    await user.click(screen.getByRole('button', { name: /编辑检验 合成检验项目/ }))
    const editDialog = within(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog').textContent).toContain('编辑检验')
    expect(editDialog.getByRole('button', { name: '选择 合成检验项目 SYN-1' }).getAttribute('aria-pressed')).toBe('true')
    await user.type(editDialog.getByRole('textbox', { name: '搜索检验目录' }), '另一个项目')
    await waitFor(() => expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('另一个项目', 1))
    await user.click(editDialog.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    await user.click(screen.getByRole('button', { name: /编辑检验 合成检验项目/ }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '选择 另一个合成项目 SYN-1' }))
    expect(dialog.getByRole('alert').textContent).toContain('请先开具或删除已有检验草稿')
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
  })

  it('keeps the saved draft inline through save failures alongside the pending list', async () => {
    const state = { draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
      draftVersion: 1, reportingSupported: true, requests: [request('first', '合成第一项', '第一份结论')] }
    const page = props({ detail: { ...detail, laboratoryRequests: state }, laboratoryItemId: service.id, indicationCode: 'clinical-evaluation' })
    const { rerender } = render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    const dialog = screen.getByRole('region', { name: '检验申请' })
    rerender(<LaboratoryPage {...page} actions={{ ...page.actions, save: { ...page.actions.save, error: new Error('synthetic failure') } }} />)
    expect(within(dialog).getByRole('alert')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: '重试保存' }))
    expect(page.actions.save.onSubmit).toHaveBeenCalledOnce()
    expect(within(dialog).queryByRole('button', { name: '开具检验申请' })).toBeNull()
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
    expect(await screen.findByText('更新或提交未完成，草稿已保留。')).toBeTruthy()
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
    expect(screen.getByRole('button', { name: '添加检验' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '确认已阅 合成第一项' })).toBeNull()
    await user.click(list.getByRole('button', { name: '查看全部申请' }))
    expect(list.getByRole('button', { name: /合成第一项/ }).getAttribute('aria-pressed')).toBe('true')
  })
  it('pages the composer catalog, retries a failed page and resets to page one for an unmatched search', async () => {
    const page = props()
    const firstSearch = { ...page.referenceSearch, data: { items: [service], page: 1, pageSize: 1, total: 2 } }
    const { rerender } = render(<LaboratoryPage {...page} referenceSearch={firstSearch} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true)
    await user.click(dialog.getByRole('button', { name: '下一页' }))
    expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('', 2)
    rerender(<LaboratoryPage {...page} referenceSearch={{ ...firstSearch, error: new Error('synthetic catalog failure'), isError: true }} />)
    expect(dialog.getByRole('alert').textContent).toContain('无法加载本院检验目录')
    expect(dialog.queryByRole('table')).toBeNull()
    await user.click(dialog.getByRole('button', { name: '重试' }))
    expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('', 2)
    const secondSearch = { ...firstSearch, data: { items: [{ ...service, id: 'second-service', nameZh: '合成第二页项目' }],
      page: 2, pageSize: 1, total: 2 } }
    rerender(<LaboratoryPage {...page} referenceSearch={secondSearch} />)
    expect(dialog.getByRole('button', { name: '选择 合成第二页项目 SYN-1' })).toBeTruthy()
    expect(dialog.queryByRole('alert')).toBeNull()
    expect(dialog.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
    await user.type(dialog.getByRole('textbox', { name: '搜索检验目录' }), '没有这个项目')
    await waitFor(() => expect(page.referenceSearch.onSearch).toHaveBeenLastCalledWith('没有这个项目', 1))
    rerender(<LaboratoryPage {...page} referenceSearch={{ ...firstSearch,
      data: { items: [], page: 1, pageSize: 1, total: 0 } }} />)
    expect(dialog.getByText('没有匹配记录')).toBeTruthy()
    expect(dialog.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true)
    expect(dialog.queryByRole('table')).toBeNull()
  })
  it('presents the unselected order form as a compact hint without autosave noise', () => {
    render(<LaboratoryPage {...props()} />)
    const form = within(screen.getByRole('region', { name: '检验申请' }))
    expect(form.getByRole('button', { name: '添加检验' })).toBeTruthy()
    const hint = form.getByText('尚未选择检验项目')
    expect(hint.closest('[data-slot="empty"]')).toBeTruthy()
    expect(hint.closest('.min-h-16')).toBeNull()
    expect(form.queryByText('修改等待自动保存')).toBeNull()
  })
  it('shows the localized unselected hint in both locales', () => {
    const zh = props()
    const { unmount } = render(<LaboratoryPage {...zh} />)
    expect(screen.getByText(zh.messages.laboratoryItemEmpty)).toBeTruthy()
    expect(screen.getByText('点「添加检验」在弹窗中选择检验项目并确认适应证。')).toBeTruthy()
    unmount()
    const en = props({ locale: 'en-US', messages: getWorkspaceMessages('en-US') })
    render(<LaboratoryPage {...en} />)
    expect(screen.getByText('No laboratory item selected')).toBeTruthy()
    expect(screen.getByText('Choose “Add laboratory item” to pick an item and confirm the indication in the dialog.')).toBeTruthy()
  })
  it('adds a laboratory item through the composer dialog and lands it in the draft card', async () => {
    const page = props()
    function Page() {
      const [itemId, setItemId] = useState('')
      const [indication, setIndication] = useState('')
      return <LaboratoryPage {...page} indicationCode={indication} laboratoryItemId={itemId}
        onIndicationChange={setIndication} onLaboratoryItemChange={setItemId} />
    }
    render(<Page />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    // 单一适应证在选中后自动取首个允许值，确认按钮随后可用。
    expect(dialog.getByText('临床评估')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '加入检验申请' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const card = within(screen.getByRole('region', { name: '检验申请' })).getByRole('button', { name: '编辑检验 合成检验项目' })
    expect(card.textContent).toContain('SYN-1')
    expect(card.textContent).toContain('临床评估')
    // 确认即写入服务端草稿：不等 800ms 自动保存，确认后立即换例等卸载场景也不丢保存。
    expect(page.actions.save.onSubmit).toHaveBeenCalledWith({ catalogItemId: 'synthetic-laboratory-service', indicationCode: 'clinical-evaluation' })
  })
  it('discards in-dialog input when closing without confirm and offers a fresh add next time', async () => {
    const page = props()
    render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    await user.click(dialog.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(page.onLaboratoryItemChange).not.toHaveBeenCalled()
    expect(page.onIndicationChange).not.toHaveBeenCalled()
    // 未确认关闭即弃置：再次打开时没有已选行，也没有已展开的表单。
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const reopened = within(screen.getByRole('dialog'))
    expect(reopened.getByRole('button', { name: '选择 合成检验项目 SYN-1' }).getAttribute('aria-pressed')).toBe('false')
    expect(reopened.queryByRole('combobox', { name: '检验适应证' })).toBeNull()
    await userEvent.setup().click(reopened.getByRole('button', { name: '取消' }))
  })
  it('reopens the same dialog from the draft card for editing and saves changes once', async () => {
    const state = { draft: { catalogItemId: service.id, indicationCode: 'clinical-evaluation', laboratoryService: service },
      draftVersion: 1, reportingSupported: true, requests: [] }
    const page = props({ detail: { ...detail, laboratoryRequests: state }, laboratoryItemId: service.id, indicationCode: 'clinical-evaluation' })
    render(<LaboratoryPage {...page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /编辑检验 合成检验项目/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('编辑检验')).toBeTruthy()
    expect(dialog.getByRole('button', { name: '保存修改' })).toBeTruthy()
    // 重开即恢复已选项目与适应证（单一适应证为静态展示）；确认后仅回写一次页面状态。
    expect(dialog.getByText('临床评估')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(page.onLaboratoryItemChange).toHaveBeenCalledExactlyOnceWith(service.id)
    expect(page.onIndicationChange).toHaveBeenCalledExactlyOnceWith('clinical-evaluation')
  })
  it('opens the catalog and order form in one composer dialog with a five-row compact list', async () => {
    const page = props()
    const firstSearch = { ...page.referenceSearch, data: { items: [service], page: 1, pageSize: 20, total: 1 } }
    const { rerender } = render(<LaboratoryPage {...page} referenceSearch={firstSearch} />)
    expect(document.querySelector('[data-agent-catalog="laboratory"]')).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加检验' }))
    const dialogElement = screen.getByRole('dialog')
    expect(dialogElement.getAttribute('data-agent-catalog')).toBe('laboratory')
    rerender(<LaboratoryPage {...page} referenceSearch={firstSearch} />)
    // 弹窗内目录为单行紧凑行，可见高度封顶五条（约 12.5rem）。
    const list = document.querySelector('[data-agent-catalog="laboratory"] div[class*="max-h-[12.5rem]"]')
    expect(list).not.toBeNull()
    const row = list!.querySelector('li')
    expect(row?.className).toContain('px-3 py-2')
    expect(row?.querySelector('strong')?.className).toContain('truncate')
    expect(within(dialogElement).getByRole('button', { name: '选择 合成检验项目 SYN-1' })).toBeTruthy()
  })
  it('groups the request list count beside the heading and inlines the status badge with the item name', () => {
    render(<LaboratoryPage {...props({ detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [request('first', '合成第一项', '第一份结论')] } } })} />)
    const list = within(screen.getByRole('region', { name: '申请列表' }))
    const heading = list.getByText('已开具')
    const count = list.getByText('共 1 份申请 · 1 份待阅')
    expect(count.className).toContain('text-xs')
    expect(heading.parentElement).toBe(count.parentElement)
    const item = list.getByRole('button', { name: /合成第一项/ })
    expect(item.className).toContain('items-center')
    expect(item.className).not.toContain('flex-col')
  })
  it('gives the request search empty state a reassuring description and a compact reset action', async () => {
    const cancelled: LaboratoryRequest = { ...request('cancelled', '已取消合成项目', ''), status: 'cancelled' }
    delete cancelled.report
    render(<LaboratoryPage {...props({ detail: { ...detail, laboratoryRequests: {
      draftVersion: 0, reportingSupported: true, requests: [cancelled] } } })} />)
    const user = userEvent.setup()
    const list = within(screen.getByRole('region', { name: '申请列表' }))
    await user.click(list.getByRole('button', { name: '进行中' }))
    expect(list.getByText('没有匹配的申请')).toBeTruthy()
    expect(list.getByText('搜索为空不会删除申请记录。')).toBeTruthy()
    const reset = list.getByRole('button', { name: '查看全部申请' })
    expect(reset.className).toContain('h-7')
    await user.click(reset)
    expect(list.getByRole('button', { name: /已取消合成项目/ })).toBeTruthy()
  })
})

describe('检验页签右列布局', () => {
  it('keeps a single recommendation panel in the pending column by default', () => {
    render(<LaboratoryPage {...props()} />)
    const pending = document.querySelector('[data-order-pending]')
    expect(pending).not.toBeNull()
    // A11：右辅助列默认只保留一个推荐/待处理面板，不堆叠其它区块。
    const panels = within(pending as HTMLElement).getAllByRole('region')
    expect(panels).toHaveLength(1)
    expect(panels[0]?.getAttribute('aria-label')).toBe('待开具检验')
    expect(screen.getAllByRole('region', { name: '待开具检验' })).toHaveLength(1)
  })
})
