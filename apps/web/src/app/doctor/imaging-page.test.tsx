// @vitest-environment jsdom
import type { SessionContext, PathologyRequest, ImagingRequest, ImagingServiceSnapshot } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagingPage, useImagingViewState, type ImagingPageActions } from './imaging-page.tsx'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

const ctService: ImagingServiceSnapshot = {
  outpatientBilling: { id: 'synthetic-price', version: 1, priceFen: 2500, currency: 'CNY', unit: '项目', source: 'synthetic-outpatient-investigation-2026-10-26-v1', effectiveOn: '2026-08-24' },
  applicability: '成人胸部疾病的评估与随访；不含增强扫描',
  bodySite: '胸部',
  code: 'CT-CHEST-PLAIN',
  department: '放射科',
  examCode: 'chest-ct-plain',
  id: 'imaging-chest-ct-plain',
  method: '平扫（不使用造影剂）',
  modality: 'CT',
  name: '胸部 CT 平扫',
  reportSections: ['technique', 'findings', 'impression'],
  version: 1,
}
const radiographService: ImagingServiceSnapshot = {
  ...ctService,
  code: 'DX-CHEST',
  examCode: 'chest-radiograph',
  id: 'imaging-chest-radiograph',
  method: 'X 线摄影',
  modality: 'DX',
  name: '胸片',
}

function request(overrides: Partial<ImagingRequest> = {}): ImagingRequest {
  return {
    id: 'request-1',
    indication: '咳嗽两周',
    previousReports: [],
    service: ctService,
    serviceRequestId: 'service-request-1',
    serviceRequestVersion: '2',
    status: 'reported',
    taskId: 'task-1',
    taskVersion: '4',
    version: 4,
    ...overrides,
  }
}

const report = {
  diagnosticReportId: 'report-1',
  diagnosticReportVersion: '1',
  examinedAt: '2026-06-01T10:00:00+08:00',
  findings: '右肺见一实性肿块（Im 85），长径约 31 mm，未见钙化。',
  impression: '右肺实性肿块，长径约 31 mm，建议结合临床进一步检查。',
  issuedAt: '2026-06-01T10:00:00+08:00',
  revisionNumber: 1,
  status: 'final' as const,
  studyId: 'study-1',
  technique: '胸部 CT 平扫，轴位。',
}

function commandResponse(data: unknown) {
  return { auditId: 'audit-1', data, effects: [], requestId: 'request-id-1', warnings: [] }
}

const actionSession: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor',
    practitionerId: 'practitioner-doctor', organizationId: 'organization-outpatient', locationId: 'location-outpatient', roleCode: 'outpatient-doctor' },
  user: { id: 'account-doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [],
}
const actionContext = { session: actionSession, caseId: 'case-1', patientId: 'patient-1', encounterId: 'encounter-1', patientName: '合成检查患者', onChanged: () => undefined }
function actionCase(kind: 'imaging' | 'pathology', requests: ImagingRequest[] | PathologyRequest[]) {
  return { registrationNumber: null, allergies: [], caseId: 'case-1', consultation: { turns: [], version: 1 },
    encounter: { id: 'encounter-1', status: 'in-progress', versionId: '3' },
    patient: { id: 'patient-1', identifier: 'SYN-1', name: '合成检查患者', synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'first-visit', taskId: 'case-task', taskVersion: '1',
    [kind === 'imaging' ? 'imagingRequests' : 'pathologyRequests']: { draftVersion: 4, requests } }
}

interface Call { body: unknown; method: string; path: string }

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      method: init?.method ?? 'GET',
      path: new URL(String(input), 'http://localhost').pathname,
    }
    calls.push(call)
    return handler(call)
  }))
  return calls
}

