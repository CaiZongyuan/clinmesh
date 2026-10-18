// @vitest-environment jsdom
import {
  checkClinicalDocumentQualityRequestSchema, clinicalDocumentQualityControlStateSchema,
  doctorCaseDetailSchema, type ClinicalDocumentContent,
  retainClinicalDocumentQualityIssueRequestSchema, type ClinicalDocumentQualityControlState,
} from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { ClinicalDocumentPage } from './clinical-document-page.tsx'

const baseDocument: ClinicalDocumentContent = {
  chiefComplaint: '发热三天。', historyOfPresentIllness: '三天前发热，最高体温 38.5℃。',
  priorMedicalHistory: '既往体健。', familyHistory: '父亲患高血压。', allergyHistory: '药物过敏史待核实。', physicalExamination: '双肺呼吸音清。', auxiliaryExamination: '',
  assessment: '发热，待查。', disposition: '门诊观察。', followUp: '症状加重及时复诊。',
}
const detail = doctorCaseDetailSchema.parse({
  caseId: 'case-quality', taskId: 'task-quality', taskVersion: '1', status: 'first-visit',
  patient: { id: 'patient-quality', identifier: 'CM-SYN-QC', name: '合成质控患者', birthDate: '1988-03-16',
    gender: 'female', synthetic: true, versionId: '1' },
  encounter: { id: 'encounter-quality', versionId: '1', status: 'in-progress' },
  presentation: { chiefComplaint: '发热三天。', summary: '发热三天。', vitalSigns: {
    bloodPressure: { systolicMmHg: 118, diastolicMmHg: 76 }, oxygenSaturationPct: 98,
    pulseBpm: 96, respirationBpm: 20, temperatureC: 38.5,
  } },
  consultation: { turns: [], version: 1 }, priorFacts: [], allergies: [],
  consultationRecording: { hasSavedDraft: true, version: 1, status: 'updated', additions: [] },
  clinicalDocument: { draft: { ...baseDocument, version: 1, updatedAt: '2026-10-15T09:00:00+08:00' }, signed: [] },
})

function actions(): ComponentProps<typeof ClinicalDocumentPage>['actions'] {
  return {
    save: { error: null, pending: false, success: false, onSubmit: vi.fn() },
    prepareSign: { data: undefined, error: null, pending: false, onSubmit: vi.fn(), onReset: vi.fn() },
    sign: { error: null, pending: false, success: false, onSubmit: vi.fn() },
    revise: { error: null, pending: false, success: false, onSubmit: vi.fn() },
  }
}

const clients: QueryClient[] = []
function mount(pageActions = actions(), initialDocument = baseDocument) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Page({ currentDetail = detail, scope = 'workspace:epoch:doctor' }: {
    currentDetail?: typeof detail; scope?: string;
  }) {
    const [workingDocument, setDocument] = useState(initialDocument)
    return <ClinicalDocumentPage actions={pageActions} allowRevision={false} detail={currentDetail} qualityScope={scope}
      elementId="clinical-document" locale="zh-CN" messages={getWorkspaceMessages('zh-CN')}
      onDocumentChange={setDocument} workingDocument={workingDocument} />
  }
  const view = render(<QueryClientProvider client={client}><Page /></QueryClientProvider>)
  return { ...view, client, actions: pageActions,
    navigateToAnotherCase: () => view.rerender(<QueryClientProvider client={client}><p>合成病例 B</p></QueryClientProvider>),
    rerenderPage: (currentDetail: typeof detail, scope = 'workspace:epoch:doctor') =>
    view.rerender(<QueryClientProvider client={client}><Page currentDetail={currentDetail} scope={scope} /></QueryClientProvider>) }
}

