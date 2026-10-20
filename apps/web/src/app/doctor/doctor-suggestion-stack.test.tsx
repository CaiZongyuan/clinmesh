// @vitest-environment jsdom
import { doctorRecommendationStateSchema, type DoctorRecommendationKind, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import {
  checkClinicalDocumentQualityRequestSchema, clinicalDocumentQualityControlStateSchema, doctorCaseDetailSchema,
  encounterCompletionPreviewSchema, type ClinicalDocumentContent, type ClinicalDocumentQualityControlState,
  type EncounterCompletionItem, type EncounterCompletionPreview,
} from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DoctorSuggestionStack } from './doctor-suggestion-stack.tsx'

const messages = getWorkspaceMessages('zh-CN')

const baseDocument: ClinicalDocumentContent = {
  chiefComplaint: '发热三天。', historyOfPresentIllness: '三天前发热，最高体温 38.5℃。',
  priorMedicalHistory: '既往体健。', familyHistory: '父亲患高血压。', allergyHistory: '药物过敏史待核实。', physicalExamination: '双肺呼吸音清。', auxiliaryExamination: '',
  assessment: '发热，待查。', disposition: '门诊观察。', followUp: '症状加重及时复诊。',
}

const detail = doctorCaseDetailSchema.parse({
  caseId: 'case-stack', taskId: 'task-stack', taskVersion: '1', status: 'first-visit',
  patient: { id: 'patient-stack', identifier: 'CM-SYN-STACK', name: '合成建议栈患者', birthDate: '1988-03-16',
    gender: 'female', synthetic: true, versionId: '1' },
  encounter: { id: 'encounter-stack', versionId: '1', status: 'in-progress' },
  presentation: { chiefComplaint: '发热三天。', summary: '发热三天。', vitalSigns: {
    bloodPressure: { systolicMmHg: 118, diastolicMmHg: 76 }, oxygenSaturationPct: 98,
    pulseBpm: 96, respirationBpm: 20, temperatureC: 38.5,
  } },
  consultation: { turns: [], version: 1 }, priorFacts: [], allergies: [],
  consultationRecording: { hasSavedDraft: true, version: 1, status: 'updated', additions: [] },
  clinicalDocument: { draft: { ...baseDocument, assessment: '上呼吸道感染。', version: 1, updatedAt: '2026-10-15T09:00:00+08:00' }, signed: [] },
})

const completionExpectations: Record<EncounterCompletionItem['code'], [EncounterCompletionItem['status'], EncounterCompletionItem['target'], string]> = {
  'primary-diagnosis-confirmed': ['incomplete', 'diagnosis', '尚未确认主诊断'],
  'clinical-document-signed': ['incomplete', 'clinical-document', '尚未签署病历'],
  'required-reports-acknowledged': ['complete', 'laboratory', '已查阅必需报告'],
  'medication-conclusion-recorded': ['complete', 'medication-conclusion', '已记录用药结论'],
  'no-pending-drafts': ['complete', 'clinical-document', '无待处理草稿'],
  'disposition-complete': ['complete', 'clinical-document', '处置方案已完成'],
  'follow-up-complete': ['complete', 'clinical-document', '随访已安排'],
}

function completionPreview(overrides: Partial<Record<EncounterCompletionItem['code'], EncounterCompletionItem['status']>> = {}): EncounterCompletionPreview {
  return encounterCompletionPreviewSchema.parse({
    canComplete: false, encounterId: detail.encounter.id, encounterVersion: '1',
    items: Object.entries(completionExpectations).map(([code, [status, target, statusText]]) => ({
      code, target, statusText, status: overrides[code as EncounterCompletionItem['code']] ?? status,
    })),
  })
}

type CompletionView = ComponentProps<typeof DoctorSuggestionStack>['completion']
function completionView(overrides: Partial<CompletionView> = {}): CompletionView {
  return { data: undefined, isPending: true, isLoading: false, error: null, refetch: vi.fn(), ...overrides }
}

function recommendationState(kind: DoctorRecommendationKind, overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return doctorRecommendationStateSchema.parse({
    caseId: detail.caseId, encounterId: detail.encounter.id, encounterVersion: '1', kind,
    generation: 0, inputFingerprint: 'a'.repeat(64), status: 'idle', stale: false,
    items: [], guidelines: [], caseEvidence: [], missingInformation: [], ...overrides,
  })
}

