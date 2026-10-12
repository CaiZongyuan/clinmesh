// @vitest-environment jsdom
import type { ImagingRequest, ImagingServiceSnapshot } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagingPage, useImagingViewState, type ImagingPageActions } from './imaging-page.tsx'

const ctService: ImagingServiceSnapshot = {
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
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

/** 像医生工作台一样由调用方持有阅片状态。 */
function Page({ active = true, canCorrect = false, editDraft = false, onChanged, onInsertSummary, selectedReportId, state }: {
  active?: boolean
  editDraft?: boolean
  canCorrect?: boolean
  onChanged: ImagingPageActions['onChanged']
  onInsertSummary?: ImagingPageActions['onInsertSummary']
  selectedReportId?: string | undefined
  state: Parameters<typeof ImagingPage>[0]['state']
}) {
  const view = useImagingViewState('case-1')
  return (
    <ImagingPage
      active={active}
      actions={{ canCorrect, onChanged, onInsertSummary, view }}
      caseId="case-1"
      elementId="imaging"
      editDraft={editDraft}
      encounter={{ id: 'encounter-1', versionId: '3' }}
      locale="zh-CN"
      readOnly={false}
      selectedReportId={selectedReportId}
      state={state}
    />
  )
}

const services = { items: [{ available: true, service: ctService }, { available: false, service: radiographService }] }

describe('doctor imaging page', () => {
  beforeEach(() => {
    // jsdom 没有 canvas 与 ImageData；阅片器只需要能把一帧画上去。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: () => undefined } as never)
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('opens a searchable catalog without selecting an examination or enabling issuance', async () => {
    const calls = stubFetch(() => Response.json(services))
    const user = userEvent.setup()
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)

    const search = await screen.findByRole('textbox', { name: '搜索放射目录' })
    expect(screen.queryByLabelText('检查指征')).toBeNull()
    expect((screen.getByRole('button', { name: '签发申请' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('本次就诊暂无放射申请。')).toBeNull()
    expect((screen.getByRole('button', { name: /胸片.*本院当前未开展/ }) as HTMLButtonElement).disabled).toBe(true)

    await user.type(search, 'CT')
    expect(screen.queryByRole('button', { name: /胸片.*本院当前未开展/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /胸部 CT 平扫.*平扫/ }))
    expect(screen.getByText(ctService.applicability)).toBeTruthy()
    await user.type(screen.getByLabelText('检查指征'), '咳嗽两周')
    expect((screen.getByRole('button', { name: '签发申请' }) as HTMLButtonElement).disabled).toBe(false)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('saves the edited draft before issuing it and lists services the hospital does not currently offer', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (method === 'PUT') return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 3 }))
      return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 4, request: request({ status: 'issued', version: 1 }) }))
    })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    renderPage(
      <Page
        onChanged={onChanged}
        state={{ draft: { indication: '咳嗽', service: ctService }, draftVersion: 2, requests: [] }}
      />,
    )

    expect(await screen.findByText('胸片：本院当前未开展')).toBeTruthy()
    expect(screen.getByText('已保存草稿：胸部 CT 平扫')).toBeTruthy()
    const indication = screen.getByLabelText('检查指征')
    await user.clear(indication)
    await user.type(indication, '咳嗽两周，排查肺部病变')
    await user.click(screen.getByRole('button', { name: '签发申请' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(calls.filter(call => call.method !== 'GET')).toEqual([
      {
        body: {
          expectedVersions: { 'Encounter/encounter-1': '3' },
          input: { expectedDraftVersion: 2, indication: '咳嗽两周，排查肺部病变', serviceId: 'imaging-chest-ct-plain' },
        },
        method: 'PUT',
        path: '/api/his/v1/encounters/encounter-1/imaging-request/draft',
      },
      {
        // 签发使用保存后返回的草稿版本。
        body: { expectedVersions: { 'Encounter/encounter-1': '3' }, input: { expectedDraftVersion: 3 } },
        method: 'POST',
        path: '/api/his/v1/encounters/encounter-1/imaging-request/actions/issue',
      },
    ])
  })

  it('restores an existing request draft in the add dialog when requests already exist', async () => {
    stubFetch(() => Response.json(services))
    renderPage(<Page editDraft onChanged={() => undefined} state={{
      draft: { indication: '保存的检查指征', service: ctService }, draftVersion: 3, requests: [request({ report })],
    }} />)

    const dialog = await screen.findByRole('dialog', { name: '追加申请' })
    expect((await within(dialog).findByLabelText('检查指征') as HTMLTextAreaElement).value).toBe('保存的检查指征')
    expect(within(dialog).getByText('已保存草稿：胸部 CT 平扫')).toBeTruthy()
  })

  it('keeps a restored draft dialog closed while its category is inactive', async () => {
    stubFetch(() => Response.json(services))
    renderPage(<Page active={false} editDraft onChanged={() => undefined} state={{
      draft: { indication: '保存的检查指征', service: ctService }, draftVersion: 3, requests: [request({ report })],
    }} />)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('defaults to request management and restores a saved draft only when adding is opened', async () => {
    stubFetch(() => Response.json(services))
    const user = userEvent.setup()
    renderPage(<Page onChanged={() => undefined} state={{
      draft: { indication: '保存的检查指征', service: ctService }, draftVersion: 3, requests: [request({ report })],
    }} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(report.impression)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '追加申请' }))
    const dialog = await screen.findByRole('dialog', { name: '追加申请' })
    expect((await within(dialog).findByLabelText('检查指征') as HTMLTextAreaElement).value).toBe('保存的检查指征')
  })

  it('retains the selected examination and indication when issuance fails', async () => {
    stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (method === 'PUT') return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 1 }))
      return Response.json({ error: { code: 'CATALOG_CONFLICT', message: 'The selected imaging service is no longer available' } }, { status: 409 })
    })
    const user = userEvent.setup()
    renderPage(<Page onChanged={() => undefined} state={{ draftVersion: 0, requests: [] }} />)

    await user.click(await screen.findByRole('button', { name: /胸部 CT 平扫.*平扫/ }))
    await user.type(screen.getByLabelText('检查指征'), '咳嗽两周')
    await user.click(screen.getByRole('button', { name: '签发申请' }))
    expect(await screen.findByText('放射申请未提交')).toBeTruthy()
    expect((screen.getByLabelText('检查指征') as HTMLTextAreaElement).value).toBe('咳嗽两周')
    expect(screen.queryByRole('textbox', { name: '搜索申请' })).toBeNull()
    expect(screen.getByRole('button', { name: /胸部 CT 平扫.*平扫/ }).getAttribute('aria-pressed')).toBe('true')
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
    expect(screen.queryByRole('textbox', { name: '搜索放射目录' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /胸片.*已报告/ }))
    expect(screen.getByText('胸片报告结论。')).toBeTruthy()
    expect(screen.queryByText(report.impression)).toBeNull()
  })

  it('selects a newly issued request and closes the add dialog while retaining existing reports', async () => {
    let persisted = [request({ report })]
    stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json({ items: services.items.map(item => ({ ...item, available: true })) })
      if (method === 'PUT') return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 2 }))
      const added = request({ id: 'request-2', service: radiographService, status: 'issued', version: 1 })
      persisted = [...persisted, added]
      return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 3, request: added }))
    })
    function RequestsPage() {
      const [requests, setRequests] = useState(persisted)
      return <Page onChanged={() => setRequests(persisted)} state={{ draftVersion: 1, requests }} />
    }
    const user = userEvent.setup()
    renderPage(<RequestsPage />)

    await user.click(screen.getByRole('button', { name: '追加申请' }))
    const dialog = await screen.findByRole('dialog', { name: '追加申请' })
    await user.click(await within(dialog).findByRole('button', { name: /胸片.*X 线摄影/ }))
    await user.type(within(dialog).getByLabelText('检查指征'), '肺部病变随访')
    await user.click(within(dialog).getByRole('button', { name: '签发申请' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: /胸片.*已开具/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(screen.getByRole('region', { name: '放射申请详情' })).queryByText(report.impression)).toBeNull()
    await user.click(screen.getByRole('button', { name: /胸部 CT 平扫.*已报告/ }))
    expect(within(screen.getByRole('region', { name: '放射申请详情' })).getByText(report.impression)).toBeTruthy()
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
    const calls = stubFetch(({ method, path }) => {
      if (path.endsWith('/imaging-services')) return Response.json(services)
      if (path === '/api/his/v1/imaging-studies/study-1') {
        return Response.json({ available: false, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' })
      }
      if (method === 'POST') return Response.json(commandResponse({ request: request({ id: 'request-2', status: 'in-progress' }) }))
      return new Response('{}', { status: 404 })
    })
    const user = userEvent.setup()
    renderPage(
      <Page
        onChanged={() => undefined}
        state={{
          draftVersion: 4,
          requests: [
            request({ report }),
            request({
              generationError: { code: 'IMAGING_RESULT_UNAVAILABLE', message: 'The imaging result is not available for this examination' },
              id: 'request-2',
              service: radiographService,
              status: 'generation-failed',
              taskVersion: '5',
              version: 4,
            }),
          ],
        }}
      />,
    )

    const reported = (await within(screen.getByRole('region', { name: '放射申请详情' })).findByText('胸部 CT 平扫')).closest('li')!
    await user.click(within(reported).getByRole('button', { name: '打开影像' }))
    expect(await within(reported).findByText(/影像暂不可用/)).toBeTruthy()
    expect((within(reported).getByRole('button', { name: '确认已阅' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(reported).getByText('右肺见一实性肿块（Im 85），长径约 31 mm，未见钙化。')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /胸片.*未取得结果/ }))
    const failed = within(screen.getByRole('region', { name: '放射申请详情' })).getByText('胸片').closest('li')!
    expect(within(failed).getByText(/没有取得结果/)).toBeTruthy()
    expect(within(failed).queryByText(/IMAGING_RESULT_UNAVAILABLE/)).toBeNull()
    expect(within(failed).getByRole('button', { name: '取消申请' })).toBeTruthy()
    await user.click(within(failed).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(calls.find(call => call.method === 'POST')).toEqual({
      body: { expectedVersions: { 'Task/task-1': '5' }, input: { expectedRequestVersion: 4 } },
      method: 'POST',
      path: '/api/his/v1/imaging-requests/request-2/actions/retry',
    }))
  })
})