function stubQuality() {
  const candidates = new Map<string, ClinicalDocumentQualityControlState>()
  let failRetain = false
  let loseRetainResponse = false
  let checkInterceptor: ((response: Response) => Promise<Response>) | undefined
  const requests: Array<ReturnType<typeof checkClinicalDocumentQualityRequestSchema.parse>> = []
  const decisions: Array<ReturnType<typeof retainClinicalDocumentQualityIssueRequestSchema.parse>> = []
  const decisionKeys: Array<string | null> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const command = (data: ClinicalDocumentQualityControlState) => Response.json({ data,
      auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] })
    if (url.pathname.endsWith('/document-quality-control/actions/check')) {
      const request = checkClinicalDocumentQualityRequestSchema.parse(JSON.parse(String(init?.body)))
      requests.push(request)
      const state = clinicalDocumentQualityControlStateSchema.parse({ caseId: 'case-quality', encounterId: 'encounter-quality',
        draftVersion: request.input.expectedDraftVersion, clientId: request.input.clientId, clientRevision: request.input.clientRevision,
        documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: request.input.clientRevision ?? 1,
        stale: false, status: 'ready', notices: [], issues: [{ id: 'prior-history-conflict', kind: 'inconsistency',
          field: 'priorMedicalHistory', classification: 'needs-verification', message: '请核实过敏史的不同记录。',
          explanation: { impact: '当前正文与患者自述的过敏情况不同，阅读者可能误解已核实的过敏史。',
            suggestion: '对照患者原话核实药物名称、反应和时间，并修订当前表述或核实后保留。' },
          basis: { label: '病历事实一致性核对', kind: 'project' }, relatedFingerprint: 'c'.repeat(64), status: 'open',
          evidence: [{ id: 'patient-allergy', kind: 'patient', label: '患者自述', text: '曾经服用青霉素后起皮疹。',
            recordedAt: '2026-10-15T09:00:00+08:00' }, { id: 'document-history', kind: 'document', label: '当前病历',
            text: '无药物过敏史。', field: 'priorMedicalHistory' }] }] })
      candidates.set(request.input.clientId ?? '', state)
      const response = command(state)
      if (checkInterceptor === undefined) return response
      const intercept = checkInterceptor
      checkInterceptor = undefined
      return intercept(response)
    }
    if (url.pathname.endsWith('/document-quality-control/actions/retain')) {
      const request = retainClinicalDocumentQualityIssueRequestSchema.parse(JSON.parse(String(init?.body)))
      decisions.push(request)
      decisionKeys.push(new Headers(init?.headers).get('idempotency-key'))
      if (failRetain) { failRetain = false; return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic retain failure' } }, { status: 503 }) }
      const state = candidates.get(request.input.clientId ?? '')!
      const retained: ClinicalDocumentQualityControlState = { ...state, issues: state.issues.map(issue => ({ ...issue,
        status: 'retained', review: { actorId: '合成医生', reviewedAt: decisions.length === 1 ? '2026-10-15T09:30:00+08:00' : '2026-10-15T09:31:00+08:00',
          ...(request.input.reason ? { reason: request.input.reason } : {}) } })) }
      candidates.set(request.input.clientId ?? '', retained)
      if (loseRetainResponse) { loseRetainResponse = false; throw new TypeError('Synthetic response lost after verification committed') }
      return command(retained)
    }
    if (url.pathname.endsWith('/document-quality-control')) return Response.json(candidates.get(url.searchParams.get('clientId') ?? ''))
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))
  return { requests, decisions, decisionKeys, failNextRetain: () => { failRetain = true },
    loseNextRetainResponse: () => { loseRetainResponse = true },
    setSavedState: (state: ClinicalDocumentQualityControlState) => { candidates.set('', state) },
    setState: (state: ClinicalDocumentQualityControlState) => { candidates.set(state.clientId ?? '', state) },
    interceptNextCheck: (intercept: NonNullable<typeof checkInterceptor>) => { checkInterceptor = intercept } }
}

