// @vitest-environment jsdom

import type { ClinicalCatalog, DoctorCaseDetail } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema, type DoctorRecommendationState, type DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPageRegistryProvider, useAgentPageRegistration, useRegisterAgentPage } from '../agent-page-context.tsx'
import { ApiClientError } from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { ReferenceCatalogSearches } from './catalog-picker-dialogs.tsx'
import { getPrescriptionIssueErrorMessage, PrescriptionPage, type PrescriptionPageActions } from './prescription-page.tsx'

type Medication = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications'][number]

const medication: Medication = {
  allowedCombinationIds: ['medication-b'],
  allowedCourseDays: [3, 5],
  allowedDoseTexts: ['500 mg', '1 g'],
  allowedFrequencyCodes: ['PRN', 'BID'],
  allowedQuantities: [6, 10],
  defaultCourseDays: 3,
  defaultDoseText: '500 mg',
  defaultFrequencyCode: 'PRN',
  defaultQuantity: 6,
  id: 'medication-a',
  nameEn: 'Synthetic acetaminophen',
  nameZh: '合成对乙酰氨基酚',
  version: 1,
}

const referenceProduct: ReferenceMedicationProduct = {
  approvalNumber: '国药准字H20260001',
  brandName: '合成品牌',
  code: 'synthetic-product',
  dosageForm: '胶囊',
  genericName: '合成参考药品',
  id: 'reference-medication',
  manufacturer: '合成制药有限公司',
  packageDescription: '12粒/盒',
  sourceLocator: 'synthetic-fixture',
  status: 'active',
  strength: '75 mg',
  system: 'https://example.test/medications',
  version: '1',
}

const detail: DoctorCaseDetail = {
  allergies: [],
  caseId: 'case-prescription',
  encounter: { id: 'encounter-prescription', versionId: '1' },
  patient: { id: 'patient-prescription', identifier: 'SYNTHETIC', name: '合成患者', synthetic: true, versionId: '1' },
  presentation: null,
  priorFacts: [],
  status: 'first-visit',
  taskId: 'task-prescription',
  taskVersion: '1',
}

const issuedPrescription: NonNullable<DoctorCaseDetail['medicationConclusion']>['prescription'] = {
  authoredAt: '2026-10-10T09:40:00+08:00',
  authoredByPractitionerRoleId: 'role-doctor',
  id: 'prescription-1',
  items: [{
    catalogItemId: medication.id,
    courseDays: 3,
    display: medication.nameZh,
    doseText: '500 mg',
    frequencyCode: 'PRN',
    medicationRequestId: 'request-a',
    medicationRequestVersion: '1',
    quantity: 6,
  }, {
    catalogItemId: 'medication-b',
    courseDays: 5,
    display: '合成奥司他韦',
    doseText: '75 mg',
    frequencyCode: 'BID',
    medicationRequestId: 'request-b',
    medicationRequestVersion: '1',
    quantity: 10,
  }],
  number: 'RX-SYNTHETIC-1',
  status: 'paid',
  version: 1,
}

type PrescriptionSuggestion = Extract<DoctorRecommendationSuggestion, { kind: 'prescription' }>

const recommendation: PrescriptionSuggestion = {
  caseEvidenceIds: ['synthetic-case-evidence'],
  catalogItemId: 'medication-b',
  courseDays: 5,
  doseText: '1 g',
  frequencyCode: 'BID',
  guidelineEvidenceIds: ['synthetic-guideline-evidence'],
  id: 'recommendation-b',
  kind: 'prescription' as const,
  label: '合成第二药品',
  missingInformation: [],
  opposingInformation: [],
  quantity: 10,
  rationale: '已核对的合成用药依据',
  supportingInformation: ['已有合成病例资料'],
}

function recommendationState(items: PrescriptionSuggestion[] = []): DoctorRecommendationState {
  return {
    caseEvidence: [{ id: 'synthetic-case-evidence', kind: 'draft', label: '合成已知资料', text: '合成病例资料，用于测试待开具清单。' }],
    caseId: detail.caseId,
    encounterId: detail.encounter.id,
    encounterVersion: detail.encounter.versionId,
    generation: 1,
    guidelines: [{ id: 'synthetic-guideline-evidence', documentType: 'guideline', locator: '合成测试条款',
      publisher: '合成指南发布者', scope: '合成测试病例', sourceHash: 'a'.repeat(64),
      text: '合成条款，仅用于界面合同测试。', title: '合成用药指南', url: 'https://example.test/guidelines/synthetic', version: '1' }],
    inputFingerprint: '1'.repeat(64),
    items,
    kind: 'prescription',
    missingInformation: [],
    stale: false,
    status: 'ready',
  }
}

const queryClients: QueryClient[] = []

function createActions(): PrescriptionPageActions {
  return {
    confirmNoMedication: { error: null, onSubmit: vi.fn(), pending: false },
    deleteDraft: { data: undefined, error: null, onSubmit: vi.fn(), pending: false },
    issue: { error: null, onSubmit: vi.fn(), pending: false },
    saveDraft: { error: null, onSubmit: vi.fn(), pending: false, savedRevision: undefined, success: false },
    withdraw: { error: null, onSubmit: vi.fn(), pending: false },
  }
}

