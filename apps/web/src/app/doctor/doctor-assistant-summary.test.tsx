// @vitest-environment jsdom
import {
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema, type ClinicalDocumentContent,
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

const clients: QueryClient[] = []
function mountSummary(props: Partial<ComponentProps<typeof DoctorAssistantSummary>> = {}): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const tree: ReactNode = (
    <DoctorPreparationProvider detail={props.detail ?? detail} enabled scope="workspace:epoch:doctor" inputRevision="1">
      <DoctorAssistantSummary completion={completionView()} detail={detail} clinicalDocument={baseDocument}
        locale="zh-CN" messages={messages} scope="workspace:epoch:doctor" {...props} />
    </DoctorPreparationProvider>
  )
  return render(<QueryClientProvider client={client}>{tree}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
})

it('事实行显示生命体征与「完诊清单 n/7」，展开后每项写明分区并前往对应页签', async () => {
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
  expect(within(list).getAllByText(/诊断/).length).toBeGreaterThan(0)
  await user.click(screen.getByRole('button', { name: '前往诊断完成主诊断确认' }))
  expect(onNavigateToCompletionTarget).toHaveBeenLastCalledWith('diagnosis')
  // 横幅可能与其他视图同时挂载，组件内不声明 DOM id。
  expect(view.container.querySelectorAll('[id]')).toHaveLength(0)
})

it('未提供前往回调时展开的完诊项保持纯文本', async () => {
  mountSummary({ completion: completionView({ data: completionPreview() }) })
  await userEvent.setup().click(screen.getByRole('button', { name: '完诊清单 5/7' }))
  expect(screen.getByText('主诊断确认')).toBeTruthy()
  expect(screen.getByText(/尚未确认主诊断/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /主诊断确认/ })).toBeNull()
})

it('完诊清单加载中显示骨架，失败时给出重试', async () => {
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
  const completedDetail = { ...detail, encounter: { ...detail.encounter, status: 'completed' } }
  mountSummary({ completion: completionView({ data: completionPreview() }), detail: completedDetail })
  expect(screen.getByText('体温 38.5', { exact: false })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /完诊清单/ })).toBeNull()
  expect(screen.queryByRole('region', { name: messages.assistantPrepared })).toBeNull()
})