async function openDetails() {
  await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
  return screen.getByRole('dialog', { name: '依据与说明' })
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

it.each(['ready', 'pending', 'failed'] as const)('reuses an unchanged case across A → B → A while its check is %s', async status => {
  const server = stubQuality()
  let release: (() => void) | undefined
  server.interceptNextCheck(async response => {
    if (status === 'pending') await new Promise<void>(resolve => { release = resolve })
    const body = await response.json()
    body.data.status = status === 'pending' ? 'ready' : status
    return Response.json(body)
  })
  const mounted = mount()
  await waitFor(() => expect(server.requests).toHaveLength(1))
  if (status !== 'pending') await waitFor(() => expect(mounted.client.isFetching()).toBe(0))
  mounted.navigateToAnotherCase()
  mounted.rerenderPage(detail)
  await act(async () => { release?.(); await new Promise(resolve => setTimeout(resolve, 650)) })
  expect(server.requests).toHaveLength(1)
})

it('does not create a check revision for unrelated case workflow state changes', async () => {
  const server = stubQuality()
  const mounted = mount()
  await waitFor(() => expect(server.requests).toHaveLength(1))
  await waitFor(() => expect(mounted.client.isFetching()).toBe(0))
  mounted.rerenderPage({ ...detail, taskVersion: '2', consultationRecording: { ...detail.consultationRecording!, version: 9, status: 'paused' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
  expect(server.requests).toHaveLength(1)
})

it('uses the saved check for identical working text and keeps a genuinely unsaved candidate separate', async () => {
  const server = stubQuality()
  const mounted = mount()
  await waitFor(() => expect(server.requests).toHaveLength(1))
  expect(server.requests[0]?.input.document).toBeUndefined()
  expect(server.requests[0]?.input.clientId).toBeUndefined()
  const chief = screen.getByRole('textbox', { name: '主诉' })
  const user = userEvent.setup()
  await user.clear(chief)
  await user.type(chief, '未保存的主诉。')
  await waitFor(() => expect(server.requests.at(-1)?.input.document?.chiefComplaint).toBe('未保存的主诉。'))
  expect(server.requests.at(-1)?.input.clientId).toBeTruthy()
  await user.clear(chief)
  await user.type(chief, baseDocument.chiefComplaint)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
  expect(server.requests).toHaveLength(2)
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
})

it('does not retry a transport failure while navigating and permits an explicit retry', async () => {
  const server = stubQuality()
  server.interceptNextCheck(async () => { throw new TypeError('Synthetic transport failure') })
  const mounted = mount()
  await openDetails()
  await screen.findByText('病历检查暂时失败，不能据此确认内容完整。')
  await userEvent.setup().keyboard('{Escape}')
  mounted.navigateToAnotherCase()
  mounted.rerenderPage(detail)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
  expect(server.requests).toHaveLength(1)
  await openDetails()
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检查病历' }))
  await screen.findByRole('region', { name: '既往史质控提示' })
  expect(server.requests).toHaveLength(2)
})

it('explains a safely classified JSON failure without showing internal details or treating scope notices as its cause', async () => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    body.data.status = 'failed'
    body.data.errorCode = 'AI_RESPONSE_INVALID'
    body.data.failure = { stage: 'generation', reason: 'invalid-json' }
    body.data.notices = ['仅按普通门诊模板和当前可见事实辅助检查。']
    return Response.json(body)
  })
  mount()
  await waitFor(() => expect(server.requests).toHaveLength(1))
  await openDetails()
  expect(await screen.findByText('返回内容格式不正确，本次病历检查未完成，可重试。')).toBeTruthy()
  expect(screen.queryByText(/SyntaxError|invalid-json|JSON.parse/)).toBeNull()
})

it.each(['ready', 'pending', 'failed', 'incomplete', 'unavailable', 'stale'] as const)('keeps %s checks with no open issues out of the document and explains them only on request', async status => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    body.data.issues = []
    body.data.status = status === 'stale' ? 'ready' : status
    body.data.stale = status === 'stale'
    body.data.notices = ['部分内容还没有检查完。']
    return Response.json(body)
  })
  mount()
  await waitFor(() => expect(server.requests).toHaveLength(1))
  await waitFor(() => expect(screen.queryByRole('region', { name: '病历质控' })).toBeNull())
  expect(screen.queryByText('部分内容还没有检查完。')).toBeNull()
  expect(screen.queryByText(/检查通过|质控通过/)).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
  const explanation = screen.getByRole('dialog', { name: '依据与说明' })
  expect(within(explanation).getByText('部分内容还没有检查完。')).toBeTruthy()
  expect(within(explanation).queryByText(/检查通过|质控通过/)).toBeNull()
})

