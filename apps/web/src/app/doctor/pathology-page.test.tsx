// @vitest-environment jsdom
import type { PathologyRequest, PathologyServiceSnapshot } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useImagingViewState } from './imaging-page.tsx'
import { PathologyPage, type PathologyPageActions } from './pathology-page.tsx'

// 切片引擎依赖真实 canvas，在浏览器合同测试中验证；这里用替身表达“切片已成功显示”。
vi.mock('../imaging/imaging-viewer.tsx', () => ({
  ImagingViewer: ({ onFrameShown, source }: { onFrameShown?: () => void; source: { study: { available: boolean } } }) => (
    source.study.available
      ? <button onClick={onFrameShown} type="button">切片已显示</button>
      : <p>影像暂不可用</p>
  ),
}))

const service: PathologyServiceSnapshot = {
  applicability: '既往乳腺手术切除标本切片的会诊复核',
  bodySite: '乳腺',
  code: 'PATH-BREAST-SLIDE-CONSULT',
  department: '病理科',
  examCode: 'breast-slide-consultation',
  id: 'pathology-breast-slide-consultation',
  name: '乳腺切片病理会诊',
  reportSections: ['specimen', 'microscopy', 'diagnosis', 'immunohistochemistry', 'note'],
  specimenType: '既往手术切除标本的石蜡切片',
  stain: 'HE',
  version: 1,
}
const lumpectomy = { code: '392021009', display: '乳房肿块切除术', performedAt: '2022-04-01T08:00:00+08:00', sourceReference: 'urn:uuid:procedure-0' }
const excision = { code: '392023007', display: '乳腺病灶切除术', performedAt: '2023-01-05T08:00:00+08:00', sourceReference: 'urn:uuid:procedure-1' }

function request(overrides: Partial<PathologyRequest> = {}): PathologyRequest {
  return {
    id: 'request-1',
    previousReports: [],
    purpose: '外院手术切片复核',
    service,
    serviceRequestId: 'service-request-1',
    serviceRequestVersion: '2',
    sourceProcedure: lumpectomy,
    status: 'reported',
    taskId: 'task-1',
    taskVersion: '4',
    version: 4,
    ...overrides,
  }
}

const report = {
  diagnosis: '乳腺浸润性导管癌。原始资料未提供组织学分级。',
  diagnosticReportId: 'report-1',
  diagnosticReportVersion: '1',
  immunohistochemistry: '以下结果引自原始病理资料，本次会诊未提供免疫组化切片。ER：阳性；PR：阳性；HER2：阴性。',
  issuedAt: '2026-06-01T10:00:00+08:00',
  microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌。',
  note: '本次会诊切片为原发灶组织，未包含淋巴结。',
  receivedAt: '2026-06-01T10:00:00+08:00',
  revisionNumber: 1,
  specimen: { procedure: lumpectomy, slideCount: 1, specimenId: 'specimen-1', stain: 'HE' as const },
  status: 'final' as const,
  studyId: 'study-1',
}

function commandResponse(data: unknown) {
  return { auditId: 'audit-1', data, effects: [], requestId: 'request-id-1', warnings: [] }
}

interface Call { body: unknown; method: string; path: string }

function stubFetch(handler: (call: Call) => Response): Call[] {
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
  const rendered = render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
  return { ...rendered, rerenderPage: (next: React.JSX.Element) => rendered.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) }
}

/** 像医生工作台一样由调用方持有阅片状态。 */
function Page({ active = true, canCorrect = false, editDraft = false, onChanged, onInsertSummary, onSelectRequest, readOnly = false, selectedReportId, state }: {
  active?: boolean
  canCorrect?: boolean
  editDraft?: boolean
  onChanged: PathologyPageActions['onChanged']
  onInsertSummary?: PathologyPageActions['onInsertSummary']
  onSelectRequest?: (requestId: string) => void
  readOnly?: boolean
  selectedReportId?: string
  state: Parameters<typeof PathologyPage>[0]['state']
}) {
  const view = useImagingViewState('case-1')
  return (
    <PathologyPage
      actions={{ canCorrect, onChanged, onInsertSummary, view }}
      active={active}
      caseId="case-1"
      elementId="pathology"
      editDraft={editDraft}
      encounter={{ id: 'encounter-1', versionId: '3' }}
      locale="zh-CN"
      onSelectRequest={onSelectRequest}
      readOnly={readOnly}
      selectedReportId={selectedReportId}
      state={state}
    />
  )
}