function readyDiagnosisState(): DoctorRecommendationState {
  return recommendationState('diagnosis', {
    generation: 2, status: 'ready',
    items: [{ id: 'synthetic-diagnosis', kind: 'diagnosis', catalogItemId: 'diagnosis-fever', role: 'primary',
      label: '合成发热候选', rationale: '合成来源支持待确认候选。', supportingInformation: [], opposingInformation: [],
      missingInformation: [], guidelineEvidenceIds: ['synthetic-source'], caseEvidenceIds: ['synthetic-case'] }],
    guidelines: [{ id: 'synthetic-source', title: '合成指南', publisher: '合成机构', documentType: 'official-protocol',
      version: '1', publishedAt: '2026-01-01', locator: '合成条款', scope: '合成测试', text: '合成症状可供医生评估。',
      url: 'https://example.org/synthetic-guideline', sourceHash: 'b'.repeat(64) }],
    caseEvidence: [{ id: 'synthetic-case', kind: 'consultation', label: '合成患者陈述', text: '合成患者自述发热。' }],
  })
}

let qualityIssues: ClinicalDocumentQualityControlState['issues'] = []
let recommendationResponder: (kind: DoctorRecommendationKind, method: string) => DoctorRecommendationState = kind => recommendationState(kind)

function stubStackServices(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.includes('/recommendations/')) {
      const kind = doctorRecommendationKindOf(url.pathname)
      const state = recommendationResponder(kind, init?.method ?? 'GET')
      return init?.method === 'POST'
        ? Response.json({ data: state, auditId: `audit-${kind}`, effects: [], requestId: `request-${kind}`, warnings: [] })
        : Response.json(state)
    }
    if (url.pathname.endsWith('/document-quality-control/actions/check')) {
      const request = checkClinicalDocumentQualityRequestSchema.parse(JSON.parse(String(init?.body)))
      const state = clinicalDocumentQualityControlStateSchema.parse({
        caseId: detail.caseId, encounterId: detail.encounter.id, draftVersion: request.input.expectedDraftVersion,
        documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
        ...(request.input.clientId === undefined ? {} : { clientId: request.input.clientId, clientRevision: request.input.clientRevision }),
        generation: 1, stale: false, status: 'ready', issues: qualityIssues, notices: [],
      })
      return Response.json({ data: state, auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] })
    }
    throw new Error(`unexpected fetch: ${String(init?.method ?? 'GET')} ${url.pathname}`)
  }))
}

function doctorRecommendationKindOf(pathname: string): DoctorRecommendationKind {
  return pathname.split('/recommendations/')[1]!.split('/')[0]! as DoctorRecommendationKind
}

const clients: QueryClient[] = []
function mountStack(props: Partial<ComponentProps<typeof DoctorSuggestionStack>> = {}, options: { provider?: boolean } = {}): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  let tree: ReactNode = <DoctorSuggestionStack completion={completionView()} detail={detail} document={baseDocument}
    locale="zh-CN" messages={messages} scope="workspace:epoch:doctor" {...props} />
  if (options.provider !== false) {
    tree = <DoctorPreparationProvider detail={props.detail ?? detail} enabled scope="workspace:epoch:doctor"
      inputRevision="1">{tree}</DoctorPreparationProvider>
  }
  return render(<QueryClientProvider client={client}>{tree}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  qualityIssues = []
  recommendationResponder = kind => recommendationState(kind)
})

it('完诊清单显示未完项及状态文字，且不声明 DOM id 以支持双挂载', () => {
  stubStackServices()
  const view = mountStack({ completion: completionView({ data: completionPreview() }) })
  expect(screen.getByRole('region', { name: messages.encounterCompletionChecklist })).toBeTruthy()
  expect(screen.getByText('主诊断确认')).toBeTruthy()
  expect(screen.getByText('尚未确认主诊断')).toBeTruthy()
  expect(screen.getByText('尚未签署病历')).toBeTruthy()
  expect(screen.queryByText(messages.suggestionCompletionClear)).toBeNull()
  expect(view.container.querySelectorAll('[id]')).toHaveLength(0)
})

it('完诊清单全部完成时显示完成态而不再列出条目', () => {
  stubStackServices()
  mountStack({ completion: completionView({ data: completionPreview({
    'primary-diagnosis-confirmed': 'complete', 'clinical-document-signed': 'complete',
  }) }) })
  expect(screen.getByText(messages.suggestionCompletionClear)).toBeTruthy()
  expect(screen.queryByText('主诊断确认')).toBeNull()
})