it('keeps a no-issue pending check collapsed in the signature preview without blocking confirmation', async () => {
  const server = stubQuality()
  const state = clinicalDocumentQualityControlStateSchema.parse({ caseId: detail.caseId, encounterId: detail.encounter.id,
    draftVersion: 1, documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: 1,
    stale: false, status: 'pending', notices: [], issues: [] })
  server.setSavedState(state)
  const pageActions = actions()
  pageActions.prepareSign.data = { previewId: 'preview-quality', commitToken: 'commit-quality',
    document: { content: baseDocument }, qualityControl: state }
  mount(pageActions)
  const dialog = await screen.findByRole('alertdialog', { name: '确认签署病历' })
  const summary = within(dialog).getByRole('region', { name: '签署前质控汇总' })
  expect(within(summary).queryByRole('status')).toBeNull()
  expect(within(summary).queryByRole('region', { name: '病历质控' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: '确认签署病历' })).not.toHaveProperty('disabled', true)
  await userEvent.setup().click(within(summary).getByText('依据与说明', { selector: 'summary' }))
  expect((await within(summary).findByRole('status')).textContent).toBe('正在检查病历，尚未完成全部核对。')
  expect(within(summary).queryByText(/检查通过|质控通过/)).toBeNull()
})

it('shows one short issue and the remaining count, with full explanations behind one button', async () => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    const issue = body.data.issues[0]
    body.data.issues.push({ ...issue, id: 'allergy-conflict', field: 'allergyHistory' },
      { ...issue, id: 'examination-conflict', field: 'physicalExamination' })
    return Response.json(body)
  })
  mount()
  const compact = await screen.findByRole('region', { name: '病历质控' })
  expect(within(compact).getByRole('button', { name: '既往史的记录不一致，请核对。' })).toBeTruthy()
  expect(within(compact).getByRole('button', { name: '另有 2 处' })).toBeTruthy()
  expect(screen.queryByText('当前正文与患者自述的过敏情况不同，阅读者可能误解已核实的过敏史。')).toBeNull()
  expect(screen.queryByRole('region', { name: '过敏史质控提示' })).toBeNull()
  await userEvent.setup().click(within(compact).getByRole('button', { name: '另有 2 处' }))
  expect(within(compact).getByRole('button', { name: '过敏史的记录不一致，请核对。' })).toBeTruthy()
  expect(within(compact).getByRole('button', { name: '体格检查的记录不一致，请核对。' })).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
  const explanation = screen.getByRole('dialog', { name: '依据与说明' })
  expect(within(explanation).getByRole('region', { name: '过敏史质控提示' })).toBeTruthy()
  expect(within(explanation).getAllByText('影响')).toHaveLength(3)
})

it.each(['unique', 'edited', 'repeated', 'wrong-field'] as const)('locates the current field without saving and selects only a unique verified quotation (%s)', async anchor => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    body.data.issues[0].field = 'allergyHistory'
    body.data.issues[0].evidence = [{ id: 'document-allergy', kind: 'document', label: '当前病历',
      text: anchor === 'unique' ? '过敏史' : anchor === 'repeated' ? '史' : '无药物过敏史。',
      field: anchor === 'wrong-field' ? 'priorMedicalHistory' : 'allergyHistory' }]
    server.setState(clinicalDocumentQualityControlStateSchema.parse(body.data))
    return Response.json(body)
  })
  const mounted = mount(actions(), anchor === 'repeated' ? { ...baseDocument, allergyHistory: '过敏史待核实，药物过敏史待核实。' } : baseDocument)
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '过敏史' })
  const original = field.value
  const scroll = vi.fn()
  field.closest('[data-clinical-document-field]')!.scrollIntoView = scroll
  field.setSelectionRange(0, original.length)
  await userEvent.setup().click(await screen.findByRole('button', { name: '过敏史的记录不一致，请核对。' }))
  expect(document.activeElement).toBe(field)
  expect(scroll).toHaveBeenCalled()
  expect(field.value).toBe(original)
  expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(anchor === 'unique' ? '过敏史' : '')
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
})

