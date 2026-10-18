// @vitest-environment jsdom
import {
  checkClinicalDocumentQualityRequestSchema, clinicalDocumentQualityControlStateSchema,
  doctorCaseDetailSchema, type ClinicalDocumentContent,
  type ClinicalDocumentQualityControlState,
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
  return { ...view, client, actions: pageActions, rerenderPage: (currentDetail: typeof detail, scope = 'workspace:epoch:doctor') =>
    view.rerender(<QueryClientProvider client={client}><Page currentDetail={currentDetail} scope={scope} /></QueryClientProvider>) }
}

function stubQuality() {
  const candidates = new Map<string, ClinicalDocumentQualityControlState>()
  let checkInterceptor: ((response: Response) => Promise<Response>) | undefined
  const requests: Array<ReturnType<typeof checkClinicalDocumentQualityRequestSchema.parse>> = []
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
    if (url.pathname.endsWith('/document-quality-control')) return Response.json(candidates.get(url.searchParams.get('clientId') ?? ''))
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))
  return { requests,
    setSavedState: (state: ClinicalDocumentQualityControlState) => { candidates.set('', state) },
    interceptNextCheck: (intercept: NonNullable<typeof checkInterceptor>) => { checkInterceptor = intercept } }
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

it.each([{ field: 'chiefComplaint', label: '主诉' }, { field: 'familyHistory', label: '家族史' }, { field: 'allergyHistory', label: '过敏史' }] as const)('checks unsaved $label without saving it or showing completion hints and preserves focus', async ({ field, label }) => {
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
  await waitFor(() => expect(current.issues).toHaveLength(1))
  expect(screen.queryByRole('region', { name: `${label}质控提示` })).toBeNull()
  expect(screen.queryByText('待补充')).toBeNull()
  expect(screen.queryByText(`尚未记录${label}。`)).toBeNull()
  expect(input).toHaveProperty('value', '')
  expect(document.activeElement).toBe(input)
  if (field !== 'chiefComplaint') expect(input).toHaveProperty('required', false)
  await userEvent.setup().type(input, baseDocument[field]!)
  await waitFor(() => expect(requests.at(-1)?.input.document?.[field]).toBe(baseDocument[field]))
  await waitFor(() => expect(screen.queryByRole('region', { name: `${label}质控提示` })).toBeNull())
  expect(input).toHaveProperty('value', baseDocument[field])
  expect(document.activeElement).toBe(input)
})

it('shows a verification hint without evidence controls, review actions or document changes', async () => {
  stubQuality()
  const mounted = mount()
  const issues = await screen.findByRole('region', { name: '既往史质控提示' })
  expect(within(issues).queryByText('曾经服用青霉素后起皮疹。')).toBeNull()
  expect(within(issues).getByText('请核实过敏史的不同记录。')).toBeTruthy()
  expect(within(issues).queryByRole('button', { name: '查看依据' })).toBeNull()
  expect(within(issues).queryByText('无药物过敏史。')).toBeNull()
  expect(within(issues).queryByRole('button', { name: '已核实，保留' })).toBeNull()
  expect(within(issues).queryByRole('button', { name: '确认保留' })).toBeNull()
  expect(within(issues).queryByRole('textbox')).toBeNull()
  expect(screen.getByRole('textbox', { name: '既往史' })).toHaveProperty('value', baseDocument.priorMedicalHistory)
  expect(mounted.actions.save?.onSubmit).not.toHaveBeenCalled()
})

it('keeps an existing review readable as history without offering another confirmation', async () => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    body.data.issues[0].status = 'retained'
    body.data.issues[0].review = {
      actorId: '合成医生', reviewedAt: '2026-10-15T09:30:00+08:00', reason: '历史核实记录。',
    }
    return Response.json(body)
  })
  mount()
  const issues = await screen.findByRole('region', { name: '既往史质控提示' })
  await userEvent.setup().click(within(issues).getByText('历史处理记录 (1)'))
  expect(within(issues).getByText(/历史核实记录。/)).toBeTruthy()
  expect(within(issues).queryByRole('button', { name: '已核实，保留' })).toBeNull()
  expect(within(issues).queryByRole('button', { name: '确认保留' })).toBeNull()
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

it.each(['open', 'retained'] as const)('hides completion hints in all ten fields, including %s history', async status => {
  const server = stubQuality()
  server.interceptNextCheck(async response => {
    const body = await response.json()
    body.data.issues = Object.keys(baseDocument).map(field => ({ ...body.data.issues[0],
      id: `completion-${field}`, field, kind: 'missing-field', classification: 'needs-completion', status,
      message: `${field}尚未记录，请按本次门诊实际情况补充。`,
    }))
    return Response.json(body)
  })
  const mounted = mount()
  await screen.findByText('本次检查已更新，请核对各字段提示。')
  expect(mounted.container.querySelectorAll('[data-document-quality-field]')).toHaveLength(0)
  expect(screen.queryByText(/尚未记录，请按本次门诊实际情况补充。/)).toBeNull()
  expect(screen.queryByText('待补充')).toBeNull()
  expect(screen.queryByRole('button', { name: '查看依据' })).toBeNull()
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
  await within(summary).findByText(label)
  expect(within(summary).queryByText('请核实主诉持续时间。')).toBeNull()
  expect(within(summary).queryByText('待补充')).toBeNull()
  expect(within(summary).queryByRole('button', { name: '查看依据' })).toBeNull()
  expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
  const confirm = within(dialog).getByRole('button', { name: '确认签署病历' })
  expect(confirm).not.toHaveProperty('disabled', true)
  await userEvent.setup().click(confirm)
  expect(pageActions.sign.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ previewId: 'preview-quality' }))
})
