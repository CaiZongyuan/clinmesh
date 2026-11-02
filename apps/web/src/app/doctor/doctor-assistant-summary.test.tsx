// @vitest-environment jsdom
import { doctorRecommendationStateSchema, type DoctorRecommendationKind, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import {
  checkClinicalDocumentQualityRequestSchema, clinicalDocumentQualityControlStateSchema, doctorCaseDetailSchema,
  encounterCompletionPreviewSchema, type ClinicalDocumentContent, type ClinicalDocumentQualityControlState,
  type EncounterCompletionItem, type EncounterCompletionPreview,
} from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DoctorAssistantSummary } from './doctor-assistant-summary.tsx'

const messages = getWorkspaceMessages('zh-CN')

const baseDocument: ClinicalDocumentContent = {
  chiefComplaint: '发热三天。', historyOfPresentIllness: '三天前发热，最高体温 38.5℃。',
  priorMedicalHistory: '既往体健。', familyHistory: '父亲患高血压。', allergyHistory: '药物过敏史待核实。', physicalExamination: '双肺呼吸音清。', auxiliaryExamination: '',
  assessment: '发热，待查。', disposition: '门诊观察。', followUp: '症状加重及时复诊。',
}

const detail = doctorCaseDetailSchema.parse({
  registrationNumber: null,
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

type CompletionView = ComponentProps<typeof DoctorAssistantSummary>['completion']
function completionView(overrides: Partial<CompletionView> = {}): CompletionView {
  return { data: undefined, isLoading: false, error: null, refetch: vi.fn(), ...overrides }
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
let failQualityCheck = false
let qualityStatus: 'ready' | 'failed' = 'ready'
let qualityStale = false
let recommendationResponder: (kind: DoctorRecommendationKind, method: string) => DoctorRecommendationState = kind => recommendationState(kind)

function stubStackServices(): void {
  const qualityRevisions = new Map<string, number>()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.includes('/recommendations/')) {
      const kind = doctorRecommendationKindOf(url.pathname)
      const state = recommendationResponder(kind, init?.method ?? 'GET')
      return init?.method === 'POST'
        ? Response.json({ data: state, auditId: `audit-${kind}`, effects: [], requestId: `request-${kind}`, warnings: [] })
        : Response.json(state)
    }
    if (url.pathname.includes('/document-quality-control')) {
      if (failQualityCheck) throw new Error('合成质控服务错误')
      const isCheck = url.pathname.endsWith('/actions/check')
      const request = isCheck ? checkClinicalDocumentQualityRequestSchema.parse(JSON.parse(String(init?.body))) : undefined
      const clientId = request?.input.clientId ?? url.searchParams.get('clientId') ?? undefined
      if (clientId !== undefined && request?.input.clientRevision !== undefined) qualityRevisions.set(clientId, request.input.clientRevision)
      const state = clinicalDocumentQualityControlStateSchema.parse({
        caseId: detail.caseId, encounterId: detail.encounter.id,
        draftVersion: request?.input.expectedDraftVersion ?? (detail.clinicalDocument?.draft?.version ?? 0),
        documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
        ...(clientId === undefined ? {} : { clientId, clientRevision: qualityRevisions.get(clientId) ?? 1 }),
        generation: 1, stale: qualityStale, status: qualityStatus, issues: qualityIssues, notices: [],
      })
      return isCheck
        ? Response.json({ data: state, auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] })
        : Response.json(state)
    }
    throw new Error(`unexpected fetch: ${String(init?.method ?? 'GET')} ${url.pathname}`)
  }))
}

function doctorRecommendationKindOf(pathname: string): DoctorRecommendationKind {
  return pathname.split('/recommendations/')[1]!.split('/')[0]! as DoctorRecommendationKind
}