it.each([{ field: 'chiefComplaint', label: '主诉' }, { field: 'familyHistory', label: '家族史' }, { field: 'allergyHistory', label: '过敏史' }] as const)('checks unsaved $label without saving it, locates its issue and preserves focus', async ({ field, label }) => {
  const requests: Array<ReturnType<typeof checkClinicalDocumentQualityRequestSchema.parse>> = []
  let current = clinicalDocumentQualityControlStateSchema.parse({
    caseId: 'case-quality', encounterId: 'encounter-quality', draftVersion: 1,
    documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: 1,
    stale: false, status: 'ready', issues: [], notices: [],
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/his/v1/doctor/cases/case-quality/document-quality-control/actions/check') {
      const request = checkClinicalDocumentQualityRequestSchema.parse(JSON.parse(String(init?.body)))
      requests.push(request)
      current = { ...current, clientId: request.input.clientId, clientRevision: request.input.clientRevision,
        issues: request.input.document?.[field] === '' ? [{ id: `missing-${field}`, kind: 'missing-field', field,
          classification: 'needs-completion', message: `尚未记录${label}。`, basis: { label: '项目门诊病历内容辅助提示', kind: 'project' },
          evidence: [], relatedFingerprint: 'c'.repeat(64), status: 'open' }] : [] }
      return Response.json({ data: current, auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] })
    }
    if (path === '/api/his/v1/doctor/cases/case-quality/document-quality-control') return Response.json(current)
    throw new Error(`Unexpected request: ${path}`)
  }))
  const mounted = mount()
  const input = screen.getByRole('textbox', { name: label })
  await userEvent.setup().clear(input)
  await waitFor(() => expect(requests.at(-1)?.input.document?.[field]).toBe(''))
  expect(requests.at(-1)?.input.expectedDraftVersion).toBe(1)
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(input)
  await userEvent.setup().click(await screen.findByRole('button', { name: `${label}有内容待补充，请核对。` }))
  expect(document.activeElement).toBe(input)
  expect(input).toHaveProperty('selectionStart', 0)
  await openDetails()
  const issues = await screen.findByRole('region', { name: `${label}质控提示` })
  expect(within(issues).getByText('待补充')).toBeTruthy()
  expect(within(issues).getByText(`尚未记录${label}。`)).toBeTruthy()
  expect(within(issues).queryByText('影响')).toBeNull()
  expect(within(issues).queryByText('处理建议')).toBeNull()
  expect(input).toHaveProperty('value', '')
  if (field !== 'chiefComplaint') expect(input).toHaveProperty('required', false)
  await userEvent.setup().keyboard('{Escape}')
  await userEvent.setup().type(input, '已核实的合成内容。')
  await waitFor(() => expect(screen.queryByRole('region', { name: '病历质控' })).toBeNull())
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
})

it('keeps a failed verification decision retryable and records an optional reason without changing the text', async () => {
  const server = stubQuality()
  server.failNextRetain()
  const mounted = mount()
  const user = userEvent.setup()
  await openDetails()
  const issues = await screen.findByRole('region', { name: '既往史质控提示' })
  expect(within(issues).getByText('影响')).toBeTruthy()
  expect(within(issues).getByText('当前正文与患者自述的过敏情况不同，阅读者可能误解已核实的过敏史。')).toBeTruthy()
  expect(within(issues).getByText('处理建议')).toBeTruthy()
  expect(within(issues).getByText('对照患者原话核实药物名称、反应和时间，并修订当前表述或核实后保留。')).toBeTruthy()
  expect(within(issues).queryByText('曾经服用青霉素后起皮疹。')).toBeNull()
  await user.click(within(issues).getByRole('button', { name: '查看依据' }))
  expect(within(issues).getByText('曾经服用青霉素后起皮疹。')).toBeTruthy()
  expect(within(issues).getByText('无药物过敏史。')).toBeTruthy()
  await user.click(within(issues).getByRole('button', { name: '已核实，保留原文' }))
  await user.type(within(issues).getByRole('textbox', { name: '保留原因（选填）' }), '已核对原问诊，保留待查描述。')
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await waitFor(() => expect(server.decisions).toHaveLength(1))
  await waitFor(() => expect(within(issues).getByRole('button', { name: '确认保留' })).not.toHaveProperty('disabled', true))
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await waitFor(() => expect(server.decisions).toHaveLength(2))
  expect(server.decisionKeys[0]).toBeTruthy()
  expect(server.decisionKeys[1]).toBe(server.decisionKeys[0])
  await user.click(within(issues).getByText('已核实的提示 (1)'))
  expect(within(issues).getByText(/已核对原问诊，保留待查描述。/)).toBeTruthy()
  expect(within(mounted.container).getByRole('textbox', { name: '既往史', hidden: true })).toHaveProperty('value', baseDocument.priorMedicalHistory)
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
})