it('完诊清单加载中显示骨架占位', () => {
  stubStackServices()
  const view = mountStack({ completion: completionView({ isPending: true, isLoading: true }) })
  expect(view.container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
  expect(screen.queryByText(messages.suggestionCompletionClear)).toBeNull()
})

it('完诊清单失败时给出失败态与重试入口', async () => {
  stubStackServices()
  const refetch = vi.fn()
  mountStack({ completion: completionView({ error: new Error('合成网络错误'), refetch }) })
  expect(screen.getByText(messages.suggestionLoadFailed)).toBeTruthy()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: messages.suggestionRetry }))
  expect(refetch).toHaveBeenCalledTimes(1)
})

it('未接诊时显示占位且不渲染任何分区', () => {
  stubStackServices()
  mountStack({ detail: undefined }, { provider: false })
  expect(screen.getByText(messages.suggestionNoCase)).toBeTruthy()
  expect(screen.queryByRole('region', { name: messages.encounterCompletionChecklist })).toBeNull()
  expect(screen.queryByRole('region', { name: messages.documentQualityTitle })).toBeNull()
  expect(screen.queryByRole('region', { name: messages.suggestionRecommendationsTitle })).toBeNull()
})

it('质控开放疑点以短句展示', async () => {
  stubStackServices()
  qualityIssues = [{
    id: 'prior-history-conflict', kind: 'inconsistency', field: 'priorMedicalHistory', classification: 'needs-verification',
    message: '请核实过敏史的不同记录。', basis: { label: '病历事实一致性核对', kind: 'project' }, evidence: [],
    relatedFingerprint: 'c'.repeat(64), status: 'open',
  }]
  mountStack({ completion: completionView({ data: completionPreview() }) })
  await waitFor(() => {
    expect(screen.getByText(`${messages.priorMedicalHistory}的记录不一致，请核对。`)).toBeTruthy()
  }, { timeout: 4000 })
})

it('质控无开放疑点时显示清空态', async () => {
  stubStackServices()
  mountStack({ completion: completionView({ data: completionPreview() }) })
  await waitFor(() => {
    expect(screen.getByText(messages.suggestionQualityClear)).toBeTruthy()
  }, { timeout: 4000 })
})

it('医生推荐分区展示五类条目及各自状态', async () => {
  stubStackServices()
  recommendationResponder = (kind, method) => kind === 'diagnosis' && method === 'POST' ? readyDiagnosisState() : recommendationState(kind)
  mountStack({ completion: completionView({ data: completionPreview() }) })
  await waitFor(() => {
    expect(screen.getByText(messages.suggestionRecommendationReadyCount.replace('{count}', '1'))).toBeTruthy()
  }, { timeout: 4000 })
  expect(screen.getByRole('region', { name: messages.suggestionRecommendationsTitle })).toBeTruthy()
  expect(screen.getByText('待确认诊断')).toBeTruthy()
  expect(screen.getAllByText(messages.suggestionRecommendationIdle).length).toBeGreaterThanOrEqual(4)
})

it('推荐生成失败时显示失败态', async () => {
  stubStackServices()
  recommendationResponder = kind => recommendationState(kind, { generation: 1, status: 'failed', items: [] })
  mountStack({ completion: completionView({ data: completionPreview() }) })
  await waitFor(() => {
    expect(screen.getAllByText(messages.suggestionRecommendationFailed)).toHaveLength(5)
  }, { timeout: 4000 })
})

it('全部就绪时显示整体空态', async () => {
  stubStackServices()
  mountStack({ completion: completionView({ data: completionPreview({
    'primary-diagnosis-confirmed': 'complete', 'clinical-document-signed': 'complete',
  }) }) })
  await waitFor(() => {
    expect(screen.getByText(messages.suggestionStackEmpty)).toBeTruthy()
  }, { timeout: 4000 })
  expect(screen.queryByRole('region', { name: messages.encounterCompletionChecklist })).toBeNull()
})

it('缺少推荐上下文时仍渲染完诊与质控分区', async () => {
  stubStackServices()
  mountStack({ completion: completionView({ data: completionPreview() }) }, { provider: false })
  expect(screen.getByRole('region', { name: messages.encounterCompletionChecklist })).toBeTruthy()
  expect(screen.queryByRole('region', { name: messages.suggestionRecommendationsTitle })).toBeNull()
  await waitFor(() => {
    expect(screen.getByText(messages.suggestionQualityClear)).toBeTruthy()
  }, { timeout: 4000 })
})