const clients: QueryClient[] = []
function mountSummary(props: Partial<ComponentProps<typeof DoctorAssistantSummary>> = {}, options: { provider?: boolean } = {}): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  let tree: ReactNode = <DoctorAssistantSummary completion={completionView()} detail={detail} clinicalDocument={baseDocument}
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
  failQualityCheck = false
  qualityStatus = 'ready'
  qualityStale = false
  recommendationResponder = kind => recommendationState(kind)
})

it('事实行显示生命体征与「完诊清单 n/7」，展开后每项写明分区并前往对应页签', async () => {
  stubStackServices()
  const onNavigateToCompletionTarget = vi.fn()
  const view = mountSummary({ completion: completionView({ data: completionPreview() }), onNavigateToCompletionTarget })
  expect(screen.getByText('体温 38.5℃ · 脉搏 96 · 呼吸 20 · 血压 118/76 · 血氧 98%')).toBeTruthy()
  const toggle = screen.getByRole('button', { name: '完诊清单 5/7' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('region', { name: messages.encounterCompletionChecklist })).toBeNull()
  const user = userEvent.setup()
  await user.click(toggle)
  const list = screen.getByRole('region', { name: messages.encounterCompletionChecklist })
  expect(within(list).getAllByRole('listitem')).toHaveLength(7)
  expect(within(list).getAllByText(messages.diagnosis).length).toBeGreaterThan(0)
  await user.click(screen.getByRole('button', { name: '前往诊断完成主诊断确认' }))
  expect(onNavigateToCompletionTarget).toHaveBeenLastCalledWith('diagnosis')
  // 横幅可能与其他视图同时挂载，组件内不声明 DOM id。
  expect(view.container.querySelectorAll('[id]')).toHaveLength(0)
})

it('未提供前往回调时展开的完诊项保持纯文本', async () => {
  stubStackServices()
  mountSummary({ completion: completionView({ data: completionPreview() }) })
  await userEvent.setup().click(screen.getByRole('button', { name: '完诊清单 5/7' }))
  expect(screen.getByText('尚未确认主诊断')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /主诊断确认/ })).toBeNull()
})

it('完诊清单加载中显示骨架，失败时给出重试', async () => {
  stubStackServices()
  const user = userEvent.setup()
  const loading = mountSummary({ completion: completionView({ isLoading: true }) })
  await user.click(screen.getByRole('button', { name: messages.encounterCompletionChecklist }))
  expect(loading.container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
  cleanup()
  const refetch = vi.fn()
  mountSummary({ completion: completionView({ error: new Error('合成网络错误'), refetch }) })
  await user.click(screen.getByRole('button', { name: messages.encounterCompletionChecklist }))
  expect(screen.getByText(messages.suggestionLoadFailed)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: messages.suggestionRetry }))
  expect(refetch).toHaveBeenCalledTimes(1)
})

it('完诊后只保留生命体征，不显示完诊清单和助手行', () => {
  stubStackServices()
  const completedDetail = { ...detail, encounter: { ...detail.encounter, status: 'completed' } }
  mountSummary({ completion: completionView({ data: completionPreview() }), detail: completedDetail })
  expect(screen.getByText('体温 38.5', { exact: false })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /完诊清单/ })).toBeNull()
  expect(screen.queryByRole('region', { name: messages.assistantPrepared })).toBeNull()
})

it('助手已准备行写明每项条数或状态，点击跳到对应页签', async () => {
  stubStackServices()
  recommendationResponder = (kind, method) => kind === 'diagnosis' && method === 'POST' ? readyDiagnosisState() : recommendationState(kind)
  const onNavigateToCompletionTarget = vi.fn()
  mountSummary({ completion: completionView({ data: completionPreview() }), onNavigateToCompletionTarget })
  const row = screen.getByRole('region', { name: messages.assistantPrepared })
  const diagnosis = await within(row).findByRole('button', { name: '诊断建议 1' }, { timeout: 4000 })
  // 诊断未确认时处方建议不会生成，写明原因而不是「待生成」。
  expect(within(row).getByRole('button', { name: '处方 确认诊断后生成' })).toBeTruthy()
  const user = userEvent.setup()
  await user.click(diagnosis)
  expect(onNavigateToCompletionTarget).toHaveBeenLastCalledWith('diagnosis')
  await user.click(within(row).getByRole('button', { name: '处方 确认诊断后生成' }))
  expect(onNavigateToCompletionTarget).toHaveBeenLastCalledWith('medication-conclusion')
})

