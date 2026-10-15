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
  priorMedicalHistory: '既往体健。', physicalExamination: '双肺呼吸音清。', auxiliaryExamination: '',
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
function mount(pageActions = actions()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Page({ currentDetail = detail, scope = 'workspace:epoch:doctor' }: {
    currentDetail?: typeof detail; scope?: string;
  }) {
    const [workingDocument, setDocument] = useState(baseDocument)
    return <ClinicalDocumentPage actions={pageActions} allowRevision={false} detail={currentDetail} qualityScope={scope}
      elementId="clinical-document" locale="zh-CN" messages={getWorkspaceMessages('zh-CN')}
      onDocumentChange={setDocument} workingDocument={workingDocument} />
  }
  const view = render(<QueryClientProvider client={client}><Page /></QueryClientProvider>)
  return { ...view, actions: pageActions, rerenderPage: (currentDetail: typeof detail, scope = 'workspace:epoch:doctor') =>
    view.rerender(<QueryClientProvider client={client}><Page currentDetail={currentDetail} scope={scope} /></QueryClientProvider>) }
}

function stubQuality() {
  const candidates = new Map<string, ClinicalDocumentQualityControlState>()
  let failRetain = false
  let checkInterceptor: ((response: Response) => Promise<Response>) | undefined
  const requests: Array<ReturnType<typeof checkClinicalDocumentQualityRequestSchema.parse>> = []
  const decisions: Array<ReturnType<typeof retainClinicalDocumentQualityIssueRequestSchema.parse>> = []
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
      if (failRetain) { failRetain = false; return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic retain failure' } }, { status: 503 }) }
      const state = candidates.get(request.input.clientId ?? '')!
      const retained: ClinicalDocumentQualityControlState = { ...state, issues: state.issues.map(issue => ({ ...issue,
        status: 'retained', review: { actorId: '合成医生', reviewedAt: '2026-10-15T09:30:00+08:00',
          ...(request.input.reason ? { reason: request.input.reason } : {}) } })) }
      candidates.set(request.input.clientId ?? '', retained)
      return command(retained)
    }
    if (url.pathname.endsWith('/document-quality-control')) return Response.json(candidates.get(url.searchParams.get('clientId') ?? ''))
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))
  return { requests, decisions, failNextRetain: () => { failRetain = true },
    interceptNextCheck: (intercept: NonNullable<typeof checkInterceptor>) => { checkInterceptor = intercept } }
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

it('checks unsaved text without saving it and locates missing information inside its field without moving focus', async () => {
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
        issues: request.input.document?.chiefComplaint === '' ? [{ id: 'missing-chief', kind: 'missing-field', field: 'chiefComplaint',
          classification: 'needs-completion', message: '尚未记录主诉。', basis: { label: '门诊病历书写规范第十三条', kind: 'official' },
          evidence: [], relatedFingerprint: 'c'.repeat(64), status: 'open' }] : [] }
      return Response.json({ data: current, auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] })
    }
    if (path === '/api/his/v1/doctor/cases/case-quality/document-quality-control') return Response.json(current)
    throw new Error(`Unexpected request: ${path}`)
  }))
  const mounted = mount()
  const chief = screen.getByRole('textbox', { name: '主诉' })
  await userEvent.setup().clear(chief)
  await waitFor(() => expect(requests.at(-1)?.input.document?.chiefComplaint).toBe(''))
  expect(requests.at(-1)?.input.expectedDraftVersion).toBe(1)
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
  const issues = await screen.findByRole('region', { name: '主诉质控提示' })
  expect(within(issues).getByText('待补充')).toBeTruthy()
  expect(within(issues).getByText('尚未记录主诉。')).toBeTruthy()
  expect(chief).toHaveProperty('value', '')
  expect(document.activeElement).toBe(chief)
})

it('keeps a failed verification decision retryable and records an optional reason without changing the text', async () => {
  const server = stubQuality()
  server.failNextRetain()
  const mounted = mount()
  const user = userEvent.setup()
  const issues = await screen.findByRole('region', { name: '既往史质控提示' })
  expect(within(issues).queryByText('曾经服用青霉素后起皮疹。')).toBeNull()
  await user.click(within(issues).getByRole('button', { name: '查看依据' }))
  expect(within(issues).getByText('曾经服用青霉素后起皮疹。')).toBeTruthy()
  expect(within(issues).getByText('无药物过敏史。')).toBeTruthy()
  await user.click(within(issues).getByRole('button', { name: '已核实，保留' }))
  await user.type(within(issues).getByRole('textbox', { name: '保留原因（选填）' }), '已核对原问诊，保留待查描述。')
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await waitFor(() => expect(server.decisions).toHaveLength(1))
  await waitFor(() => expect(within(issues).getByRole('button', { name: '确认保留' })).not.toHaveProperty('disabled', true))
  await user.click(within(issues).getByRole('button', { name: '确认保留' }))
  await waitFor(() => expect(server.decisions).toHaveLength(2))
  await user.click(within(issues).getByText('已核实的提示 (1)'))
  expect(within(issues).getByText(/已核对原问诊，保留待查描述。/)).toBeTruthy()
  expect(screen.getByRole('textbox', { name: '既往史' })).toHaveProperty('value', baseDocument.priorMedicalHistory)
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
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
  mount()
  await screen.findByText('正文或依据已变化，当前结果已过期，请重新检查。')
  expect(screen.queryByRole('region', { name: '既往史质控提示' })).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检查病历' }))
  await screen.findByRole('region', { name: '既往史质控提示' })
})

it('rechecks on a new authorization scope without reusing the previous client identity', async () => {
  const server = stubQuality()
  const mounted = mount()
  await screen.findByRole('region', { name: '既往史质控提示' })
  const previousClientId = server.requests.at(-1)!.input.clientId
  mounted.rerenderPage(detail, 'workspace:next-epoch:another-doctor')
  expect(screen.queryByRole('region', { name: '既往史质控提示' })).toBeNull()
  await screen.findByRole('region', { name: '既往史质控提示' })
  expect(server.requests.at(-1)?.input.clientId).not.toBe(previousClientId)
})