it('recovers an already committed verification after its response is lost without overwriting its original review', async () => {
  const server = stubQuality()
  server.loseNextRetainResponse()
  mount()
  const user = userEvent.setup()
  await openDetails()
  const issues = await screen.findByRole('region', { name: '既往史质控提示' })
  await user.click(within(issues).getByRole('button', { name: '已核实，保留原文' }))
  await user.type(within(issues).getByRole('textbox', { name: '保留原因（选填）' }), '已核实原问诊。')
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await within(issues).findByText('核实记录未能保存，请重试；当前病历正文未改变。')
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await user.click(await within(issues).findByText('已核实的提示 (1)'))
  expect(server.decisions).toHaveLength(1)
  const displayTime = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'short' })
  const reviewText = within(issues).getByText(/已核实原问诊。/).textContent
  expect(reviewText).toContain(displayTime.format(new Date('2026-10-15T09:30:00+08:00')))
  expect(reviewText).not.toContain(displayTime.format(new Date('2026-10-15T09:31:00+08:00')))
})

it('keeps a committed verification when an older poll finishes after its write receipt', async () => {
  stubQuality()
  const fetcher = globalThis.fetch
  let releaseWrite: (() => void) | undefined
  let releasePoll: (() => void) | undefined
  let writing = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/actions/retain')) {
      writing = true
      await new Promise<void>(resolve => { releaseWrite = resolve })
    } else if (writing && url.pathname.endsWith('/document-quality-control') && releasePoll === undefined) {
      const response = await fetcher(input, init)
      await new Promise<void>(resolve => { releasePoll = resolve })
      return response
    }
    return fetcher(input, init)
  })
  const mounted = mount()
  const user = userEvent.setup()
  await openDetails()
  const issues = await screen.findByRole('region', { name: '既往史质控提示' })
  await user.click(within(issues).getByRole('button', { name: '已核实，保留原文' }))
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await waitFor(() => expect(releasePoll).toBeDefined(), { timeout: 2_000 })
  await act(async () => { releaseWrite?.(); await Promise.resolve() })
  await within(issues).findByText('已核实的提示 (1)')
  await act(async () => { releasePoll?.(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await waitFor(() => expect(mounted.client.isFetching()).toBe(0))
  expect(within(issues).getByText('已核实的提示 (1)')).toBeTruthy()
  expect(within(issues).queryByText('待核实')).toBeNull()
})

it('discards an in-flight response after further unsaved edits and checks changed source text without an Encounter revision', async () => {
  const server = stubQuality()
  let release: (() => void) | undefined
  server.interceptNextCheck(async response => {
    await new Promise<void>(resolve => { release = resolve })
    const body = await response.json()
    body.data.issues[0].message = '迟到的旧输入提示。'
    return Response.json(body)
  })
  const mounted = mount()
  await waitFor(() => expect(server.requests).toHaveLength(1))
  const user = userEvent.setup()
  const chief = screen.getByRole('textbox', { name: '主诉' })
  await user.clear(chief)
  await user.type(chief, '咳嗽两天。')
  await waitFor(() => expect(server.requests.at(-1)?.input.document?.chiefComplaint).toBe('咳嗽两天。'))
  await act(async () => { release?.(); await Promise.resolve() })
  expect(screen.queryByText('迟到的旧输入提示。')).toBeNull()
  const previousRevision = server.requests.at(-1)!.input.clientRevision!
  mounted.rerenderPage({ ...detail, consultationRecording: { ...detail.consultationRecording!, sources: [{
    id: 'doctor-source-new', kind: 'doctor', messageText: '补充核实：既往青霉素相关皮疹。', recordedAt: '2026-10-15T10:00:00+08:00',
  }] } })
  await waitFor(() => expect(server.requests.at(-1)!.input.clientRevision).toBeGreaterThan(previousRevision))
  expect(server.requests.at(-1)?.expectedVersions).toEqual({ 'Encounter/encounter-quality': '1' })
  expect(server.requests.at(-1)?.input.document?.chiefComplaint).toBe('咳嗽两天。')
  expect(chief).toHaveProperty('value', '咳嗽两天。')
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
})

it.each(['case', 'scope', 'revision'] as const)('does not show a response with a mismatched %s identity and recovers by checking again', async mismatch => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    if (mismatch === 'case') body.data.caseId = 'case-other'
    if (mismatch === 'scope') body.data.clientId = 'another-client'
    if (mismatch === 'revision') body.data.clientRevision = 0
    return Response.json(body)
  })
  mount(actions(), { ...baseDocument, chiefComplaint: '尚未保存的主诉。' })
  await openDetails()
  await screen.findByText('正文或依据已变化，当前结果已过期，请重新检查。')
  expect(screen.queryByRole('region', { name: '既往史质控提示' })).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检查病历' }))
  await screen.findByRole('region', { name: '既往史质控提示' })
})