function createSearch(): ReferenceCatalogSearches['medications'] {
  return { data: undefined, error: new Error('Catalog offline'), isError: true, isFetching: false, isPending: false, onSearch: vi.fn() }
}

function renderPage(overrides: Partial<React.ComponentProps<typeof PrescriptionPage>> = {}) {
  const props: React.ComponentProps<typeof PrescriptionPage> = {
    actions: createActions(),
    allowWithdrawal: true,
    catalog: [medication],
    detail,
    elementId: 'prescription-page',
    locale: 'zh-CN',
    messages: getWorkspaceMessages('zh-CN'),
    readOnly: false,
    referenceSearch: createSearch(),
    ...overrides,
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClients.push(queryClient)
  let readAgentState: () => unknown = () => undefined
  function AgentFormReader(): null {
    useRegisterAgentPage({ actions: {}, label: '医生', claim: {
      version: 1, viewId: 'consultation', viewRevision: '1', ui: { status: 'ready' },
      selection: { id: props.detail.caseId, kind: 'case', version: '1' },
    }, readState: () => ({}) })
    readAgentState = useAgentPageRegistration()?.readState ?? (() => undefined)
    return null
  }
  return { ...render(<PrescriptionPage {...props} />, { wrapper: ({ children }) => (
    <QueryClientProvider client={queryClient}><AgentPageRegistryProvider>
      <AgentFormReader />{children}
    </AgentPageRegistryProvider></QueryClientProvider>
  ) }), props, readAgentState: () => readAgentState() }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState())))
})

describe('开具拦截文案', () => {
  const messages = getWorkspaceMessages('zh-CN')
  const errorWith = (code: string, reason?: string) => new ApiClientError(409, code, 'synthetic conflict', undefined, undefined, reason)

  it('按服务端 reason 给出可操作文案而不是笼统拒绝', () => {
    const expectations: Array<[string, string]> = [
      ['PRESCRIPTION_ENCOUNTER_NOT_ACTIVE', '请回到候诊队列确认患者状态'],
      ['PRESCRIPTION_NO_MEDICATION_RECORDED', '已记录"无需用药"'],
      ['PRESCRIPTION_DRAFT_STALE', '请刷新处方页签后重试'],
      ['PRESCRIPTION_ALREADY_ISSUED', '已有正式处方'],
      ['PRESCRIPTION_ALLERGY_CONFLICT', '与患者活动过敏冲突'],
      ['PRESCRIPTION_DIAGNOSIS_UNCONFIRMED', '请先在诊断页签确认主诊断'],
      ['PRESCRIPTION_DIAGNOSIS_NOT_ALLOWED', '不在该药品允许的目录范围'],
      ['PRESCRIPTION_DOSAGE_NOT_ALLOWED', '疗程或数量不在该药品目录允许的范围'],
    ]
    for (const [reason, fragment] of expectations) {
      expect(getPrescriptionIssueErrorMessage(errorWith('WORKFLOW_CONFLICT', reason), messages)).toContain(fragment)
      expect(getPrescriptionIssueErrorMessage(errorWith('WORKFLOW_CONFLICT', reason), messages))
        .not.toBe(messages.prescriptionIssueConflictDescription)
    }
  })

  it('未知 reason 与缺失 reason 回落到通用冲突文案', () => {
    expect(getPrescriptionIssueErrorMessage(errorWith('WORKFLOW_CONFLICT', 'FUTURE_REASON'), messages))
      .toBe(messages.prescriptionIssueConflictDescription)
    expect(getPrescriptionIssueErrorMessage(errorWith('WORKFLOW_CONFLICT'), messages))
      .toBe(messages.prescriptionIssueConflictDescription)
    expect(getPrescriptionIssueErrorMessage(new Error('synthetic failure'), messages))
      .toBe(getWorkspaceErrorMessage(new Error('synthetic failure'), messages))
  })
})