it('某一项生成失败时写明是哪一项', async () => {
  stubStackServices()
  recommendationResponder = kind => recommendationState(kind, { generation: 1, status: kind === 'laboratory' ? 'failed' : 'idle', items: [] })
  mountSummary({ completion: completionView({ data: completionPreview() }) })
  expect(await screen.findByRole('button', { name: `检验建议 ${messages.suggestionRecommendationFailed}` }, { timeout: 4000 })).toBeTruthy()
  expect(screen.queryByRole('button', { name: `诊断建议 ${messages.suggestionRecommendationFailed}` })).toBeNull()
})

it('质控开放疑点显示为「质控待核实 n」并跳到病历页签', async () => {
  stubStackServices()
  const issue = (id: string) => ({
    id, kind: 'inconsistency', field: 'priorMedicalHistory', classification: 'needs-verification',
    message: '请核实过敏史的不同记录。', basis: { label: '病历事实一致性核对', kind: 'project' }, evidence: [],
    relatedFingerprint: 'c'.repeat(64), status: 'open',
  }) satisfies ClinicalDocumentQualityControlState['issues'][number]
  qualityIssues = [issue('prior-1'), issue('prior-2')]
  const onNavigateToCompletionTarget = vi.fn()
  mountSummary({ completion: completionView({ data: completionPreview() }), onNavigateToCompletionTarget })
  await userEvent.setup().click(await screen.findByRole('button', { name: '质控待核实 2' }, { timeout: 4000 }))
  expect(onNavigateToCompletionTarget).toHaveBeenLastCalledWith('clinical-document')
})

it('质控无疑点时写明清空，检查失败时写明失败并可重试', async () => {
  stubStackServices()
  mountSummary({ completion: completionView({ data: completionPreview() }) })
  expect(await screen.findByText(messages.suggestionQualityClear, {}, { timeout: 4000 })).toBeTruthy()
  cleanup()
  qualityStatus = 'failed'
  mountSummary({ completion: completionView({ data: completionPreview() }) })
  expect(await screen.findByText(`质控 ${messages.suggestionRecommendationFailed}`, {}, { timeout: 4000 })).toBeTruthy()
  expect(screen.queryByText(messages.suggestionQualityClear)).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: messages.suggestionRetry }))
  expect(await screen.findByText(`质控 ${messages.suggestionRecommendationFailed}`, {}, { timeout: 4000 })).toBeTruthy()
})

it('质控结果过期时写明过期并可重新检查，不显示清空', async () => {
  stubStackServices()
  qualityStale = true
  mountSummary({ completion: completionView({ data: completionPreview() }) })
  const row = screen.getByRole('region', { name: messages.assistantPrepared })
  expect(await within(row).findByText(messages.documentQualityStale, {}, { timeout: 4000 })).toBeTruthy()
  expect(within(row).queryByText(messages.suggestionQualityClear)).toBeNull()
  qualityStale = false
  await userEvent.setup().click(within(row).getByRole('button', { name: messages.suggestionRetry }))
  expect(await within(row).findByText(messages.suggestionQualityClear, {}, { timeout: 4000 })).toBeTruthy()
})

it('缺少推荐上下文时助手行只显示质控', async () => {
  stubStackServices()
  mountSummary({ completion: completionView({ data: completionPreview() }) }, { provider: false })
  const row = screen.getByRole('region', { name: messages.assistantPrepared })
  expect(await within(row).findByText(messages.suggestionQualityClear, {}, { timeout: 4000 })).toBeTruthy()
  expect(within(row).queryByRole('button', { name: /诊断建议/ })).toBeNull()
})