const services = { items: [{ available: true, service, sourceProcedures: [lumpectomy, excision] }] }

describe('doctor pathology consultation page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('shows the searchable catalog directly without selecting a consultation by default', async () => {
    stubFetch(() => Response.json({ items: [
      ...services.items,
      { available: true, service: { ...service, id: 'pathology-second', name: '乳腺切片复核' }, sourceProcedures: [excision] },
    ] }))
    const user = userEvent.setup()
    renderPage(<Page onChanged={vi.fn()} state={{ draftVersion: 0, requests: [] }} />)

    const search = await screen.findByRole('searchbox', { name: '搜索病理目录' })
    expect(screen.getAllByRole('radio').every(radio => !(radio as HTMLInputElement).checked)).toBe(true)
    expect(screen.queryByText('本次就诊暂无病理会诊申请。')).toBeNull()
    expect(screen.queryByLabelText('会诊目的')).toBeNull()
    await user.type(search, '复核')
    expect(screen.queryByRole('radio', { name: '选择乳腺切片病理会诊' })).toBeNull()
    await user.click(screen.getByRole('radio', { name: '选择乳腺切片复核' }))
    expect(screen.getByRole('combobox', { name: '送检的既往手术' })).toBeTruthy()
    expect(screen.getByLabelText('会诊目的')).toBeTruthy()
    expect((screen.getByRole('button', { name: '签发申请' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows only the selected request detail and keeps new consultations in the add dialog', async () => {
    stubFetch(() => Response.json(services))
    const user = userEvent.setup()
    renderPage(<Page onChanged={vi.fn()} state={{ draftVersion: 0, requests: [
      request({ report }),
      request({ id: 'request-2', status: 'acknowledged', report: { ...report, diagnosticReportId: 'report-2', diagnosis: '第二份切片会诊诊断。' } }),
    ] }} />)

    expect(await screen.findByText(report.diagnosis)).toBeTruthy()
    expect(screen.queryByText('第二份切片会诊诊断。')).toBeNull()
    expect(screen.queryByRole('searchbox', { name: '搜索病理目录' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /乳腺切片病理会诊.*医生已阅/ }))
    expect(screen.getByText('第二份切片会诊诊断。')).toBeTruthy()
    expect(screen.queryByText(report.diagnosis)).toBeNull()
    await user.click(screen.getByRole('button', { name: '追加申请' }))
    const dialog = await screen.findByRole('dialog', { name: '追加申请' })
    expect(within(dialog).getByRole('searchbox', { name: '搜索病理目录' })).toBeTruthy()
    expect(within(dialog).getByRole('radio', { name: `选择${service.name}` })).toBeTruthy()
  })

  it('opens the targeted historical report while keeping other histories collapsed by default', async () => {
    stubFetch(() => Response.json(services))
    const previousReport = { ...report, diagnosticReportId: 'report-old', diagnosis: '此前报告诊断。' }
    const state = { draftVersion: 0, requests: [request({ report, previousReports: [previousReport] })] }
    const { rerenderPage } = renderPage(<Page onChanged={vi.fn()} state={state} />)
    const history = screen.getByText('历史报告 · 1').closest('details')!
    expect(history.open).toBe(false)

    rerenderPage(<Page onChanged={vi.fn()} selectedReportId="report-old" state={state} />)
    await waitFor(() => expect(history.open).toBe(true))
    expect(within(history).getByText('此前报告诊断。')).toBeTruthy()
  })

  it('unmounts the slide reader while the pathology category is inactive', async () => {
    stubFetch(({ path }) => path.endsWith('/pathology-services')
      ? Response.json(services)
      : Response.json({ available: true, examCode: 'breast-slide-consultation', series: [], studyId: 'study-1' }))
    const user = userEvent.setup()
    const state = { draftVersion: 0, requests: [request({ report })] }
    const { rerenderPage } = renderPage(<Page onChanged={vi.fn()} state={state} />)
    await user.click(screen.getByRole('button', { name: '打开切片' }))
    expect(await screen.findByRole('button', { name: '切片已显示' })).toBeTruthy()

    rerenderPage(<Page active={false} onChanged={vi.fn()} state={state} />)
    expect(screen.queryByRole('button', { name: '切片已显示' })).toBeNull()
    expect((screen.getByRole('button', { name: '确认已阅' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves the edited draft with the selected source procedure before issuing it', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/pathology-services')) return Response.json(services)
      if (method === 'PUT') return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 3 }))
      return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 4, request: request({ status: 'issued', version: 1 }) }))
    })
    const onChanged = vi.fn()
    const onSelectRequest = vi.fn()
    const user = userEvent.setup()
    renderPage(
      <Page
        onChanged={onChanged}
        onSelectRequest={onSelectRequest}
        state={{ draft: { purpose: '复核', service, sourceProcedure: lumpectomy }, draftVersion: 2, requests: [] }}
      />,
    )

    expect(await screen.findByText('已保存草稿：乳腺切片病理会诊（乳房肿块切除术 · 2022-04-01）')).toBeTruthy()
    // 可选的手术来自病例可见既往病史。
    act(() => screen.getByRole('combobox', { name: '送检的既往手术' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '乳腺病灶切除术 · 2023-01-05' }))
    const purpose = screen.getByLabelText('会诊目的')
    await user.clear(purpose)
    await user.type(purpose, '外院手术切片复核，明确病理类型')
    await user.click(screen.getByRole('button', { name: '签发申请' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(onSelectRequest).toHaveBeenCalledWith('request-1')
    expect(calls.filter(call => call.method !== 'GET')).toEqual([
      {
        body: {
          expectedVersions: { 'Encounter/encounter-1': '3' },
          input: {
            expectedDraftVersion: 2,
            purpose: '外院手术切片复核，明确病理类型',
            serviceId: 'pathology-breast-slide-consultation',
            sourceProcedureReference: 'urn:uuid:procedure-1',
          },
        },
        method: 'PUT',
        path: '/api/his/v1/encounters/encounter-1/pathology-request/draft',
      },
      {
        // 签发使用保存后返回的草稿版本。
        body: { expectedVersions: { 'Encounter/encounter-1': '3' }, input: { expectedDraftVersion: 3 } },
        method: 'POST',
        path: '/api/his/v1/encounters/encounter-1/pathology-request/actions/issue',
      },
    ])
  })

  it('keeps the editable draft and catalog when issuing the consultation fails', async () => {
    const calls = stubFetch(({ path }) => path.endsWith('/pathology-services')
      ? Response.json(services)
      : Response.json({ error: { code: 'CATALOG_CONFLICT', message: 'The consultation service is no longer available' } }, { status: 409 }))
    const user = userEvent.setup()
    const onSelectRequest = vi.fn()
    renderPage(<Page onChanged={vi.fn()} onSelectRequest={onSelectRequest} state={{
      draft: { purpose: '保存的会诊目的', service, sourceProcedure: lumpectomy },
      draftVersion: 2,
      requests: [],
    }} />)

    await screen.findByLabelText('会诊目的')
    await user.click(screen.getByRole('button', { name: '签发申请' }))
    expect(await screen.findByText('病理会诊申请未提交')).toBeTruthy()
    expect((screen.getByLabelText('会诊目的') as HTMLTextAreaElement).value).toBe('保存的会诊目的')
    expect(screen.getByRole('combobox', { name: '送检的既往手术' }).textContent).toContain('乳房肿块切除术 · 2022-04-01')
    expect(screen.getByRole('searchbox', { name: '搜索病理目录' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '申请列表' })).toBeNull()
    expect(onSelectRequest).not.toHaveBeenCalled()
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1)
  })

  it('keeps completed consultations readable with corrections but without request writes', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    renderPage(<Page canCorrect onChanged={vi.fn()} readOnly state={{ draftVersion: 0, requests: [request({ report })] }} />)

    expect(screen.getByText(report.diagnosis)).toBeTruthy()
    expect(screen.getByText('更正报告（管理员）')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开切片' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '追加申请' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认已阅' })).toBeNull()
    expect(screen.queryByRole('button', { name: '签发申请' })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps issued requests in management until an agent-prepared draft explicitly opens for editing', async () => {
    stubFetch(() => Response.json(services))
    const state = {
      draft: { purpose: '保存的会诊目的', service, sourceProcedure: excision },
      draftVersion: 2,
      requests: [request({ report })],
    }
    const { rerenderPage } = renderPage(<Page key="normal" onChanged={vi.fn()} state={state} />)
    expect(screen.queryByRole('dialog', { name: '追加申请' })).toBeNull()
    expect(screen.getByText(report.diagnosis)).toBeTruthy()
    rerenderPage(<Page editDraft key="agent-prepared" onChanged={vi.fn()} state={state} />)

    const dialog = await screen.findByRole('dialog', { name: '追加申请' })
    expect((await within(dialog).findByLabelText('会诊目的') as HTMLTextAreaElement).value).toBe('保存的会诊目的')
    expect(within(dialog).getByRole('combobox', { name: '送检的既往手术' }).textContent).toContain('乳腺病灶切除术 · 2023-01-05')
    expect((within(dialog).getByRole('radio', { name: `选择${service.name}` }) as HTMLInputElement).checked).toBe(true)
  })

  it('shows a consultation the hospital does not offer and a history without a source procedure', async () => {
    stubFetch(() => Response.json({
      items: [
        { available: true, service, sourceProcedures: [] },
        { available: false, service: { ...service, id: 'pathology-other', name: '其他切片会诊' }, sourceProcedures: [] },
      ],
    }))
    const user = userEvent.setup()
    renderPage(<Page onChanged={vi.fn()} state={{ draftVersion: 0, requests: [] }} />)

    expect(await screen.findByText('其他切片会诊：本院当前未开展')).toBeTruthy()
    expect((screen.getByRole('radio', { name: '选择其他切片会诊' }) as HTMLInputElement).disabled).toBe(true)
    await user.click(screen.getByRole('radio', { name: `选择${service.name}` }))
    expect(screen.getByText('该患者的既往病史中没有可送检的乳腺手术。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '签发申请' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the report with its specimen and enables acknowledgement only after the slide is shown', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/pathology-services')) return Response.json(services)
      if (path === '/api/his/v1/imaging-studies/study-1') {
        return Response.json({ available: true, examCode: 'breast-slide-consultation', series: [], studyId: 'study-1' })
      }
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
    const onInsertSummary = vi.fn(() => 'inserted' as const)
    const user = userEvent.setup()
    renderPage(
      <Page
        onChanged={onChanged}
        onInsertSummary={onInsertSummary}
        state={{ draftVersion: 2, requests: [request({ report })] }}
      />,
    )

    const item = await screen.findByRole('region', { name: '申请详情' })
    expect(within(item).getByText('报告已出')).toBeTruthy()
    expect(within(item).getByText(/第 1 版/)).toBeTruthy()
    expect(within(item).getByText('送检手术：乳房肿块切除术 · 2022-04-01')).toBeTruthy()
    expect(within(item).getByText('既往手术：乳房肿块切除术 · 2022-04-01；HE 染色切片 1 张')).toBeTruthy()
    expect(within(item).getByText('乳腺浸润性导管癌。原始资料未提供组织学分级。')).toBeTruthy()
    expect(within(item).getByText(/以下结果引自原始病理资料/)).toBeTruthy()
    const acknowledge = within(item).getByRole('button', { name: '确认已阅' }) as HTMLButtonElement
    expect(acknowledge.disabled).toBe(true)
    expect(within(item).getByText('打开切片并成功显示后才能确认已阅')).toBeTruthy()

    await user.click(within(item).getByRole('button', { name: '打开切片' }))
    await user.click(await within(item).findByRole('button', { name: '切片已显示' }))
    await waitFor(() => expect(acknowledge.disabled).toBe(false))
    await user.click(acknowledge)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(calls.find(call => call.method === 'POST')).toEqual({
      body: { expectedVersions: { 'DiagnosticReport/report-1': '1' }, input: { expectedRequestVersion: 4 } },
      method: 'POST',
      path: '/api/his/v1/pathology-requests/request-1/reports/report-1/actions/acknowledge',
    })

    await user.click(within(item).getByRole('button', { name: '摘要插入病历' }))
    expect(onInsertSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'request-1' }), expect.objectContaining({ diagnosticReportId: 'report-1' }))
    expect(within(item).getByRole('status').textContent).toContain('已插入病历“辅助检查”')
  })

  it('offers retry and cancel for a consultation without a result and correction only to an administrator', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/pathology-services')) return Response.json(services)
      if (method === 'POST' && path.endsWith('/actions/correct')) {
        return Response.json(commandResponse({
          diagnosticReportId: 'report-2',
          previousDiagnosticReportId: 'report-1',
          provenanceId: 'provenance-1',
          requestId: 'request-2',
          requestVersion: 6,
          status: 'reported',
        }))
      }
      if (method === 'POST') return Response.json(commandResponse({ request: request({ status: 'in-progress' }) }))
      return new Response('{}', { status: 404 })
    })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    renderPage(
      <Page
        canCorrect
        onChanged={onChanged}
        state={{
          draftVersion: 2,
          requests: [
            request({ generationError: { code: 'PATHOLOGY_RESULT_UNAVAILABLE', message: 'unavailable' }, status: 'generation-failed' }),
            request({ id: 'request-2', report: { ...report, acknowledgement: { acknowledgedAt: report.issuedAt, acknowledgedBy: 'practitioner-1', id: 'acknowledgement-1' } }, status: 'acknowledged', version: 5 }),
          ],
        }}
      />,
    )

    const failed = await screen.findByRole('region', { name: '申请详情' })
    expect(within(failed).getByText('未取得结果')).toBeTruthy()
    expect(within(failed).getByText('本次会诊没有取得结果，未生成报告。可以重试，或取消该申请。')).toBeTruthy()
    // 失败原因的内部代码不显示给医生。
    expect(within(failed).queryByText(/PATHOLOGY_RESULT_UNAVAILABLE/)).toBeNull()
    await user.click(within(failed).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(calls.some(call => call.path === '/api/his/v1/pathology-requests/request-1/actions/retry')).toBe(true))
    expect(within(failed).getByRole('button', { name: '取消申请' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /乳腺切片病理会诊.*医生已阅/ }))
    const acknowledged = screen.getByRole('region', { name: '申请详情' })
    expect(within(acknowledged).getByText('医生已阅')).toBeTruthy()
    expect(within(acknowledged).queryByRole('button', { name: '确认已阅' })).toBeNull()
    await user.click(within(acknowledged).getByText('更正报告（管理员）'))
    await user.type(within(acknowledged).getByLabelText('报告内容修订号'), '2')
    await user.type(within(acknowledged).getByLabelText('更正原因'), '更正镜下所见措辞')
    await user.click(within(acknowledged).getByRole('button', { name: '提交更正' }))
    await waitFor(() => expect(calls.find(call => call.path.endsWith('/actions/correct'))).toEqual({
      body: {
        expectedVersions: { 'DiagnosticReport/report-1': '1' },
        input: { expectedRequestVersion: 5, reason: '更正镜下所见措辞', reportRevision: 2 },
      },
      method: 'POST',
      path: '/api/his/v1/pathology-requests/request-2/reports/report-1/actions/correct',
    }))
  })
})