it('rechecks on a new authorization scope without reusing the previous client identity', async () => {
  const server = stubQuality()
  const mounted = mount(actions(), { ...baseDocument, chiefComplaint: '尚未保存的主诉。' })
  await openDetails()
  await screen.findByRole('region', { name: '既往史质控提示' })
  const previousClientId = server.requests.at(-1)!.input.clientId
  mounted.rerenderPage(detail, 'workspace:next-epoch:another-doctor')
  expect(screen.queryByRole('region', { name: '既往史质控提示' })).toBeNull()
  await screen.findByRole('region', { name: '既往史质控提示' })
  expect(server.requests.at(-1)?.input.clientId).not.toBe(previousClientId)
})

it('shows two separate quotations from the same source without duplicate React keys', async () => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    body.data.issues[0].evidence = [
      { id: 'same-patient-source', kind: 'patient', label: '患者自述', text: '曾服用青霉素后起皮疹。' },
      { id: 'same-patient-source', kind: 'patient', label: '患者自述', text: '但这次服药没有出现皮疹。' },
    ]
    return Response.json(body)
  })
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    mount()
    await openDetails()
    const issues = await screen.findByRole('region', { name: '既往史质控提示' })
    await userEvent.setup().click(within(issues).getByRole('button', { name: '查看依据' }))
    expect(within(issues).getByText('曾服用青霉素后起皮疹。')).toBeTruthy()
    expect(within(issues).getByText('但这次服药没有出现皮疹。')).toBeTruthy()
    expect(errors.mock.calls.flat().join(' ')).not.toContain('same key')
  } finally { errors.mockRestore() }
})

it.each([
  ['pending', '正在检查病历，尚未完成全部核对。'],
  ['failed', '病历检查暂时失败，不能据此确认内容完整。'],
  ['incomplete', '本次检查不完整，请结合现有提示核对。'],
  ['unavailable', '语义核对暂不可用，仍显示可确定的提示。'],
] as const)('shows %s honestly in the signing summary without adding a signing gate', async (status, label) => {
  const server = stubQuality()
  const state = clinicalDocumentQualityControlStateSchema.parse({ caseId: detail.caseId, encounterId: detail.encounter.id,
    draftVersion: 1, documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: 1,
    stale: false, status, notices: [], issues: [{ id: 'missing-duration', kind: 'missing-field', field: 'chiefComplaint',
      classification: 'needs-completion', message: '请核实主诉持续时间。', relatedFingerprint: 'c'.repeat(64), status: 'open',
      basis: { kind: 'project', label: '项目主诉辅助提示' }, evidence: [] }] })
  server.setSavedState(state)
  const pageActions = actions()
  pageActions.prepareSign.data = { previewId: 'preview-quality', commitToken: 'commit-quality',
    document: { content: baseDocument }, qualityControl: state }
  mount(pageActions)
  const dialog = await screen.findByRole('alertdialog', { name: '确认签署病历' })
  const summary = within(dialog).getByRole('region', { name: '签署前质控汇总' })
  await userEvent.setup().click(within(summary).getByText('依据与说明', { selector: 'summary' }))
  await within(summary).findByText(label)
  expect(within(summary).getByText('请核实主诉持续时间。')).toBeTruthy()
  expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
  const confirm = within(dialog).getByRole('button', { name: '确认签署病历' })
  expect(confirm).not.toHaveProperty('disabled', true)
  await userEvent.setup().click(confirm)
  expect(pageActions.sign.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ previewId: 'preview-quality' }))
})