function renderPage(element: React.JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

/** 像医生工作台一样由调用方持有阅片状态。 */
function Page({ actionContext: batchContext, active = true, canCorrect = false, editDraft = false, locale = 'zh-CN', onChanged, onInsertSummary, onSelectRequest, readOnly = false, selectedReportId, state }: {
  actionContext?: typeof actionContext
  active?: boolean
  editDraft?: boolean
  locale?: WorkspaceLocale
  canCorrect?: boolean
  onChanged: ImagingPageActions['onChanged']
  onInsertSummary?: ImagingPageActions['onInsertSummary']
  onSelectRequest?: ((requestId: string) => void) | undefined
  readOnly?: boolean
  selectedReportId?: string | undefined
  state: Parameters<typeof ImagingPage>[0]['state']
}) {
  const view = useImagingViewState('case-1')
  return (
    <ImagingPage
      actionContext={batchContext}
      active={active}
      actions={{ canCorrect, onChanged, onInsertSummary, view }}
      caseId="case-1"
      elementId="imaging"
      editDraft={editDraft}
      encounter={{ id: 'encounter-1', versionId: '3' }}
      locale={locale}
      onSelectRequest={onSelectRequest}
      readOnly={readOnly}
      selectedReportId={selectedReportId}
      state={state}
    />
  )
}

const services = { items: [{ available: true, service: ctService }, { available: false, service: radiographService }] }

function recommendations(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return {
    caseId: 'case-1', kind: 'imaging', encounterId: 'encounter-1', encounterVersion: '3',
    inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, missingInformation: [], stale: false,
    guidelines: [{ id: 'synthetic-guideline', title: '合成检查指南', publisher: '合成发布机构',
      documentType: 'official-protocol', version: '1', url: 'https://example.test/synthetic-guideline',
      locator: '检查章节', scope: '合成成人病例', text: '依据当前资料核对检查指征。', sourceHash: 'b'.repeat(64) }],
    caseEvidence: [{ id: 'synthetic-case-evidence', kind: 'consultation', label: '患者回答', text: '咳嗽两周' }],
    items: [{
      id: 'synthetic-imaging-suggestion', kind: 'imaging', label: ctService.name,
      serviceId: ctService.id, indication: '持续咳嗽，需要医生核对检查指征。',
      rationale: '依据当前病例完善胸部检查。', supportingInformation: ['咳嗽两周'],
      opposingInformation: [], missingInformation: [],
      guidelineEvidenceIds: ['synthetic-guideline'], caseEvidenceIds: ['synthetic-case-evidence'],
    }],
    ...overrides,
  }
}

describe('doctor imaging page', () => {
  it('continuously adds two independent manual examinations and restores their indications after remount without a server draft write', async () => {
    const calls = stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services')
      ? { items: services.items.map(item => ({ ...item, available: true })) }
      : recommendations({ items: [] })))
    const page = <Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />
    const mounted = renderPage(page)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '添加放射检查' }))
    const dialog = within(screen.getByRole('dialog', { name: '选择放射检查' }))
    for (const [service, indication] of [[ctService, '持续咳嗽，排查肺部病变'], [radiographService, '胸痛，核对胸部情况']] as const) {
      await user.click(dialog.getByRole('button', { name: new RegExp(`^${service.name}`) }))
      await user.type(dialog.getByLabelText('检查指征'), indication)
      await user.click(dialog.getByRole('button', { name: '加入放射检查' }))
      expect(screen.getByRole('dialog', { name: '选择放射检查' })).toBeTruthy()
      expect(dialog.queryByLabelText('检查指征')).toBeNull()
    }
    expect(dialog.getByText('已加入 2 项：胸部 CT 平扫、胸片').getAttribute('role')).toBe('status')
    await user.click(dialog.getByRole('button', { name: '关闭' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '开具选中项目（2）' })).toBeTruthy()
    mounted.unmount()
    renderPage(page)
    const pending = within(screen.getByRole('region', { name: '待开具放射检查' }))
    expect(await pending.findByRole('checkbox', { name: '选择胸部 CT 平扫' })).toBeTruthy()
    expect(pending.getByRole('checkbox', { name: '选择胸片' })).toBeTruthy()
    expect(pending.getByText('持续咳嗽，排查肺部病变')).toBeTruthy()
    expect(pending.getByText('胸痛，核对胸部情况')).toBeTruthy()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('keeps eight rows and shows an in-dialog limit error without losing the ninth indication', async () => {
    const directory = Array.from({ length: 9 }, (_, index) => ({ available: true, service: { ...ctService, id: `imaging-${index}`, name: `合成检查${index}` } }))
    stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? { items: directory } : recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '添加放射检查' }))
    const composer = within(screen.getByRole('dialog'))
    for (const item of directory) {
      await user.click(composer.getByRole('button', { name: new RegExp(`^${item.service.name}`) }))
      await user.type(composer.getByLabelText('检查指征'), '该项目独立指征')
      await user.click(composer.getByRole('button', { name: '加入放射检查' }))
    }
    expect(composer.getByRole('alert').textContent).toContain('最多保留 8 项')
    expect(composer.getByLabelText('检查指征')).toHaveProperty('value', '该项目独立指征')
    await user.click(composer.getByRole('button', { name: '关闭' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    expect(screen.queryByRole('checkbox', { name: '选择合成检查8' })).toBeNull()
  })

  it('preserves an unpriced draft and blocks its formal issuance', async () => {
    const { outpatientBilling: _price, ...unpriced } = ctService
    const catalog = { items: services.items.map(item => ({ ...item, service: unpriced })) }
    const calls = stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? catalog : recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 1, requests: [], draft: { service: unpriced, indication: '需要核对的检查指征。' } }} />)
    const pending = within(screen.getByRole('region', { name: '待开具放射检查' }))
    await waitFor(() => expect(pending.getByRole('button', { name: /^开具选中项目/ })).toHaveProperty('disabled', true))
    expect(pending.getAllByText('未配置本院门诊价格，可保存草稿，暂不能正式开立。').length).toBeGreaterThan(0)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  beforeEach(() => {
    sessionStorage.clear()
    // jsdom 没有 canvas 与 ImageData；阅片器只需要能把一帧画上去。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: () => undefined } as never)
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  })
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('confirms prepared imaging orders directly with the current draft version without writing a temporary draft', async () => {
    const confirmations: unknown[] = []
    const calls = stubFetch(({ path, body }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (path.endsWith('/actions/confirm')) {
        confirmations.push(confirmDoctorPreparationRequestSchema.parse(body))
        return Response.json(confirmDoctorPreparationResponseSchema.parse(commandResponse({ kind: 'imaging', draftVersion: 3, encounterVersion: '3', recordIds: ['request-new'] })))
      }
      return Response.json(recommendations())
    })
    const onChanged = vi.fn()
    renderPage(<Page onChanged={onChanged} state={{ draftVersion: 2, requests: [request({ report })] }} />)
    const panel = within(screen.getByRole('region', { name: '待开具放射检查' }))
    await panel.findByRole('checkbox', { name: '选择胸部 CT 平扫' })
    await userEvent.setup().click(panel.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(confirmations).toEqual([{ expectedVersions: { 'Encounter/encounter-1': '3' }, input: {
      generation: 1, inputFingerprint: 'a'.repeat(64), expectedDraftVersion: 2, selections: [{ source: 'agent', suggestionId: 'synthetic-imaging-suggestion', kind: 'imaging', reviewedService: { id: ctService.id, version: ctService.version, outpatientBilling: ctService.outpatientBilling ?? null }, serviceId: ctService.id, indication: '持续咳嗽，需要医生核对检查指征。' }],
    } }]))
    expect(calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/api/his/v1/doctor/cases/case-1/recommendations/imaging/actions/confirm'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('preserves saved request contents when suggestions refresh and discards cancelled list adjustments', async () => {
    let current = recommendations()
    stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (method === 'POST' && path.endsWith('/actions/generate')) {
        current = recommendations({ generation: 2, items: [{ ...current.items[0]!, rationale: '重新核对后的检查建议。' }] })
        return Response.json(commandResponse(current))
      }
      return Response.json(current)
    })
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 1, requests: [], draft: { service: ctService, indication: '已保存的医生检查指征。' } }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^(调整|核对)$/ }))
    const dialog = within(screen.getByRole('dialog', { name: '调整项目' }))
    await user.type(dialog.getByLabelText('检查目的'), '继续手工核对。')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '刷新' }))
    await user.click(screen.getByRole('button', { name: '依据与说明' }))
    expect(await screen.findByText('重新核对后的检查建议。')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('region', { name: '待开具放射检查' }).textContent).toContain('已保存的医生检查指征。')
    await user.click(await screen.findByRole('button', { name: /^(调整|核对)$/ }))
    expect(within(screen.getByRole('dialog')).getByLabelText('检查目的')).toHaveProperty('value', '已保存的医生检查指征。')
  })

  it('cannot issue an examination that is unavailable in the hospital catalog', async () => {
    const state = recommendations()
    state.items = [{ ...state.items[0]!, kind: 'imaging', serviceId: radiographService.id,
      indication: '待核对的检查指征。', label: radiographService.name }]
    const calls = stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? services : state))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)
    expect((await screen.findByRole('button', { name: /^开具选中项目/ })).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByLabelText('检查指征')).toBeNull()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it.each(['inactive', 'read-only'] as const)('does not generate or expose prepared orders for an %s page', async mode => {
    const calls = stubFetch(() => Response.json(services))
    renderPage(<Page active={mode !== 'inactive'} readOnly={mode === 'read-only'} onChanged={() => undefined}
      state={{ draftVersion: 0, requests: [] }} />)
    expect(screen.queryByRole('region', { name: '待开具放射检查' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^开具选中项目/ })).toBeNull()
    expect(calls.some(call => call.path.includes('/recommendations/'))).toBe(false)
  })

  it('keeps catalog details and indication in one dialog and adds a local row without writing a server draft', async () => {
    const calls = stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? services : recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '添加放射检查' }))
    const dialog = within(screen.getByRole('dialog', { name: '选择放射检查' }))
    await user.type(dialog.getByRole('textbox', { name: '搜索放射目录' }), 'CT')
    expect(dialog.queryByRole('button', { name: /^胸片/ })).toBeNull()
    await user.click(dialog.getByRole('button', { name: /^胸部 CT 平扫/ }))
    expect(dialog.getByText('¥25.00 / 项目 × 1')).toBeTruthy()
    expect(dialog.getByText(ctService.applicability)).toBeTruthy()
    await user.type(dialog.getByLabelText('检查指征'), '咳嗽两周，排查肺部病变')
    await user.click(dialog.getByRole('button', { name: '加入放射检查' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('checkbox', { name: '选择胸部 CT 平扫' })).toBeTruthy()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('shows continuous addition and explicit close in English', async () => {
    stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? services : recommendations({ items: [] })))
    renderPage(<Page locale="en-US" onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Add examination' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Select an examination' }))
    await user.click(dialog.getByRole('button', { name: /^胸部 CT 平扫/ }))
    await user.type(dialog.getByLabelText('Indication'), 'Synthetic clinical indication')
    await user.click(dialog.getByRole('button', { name: 'Add imaging examination' }))
    expect(dialog.getByText('Added 1: 胸部 CT 平扫')).toBeTruthy()
    await user.click(dialog.getByText('Close', { selector: 'button', exact: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('issues the edited legacy manual row through the unified list with its original draft version', async () => {
    const calls = stubFetch(({ path }) => path.endsWith('/imaging-services') ? Response.json(services)
      : path.endsWith('/actions/confirm') ? Response.json(commandResponse({ kind: 'imaging', draftVersion: 3, encounterVersion: '3', recordIds: ['request-new'] }))
      : Response.json(recommendations({ items: [] })))
    const user = userEvent.setup()
    const onSelectRequest = vi.fn()
    renderPage(<Page onChanged={vi.fn()} onSelectRequest={onSelectRequest} state={{ draft: { indication: '咳嗽', service: ctService }, draftVersion: 2, requests: [] }} />)
    await user.click(await screen.findByRole('button', { name: '调整' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.clear(dialog.getByLabelText('检查目的'))
    await user.type(dialog.getByLabelText('检查目的'), '咳嗽两周，排查肺部病变')
    await user.click(dialog.getByRole('button', { name: '保留本次调整' }))
    await user.click(screen.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toHaveLength(1))
    expect(calls.find(call => call.method === 'POST')).toMatchObject({ method: 'POST',
      path: '/api/his/v1/doctor/cases/case-1/recommendations/imaging/actions/confirm',
      body: { expectedVersions: { 'Encounter/encounter-1': '3' }, input: { expectedDraftVersion: 2, resolveExistingDraft: true,
        selections: [{ source: 'manual', kind: 'imaging', serviceId: ctService.id, indication: '咳嗽两周，排查肺部病变' }] } },
    })
    expect(calls.some(call => call.method === 'PUT')).toBe(false)
    await waitFor(() => expect(onSelectRequest).toHaveBeenCalledWith('request-new'))
  })

  it('imports an existing server draft into the only pending list beside issued reports', async () => {
    stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? services : recommendations({ items: [] })))
    renderPage(<Page editDraft onChanged={() => undefined} state={{ draft: { indication: '保存的检查指征', service: ctService }, draftVersion: 3, requests: [request({ report })] }} />)
    expect(await screen.findByText(report.impression)).toBeTruthy()
    expect(screen.queryByText(/已保存草稿：/)).toBeNull()
    await userEvent.setup().click(await screen.findByRole('button', { name: '调整' }))
    expect(within(await screen.findByRole('region', { name: '待开具项目详情' })).getByLabelText('检查目的')).toHaveProperty('value', '保存的检查指征')
  })

  it('preserves an adjusted legacy row when another manual examination is added', async () => {
    stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? { items: services.items.map(item => ({ ...item, available: true })) } : recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 2, requests: [], draft: { service: ctService, indication: '已保存的检查指征' } }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '调整' }))
    const adjust = within(screen.getByRole('dialog', { name: '调整项目' }))
    await user.clear(adjust.getByLabelText('检查目的'))
    await user.type(adjust.getByLabelText('检查目的'), '医生在清单中补充的检查指征')
    await user.click(adjust.getByRole('button', { name: '保留本次调整' }))
    await user.click(screen.getByRole('button', { name: '添加放射检查' }))
    const composer = within(screen.getByRole('dialog'))
    await user.click(composer.getByRole('button', { name: /^胸片/ }))
    await user.type(composer.getByLabelText('检查指征'), '胸片独立指征')
    await user.click(composer.getByRole('button', { name: '加入放射检查' }))
    await user.click(composer.getByRole('button', { name: '关闭' }))
    expect(screen.getByText('医生在清单中补充的检查指征')).toBeTruthy()
    expect(screen.getByText('胸片独立指征')).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })

  it('preserves an existing manual examination when another automatic examination is adjusted', async () => {
    const calls = stubFetch(({ path }) => path.endsWith('/imaging-services')
      ? Response.json({ items: services.items.map(item => ({ ...item, available: true })) })
      : path.endsWith('/actions/confirm')
        ? Response.json(commandResponse({ kind: 'imaging', draftVersion: 3, encounterVersion: '3', recordIds: ['manual-new', 'adjusted-new'] }))
        : Response.json(recommendations()))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 2, requests: [],
      draft: { service: radiographService, indication: '医生已保存的胸片指征' } }} />)
    const user = userEvent.setup()
    await screen.findByRole('checkbox', { name: '选择胸部 CT 平扫' })
    await user.click(screen.getAllByRole('button', { name: '调整' })[1]!)
    const dialog = screen.getByRole('dialog', { name: '调整项目' })
    const input = within(dialog).getByRole('textbox', { name: '检查目的' })
    await user.clear(input)
    await user.type(input, '医生补充的 CT 检查指征')
    await user.click(within(dialog).getByRole('button', { name: '保留本次调整' }))
    expect(screen.getByRole('checkbox', { name: '选择胸片' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择胸部 CT 平扫' })).toBeTruthy()
    expect(screen.getByText('医生已保存的胸片指征')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^开具选中项目/ }))
    await waitFor(() => expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1))
    expect(calls.find(call => call.method !== 'GET')?.body).toMatchObject({ input: { selections: [
      { source: 'manual', kind: 'imaging', serviceId: radiographService.id, indication: '医生已保存的胸片指征' },
      { source: 'agent', kind: 'imaging', serviceId: ctService.id, indication: '医生补充的 CT 检查指征', suggestionId: expect.any(String) },
    ] } })
  })

  it('keeps a saved manual row visible with a retryable error when removing its draft fails', async () => {
    stubFetch(({ method, path }) => path.endsWith('/imaging-services') ? Response.json(services)
      : method === 'DELETE' ? Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: 'Synthetic draft deletion failed' } }, { status: 409 })
      : Response.json(recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 2, requests: [], draft: { service: ctService, indication: '需保留的人工检查指征' } }} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: '移除胸部 CT 平扫' }))
    expect(await screen.findByText('草稿未移除')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择胸部 CT 平扫' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除胸部 CT 平扫' })).toHaveProperty('disabled', false)
  })

  it('keeps a restored draft dialog closed while its category is inactive', async () => {
    stubFetch(() => Response.json(services))
    renderPage(<Page active={false} editDraft onChanged={() => undefined} state={{
      draft: { indication: '保存的检查指征', service: ctService }, draftVersion: 3, requests: [request({ report })],
    }} />)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('requires explicit confirmation to discard manual pending rows and closes the confirmation after success', async () => {
    stubFetch(({ path }) => Response.json(path.endsWith('/imaging-services') ? services : recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [request({ report })] }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '添加放射检查' }))
    const composer = within(screen.getByRole('dialog'))
    await user.click(composer.getByRole('button', { name: /^胸部 CT 平扫/ }))
    await user.type(composer.getByLabelText('检查指征'), '保存的检查指征')
    await user.click(composer.getByRole('button', { name: '加入放射检查' }))
    await user.click(composer.getByRole('button', { name: '关闭' }))
    await user.click(screen.getByRole('button', { name: '清空待开清单' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消' }))
    expect(screen.getByRole('checkbox')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '清空待开清单' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认清空' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(report.impression)).toBeTruthy()
  })

  it.each(['success', 'failure'])('protects the discard confirmation during deletion and allows closing after %s', async outcome => {
    let releaseDelete: (response: Response) => void = () => { throw new Error('Deletion is not pending') }
    const deletion = new Promise<Response>(resolve => { releaseDelete = resolve })
    const calls = stubFetch(({ method, path }) => method === 'DELETE' ? deletion
      : Response.json(path.endsWith('/imaging-services') ? services : recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 2, requests: [],
      draft: { service: ctService, indication: '合成检查指征' } }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '清空待开清单' }))
    const confirmation = within(screen.getByRole('alertdialog'))
    await user.click(confirmation.getByRole('button', { name: '确认清空' }))
    await waitFor(() => expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1))
    expect(confirmation.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    releaseDelete(outcome === 'success' ? Response.json(commandResponse({ caseId: 'case-1', draftVersion: 3 }))
      : Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成草稿删除失败' } }, { status: 409 }))
    if (outcome === 'failure') {
      await confirmation.findByRole('alert')
      expect(confirmation.getByRole('button', { name: '取消' })).toHaveProperty('disabled', false)
      await user.click(confirmation.getByRole('button', { name: '取消' }))
      expect(screen.getByRole('checkbox', { name: '选择胸部 CT 平扫' })).toBeTruthy()
    } else {
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择胸部 CT 平扫' })).toBeNull())
    }
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('retains manual indication and blocks short input when formal issuance conflicts', async () => {
    const calls = stubFetch(({ path }) => path.endsWith('/imaging-services') ? Response.json(services)
      : path.endsWith('/actions/confirm') ? Response.json({ error: { code: 'CATALOG_CONFLICT', message: 'The selected service changed' } }, { status: 409 })
      : Response.json(recommendations({ items: [] })))
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '添加放射检查' }))
    const composer = within(screen.getByRole('dialog'))
    await user.click(composer.getByRole('button', { name: /^胸部 CT 平扫/ }))
    await user.type(composer.getByLabelText('检查指征'), '咳')
    expect(composer.getByRole('button', { name: '加入放射检查' })).toHaveProperty('disabled', true)
    await user.type(composer.getByLabelText('检查指征'), '嗽两周')
    await user.click(composer.getByRole('button', { name: '加入放射检查' }))
    await user.click(composer.getByRole('button', { name: '关闭' }))
    await user.click(screen.getByRole('button', { name: /^开具选中项目/ }))
    expect(await screen.findByText('更新或提交未完成，草稿已保留。')).toBeTruthy()
    expect(screen.getByRole('checkbox')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '调整' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('检查目的')).toHaveProperty('value', '咳嗽两周')
    expect(calls.some(call => call.method === 'PUT')).toBe(false)
  })

  it('shows only the selected request report and changes the detail from the request list', async () => {
    stubFetch(() => Response.json(services))
    const user = userEvent.setup()
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [
      request({ report }),
      request({ id: 'request-2', service: radiographService, report: { ...report, diagnosticReportId: 'report-2', impression: '胸片报告结论。' } }),
    ] }} />)

    expect(await screen.findByText(report.impression)).toBeTruthy()
    expect(screen.getByText(/第 1 版/)).toBeTruthy()
    expect(screen.queryByText('胸片报告结论。')).toBeNull()
    expect(await screen.findByRole('button', { name: '添加放射检查' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /胸片.*已报告/ }))
    expect(screen.getByText('胸片报告结论。')).toBeTruthy()
    expect(screen.queryByText(report.impression)).toBeNull()
  })

  it('keeps manual additions and existing reports available when the Agent cannot load', async () => {
    stubFetch(({ method, path }) => path.endsWith('/imaging-services') ? Response.json(services)
      : method === 'PUT' && path.endsWith('/imaging-request/draft') ? Response.json(commandResponse({ caseId: 'case-1', draftVersion: 1 }))
      : path.endsWith('/actions/confirm') ? Response.json(commandResponse({ kind: 'imaging', draftVersion: 2, encounterVersion: '3', recordIds: ['new'] }))
      : Response.json({ error: { code: 'AI_REQUEST_FAILED', message: 'Synthetic model unavailable' } }, { status: 503 }))
    const user = userEvent.setup()
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 1, requests: [request({ report })] }} />)
    expect(screen.getByText(report.impression)).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: '添加放射检查' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: /胸部 CT 平扫/ }))
    await user.type(dialog.getByLabelText('检查指征'), '人工核对后排查肺部病变')
    await user.click(dialog.getByRole('button', { name: '加入放射检查' }))
    await user.click(dialog.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText(report.impression)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^开具选中项目/ }))
    expect(await screen.findByText(/已完成开具/)).toBeTruthy()
  })

  it('keeps report history collapsed until navigation targets an earlier report version', async () => {
    stubFetch(() => Response.json(services))
    const previousReport = { ...report, diagnosticReportId: 'report-old', impression: '旧版报告结论。' }
    function ReportNavigationPage() {
      const [selectedReportId, setSelectedReportId] = useState<string>()
      return <>
        <button onClick={() => setSelectedReportId('report-old')}>跳转历史报告</button>
        <Page onChanged={() => undefined} selectedReportId={selectedReportId} state={{ draftVersion: 0, requests: [request({
          previousReports: [previousReport],
          report: { ...report, revisionNumber: 2, revisionOfDiagnosticReportId: 'report-old', revisionReason: '复核报告内容' },
        })] }} />
      </>
    }
    const user = userEvent.setup()
    renderPage(<ReportNavigationPage />)

    const history = screen.getByText('历史报告 · 1').closest('details')!
    expect(history.open).toBe(false)
    await user.click(screen.getByRole('button', { name: '跳转历史报告' }))
    expect(history.open).toBe(true)
    expect(within(history).getByText('旧版报告结论。')).toBeTruthy()
    expect(screen.getByText(/第 2 版，更正原因：复核报告内容/)).toBeTruthy()
  })

  it('enables acknowledgement only after the images are shown', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (path === '/api/his/v1/imaging-studies/study-1') {
        return Response.json({
          available: true,
          examCode: 'chest-ct-plain',
          series: [{
            frames: [{ blocks: [{ length: 4, rowCount: 1, rowStart: 0 }], columns: 2, pixelSpacingMm: [1, 1], positionMm: 0, rows: 1 }],
            kind: 'frame-stack',
            modality: 'CT',
            pixelFormat: 'int16',
            valueUnit: 'hu',
          }],
          studyId: 'study-1',
        })
      }
      if (path.includes('/blocks/')) return new Response(new Uint8Array(new Int16Array([-600, 40]).buffer))
      if (method === 'POST') {
        return Response.json(commandResponse({
          acknowledgementId: 'acknowledgement-1',
          acknowledgedAt: '2026-06-01T10:00:00+08:00',
          acknowledgedBy: 'practitioner-1',
          diagnosticReportId: 'report-1',
          requestId: 'request-1',
          requestVersion: 5,
          status: 'acknowledged',
        }))
      }
      return new Response('{}', { status: 404 })
    })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    renderPage(
      <Page
        onChanged={onChanged}
        state={{ draftVersion: 2, requests: [request({ report })] }}
      />,
    )

    const item = (await within(screen.getByRole('region', { name: '放射申请详情' })).findByText('胸部 CT 平扫')).closest('li')!
    expect(within(item).getByText('右肺实性肿块，长径约 31 mm，建议结合临床进一步检查。')).toBeTruthy()
    const acknowledge = within(item).getByRole('button', { name: '确认已阅' }) as HTMLButtonElement
    expect(acknowledge.disabled).toBe(true)
    expect(calls.some(call => call.path.includes('/imaging-studies/'))).toBe(false)

    await user.click(within(item).getByRole('button', { name: '打开影像' }))
    await waitFor(() => expect(acknowledge.disabled).toBe(false))
    expect(calls.map(call => call.path)).toContain('/api/his/v1/imaging-studies/study-1/series/0/frames/0/blocks/0')
    await user.click(acknowledge)

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(calls.find(call => call.method === 'POST')).toEqual({
      body: { expectedVersions: { 'DiagnosticReport/report-1': '1' }, input: { expectedRequestVersion: 4 } },
      method: 'POST',
      path: '/api/his/v1/imaging-requests/request-1/reports/report-1/actions/acknowledge',
    })
  })

  it('does not load or mark images as shown while the imaging category is inactive', async () => {
    const calls = stubFetch(({ path }) => path.endsWith('/imaging-services')
      ? Response.json(services)
      : Response.json({ available: false, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' }))
    const user = userEvent.setup()
    renderPage(<Page active={false} onChanged={() => undefined} state={{ draftVersion: 0, requests: [request({ report })] }} />)

    const detail = screen.getByRole('region', { name: '放射申请详情' })
    await user.click(within(detail).getByRole('button', { name: '打开影像' }))
    expect(calls.some(call => call.path.includes('/imaging-studies/'))).toBe(false)
    expect((within(detail).getByRole('button', { name: '确认已阅' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes acknowledgement again when the study later reports its pixels unavailable', async () => {
    let available = true
    stubFetch(({ path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (path === '/api/his/v1/imaging-studies/study-1') {
        return Response.json(available
          ? {
              available: true,
              examCode: 'chest-ct-plain',
              series: [{
                frames: [{ blocks: [{ length: 4, rowCount: 1, rowStart: 0 }], columns: 2, pixelSpacingMm: [1, 1], positionMm: 0, rows: 1 }],
                kind: 'frame-stack',
                modality: 'CT',
                pixelFormat: 'int16',
                valueUnit: 'hu',
              }],
              studyId: 'study-1',
            }
          : { available: false, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' })
      }
      if (path.includes('/blocks/')) return new Response(new Uint8Array(new Int16Array([-600, 40]).buffer))
      return new Response('{}', { status: 404 })
    })
    const user = userEvent.setup()
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 2, requests: [request({ report })] }} />)

    const item = (await within(screen.getByRole('region', { name: '放射申请详情' })).findByText('胸部 CT 平扫')).closest('li')!
    const acknowledge = within(item).getByRole('button', { name: '确认已阅' }) as HTMLButtonElement
    await user.click(within(item).getByRole('button', { name: '打开影像' }))
    await waitFor(() => expect(acknowledge.disabled).toBe(false))

    // 重新打开时检查报告像素已不可读：此前显示过也不能再确认已阅。
    available = false
    await user.click(within(item).getByRole('button', { name: '收起影像' }))
    await user.click(within(item).getByRole('button', { name: '打开影像' }))
    expect(await within(item).findByText(/影像暂不可用/)).toBeTruthy()
    expect(acknowledge.disabled).toBe(true)
  })

  it('inserts the report summary on request and lets an administrator reissue the report from a reviewed revision', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (method === 'POST') {
        return Response.json(commandResponse({
          diagnosticReportId: 'report-2',
          previousDiagnosticReportId: 'report-1',
          provenanceId: 'provenance-2',
          requestId: 'request-1',
          requestVersion: 5,
          status: 'reported',
        }))
      }
      return new Response('{}', { status: 404 })
    })
    const onChanged = vi.fn()
    const onInsertSummary = vi.fn<NonNullable<ImagingPageActions['onInsertSummary']>>()
      .mockReturnValueOnce('inserted')
      .mockReturnValueOnce('duplicate')
    const user = userEvent.setup()
    renderPage(
      <Page
        canCorrect
        onChanged={onChanged}
        onInsertSummary={onInsertSummary}
        state={{ draftVersion: 2, requests: [request({ report })] }}
      />,
    )

    const item = (await within(screen.getByRole('region', { name: '放射申请详情' })).findByText('胸部 CT 平扫')).closest('li')!
    await user.click(within(item).getByRole('button', { name: '摘要插入病历' }))
    expect(within(item).getByRole('status').textContent).toContain('已插入病历“辅助检查”')
    await user.click(within(item).getByRole('button', { name: '摘要插入病历' }))
    expect(within(item).getByRole('status').textContent).toContain('未重复插入')
    expect(onInsertSummary).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'request-1' }), report)

    await user.click(within(item).getByText('更正报告（管理员）'))
    const submit = within(item).getByRole('button', { name: '提交更正' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await user.type(within(item).getByLabelText('报告内容修订号'), '2')
    await user.type(within(item).getByLabelText('更正原因'), '报告内容已重新核对')
    await user.click(submit)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(within(item).queryByText('报告未更正')).toBeNull()
    expect(calls.find(call => call.method === 'POST')).toEqual({
      body: {
        expectedVersions: { 'DiagnosticReport/report-1': '1' },
        input: { expectedRequestVersion: 4, reason: '报告内容已重新核对', reportRevision: 2 },
      },
      method: 'POST',
      path: '/api/his/v1/imaging-requests/request-1/reports/report-1/actions/correct',
    })
  })

  it('keeps acknowledgement closed while the pixels are unavailable and offers recovery for a failed examination', async () => {
    const failedRequest = request({ generationError: { code: 'IMAGING_RESULT_UNAVAILABLE', message: 'The imaging result is not available for this examination' },
      id: 'request-2', service: radiographService, status: 'generation-failed', taskVersion: '5', version: 4 })
    const requests = [request({ report }), failedRequest]
    const calls = stubFetch(({ method, path }) => {
      if (path === '/api/auth/context') return Response.json(actionSession)
      if (path === '/api/his/v1/doctor/cases/case-1') return Response.json(actionCase('imaging', requests))
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (path === '/api/his/v1/imaging-studies/study-1') return Response.json({ available: false, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' })
      if (method === 'POST') return Response.json({ ...commandResponse({ request: { ...failedRequest, generationError: undefined, status: 'in-progress', version: 5, taskVersion: '6' } }),
        effects: [{ kind: 'updated', reference: 'Task/task-1', versionId: '6' }] })
      return new Response('{}', { status: 404 })
    })
    const user = userEvent.setup()
    renderPage(<Page actionContext={actionContext} onChanged={() => undefined} state={{ draftVersion: 4, requests }} />)
    const reported = (await within(screen.getByRole('region', { name: '放射申请详情' })).findByText('胸部 CT 平扫')).closest('li')!
    await user.click(within(reported).getByRole('button', { name: '打开影像' }))
    expect(await within(reported).findByText(/影像暂不可用/)).toBeTruthy()
    expect((within(reported).getByRole('button', { name: '确认已阅' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(reported).getByText('右肺见一实性肿块（Im 85），长径约 31 mm，未见钙化。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /胸片.*未取得结果/ }))
    const failed = within(screen.getByRole('region', { name: '放射申请详情' })).getByText('胸片').closest('li')!
    expect(within(failed).getByText(/没有取得结果/)).toBeTruthy()
    expect(within(failed).queryByText(/IMAGING_RESULT_UNAVAILABLE/)).toBeNull()
    expect(screen.getByRole('checkbox', { name: '选择取消：胸片' }).getAttribute('aria-disabled')).not.toBe('true')
    await user.click(screen.getByRole('checkbox', { name: '选择重试：胸片' }))
    await user.click(screen.getByRole('button', { name: '集中重试申请' }))
    const preview = within(screen.getByRole('dialog', { name: '集中重试申请核对' }))
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
    await user.click(preview.getByRole('button', { name: '确认重试申请' }))
    await waitFor(() => expect(screen.getByRole('region', { name: '重试申请逐项结果' }).textContent).toContain('成功 1/1'))
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ body: { expectedVersions: { 'Task/task-1': '5' }, input: { expectedRequestVersion: 4 } },
      method: 'POST', path: '/api/his/v1/imaging-requests/request-2/actions/retry' }])
  })})