afterEach(() => {
  cleanup()
  queryClients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function medicationForm(): ReturnType<typeof within> {
  return within(screen.getByRole('region', { name: '填写处方' }))
}

describe('PrescriptionPage', () => {
  it('keeps the medication catalog and directions inline beside the prepared prescription', async () => {
    renderPage()
    expect(screen.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    expect(screen.getByLabelText('剂量')).toBeTruthy()
    expect(screen.getByRole('region', { name: '待开具处方' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '添加药品' })).toBeNull()
  })
  it('issues two automatic medications in one prescription and keeps the remaining draft beside both issued records', async () => {
    const catalog = [medication, { ...medication, id: 'medication-b', nameZh: '合成第二药品' },
      { ...medication, id: 'medication-c', nameZh: '合成第三药品' }].map(item => ({
      ...item, allowedCombinationIds: ['medication-a', 'medication-b', 'medication-c'],
    }))
    const suggestions: PrescriptionSuggestion[] = [
      { ...recommendation, id: 'recommendation-a', catalogItemId: medication.id, label: medication.nameZh, doseText: '500 mg' },
      recommendation,
      { ...recommendation, id: 'recommendation-c', catalogItemId: 'medication-c', label: '合成第三药品' },
    ]
    const confirmations: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/actions/confirm')) return Response.json(recommendationState(suggestions))
      confirmations.push(confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body))))
      return Response.json(confirmDoctorPreparationResponseSchema.parse({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
        data: { kind: 'prescription', draftVersion: 2, encounterVersion: '2', recordIds: ['prescription-1'] } }))
    }))
    const mounted = renderPage({ catalog })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(await panel.findByRole('checkbox', { name: '选择合成第三药品' }))
    await user.click(panel.getByRole('button', { name: '开具处方（2）' }))
    await waitFor(() => expect(confirmations).toEqual([expect.objectContaining({ input: expect.objectContaining({ selections: [
      expect.objectContaining({ source: 'agent', catalogItemId: 'medication-a', doseText: '500 mg' }),
      expect.objectContaining({ source: 'agent', catalogItemId: 'medication-b', doseText: '1 g' }),
    ] }) })]))
    mounted.rerender(<PrescriptionPage {...mounted.props} detail={{ ...detail, encounter: { ...detail.encounter, versionId: '2' }, medicationConclusion: {
      draftVersion: 2, prescription: { ...issuedPrescription, status: 'signed', items: issuedPrescription.items.map((item, index) => ({
        ...item, display: index === 0 ? medication.nameZh : '合成第二药品', doseText: index === 0 ? '500 mg' : '1 g',
      })) },
    } }} />)
    expect(screen.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    expect(panel.getByRole('checkbox', { name: '选择合成第三药品' })).toBeTruthy()
    expect(panel.queryByRole('checkbox', { name: '选择合成对乙酰氨基酚' })).toBeNull()
    expect(panel.queryByRole('checkbox', { name: '选择合成第二药品' })).toBeNull()
    expect(panel.getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: '查看药品 合成第二药品' }))
    expect(within(screen.getByRole('region', { name: '药品详情' })).getByText('1 g')).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看药品 合成对乙酰氨基酚' })).toBeTruthy()
    expect(confirmations).toHaveLength(1)
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })
  it('retains the selected medication package while editing directions in the inline form', async () => {
    const search: ReferenceCatalogSearches['medications'] = {
      data: { items: [{ ...referenceProduct, id: 'reference-10', packageDescription: '10粒/盒' },
        { ...referenceProduct, id: 'reference-12', packageDescription: '12粒/盒' }], page: 1, pageSize: 20, total: 2, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    }
    renderPage({ referenceSearch: search })
    const user = userEvent.setup()
    const form = medicationForm()
    await user.click(form.getByRole('combobox', { name: /^包装 / }))
    await user.click(screen.getByRole('option', { name: '12粒/盒' }))
    expect(screen.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    expect(search.onSearch).toHaveBeenCalledTimes(1)
    const reopened = medicationForm()
    expect(within(reopened.getByRole('combobox', { name: /^包装 / })).getByText('12粒/盒')).toBeTruthy()
    expect(search.onSearch).toHaveBeenCalledTimes(1)
  })
  it.each(['list', 'manual form'] as const)('deletes a saved prescription draft when its final medication is explicitly removed from the %s', async origin => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 }] },
    } } })
    const user = userEvent.setup()
    if (origin === 'manual form') {
      const form = medicationForm()
      await user.click(form.getByRole('button', { name: '移除药品' }))
      } else {
      await user.click(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^移除/ }))
    }
    expect(mounted.props.actions.deleteDraft.onSubmit).toHaveBeenCalledOnce()
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('checkbox')).toBeTruthy()
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...mounted.props.actions,
      deleteDraft: { ...mounted.props.actions.deleteDraft, data: { caseId: detail.caseId, draftVersion: 2 } },
    }} detail={{ ...detail, medicationConclusion: { draftVersion: 2 } }} />)
    expect(within(screen.getByRole('region', { name: '待开具处方' })).queryByRole('checkbox')).toBeNull()
  })
  it('keeps the final medication and its directions when draft deletion fails and retries its removal', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 }] },
    } } })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(panel.getByRole('button', { name: /^移除/ }))
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...mounted.props.actions,
      deleteDraft: { ...mounted.props.actions.deleteDraft, error: new Error('Synthetic deletion failure') },
    }} />)
    expect(panel.getByRole('checkbox', { name: '选择合成对乙酰氨基酚' })).toBeTruthy()
    const form = medicationForm()
    expect(within(form.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    expect(screen.getByText(mounted.props.messages.operationFailed)).toBeTruthy()
    await user.click(panel.getByRole('button', { name: /^移除/ }))
    expect(mounted.props.actions.deleteDraft.onSubmit).toHaveBeenCalledTimes(2)
  })
  it('issues a manual reference product with its full directions when recommendation loading fails', async () => {
    const confirmations: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/actions/confirm')) throw new Error('Synthetic recommendation read failure')
      confirmations.push(confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body))))
      return Response.json(confirmDoctorPreparationResponseSchema.parse({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
        data: { kind: 'prescription', draftVersion: 2, encounterVersion: '1', recordIds: ['synthetic-prescription'] } }))
    }))
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct,
        courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10 }] },
    } } })
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await userEvent.setup().click(panel.getByRole('button', { name: /^开具处方/ }))
    await waitFor(() => expect(confirmations).toEqual([{ expectedVersions: { 'Encounter/encounter-prescription': '1' }, input: {
      expectedDraftVersion: 1, resolveExistingDraft: true, selections: [
        { source: 'manual', kind: 'prescription', catalogItemId: referenceProduct.id, referenceProduct,
          courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10 },
      ],
    } }]))
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
    expect(panel.queryByRole('checkbox')).toBeNull()
    expect(medicationForm().queryByRole('combobox', { name: '剂量' })).toBeNull()
  })
  it('keeps reference product fields synchronized between list adjustment and manual entry', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct,
        courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10 }] },
    } } })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(panel.getByRole('button', { name: '调整' }))
    const adjustment = within(screen.getByRole('dialog', { name: '调整项目' }))
    await user.clear(adjustment.getByRole('textbox', { name: '每次剂量' }))
    await user.type(adjustment.getByRole('textbox', { name: '每次剂量' }), '150 mg')
    await user.click(adjustment.getByRole('button', { name: '保留本次调整' }))
    const form = medicationForm()
    expect(form.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '150 mg')
    expect(form.getByText('12粒/盒')).toBeTruthy()
    await user.type(form.getByRole('textbox', { name: '剂量' }), ' 合成追加')
    await user.click(panel.getByRole('button', { name: '调整' }))
    expect(screen.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '150 mg 合成追加')
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })
  it('uses one manual item after editing an automatic medication and removes it from both entry points', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await panel.findByRole('checkbox', { name: '选择合成第二药品' })
    await user.click(panel.getByRole('button', { name: '调整' }))
    const adjustment = within(screen.getByRole('dialog', { name: '调整项目' }))
    await user.clear(adjustment.getByRole('textbox', { name: '每次剂量' }))
    await user.type(adjustment.getByRole('textbox', { name: '每次剂量' }), '500 mg')
    await user.click(adjustment.getByRole('button', { name: '保留本次调整' }))
    const form = medicationForm()
    expect(within(form.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    expect(form.getByRole('group', { name: '已选药品' }).querySelectorAll('button')).toHaveLength(1)
    expect(panel.getAllByRole('checkbox')).toHaveLength(1)
    await user.click(panel.getByRole('button', { name: /^移除/ }))
    expect(panel.queryByRole('checkbox')).toBeNull()
    expect(medicationForm().queryByRole('combobox', { name: '剂量' })).toBeNull()
  })
  it('adds manual medication inline to the unified list without another issuance button', async () => {
    const mounted = renderPage()
    expect(screen.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    const user = userEvent.setup()
    const dialog = medicationForm()
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    expect(dialog.getByRole('combobox', { name: '剂量' })).toBeTruthy()
    expect(dialog.queryByRole('button', { name: '正式开具处方' })).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('combobox', { name: '剂量' })).toBeTruthy()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    expect(panel.getByRole('checkbox', { name: '选择合成对乙酰氨基酚' })).toBeTruthy()
    expect(panel.getAllByRole('button', { name: /^开具处方/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '正式开具处方' })).toBeNull()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([
      { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 },
    ]), { timeout: 2000 })
  })
  it('issues the prepared prescription together with the current manual dose in one versioned confirmation', async () => {
    const confirmations: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) {
        confirmations.push(confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body))))
        return Response.json(confirmDoctorPreparationResponseSchema.parse({ auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-confirm', warnings: [],
          data: { kind: 'prescription', draftVersion: 2, encounterVersion: '1', recordIds: ['prescription-new'] } }))
      }
      return Response.json(recommendationState([recommendation]))
    }))
    const secondMedication: Medication = { ...medication, allowedCombinationIds: [medication.id], id: 'medication-b', nameZh: '合成第二药品' }
    const mounted = renderPage({ catalog: [medication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 }] },
      draftVersion: 1,
    } } })
    const user = userEvent.setup()
    medicationForm()
    await user.click(screen.getByRole('combobox', { name: '剂量' }))
    await user.click(await screen.findByRole('option', { name: '1 g' }))
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await panel.findByRole('checkbox', { name: '选择合成第二药品' })
    expect(panel.getByRole('checkbox', { name: '选择合成对乙酰氨基酚' }).getAttribute('aria-checked')).toBe('true')
    await user.click(panel.getByRole('button', { name: /^开具处方/ }))
    await waitFor(() => expect(confirmations).toEqual([{ expectedVersions: { 'Encounter/encounter-prescription': '1' }, input: {
      generation: 1, inputFingerprint: '1'.repeat(64), expectedDraftVersion: 1, resolveExistingDraft: true,
      selections: [
        { source: 'manual', kind: 'prescription', catalogItemId: 'medication-a', courseDays: 3, doseText: '1 g', frequencyCode: 'PRN', quantity: 6 },
        { source: 'agent', suggestionId: 'recommendation-b', kind: 'prescription', catalogItemId: 'medication-b', courseDays: 5, doseText: '1 g', frequencyCode: 'BID', quantity: 10 },
      ],
    } }]))
    expect(screen.queryByRole('combobox', { name: '剂量' })).toBeNull()
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
    expect(mounted.props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['saveDraft', 'issue', 'confirmNoMedication', 'deleteDraft'] as const)('prevents prepared prescription confirmation while %s is pending', async operation => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const actions = createActions()
    actions[operation].pending = true
    renderPage({ actions, catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    await screen.findByRole('checkbox', { name: '选择合成第二药品' })
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    expect(actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps incomplete automatic prescription fields empty and unselected without filling directory defaults or changing the Agent draft', async () => {
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') writes.push(String(input))
      return Response.json(recommendationState([{ ...recommendation, courseDays: null, doseText: null, frequencyCode: null, quantity: null }]))
    }))
    const mounted = renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    const checkbox = await panel.findByRole('checkbox', { name: '选择合成第二药品' })
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    expect(checkbox.getAttribute('aria-disabled')).toBe('true')
    expect(panel.getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    expect(mounted.readAgentState()).toEqual({ forms: { prescription: { mode: 'prescription', items: [] } } })
    await userEvent.setup().click(panel.getByRole('button', { name: '调整' }))
    const dialog = within(screen.getByRole('dialog', { name: '调整项目' }))
    for (const label of ['每次剂量', '频次', '疗程（天）', '数量']) expect(dialog.getByLabelText(label)).toHaveProperty('value', '')
    expect(writes).toEqual([])
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps a cleared manual prescription dose incomplete in the prepared list without restoring a default', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct,
        doseText: '75 mg', frequencyCode: 'BID', courseDays: 5, quantity: 10 }] },
    } } })
    medicationForm()
    await userEvent.setup().clear(screen.getByRole('textbox', { name: '剂量' }))
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    const choice = panel.getByRole('checkbox', { name: '选择合成参考药品' })
    expect(choice.getAttribute('aria-checked')).toBe('false')
    expect(choice.getAttribute('aria-disabled')).toBe('true')
    expect(panel.getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    medicationForm()
    expect(screen.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '')
    expect(mounted.readAgentState()).toEqual({ forms: { prescription: { mode: 'prescription', items: [{
      catalogItemId: referenceProduct.id, courseDays: 5, doseText: '', frequencyCode: 'BID', quantity: 10,
    }] } } })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['dose', { allowedDoseTexts: ['500 mg'] }],
    ['frequency', { allowedFrequencyCodes: ['PRN'] }],
    ['course', { allowedCourseDays: [3] }],
    ['quantity', { allowedQuantities: [6] }],
  ] satisfies [string, Partial<Medication>][])('prevents confirmation when the current catalog no longer accepts the suggested %s', async (_field, changes) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const mounted = renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    await screen.findByRole('checkbox', { name: '选择合成第二药品' })
    const confirmPrepared = within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })
    expect(confirmPrepared.hasAttribute('disabled')).toBe(false)
    mounted.rerender(<PrescriptionPage {...mounted.props} catalog={[{
      ...medication, ...changes, id: 'medication-b', nameZh: '合成第二药品',
    }]} />)
    expect(confirmPrepared.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirmPrepared)
    expect(screen.queryByRole('group', { name: '已选药品' })).toBeNull()
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'outward-combination', 'inward-combination'] as const)('rejects a currently %s medication recommendation without changing the draft', async conflict => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const secondMedication: Medication = { ...medication, allowedCombinationIds: conflict === 'inward-combination' ? [] : [medication.id], id: 'medication-b', nameZh: '合成第二药品' }
    const firstMedication: Medication = { ...medication, allowedCombinationIds: conflict === 'outward-combination' ? [] : ['medication-b'] }
    const existingId = firstMedication.id
    const mounted = renderPage({ catalog: conflict === 'unavailable' ? [firstMedication] : [firstMedication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: existingId, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 }] },
      draftVersion: 1,
    } } })
    await screen.findByRole('checkbox', { name: '选择合成第二药品' })
    const confirmPrepared = within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })
    expect(confirmPrepared.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirmPrepared)
    medicationForm()
    expect(within(screen.getByRole('group', { name: '已选药品' })).getAllByRole('button')).toHaveLength(1)
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the eight medication limit for prepared prescription confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const ids = [...Array.from({ length: 8 }, (_, index) => `medication-limit-${index}`), recommendation.catalogItemId]
    const catalog = ids.map(id => ({ ...medication, id, allowedCombinationIds: ids, nameZh: id === recommendation.catalogItemId ? '合成第二药品' : id }))
    const mounted = renderPage({ catalog, detail: { ...detail, medicationConclusion: {
      draft: { items: ids.slice(0, 8).map(catalogItemId => ({ catalogItemId, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 })) },
      draftVersion: 1,
    } } })
    await screen.findByRole('checkbox', { name: '选择合成第二药品' })
    const confirmPrepared = within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })
    expect(confirmPrepared.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirmPrepared)
    medicationForm()
    expect(within(screen.getByRole('group', { name: '已选药品' })).getAllByRole('button')).toHaveLength(8)
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['signed', 'paid', 'dispensed', 'withdrawn'] as const)('retains unissued candidates beside a %s prescription without offering another prescription', async status => {
    const remaining = { ...recommendation, id: 'recommendation-c', catalogItemId: 'medication-c', label: '合成第三药品' }
    const network = vi.fn(async () => Response.json(recommendationState([recommendation, remaining])))
    vi.stubGlobal('fetch', network)
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: { ...issuedPrescription, status } } } })
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await panel.findByRole('checkbox', { name: '选择合成第三药品' })
    if (status === 'withdrawn') expect(panel.getByRole('checkbox', { name: '选择合成第二药品' })).toBeTruthy()
    else expect(panel.queryByRole('checkbox', { name: '选择合成第二药品' })).toBeNull()
    expect(panel.getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'read-only', props: { readOnly: true } },
    { name: 'formal no-medication', props: { detail: { ...detail, medicationConclusion: { draftVersion: 2,
      noMedication: { id: 'no-medication-1', version: 1, authoredAt: '2026-10-13T09:00:00+08:00',
        authoredByActorId: 'doctor-1', authoredByPractitionerRoleId: 'doctor-role-1' },
    } } } },
  ])('does not prepare or confirm items in a $name state', async ({ props }) => {
    const network = vi.fn(async () => Response.json(recommendationState([recommendation])))
    vi.stubGlobal('fetch', network)
    renderPage(props)
    expect(screen.queryByRole('region', { name: '待开具处方' })).toBeNull()
    await act(async () => {})
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps manual draft edits while no-medication mode suspends preparations and autosave', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10 }] },
    } } })
    medicationForm()
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: '剂量' }), { target: { value: '150 mg' } })
    fireEvent.click(screen.getByRole('button', { name: '无需用药' }))
    expect(screen.queryByRole('region', { name: '待开具处方' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '开具处方' }))
    medicationForm()
    expect(screen.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '150 mg')
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([{
      catalogItemId: referenceProduct.id, referenceProduct, courseDays: 5, doseText: '150 mg', frequencyCode: 'BID', quantity: 10,
    }])
    expect(mounted.props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
  })

  it('cancels an unsaved draft timer when the case becomes read-only', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })
    medicationForm()
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: '剂量' }), { target: { value: '150 mg' } })
    mounted.rerender(<PrescriptionPage {...mounted.props} readOnly />)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('preserves manual directions when a source revision changes the automatic suggestion for that medication', async () => {
    const initial = recommendationState([recommendation])
    let state = initial
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(state)))
    const mounted = renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }], recommendationRevision: 'source-1', detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: 'medication-b', courseDays: 5, doseText: '1 g', frequencyCode: 'BID', quantity: 10 }] },
    } } })
    const user = userEvent.setup()
    medicationForm()
    await user.click(screen.getByRole('combobox', { name: '剂量' }))
    await user.click(await screen.findByRole('option', { name: '500 mg' }))
    state = { ...initial, inputFingerprint: '2'.repeat(64), generation: 2,
      items: [{ ...recommendation, doseText: '1 g', rationale: '更新后的合成建议依据' }],
    }
    mounted.rerender(<PrescriptionPage {...mounted.props} recommendationRevision="source-2" />)
    await user.click(screen.getByRole('button', { name: '依据与说明' }))
    await screen.findByText('更新后的合成建议依据')
    await user.keyboard('{Escape}')
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getAllByRole('checkbox')).toHaveLength(1)
    medicationForm()
    expect(within(screen.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: '已选药品' })).getAllByRole('button')).toHaveLength(1)
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps edits made before deletion becomes pending and autosaves them after the deletion refresh', async () => {
    const user = userEvent.setup()
    const pageActions = createActions()
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })
    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    await user.click(within(screen.getByRole('alertdialog', { name: '确认删除处方草稿' })).getByRole('button', { name: '确认删除' }))
    expect(pageActions.deleteDraft.onSubmit).toHaveBeenCalledOnce()

    medicationForm()
    vi.useFakeTimers()
    fireEvent.change(screen.getByLabelText('剂量'), { target: { value: '150 mg' } })
    const pendingActions = { ...pageActions, deleteDraft: { ...pageActions.deleteDraft, pending: true } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={pendingActions} />)
    expect(screen.getByLabelText('剂量').closest('fieldset[disabled]')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('剂量'), { target: { value: '300 mg' } })
    expect(screen.getByLabelText('剂量')).toHaveProperty('value', '150 mg')
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(pageActions.saveDraft.onSubmit).not.toHaveBeenCalled()
    const deletion = { caseId: detail.caseId, draftVersion: 2 }
    const completedActions = { ...pageActions, deleteDraft: { ...pageActions.deleteDraft, data: deletion } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={completedActions} />)
    expect(screen.getByLabelText('剂量').getAttribute('value')).toBe('150 mg')

    const refreshedDetail = { ...detail, medicationConclusion: { draftVersion: 2 } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={completedActions} detail={refreshedDetail} />)
    expect(screen.getByLabelText('剂量').getAttribute('value')).toBe('150 mg')
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(pageActions.saveDraft.onSubmit).toHaveBeenLastCalledWith([{
      catalogItemId: referenceProduct.id, courseDays: 5, doseText: '150 mg', frequencyCode: 'BID', quantity: 10, referenceProduct,
    }])
  })

  it('does not replay a deletion receipt after a new draft is saved and its owner version refreshes', async () => {
    const deletion = { caseId: detail.caseId, draftVersion: 2 }
    const pageActions = createActions()
    pageActions.deleteDraft.data = deletion
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: { draftVersion: 1 } } })
    medicationForm()
    await userEvent.setup().click(screen.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    const savedActions = { ...pageActions, saveDraft: { ...pageActions.saveDraft, success: true,
      savedRevision: JSON.stringify([{ catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 }]),
    } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={savedActions} />)
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={savedActions} detail={{ ...detail, medicationConclusion: { draftVersion: 2 } }} />)
    expect(screen.getByRole('combobox', { name: '剂量' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '合成对乙酰氨基酚' })).toBeTruthy()
  })

  it('keeps a new draft when a previous deletion receipt is recreated during a refresh', async () => {
    const deletion = { caseId: detail.caseId, draftVersion: 2 }
    const pageActions = createActions()
    pageActions.deleteDraft.data = deletion
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: { draftVersion: 2 } } })
    medicationForm()
    await userEvent.setup().click(screen.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...pageActions, deleteDraft: { ...pageActions.deleteDraft, data: { ...deletion } } }} />)
    expect(screen.getByRole('combobox', { name: '剂量' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '合成对乙酰氨基酚' })).toBeTruthy()
  })
  it('adds medication from the on-demand catalog and opens its only dosage editor', async () => {
    const user = userEvent.setup()
    renderPage()

    medicationForm()
    expect(screen.getByLabelText('搜索药品目录')).toBeTruthy()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    await user.click(screen.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))

    const editor = screen.getByRole('region', { name: '药品详情' })
    expect(within(editor).getByLabelText('剂量')).toBeTruthy()
    expect(within(editor).getByLabelText('频次')).toBeTruthy()
    expect(within(editor).getByLabelText('疗程')).toBeTruthy()
    expect(within(editor).getByLabelText('数量')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '添加药品' })).toBeNull()
  })

  it('searches issued medication records and returns to the list without changing the prescription', async () => {
    const user = userEvent.setup()
    const { props } = renderPage({
      detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: issuedPrescription } },
    })

    const search = screen.getByLabelText('搜索处方药品')
    expect(within(screen.getByRole('region', { name: '药品详情' })).getByText('500 mg')).toBeTruthy()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    await user.click(screen.getByRole('button', { name: '查看药品 合成奥司他韦' }))
    expect(within(screen.getByRole('region', { name: '药品详情' })).getByText('75 mg')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '返回药品列表' }))
    expect(screen.getByRole('button', { name: '查看药品 合成对乙酰氨基酚' })).toBeTruthy()

    fireEvent.change(search, { target: { value: '没有匹配' } })
    expect(screen.getByText('没有匹配的记录')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '查看全部记录' }))
    await user.click(screen.getByRole('button', { name: '查看药品 合成对乙酰氨基酚' }))
    expect(within(screen.getByRole('region', { name: '药品详情' })).getByText('500 mg')).toBeTruthy()
    expect(props.actions.withdraw.onSubmit).not.toHaveBeenCalled()
    expect(props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('previews the unissued draft before confirming no medication', async () => {
    const user = userEvent.setup()
    const { props } = renderPage({
      detail: { ...detail, medicationConclusion: {
        draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 }] },
        draftVersion: 1,
      } },
    })

    await user.click(screen.getByRole('button', { name: '无需用药' }))
    await user.click(screen.getByRole('button', { name: '确认无需用药' }))
    expect(props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
    const confirmation = screen.getByRole('alertdialog', { name: '确认无需用药' })
    expect(within(confirmation).getByText('合成患者')).toBeTruthy()
    expect(within(confirmation).getByText('合成对乙酰氨基酚')).toBeTruthy()
    expect(within(confirmation).getByText(/未开具草稿将同时清除/)).toBeTruthy()
    await user.click(within(confirmation).getByRole('button', { name: '取消' }))
    expect(props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '开具处方' }))
    medicationForm()
    expect(screen.getByLabelText('剂量')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '无需用药' }))
    await user.click(screen.getByRole('button', { name: '确认无需用药' }))
    await user.click(within(screen.getByRole('alertdialog', { name: '确认无需用药' })).getByRole('button', { name: '确认无需用药' }))
    expect(props.actions.confirmNoMedication.onSubmit).toHaveBeenCalledOnce()
  })

  it('preserves reference product details and edited directions when saving fails, then retries the complete draft', async () => {
    const user = userEvent.setup()
    const actions = createActions()
    actions.saveDraft.error = new Error('Unable to save')
    renderPage({
      actions,
      detail: { ...detail, medicationConclusion: {
        draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct }] },
        draftVersion: 1,
      } },
    })

    medicationForm()
    const editor = screen.getByRole('region', { name: '药品详情' })
    expect(within(editor).getByText('12粒/盒')).toBeTruthy()
    await user.clear(within(editor).getByLabelText('剂量'))
    await user.type(within(editor).getByLabelText('剂量'), '150 mg')
    expect(within(editor).getByDisplayValue('150 mg')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '正式开具处方' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '重试保存' }))
    expect(actions.saveDraft.onSubmit).toHaveBeenLastCalledWith([{
      catalogItemId: referenceProduct.id,
      courseDays: 5,
      doseText: '150 mg',
      frequencyCode: 'BID',
      quantity: 10,
      referenceProduct,
    }])
    expect(within(editor).getByDisplayValue('150 mg')).toBeTruthy()
  })

  it('marks invalid reference directions and prevents saving or issuing until they are corrected', async () => {
    vi.useFakeTimers()
    const { props } = renderPage({ detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })

    medicationForm()
    fireEvent.change(screen.getByLabelText('疗程'), { target: { value: '31' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '1001' } })
    expect(screen.getByLabelText('疗程').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('数量').getAttribute('aria-invalid')).toBe('true')
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    medicationForm()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('疗程'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '10' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([{
      catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct,
    }])
  })

  it('switches the only medication editor while retaining each line’s directions', async () => {
    const user = userEvent.setup()
    const secondMedication: Medication = { ...medication, allowedCombinationIds: [medication.id], id: 'medication-b', nameEn: 'Synthetic second medication', nameZh: '合成第二药品' }
    renderPage({ catalog: [medication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [
        { catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 },
        { catalogItemId: secondMedication.id, doseText: '500 mg', frequencyCode: 'BID', courseDays: 5, quantity: 10 },
      ] },
      draftVersion: 1,
    } } })

    medicationForm()
    const selected = screen.getByRole('group', { name: '已选药品' })
    await user.click(within(selected).getByRole('button', { name: '合成第二药品' }))
    expect(screen.queryByLabelText('剂量')).toBeNull()
    act(() => screen.getByLabelText('剂量 2').focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '1 g' }))
    await user.click(within(selected).getByRole('button', { name: '合成对乙酰氨基酚' }))
    expect(within(screen.getByLabelText('剂量')).getByText('500 mg')).toBeTruthy()
    await user.click(within(selected).getByRole('button', { name: '合成第二药品' }))
    expect(within(screen.getByLabelText('剂量 2')).getByText('1 g')).toBeTruthy()
    expect(screen.getAllByRole('combobox')).toHaveLength(4)
  })

  it('keeps the eight medication limit and hides incompatible local combinations', () => {
    const ids = Array.from({ length: 9 }, (_, index) => `medication-${index + 1}`)
    const catalog = ids.map((id, index) => ({ ...medication, allowedCombinationIds: ids, id, nameZh: `合成药品 ${index + 1}` }))
    const { unmount } = renderPage({ catalog, detail: { ...detail, medicationConclusion: {
      draft: { items: catalog.slice(0, 8).map(item => ({ catalogItemId: item.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 })) },
      draftVersion: 1,
    } } })
    medicationForm()
    expect(screen.getByRole('button', { name: '选择 合成药品 9' }).hasAttribute('disabled')).toBe(true)
    unmount()

    renderPage({ catalog: [medication, { ...medication, id: 'incompatible', nameZh: '合成不兼容药品', allowedCombinationIds: [] }], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 }] },
      draftVersion: 1,
    } } })
    medicationForm()
    expect(screen.queryByRole('button', { name: '选择 合成不兼容药品' })).toBeNull()
  })

  it.each(['signed', 'paid', 'dispensed', 'withdrawn'] as const)('keeps %s prescription records available without ordinary writes in a read-only case', status => {
    renderPage({
      allowWithdrawal: false,
      detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: { ...issuedPrescription, status } } },
      readOnly: true,
    })
    expect(screen.getByRole('button', { name: '查看药品 合成对乙酰氨基酚' })).toBeTruthy()
    expect(screen.getByLabelText('搜索处方药品')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索药品目录' })).toBeNull()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    for (const name of ['正式开具处方', '删除处方草稿', '撤回处方', '确认无需用药']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
})
