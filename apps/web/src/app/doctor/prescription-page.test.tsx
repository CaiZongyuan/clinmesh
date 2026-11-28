// @vitest-environment jsdom

import type { ClinicalCatalog, DoctorCaseDetail } from '@clinmesh/contracts/his'
import type { ReferenceMedicationCatalogItem } from '@clinmesh/contracts/reference-data'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema, type DoctorRecommendationState, type DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { getPrescriptionIssueErrorMessage, getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { ReferenceCatalogSearches } from './catalog-picker-dialogs.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './prescription-page.tsx'

type Medication = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications'][number]

const medication: Medication = {
  allowedCombinationIds: ['medication-b'],
  allowedCourseDays: [3, 5],
  allowedDoseTexts: ['500 mg', '1 g'],
  allowedFrequencyCodes: ['PRN', 'BID'],
  allowedQuantities: [6, 10],
  allowedRouteCodes: ['PO'],
  defaultCourseDays: 3,
  defaultDoseText: '500 mg',
  defaultFrequencyCode: 'PRN',
  defaultQuantity: 6,
  defaultRouteCode: 'PO',
  id: 'medication-a',
  nameEn: 'Synthetic acetaminophen',
  nameZh: '合成对乙酰氨基酚',
  version: 1,
}

const referenceProduct: ReferenceMedicationCatalogItem = {
  allowedRouteCodes: ['PO'],
  approvalNumber: '国药准字H20260001',
  brandName: '合成品牌',
  code: 'synthetic-product',
  defaultRouteCode: 'PO',
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
  registrationNumber: null,
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
    routeCode: 'PO',
  }, {
    catalogItemId: 'medication-b',
    courseDays: 5,
    display: '合成奥司他韦',
    doseText: '75 mg',
    frequencyCode: 'BID',
    medicationRequestId: 'request-b',
    medicationRequestVersion: '1',
    quantity: 10,
    routeCode: 'PO',
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
  routeCode: 'PO',
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
  return { ...render(<PrescriptionPage {...props} />, { wrapper: ({ children }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  ) }), props }
}

beforeEach(() => {
  sessionStorage.clear()
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
      ['PRESCRIPTION_DOSAGE_NOT_ALLOWED', '剂量、频次、疗程或数量不在该药品目录允许的范围'],
      ['PRESCRIPTION_ROUTE_NOT_ALLOWED', '给药途径不在该药品目录允许的范围'],
      ['PRESCRIPTION_MIXED_CATALOG_SOURCES', '不能同时包含本院药房药品与国家参考目录药品'],
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function medicationForm(): ReturnType<typeof within> {
  return within(screen.getByRole('region', { name: '填写处方' }))
}

// 弹窗合同统一入口：点「添加药品」打开弹窗，目录检索与用药表单都在弹窗内完成。
async function openComposer(user: ReturnType<typeof userEvent.setup>, name: string | RegExp = '添加药品'): Promise<ReturnType<typeof within>> {
  await user.click(screen.getByRole('button', { name }))
  return within(screen.getByRole('dialog'))
}

describe('PrescriptionPage', () => {
  it('keeps the actionable rejection visible when a concurrent no-medication record removes editing access', () => {
    const mounted = renderPage()
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{
      ...mounted.props.actions, issue: {
        error: new ApiClientError(409, 'WORKFLOW_CONFLICT', 'synthetic conflict', undefined, undefined, 'PRESCRIPTION_NO_MEDICATION_RECORDED'),
        onSubmit: vi.fn(), pending: false,
      },
    }} detail={{ ...detail, medicationConclusion: {
      draftVersion: 1,
      noMedication: {
        authoredAt: '2026-10-20T10:00:00+08:00', authoredByActorId: 'actor-synthetic',
        authoredByPractitionerRoleId: 'role-doctor', id: 'no-medication-synthetic', version: 1,
      },
    } }} />)
    expect(screen.getByText(/已记录"无需用药"，不能再开具处方/)).toBeTruthy()
  })

  it('adds a medication through the composer dialog and lands it in the tab list', async () => {
    renderPage()
    const user = userEvent.setup()
    // 填写前左主列只有选择入口，目录在弹窗内呈现。
    expect(screen.queryByRole('textbox', { name: '搜索药品目录' })).toBeNull()
    const dialog = await openComposer(user)
    expect(dialog.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    // 点选目录行后弹窗内展开用药表单，本院药默认值来自目录。
    expect(within(dialog.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 弹窗关闭后这一条落在待开具处方面板。
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '待开具处方' })).toBeTruthy()
  })
  it('retains the selected medication package while entering directions in the composer', async () => {
    const search: ReferenceCatalogSearches['medications'] = {
      data: { items: [{ ...referenceProduct, id: 'reference-10', packageDescription: '10粒/盒' },
        { ...referenceProduct, id: 'reference-12', packageDescription: '12粒/盒' }], page: 1, pageSize: 20, total: 2, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    }
    const mounted = renderPage({ referenceSearch: search })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('tab', { name: '国家参考目录' }))
    const combo = dialog.getByRole('combobox', { name: /^包装 / })
    await user.click(combo)
    await user.click(await screen.findByRole('option', { name: '12粒/盒' }))
    expect(within(dialog.getByRole('combobox', { name: /^包装 / })).getByText('12粒/盒')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: /^选择 合成参考药品/ }))
    // 填写用药信息期间包装选择保持不变。
    await user.type(dialog.getByRole('textbox', { name: '剂量' }), '75 mg')
    await user.type(dialog.getByRole('textbox', { name: '频次' }), 'BID')
    expect(within(dialog.getByRole('combobox', { name: /^包装 / })).getByText('12粒/盒')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '编辑药品 合成参考药品' })).toBeTruthy()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([
      expect.objectContaining({ catalogItemId: 'reference-12', courseDays: 3, doseText: '75 mg', frequencyCode: 'BID', quantity: 1,
        referenceProduct: expect.objectContaining({ id: 'reference-12' }) }),
    ]), { timeout: 2000 })
  })
  it('deletes a saved prescription draft when its final medication is explicitly removed from the list', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
    } } })
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^移除/ }))
    expect(mounted.props.actions.deleteDraft.onSubmit).toHaveBeenCalledOnce()
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('checkbox')).toBeTruthy()
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...mounted.props.actions,
      deleteDraft: { ...mounted.props.actions.deleteDraft, data: { caseId: detail.caseId, draftVersion: 2 } },
    }} detail={{ ...detail, medicationConclusion: { draftVersion: 2 } }} />)
    expect(within(screen.getByRole('region', { name: '待开具处方' })).queryByRole('checkbox')).toBeNull()
    expect(medicationForm().queryByText('存在未完成的药品信息，点击对应条目补全后才能开具。')).toBeNull()
  })
  it('keeps the final medication and its directions when draft deletion fails and retries its removal', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
    } } })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(panel.getByRole('button', { name: /^移除/ }))
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...mounted.props.actions,
      deleteDraft: { ...mounted.props.actions.deleteDraft, error: new Error('Synthetic deletion failure') },
    }} />)
    expect(panel.getByRole('checkbox', { name: '选择合成对乙酰氨基酚' })).toBeTruthy()
    expect(panel.getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
    expect(panel.getByText('500 mg · 必要时（PRN） · 口服（po） · 3 天 · 6')).toBeTruthy()
    expect(screen.getByText(mounted.props.messages.operationFailed)).toBeTruthy()
    await user.click(panel.getByRole('button', { name: /^移除/ }))
    expect(mounted.props.actions.deleteDraft.onSubmit).toHaveBeenCalledTimes(2)
  })
  it.each(['remove-last', 'discard-all'] as const)('only discards another medicine’s unfinished input after confirming a whole-draft clear (%s)', async action => {
    const secondProduct = { ...referenceProduct, id: 'reference-medication-b', genericName: '合成第二药品' }
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct,
        courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10 }] },
    } }, referenceSearch: {
      data: { items: [secondProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    } })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('tab', { name: '国家参考目录' }))
    await user.click(dialog.getByRole('button', { name: /^选择 合成第二药品/ }))
    await user.type(dialog.getByRole('textbox', { name: '剂量' }), '150 mg（待核对）')
    if (action === 'remove-last') {
      await user.click(dialog.getByRole('button', { name: '移除待开药品 合成参考药品' }))
    } else {
      await user.click(dialog.getByRole('button', { name: '清空手动草稿' }))
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认清空' }))
    }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...mounted.props.actions,
      deleteDraft: { ...mounted.props.actions.deleteDraft, data: { caseId: detail.caseId, draftVersion: 2 } },
    }} detail={{ ...detail, medicationConclusion: { draftVersion: 2 } }} />)
    expect(dialog.getByText('待开具 0 项')).toBeTruthy()
    if (action === 'remove-last') {
      expect(dialog.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '150 mg（待核对）')
      expect(dialog.getByRole('button', { name: '加入处方' })).toHaveProperty('disabled', true)
    } else {
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(dialog.queryByRole('textbox', { name: '剂量' })).toBeNull()
    }
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const restored = await openComposer(user)
    if (action === 'remove-last') expect(restored.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '150 mg（待核对）')
    else expect(restored.queryByRole('textbox', { name: '剂量' })).toBeNull()
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
        courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10 }] },
    } } })
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await userEvent.setup().click(panel.getByRole('button', { name: /^开具处方/ }))
    await waitFor(() => expect(confirmations).toEqual([{ expectedVersions: { 'Encounter/encounter-prescription': '1' }, input: {
      expectedDraftVersion: 1, resolveExistingDraft: true, selections: [
        { source: 'manual', kind: 'prescription', catalogItemId: referenceProduct.id, referenceProduct,
          courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10 },
      ],
    } }]))
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
    expect(panel.queryByRole('checkbox')).toBeNull()
    expect(medicationForm().queryByRole('combobox', { name: '剂量' })).toBeNull()
  })
  it('keeps reference product fields synchronized between list adjustment and manual entry', async () => {
    const mounted = renderPage({
      detail: { ...detail, medicationConclusion: {
        draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct,
          courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10 }] },
      } },
      referenceSearch: {
        data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
        error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
      },
    })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(panel.getByRole('button', { name: '调整' }))
    const adjustment = within(screen.getByRole('dialog', { name: '调整项目' }))
    await user.clear(adjustment.getByRole('textbox', { name: '每次剂量' }))
    await user.type(adjustment.getByRole('textbox', { name: '每次剂量' }), '150 mg')
    await user.click(adjustment.getByRole('button', { name: '保留本次调整' }))
    expect(panel.getByText(/150 mg · 每日两次/)).toBeTruthy()
    // 列表条目点击重开同一弹窗编辑，输入双向同步。
    await user.click(panel.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '150 mg')
    expect(within(dialog.getByRole('combobox', { name: /^包装 / })).getByText('12粒/盒')).toBeTruthy()
    await user.type(dialog.getByRole('textbox', { name: '剂量' }), ' 合成追加')
    await user.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(panel.getByRole('button', { name: '调整' }))
    expect(screen.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '150 mg 合成追加')
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })
  it('adds manual medication through the composer without another issuance button', async () => {
    const mounted = renderPage()
    expect(screen.queryByRole('textbox', { name: '搜索药品目录' })).toBeNull()
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    expect(dialog.getByRole('combobox', { name: '剂量' })).toBeTruthy()
    expect(dialog.queryByRole('button', { name: '正式开具处方' })).toBeNull()
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    expect(panel.getByRole('checkbox', { name: '选择合成对乙酰氨基酚' })).toBeTruthy()
    expect(panel.getAllByRole('button', { name: /^开具处方/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '正式开具处方' })).toBeNull()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([
      { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6 },
    ]), { timeout: 2000 })
  })

  it.each(['saveDraft', 'issue', 'confirmNoMedication', 'deleteDraft'] as const)('prevents prepared prescription confirmation while %s is pending', async operation => {
    const actions = createActions()
    actions[operation].pending = true
    renderPage({
      actions,
      detail: { ...detail, medicationConclusion: {
        draft: { items: [{ catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6 }] },
        draftVersion: 1,
      } },
    })
    await screen.findByRole('checkbox', { name: '选择合成对乙酰氨基酚' })
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    expect(actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps an incomplete manual prescription dose in the prepared list without restoring a default', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct,
        doseText: '', frequencyCode: 'BID', routeCode: 'PO', courseDays: 5, quantity: 10 }] },
    } } })
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    expect(panel.getByText('用法用量待补充')).toBeTruthy()
    const choice = panel.getByRole('checkbox', { name: '选择合成参考药品' })
    expect(choice.getAttribute('aria-checked')).toBe('false')
    expect(choice.getAttribute('aria-disabled')).toBe('true')
    expect(panel.getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    const user = userEvent.setup()
    // 重开弹窗时字段保持为空，补全前「保存修改」保持禁用。
    await user.click(panel.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '')
    expect(dialog.getByRole('button', { name: '保存修改' })).toHaveProperty('disabled', true)
    await user.click(dialog.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
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
      draftVersion: 1, draft: { items: [{ catalogItemId: referenceProduct.id, referenceProduct, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10 }] },
    } } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    medicationForm()
    vi.useFakeTimers()
    // 弹窗内改剂量并确认；确认落单后立即进入无需用药模式，自动保存不得发生。
    fireEvent.change(screen.getByRole('textbox', { name: '剂量' }), { target: { value: '150 mg' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存修改' }))
    fireEvent.click(screen.getByRole('button', { name: '无需用药' }))
    expect(screen.queryByRole('region', { name: '待开具处方' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '开具处方' }))
    // 切回处方模式后，弹窗里改过的剂量保留在待开具处方面板并照常自动保存。
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByText(/150 mg · 每日两次/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([{
      catalogItemId: referenceProduct.id, referenceProduct, courseDays: 5, doseText: '150 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10,
    }])
    expect(mounted.props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
  })

  it('cancels an unsaved draft timer when the case becomes read-only', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    vi.useFakeTimers()
    // 弹窗内确认落单后立即转只读，待触发的自动保存必须取消。
    fireEvent.change(screen.getByRole('textbox', { name: '剂量' }), { target: { value: '150 mg' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存修改' }))
    mounted.rerender(<PrescriptionPage {...mounted.props} readOnly />)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps edits made before deletion becomes pending and autosaves them after the deletion refresh', async () => {
    const user = userEvent.setup()
    const pageActions = createActions()
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })
    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    await user.click(within(screen.getByRole('alertdialog', { name: '确认删除处方草稿' })).getByRole('button', { name: '确认删除' }))
    expect(pageActions.deleteDraft.onSubmit).toHaveBeenCalledOnce()

    // 删除请求已发出，但草稿条目仍可通过弹窗继续编辑。
    await user.click(screen.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    const dialog = within(screen.getByRole('dialog'))
    await user.clear(dialog.getByRole('textbox', { name: '剂量' }))
    await user.type(dialog.getByRole('textbox', { name: '剂量' }), '150 mg')
    await user.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByText(/150 mg/)).toBeTruthy()
    vi.useFakeTimers()
    const pendingActions = { ...pageActions, deleteDraft: { ...pageActions.deleteDraft, pending: true } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={pendingActions} />)
    // 删除挂起期间编辑入口禁用。
    expect(screen.getByRole('button', { name: '添加药品' })).toHaveProperty('disabled', true)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(pageActions.saveDraft.onSubmit).not.toHaveBeenCalled()
    const deletion = { caseId: detail.caseId, draftVersion: 2 }
    const completedActions = { ...pageActions, deleteDraft: { ...pageActions.deleteDraft, data: deletion } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={completedActions} />)
    // 未保存进服务端的编辑在删除回执后仍保留。
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByText(/150 mg/)).toBeTruthy()

    const refreshedDetail = { ...detail, medicationConclusion: { draftVersion: 2 } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={completedActions} detail={refreshedDetail} />)
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByText(/150 mg/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(pageActions.saveDraft.onSubmit).toHaveBeenLastCalledWith([{
      catalogItemId: referenceProduct.id, courseDays: 5, doseText: '150 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10, referenceProduct,
    }])
  })

  it('does not replay a deletion receipt after a new draft is saved and its owner version refreshes', async () => {
    const deletion = { caseId: detail.caseId, draftVersion: 2 }
    const pageActions = createActions()
    pageActions.deleteDraft.data = deletion
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: { draftVersion: 1 } } })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const savedActions = { ...pageActions, saveDraft: { ...pageActions.saveDraft, success: true,
      savedRevision: JSON.stringify([{ catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6, routeCode: 'PO' }]),
    } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={savedActions} />)
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={savedActions} detail={{ ...detail, medicationConclusion: { draftVersion: 2 } }} />)
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
  })

  it('keeps a new draft when a previous deletion receipt is recreated during a refresh', async () => {
    const deletion = { caseId: detail.caseId, draftVersion: 2 }
    const pageActions = createActions()
    pageActions.deleteDraft.data = deletion
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: { draftVersion: 2 } } })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...pageActions, deleteDraft: { ...pageActions.deleteDraft, data: { ...deletion } } }} />)
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
  })
  it('keeps the catalog open while adding two medicines with independent fields, then returns to one whole prescription', async () => {
    const user = userEvent.setup()
    renderPage({ catalog: [medication, { ...medication, id: 'medication-b', nameZh: '合成第二药品',
      allowedCombinationIds: [medication.id], defaultDoseText: '1 g', defaultCourseDays: 5, defaultQuantity: 10 }] })

    // 弹窗打开前既没有目录也没有用药表单。
    expect(screen.queryByLabelText('搜索药品目录')).toBeNull()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    // 点选后弹窗内展开五个用药字段。
    for (const label of ['剂量', '频次', '给药途径', '疗程', '数量']) expect(dialog.getByLabelText(label)).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(dialog.getByText('待开具 1 项')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '选择 合成第二药品' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    expect(dialog.getByText('待开具 2 项')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const pending = within(screen.getByRole('region', { name: '待开具处方' }))
    expect(pending.getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
    expect(pending.getByRole('button', { name: '编辑药品 合成第二药品' })).toBeTruthy()
    expect(pending.getByRole('button', { name: '开具处方（2）' })).toBeTruthy()
    await user.click(pending.getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' }))
    expect(within(screen.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    await user.click(pending.getByRole('button', { name: '编辑药品 合成第二药品' }))
    expect(within(screen.getByRole('combobox', { name: '剂量' })).getByText('1 g')).toBeTruthy()
    expect(within(screen.getByRole('combobox', { name: '疗程' })).getByText('5 天')).toBeTruthy()
  })

  it('按药品保留同窗未保存编辑，保存另一药及重新挂载后仍可继续修改', async () => {
    const user = userEvent.setup()
    const overrides: Partial<React.ComponentProps<typeof PrescriptionPage>> = { catalog: [medication, { ...medication, id: 'medication-b', nameZh: '合成第二药品', allowedCombinationIds: [medication.id] }],
      detail: { ...detail, medicationConclusion: { draftVersion: 1, draft: { items: [
        { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6 },
        { catalogItemId: 'medication-b', courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6 },
      ] } } } }
    const first = renderPage(overrides)
    let dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('combobox', { name: '剂量' }))
    await user.click(await screen.findByRole('option', { name: '1 g' }))
    await user.click(dialog.getByRole('button', { name: '编辑待开药品 合成第二药品' }))
    await user.click(dialog.getByRole('combobox', { name: '疗程' }))
    await user.click(await screen.findByRole('option', { name: '5 天' }))
    await user.click(dialog.getByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚' }))
    expect(dialog.getByRole('combobox', { name: '剂量' }).textContent).toContain('1 g')
    await user.click(dialog.getByRole('button', { name: '取消' }))
    first.unmount()
    renderPage(overrides)
    expect(screen.getByRole('button', { name: '开具处方（2）' })).toHaveProperty('disabled', true)
    dialog = await openComposer(user, '编辑药品 合成第二药品')
    expect(dialog.getByRole('combobox', { name: '疗程' }).textContent).toContain('5 天')
    await user.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await openComposer(user, '编辑药品 合成对乙酰氨基酚')
    expect(dialog.getByRole('combobox', { name: '剂量' }).textContent).toContain('1 g')
  })

  it('restores private added medicines immediately after remount and isolates another actor scope', async () => {
    const user = userEvent.setup()
    const first = renderPage({ recommendationScope: 'actor-one:doctor:workspace:epoch' })
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    first.unmount()
    const other = renderPage({ recommendationScope: 'actor-two:doctor:workspace:epoch' })
    expect(screen.queryByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeNull()
    other.unmount()
    renderPage({ recommendationScope: 'actor-one:doctor:workspace:epoch' })
    expect(screen.getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
  })

  it('未加入的新药输入与既有药品编辑分别保留，切换患者后回到原稿仍可恢复', async () => {
    const user = userEvent.setup()
    const overrides: Partial<React.ComponentProps<typeof PrescriptionPage>> = { catalog: [medication, { ...medication, id: 'medication-b', nameZh: '合成第二药品', allowedCombinationIds: [medication.id] }],
      detail: { ...detail, medicationConclusion: { draftVersion: 1, draft: { items: [
        { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6 },
      ] } } } }
    const first = renderPage(overrides)
    let dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成第二药品' }))
    await user.click(dialog.getByRole('combobox', { name: '数量' }))
    await user.click(await screen.findByRole('option', { name: '10' }))
    await user.click(dialog.getByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('combobox', { name: '剂量' }))
    await user.click(await screen.findByRole('option', { name: '1 g' }))
    await user.click(dialog.getByRole('button', { name: '取消' }))
    first.unmount()
    const other = renderPage({ ...overrides, detail: { ...detail, caseId: 'other-case', encounter: { id: 'other-encounter', versionId: '1' } } })
    dialog = await openComposer(user)
    expect(dialog.queryByRole('combobox', { name: '剂量' })).toBeNull()
    other.unmount()
    renderPage(overrides)
    dialog = await openComposer(user)
    expect(dialog.getByRole('combobox', { name: '数量' }).textContent).toContain('10')
    await user.click(dialog.getByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚' }))
    expect(dialog.getByRole('combobox', { name: '剂量' }).textContent).toContain('1 g')
  })

  it.each(['add', 'edit'] as const)('兼容旧单稿 %s 输入，更新及重新挂载后仍保留原字段', async kind => {
    const user = userEvent.setup()
    const scope = JSON.stringify([undefined, detail.caseId, detail.encounter.id, 'prescription'])
    sessionStorage.setItem(`clinmesh.outpatient-investigation.prescription-composer:v1:${scope}`, JSON.stringify({
      catalogItemId: medication.id, fields: { courseDays: 5, doseText: '1 g', frequencyCode: 'BID', routeCode: 'PO', quantity: 10 },
      ...(kind === 'edit' ? { editingId: medication.id } : {}),
    }))
    const overrides: Partial<React.ComponentProps<typeof PrescriptionPage>> = kind === 'edit' ? { detail: { ...detail, medicationConclusion: { draftVersion: 1, draft: { items: [
      { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6 },
    ] } } } } : {}
    const first = renderPage(overrides)
    const target = kind === 'edit' ? '编辑药品 合成对乙酰氨基酚' : '添加药品'
    let dialog = await openComposer(user, target)
    expect(dialog.getByRole('combobox', { name: '剂量' }).textContent).toContain('1 g')
    await user.click(dialog.getByRole('combobox', { name: '疗程' }))
    await user.click(await screen.findByRole('option', { name: '3 天' }))
    await user.click(dialog.getByRole('button', { name: kind === 'edit' ? '取消' : '完成选择' }))
    first.unmount()
    renderPage(overrides)
    dialog = await openComposer(user, target)
    expect(dialog.getByRole('combobox', { name: '剂量' }).textContent).toContain('1 g')
    expect(dialog.getByRole('combobox', { name: '疗程' }).textContent).toContain('3 天')
  })

  it('keeps incomplete composer input after closing and remounting without adding it to the prescription', async () => {
    const user = userEvent.setup()
    const search: ReferenceCatalogSearches['medications'] = {
      data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    }
    const first = renderPage({ referenceSearch: search })
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('tab', { name: '国家参考目录' }))
    await user.click(dialog.getByRole('button', { name: /^选择 合成参考药品/ }))
    await user.type(dialog.getByRole('textbox', { name: '剂量' }), '75 mg（待核对）')
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    first.unmount()
    renderPage({ referenceSearch: search })
    const restored = await openComposer(user)
    expect(restored.getByRole('textbox', { name: '剂量' })).toHaveProperty('value', '75 mg（待核对）')
    expect(restored.getByRole('textbox', { name: '频次' })).toHaveProperty('value', '')
    expect(restored.getByRole('button', { name: '加入处方' })).toHaveProperty('disabled', true)
    expect(restored.getByText('待开具 0 项')).toBeTruthy()
  })

  it.each(['prescription:v1:', 'prescription-composer:v1:'])('blocks issuing when the persisted %s input is corrupt', async prefix => {
    const getItem = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      return key.includes(prefix) ? '{}' : getItem.call(this, key)
    })
    renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 1, draft: { items: [{
      catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6,
    }] } } } })
    const issue = await screen.findByRole('button', { name: '开具处方（1）' })
    await waitFor(() => expect(screen.getByText('处方草稿无法读取或保存，已停止新开具。请确认清空草稿后再试。')).toBeTruthy())
    expect(issue).toHaveProperty('disabled', true)
  })

  it('requires confirmation before discarding private medicines and unfinished input', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '清空手动草稿' }))
    let confirmation = within(screen.getByRole('alertdialog'))
    await user.click(confirmation.getByRole('button', { name: '取消' }))
    expect(dialog.getByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚' })).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '清空手动草稿' }))
    confirmation = within(screen.getByRole('alertdialog'))
    await user.click(confirmation.getByRole('button', { name: '确认清空' }))
    expect(dialog.getByText('待开具 0 项')).toBeTruthy()
    expect(dialog.queryByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚' })).toBeNull()
  })

  it('retains the clear confirmation and medicines when storage rejects discarding', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '清空手动草稿' }))
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic storage failure') })
    const confirmation = within(screen.getByRole('alertdialog'))
    await user.click(confirmation.getByRole('button', { name: '确认清空' }))
    expect(confirmation.getByText('清空失败，请重试。尚未清除的输入已保留。')).toBeTruthy()
    expect(dialog.getByRole('button', { name: '编辑待开药品 合成对乙酰氨基酚', hidden: true })).toBeTruthy()
    setItem.mockRestore()
    await user.click(confirmation.getByRole('button', { name: '确认清空' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(dialog.getByText('待开具 0 项')).toBeTruthy()
  })

  it('waits for server deletion and displays its rejection inside the clear confirmation', async () => {
    const user = userEvent.setup()
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 1, draft: { items: [{
      catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 6,
    }] } } } })
    await user.click(screen.getByRole('button', { name: '清空手动草稿' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认清空' }))
    expect(mounted.props.actions.deleteDraft.onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...mounted.props.actions,
      deleteDraft: { ...mounted.props.actions.deleteDraft, error: new Error('Synthetic delete failure') },
    }} />)
    expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: '编辑药品 合成对乙酰氨基酚', hidden: true })).toBeTruthy()
  })

  it('searches issued medication records and returns to the list without changing the prescription', async () => {
    const user = userEvent.setup()
    const { props } = renderPage({
      detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: issuedPrescription } },
    })

    const search = screen.getByLabelText('搜索处方药品')
    const list = within(screen.getByRole('region', { name: '药品列表' }))
    expect(list.getByRole('cell', { name: '合成对乙酰氨基酚' })).toBeTruthy()
    expect(list.getByText(/500 mg/)).toBeTruthy()
    expect(list.getByRole('cell', { name: '合成奥司他韦' })).toBeTruthy()
    expect(list.getByText(/75 mg/)).toBeTruthy()
    expect(screen.queryByLabelText('剂量')).toBeNull()

    fireEvent.change(search, { target: { value: '没有匹配' } })
    expect(screen.getByText('没有匹配的记录')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '查看全部记录' }))
    expect(list.getByRole('cell', { name: '合成对乙酰氨基酚' })).toBeTruthy()
    expect(list.getByText(/500 mg/)).toBeTruthy()
    expect(props.actions.withdraw.onSubmit).not.toHaveBeenCalled()
    expect(props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('previews the unissued draft before confirming no medication', async () => {
    const user = userEvent.setup()
    const { props } = renderPage({
      detail: { ...detail, medicationConclusion: {
        draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
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
    // 切回处方模式后草稿原样保留在待开具处方。
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '编辑药品 合成对乙酰氨基酚' })).toBeTruthy()
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
        draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10, referenceProduct }] },
        draftVersion: 1,
      } },
    })

    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    // 规格与厂家等注册信息保留在弹窗条目头中。
    await user.click(panel.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getAllByText(/12粒\/盒/).length).toBeGreaterThan(0)
    await user.clear(dialog.getByRole('textbox', { name: '剂量' }))
    await user.type(dialog.getByRole('textbox', { name: '剂量' }), '150 mg')
    await user.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(panel.getByText(/150 mg/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '正式开具处方' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '重试保存' }))
    expect(actions.saveDraft.onSubmit).toHaveBeenLastCalledWith([{
      catalogItemId: referenceProduct.id,
      courseDays: 5,
      doseText: '150 mg',
      frequencyCode: 'BID',
      quantity: 10,
      referenceProduct,
      routeCode: 'PO',
    }])
    expect(panel.getByText(/150 mg/)).toBeTruthy()
  })

  it('marks invalid reference directions and prevents saving or issuing until they are corrected', async () => {
    vi.useFakeTimers()
    const { props } = renderPage({ detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 31, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 1001, referenceProduct }] },
      draftVersion: 1,
    } } })

    // 未完成条目在页签列表里提示补全，整单不可保存或开具。
    const form = medicationForm()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    expect(form.getByText('存在未完成的药品信息，点击对应条目补全后才能开具。')).toBeTruthy()
    expect(panel.getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()

    // 弹窗内标记非法字段并禁用确认，修正后才能保存修改。
    fireEvent.click(panel.getByRole('button', { name: /^编辑药品 合成参考药品/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('疗程').getAttribute('aria-invalid')).toBe('true')
    expect(dialog.getByLabelText('数量').getAttribute('aria-invalid')).toBe('true')
    expect(dialog.getByRole('button', { name: '保存修改' })).toHaveProperty('disabled', true)
    fireEvent.change(dialog.getByLabelText('疗程'), { target: { value: '5' } })
    fireEvent.change(dialog.getByLabelText('数量'), { target: { value: '10' } })
    expect(dialog.getByRole('button', { name: '保存修改' })).toHaveProperty('disabled', false)
    fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([{
      catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 10, referenceProduct,
    }])
  })

  it('keeps each line’s directions when its composer is reopened', async () => {
    const user = userEvent.setup()
    const secondMedication: Medication = { ...medication, allowedCombinationIds: [medication.id], id: 'medication-b', nameEn: 'Synthetic second medication', nameZh: '合成第二药品' }
    renderPage({ catalog: [medication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [
        { catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 },
        { catalogItemId: secondMedication.id, doseText: '500 mg', frequencyCode: 'BID', routeCode: 'PO', courseDays: 5, quantity: 10 },
      ] },
      draftVersion: 1,
    } } })

    // 第一条：PRN · 3 天 · 6。
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(panel.getByRole('button', { name: /^编辑药品 合成对乙酰氨基酚/ }))
    let dialog = within(screen.getByRole('dialog', { name: '编辑药品' }))
    expect(within(dialog.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    expect(within(dialog.getByRole('combobox', { name: '频次' })).getByText('必要时（PRN）')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 第二条保留自己的 BID · 5 天 · 10。
    await user.click(panel.getByRole('button', { name: /^编辑药品 合成第二药品/ }))
    dialog = within(screen.getByRole('dialog', { name: '编辑药品' }))
    expect(within(dialog.getByRole('combobox', { name: '频次' })).getByText('每日两次（BID）')).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(panel.getAllByRole('button', { name: /^编辑药品 / })).toHaveLength(2)
  })

  it('keeps the eight medication limit and hides incompatible local combinations', async () => {
    const user = userEvent.setup()
    const ids = Array.from({ length: 9 }, (_, index) => `medication-${index + 1}`)
    const catalog = ids.map((id, index) => ({ ...medication, allowedCombinationIds: ids, id, nameZh: `合成药品 ${index + 1}` }))
    const { unmount } = renderPage({ catalog, detail: { ...detail, medicationConclusion: {
      draft: { items: catalog.slice(0, 8).map(item => ({ catalogItemId: item.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO' as const, courseDays: 3, quantity: 6 })) },
      draftVersion: 1,
    } } })
    // 八条封顶：入口在满额时禁用。
    expect(screen.getByRole('button', { name: '添加药品' })).toHaveProperty('disabled', true)
    unmount()

    renderPage({ catalog: [medication, { ...medication, id: 'incompatible', nameZh: '合成不兼容药品', allowedCombinationIds: [] }], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
      draftVersion: 1,
    } } })
    const dialog = await openComposer(user)
    // 弹窗内不兼容的本院药品不进入目录行，且已锁本院来源时不误报本院无药或引导切往全禁用的国家参考目录。
    expect(dialog.queryByRole('button', { name: '选择 合成不兼容药品' })).toBeNull()
    expect(dialog.getByText('当前暂无可与已选药品联用的其他本院药品。')).toBeTruthy()
    expect(dialog.queryByRole('button', { name: '切换至国家参考目录' })).toBeNull()
  })

  it.each(['signed', 'paid', 'dispensed', 'withdrawn'] as const)('keeps %s prescription records available without ordinary writes in a read-only case', status => {
    renderPage({
      allowWithdrawal: false,
      detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: { ...issuedPrescription, status } } },
      readOnly: true,
    })
    expect(within(screen.getByRole('region', { name: '药品列表' })).getByRole('cell', { name: '合成对乙酰氨基酚' })).toBeTruthy()
    expect(screen.getByLabelText('搜索处方药品')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索药品目录' })).toBeNull()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    for (const name of ['正式开具处方', '删除处方草稿', '撤回处方', '确认无需用药']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
})

describe('处方页签布局整理', () => {
  it('将「用药结论方式」放到左主列顶部，右辅助列只保留待开具面板', () => {
    renderPage()
    const entry = document.querySelector('[data-order-entry]')
    expect(entry).not.toBeNull()
    const mode = within(entry as HTMLElement).getByRole('group', { name: '用药结论方式' })
    // 结论方式先于目录+表单卡出现，也先于右辅助列的待开具区域。
    expect(mode.compareDocumentPosition(screen.getByRole('region', { name: '填写处方' }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mode.compareDocumentPosition(screen.getByRole('region', { name: '待开具处方' }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole('group', { name: '用药结论方式' })).toHaveLength(1)
  })

  it('无需用药结论在左主列内替换目录与表单卡', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: '无需用药' }))
    const entry = document.querySelector('[data-order-entry]')
    expect(entry).not.toBeNull()
    const panel = within(entry as HTMLElement).getByRole('region', { name: '确认无需用药' })
    expect(within(panel).getByText('记录本次就诊无需用药，不生成药品医嘱或处方。')).toBeTruthy()
    // 目录与表单卡被整块替换，不再同时出现填写处方区。
    expect(screen.queryByRole('region', { name: '填写处方' })).toBeNull()
  })

  it('药品目录空态用左对齐紧凑引导替代居中悬空提示', () => {
    renderPage()
    // 填写前没有常驻目录/详情卡；空态引导在左主列入口下方。
    expect(screen.queryByRole('region', { name: '药品详情' })).toBeNull()
    const entry = document.querySelector('[data-order-entry]')
    expect(entry?.querySelector('[data-slot="empty"]')).toBeNull()
    expect(within(entry as HTMLElement).getByText('最多 8 条 · 当前 0 条')).toBeTruthy()
    expect(medicationForm().queryByRole('alert')).toBeNull()
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: /^开具处方/ })).toHaveProperty('disabled', true)
  })

  it('有草稿时自动保存状态与删除入口跟随表单区，右辅助列不再放置草稿工具', () => {
    renderPage({ detail: { ...detail, medicationConclusion: {
      draftVersion: 1, draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
    } } })
    const form = screen.getByRole('region', { name: '填写处方' })
    const tools = form.querySelector('[data-draft-tools]')
    expect(tools).not.toBeNull()
    expect(within(tools as HTMLElement).getByRole('button', { name: '删除处方草稿' })).toBeTruthy()
    expect(within(tools as HTMLElement).getByText('草稿已自动保存')).toBeTruthy()
    const aside = screen.getByRole('region', { name: '待开具处方' }).parentElement
    expect(aside?.querySelector('[data-draft-tools]')).toBeNull()
  })

  it('无草稿时不渲染空草稿工具块', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: '删除处方草稿' })).toBeNull()
    expect(screen.queryByText('草稿已自动保存')).toBeNull()
  })

  it('目录条目的包装信息只保留最小事实，工艺细节进入悬停提示', async () => {
    const craft = { ...referenceProduct, packageDescription: '本品采用五层共挤输液用三室袋、氧指示剂和高阻隔外包装袋。；14袋/盒' }
    renderPage({ referenceSearch: {
      data: { items: [craft], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    } })
    await openComposer(userEvent.setup())
    await userEvent.setup().click(within(screen.getByRole('dialog')).getByRole('tab', { name: '国家参考目录' }))
    const combo = within(screen.getByRole('dialog')).getByRole('combobox', { name: /^包装 / })
    const shown = within(combo).getByText('14袋/盒')
    expect(within(combo).queryByText(/五层共挤/)).toBeNull()
    expect(shown.getAttribute('title')).toContain('五层共挤')
  })

  it('开具记录行的包装摘要同样降噪并保留悬停全文', () => {
    const craft = { ...referenceProduct, id: 'reference-craft', packageDescription: '本品采用五层共挤输液用三室袋、氧指示剂和高阻隔外包装袋。；14袋/盒' }
    renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: {
      ...issuedPrescription,
      items: [{ catalogItemId: craft.id, courseDays: 3, display: craft.genericName, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO',
        medicationRequestId: 'request-craft', medicationRequestVersion: '1', quantity: 10, referenceProduct: craft }],
    } } } })
    const list = within(screen.getByRole('region', { name: '药品列表' }))
    expect(list.getByRole('cell', { name: '合成参考药品' })).toBeTruthy()
    expect(list.getByText(/14袋\/盒/)).toBeTruthy()
    expect(list.queryByText(/五层共挤/)).toBeNull()
    expect(screen.getByRole('region', { name: '药品列表' }).querySelector('span[title*="五层共挤"]')).not.toBeNull()
  })

  it('待开具卡片未开启异步建议时不显示过时的自动刷新与依据按钮', () => {
    renderPage()
    const panel = screen.getByRole('region', { name: '待开具处方' })
    expect(within(panel).queryByRole('button', { name: '刷新' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: '依据与说明' })).toBeNull()
  })

  it('开具后状态收敛为单行徽章与元信息，不再重复两处状态文案', () => {
    const { container } = renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: issuedPrescription } } })
    const statusRow = container.querySelector('[data-prescription-status]')
    expect(statusRow).not.toBeNull()
    expect(within(statusRow as HTMLElement).getByText('已支付')).toBeTruthy()
    expect(screen.getAllByText('已支付')).toHaveLength(1)
    expect(within(statusRow as HTMLElement).getByText(/处方号 RX-SYNTHETIC-1 ·/)).toBeTruthy()
    expect(within(statusRow as HTMLElement).getByText(/已开具处方不可直接编辑/)).toBeTruthy()
    expect(within(statusRow as HTMLElement).getByRole('button', { name: '撤回处方' })).toBeTruthy()
    expect(screen.getByRole('list', { name: '处方进度' })).toBeTruthy()
  })

  it('撤回终态在一个分组里保留明细与退款说明', () => {
    renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: {
      ...issuedPrescription, status: 'withdrawn', withdrawal: {
        id: 'withdrawal-1', prescriptionId: issuedPrescription.id, version: 2,
        withdrawnAt: '2026-10-11T08:00:00+08:00', withdrawnByActorId: 'actor-synthetic', withdrawnByPractitionerRoleId: 'role-doctor',
      },
    } } } })
    expect(screen.getAllByText('已撤回')).toHaveLength(1)
    expect(screen.getByText(/原处方明细保留，已支付记录不会自动退款/)).toBeTruthy()
  })

  it('药品目录在弹窗内支持点击候选名称并保留包装选择', async () => {
    renderPage({ referenceSearch: {
      data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    } })
    // 弹窗打开前不渲染目录。
    expect(document.querySelector('[data-agent-catalog="medication"]')).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加药品' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('tab', { name: '国家参考目录' }))
    const candidate = dialog.getByRole('button', { name: /^选择 合成参考药品/ })
    await user.click(within(candidate).getByText(referenceProduct.genericName))
    expect(candidate.getAttribute('aria-pressed')).toBe('true')
    expect(dialog.getByRole('combobox', { name: /^包装 合成参考药品/ })).toBeTruthy()
    expect(dialog.getByRole('button', { name: '加入处方' })).toBeTruthy()
  })

  it('新增呈现提供英文文案（草稿态与开具态）', () => {
    renderPage({ locale: 'en-US', messages: getWorkspaceMessages('en-US') })
    expect(screen.getByText('Up to 8 · 0 added')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Medication conclusion mode' })).toBeTruthy()

    renderPage({
      detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: issuedPrescription } },
      locale: 'en-US',
      messages: getWorkspaceMessages('en-US'),
    })
    const statusRow = document.querySelector('[data-prescription-status]')
    expect(statusRow).not.toBeNull()
    expect(within(statusRow as HTMLElement).getByText('Paid')).toBeTruthy()
    expect(within(statusRow as HTMLElement).getByRole('button', { name: 'Withdraw prescription' })).toBeTruthy()
  })

  it('默认打开「本院药房」展示规格与单价，支持本院筛选与空状态一键切换「国家参考目录」', async () => {
    const onSearch = vi.fn()
    const hospitalCatalog: Medication[] = [
      { ...medication, packageDescription: '20片/盒', priceFen: 120, strength: '500 mg' },
      { ...medication, id: 'medication-b', nameEn: 'Synthetic oseltamivir', nameZh: '合成奥司他韦', packageDescription: '10粒/盒', priceFen: 1680, strength: '75 mg' },
    ]
    renderPage({
      catalog: hospitalCatalog,
      referenceSearch: {
        data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
        error: null, isError: false, isFetching: false, isPending: false, onSearch,
      },
    })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    const localTab = dialog.getByRole('tab', { name: '本院药房' })
    const referenceTab = dialog.getByRole('tab', { name: '国家参考目录' })
    expect(localTab.getAttribute('aria-selected')).toBe('true')
    expect(referenceTab.getAttribute('aria-selected')).toBe('false')
    expect(onSearch).not.toHaveBeenCalled()

    // 展示本院药品规格与单价，且不常驻适应证标签；不混现国家参考目录条目
    const acetaminophenRow = dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' })
    expect(within(acetaminophenRow).getByText(/500 mg/)).toBeTruthy()
    expect(within(acetaminophenRow).getByText(/¥1\.20/)).toBeTruthy()
    expect(within(acetaminophenRow).queryByText(/J11|R50/)).toBeNull()
    expect(dialog.queryByRole('button', { name: /^选择 合成参考药品/ })).toBeNull()

    // 本院目录关键词检索无匹配时，展示空状态与一键切换至国家参考目录动作
    await user.type(dialog.getByRole('textbox', { name: '搜索药品目录' }), '院外罕见药')
    await user.click(dialog.getByRole('button', { name: '执行药品目录搜索' }))
    expect(dialog.getByText(/本院药房暂无匹配药品/)).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: '切换至国家参考目录' }))
    expect(referenceTab.getAttribute('aria-selected')).toBe('true')
    expect(onSearch).toHaveBeenCalledWith('院外罕见药', 1)
    expect(dialog.getByText(/国家参考目录药品仅生成电子外延处方，不在本院收费与药房发药/)).toBeTruthy()
    expect(dialog.getByRole('button', { name: /^选择 合成参考药品/ })).toBeTruthy()
  })

  it('国家参考目录请求失败时保留重试入口，且不影响切回「本院药房」选药', async () => {
    const onSearch = vi.fn()
    renderPage({
      catalog: [{ ...medication, priceFen: 120, strength: '500 mg' }],
      referenceSearch: {
        data: undefined, error: new Error('Reference offline'), isError: true, isFetching: false, isPending: false, onSearch,
      },
    })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('tab', { name: '国家参考目录' }))
    expect(onSearch).toHaveBeenCalledWith('', 1)
    await user.click(dialog.getByRole('button', { name: '重试目录' }))
    expect(onSearch).toHaveBeenCalledTimes(2)
    await user.click(dialog.getByRole('tab', { name: '本院药房' }))
    expect(dialog.queryByRole('button', { name: '重试目录' })).toBeNull()
    await user.click(dialog.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    expect(dialog.getByRole('button', { name: '加入处方' })).toHaveProperty('disabled', false)
  })

  it('编辑草稿已有条目自动定位所属来源页签，多条草稿跨源候选置灰写明原因，编辑唯一条目自身允许跨源替换', async () => {
    const search: ReferenceCatalogSearches['medications'] = {
      data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    }
    const user = userEvent.setup()

    // 1. 已含本院药房药品时：新增弹窗切到国家参考目录后候选置灰并写明需分开开具；但编辑当前唯一条目时可切换至国家参考目录替换
    const first = renderPage({
      catalog: [{ ...medication, priceFen: 120, strength: '500 mg' }],
      detail: { ...detail, medicationConclusion: {
        draftVersion: 1,
        draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
      } },
      referenceSearch: search,
    })
    const addFromLocal = await openComposer(user, '添加药品')
    expect(addFromLocal.getByRole('tab', { name: '本院药房' }).getAttribute('aria-selected')).toBe('true')
    await user.click(addFromLocal.getByRole('tab', { name: '国家参考目录' }))
    const disabledRefCandidate = addFromLocal.getByRole('button', { name: /^选择 合成参考药品/ })
    expect(disabledRefCandidate).toHaveProperty('disabled', true)
    expect(within(disabledRefCandidate).getByText(/已含本院药房药品，需与本院处方分开开具/)).toBeTruthy()
    await user.click(addFromLocal.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const editSoleLocal = await openComposer(user, /^编辑药品 合成对乙酰氨基酚/)
    expect(editSoleLocal.getByRole('tab', { name: '本院药房' }).getAttribute('aria-selected')).toBe('true')
    await user.click(editSoleLocal.getByRole('tab', { name: '国家参考目录' }))
    expect(editSoleLocal.getByRole('button', { name: /^选择 合成参考药品/ })).toHaveProperty('disabled', false)
    await user.click(editSoleLocal.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    first.unmount()

    // 2. 已含国家参考目录药品时：编辑该条目直接定位国家参考目录；点击「添加药品」默认展示本院药房但候选置灰并写明需分开开具
    renderPage({
      catalog: [{ ...medication, priceFen: 120, strength: '500 mg' }],
      detail: { ...detail, medicationConclusion: {
        draftVersion: 1,
        draft: { items: [{ catalogItemId: referenceProduct.id, doseText: '75 mg', frequencyCode: 'BID', routeCode: 'PO', courseDays: 5, quantity: 2, referenceProduct }] },
      } },
      referenceSearch: search,
    })
    const editReference = await openComposer(user, /^编辑药品 合成参考药品/)
    expect(editReference.getByRole('tab', { name: '国家参考目录' }).getAttribute('aria-selected')).toBe('true')
    expect((editReference.getByLabelText('剂量') as HTMLInputElement).value).toBe('75 mg')
    await user.click(editReference.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const addFromReference = await openComposer(user, '添加药品')
    expect(addFromReference.getByRole('tab', { name: '本院药房' }).getAttribute('aria-selected')).toBe('true')
    const disabledLocalCandidate = addFromReference.getByRole('button', { name: '选择 合成对乙酰氨基酚' })
    expect(disabledLocalCandidate).toHaveProperty('disabled', true)
    expect(within(disabledLocalCandidate).getByText(/已含国家参考目录药品，需与外延处方分开开具/)).toBeTruthy()
    await user.click(addFromReference.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('英文界面同步提供双源页签、外延处方提示与跨源禁选说明', async () => {
    const user = userEvent.setup()
    renderPage({
      catalog: [{ ...medication, priceFen: 120, strength: '500 mg' }],
      detail: { ...detail, medicationConclusion: {
        draftVersion: 1,
        draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', routeCode: 'PO', courseDays: 3, quantity: 6 }] },
      } },
      locale: 'en-US',
      messages: getWorkspaceMessages('en-US'),
      referenceSearch: {
        data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
        error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
      },
    })
    const dialog = await openComposer(user, 'Add medication')
    expect(dialog.getByRole('tab', { name: 'Hospital pharmacy' }).getAttribute('aria-selected')).toBe('true')
    await user.click(dialog.getByRole('tab', { name: 'National reference' }))
    expect(dialog.getByText(/generate external electronic prescriptions only/i)).toBeTruthy()
    const disabledCandidate = dialog.getByRole('button', { name: /^Select 合成参考药品/ })
    expect(disabledCandidate).toHaveProperty('disabled', true)
    expect(within(disabledCandidate).getByText(/Issue separately from hospital pharmacy items/)).toBeTruthy()
  })

  it('本院无可用门诊药品时展示空态引导，且本院药房与国家参考目录均支持单字关键词搜药', async () => {
    const onSearch = vi.fn()
    const user = userEvent.setup()
    renderPage({
      catalog: [],
      referenceSearch: {
        data: { items: [referenceProduct], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic' },
        error: null, isError: false, isFetching: false, isPending: false, onSearch,
      },
    })
    const dialog = await openComposer(user)
    expect(dialog.getByText('当前暂无可用的本院门诊药品。')).toBeTruthy()

    // 输入 1 个字后在本院搜索并一键切换至国家参考目录，1 字关键词直接透传至国家参考目录检索
    const searchInput = dialog.getByRole('textbox', { name: '搜索药品目录' })
    await user.type(searchInput, '氯')
    const searchButton = dialog.getByRole('button', { name: '执行药品目录搜索' })
    expect(searchButton).toHaveProperty('disabled', false)
    await user.click(searchButton)
    await user.click(dialog.getByRole('button', { name: '切换至国家参考目录' }))
    expect(dialog.getByRole('tab', { name: '国家参考目录' }).getAttribute('aria-selected')).toBe('true')
    expect(onSearch).toHaveBeenLastCalledWith('氯', 1)

    // 在国家参考目录页签内直接改输另 1 个字，搜索按钮保持可用并发起单字检索
    await user.clear(searchInput)
    await user.type(searchInput, '合')
    expect(searchButton).toHaveProperty('disabled', false)
    await user.click(searchButton)
    expect(onSearch).toHaveBeenLastCalledWith('合', 1)
  })

  it('带声明式安全规则的本院药品在选药弹窗中支持自由输入多日总数量并加入草稿', async () => {
    const safetyMedication: Medication = {
      ...medication,
      id: 'medication-metoprolol',
      nameZh: '琥珀酸美托洛尔缓释片',
      nameEn: 'Metoprolol succinate sustained-release tablet',
      allowedDoseTexts: ['47.5 mg'],
      allowedFrequencyCodes: ['QD'],
      allowedCourseDays: [7, 14, 30],
      allowedQuantities: [1],
      defaultCourseDays: 14,
      defaultDoseText: '47.5 mg',
      defaultFrequencyCode: 'QD',
      defaultQuantity: 1,
      safety: {
        pharmacologyClasses: ['beta-blocker'],
        indicationPrefixes: ['I10', 'I20', 'I25'],
        doseLimits: { unit: 'mg', minimumSingleDose: 23.75, maximumSingleDose: 190, maximumDailyDose: 190 },
        maximumDailyQuantity: 4,
      },
    }
    const mounted = renderPage({ catalog: [safetyMedication] })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 琥珀酸美托洛尔缓释片' }))
    const quantityInput = dialog.getByRole('spinbutton', { name: '数量' }) as HTMLInputElement
    expect(quantityInput.value).toBe('1')
    await user.clear(quantityInput)
    await user.type(quantityInput, '14')
    const addButton = dialog.getByRole('button', { name: '加入处方' })
    expect(addButton).toHaveProperty('disabled', false)
    await user.click(addButton)
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByText('47.5 mg · 每日一次（QD） · 口服（po） · 14 天 · 14')).toBeTruthy()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([
      { catalogItemId: 'medication-metoprolol', doseText: '47.5 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 14, quantity: 14 },
    ]))
  })

  it('待开具双入口与已开具本院处方完整展示药学二次查对要素与开方医生姓名', async () => {
    const oseltamivir: Medication = {
      ...medication,
      allowedCourseDays: [5],
      allowedDoseTexts: ['75 mg'],
      allowedFrequencyCodes: ['BID'],
      allowedQuantities: [10],
      defaultCourseDays: 5,
      defaultDoseText: '75 mg',
      defaultFrequencyCode: 'BID',
      defaultQuantity: 10,
      dosageForm: '胶囊剂',
      id: 'medication-oseltamivir',
      nameEn: 'Oseltamivir phosphate capsules',
      nameZh: '磷酸奥司他韦胶囊',
      packageDescription: '10粒/盒',
      priceFen: 760,
      strength: '75 mg',
      unit: '粒',
    }
    const mounted = renderPage({ catalog: [oseltamivir] })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 磷酸奥司他韦胶囊' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))

    const pendingInDialog = within(dialog.getByRole('region', { name: '处方待开清单' }))
    expect(pendingInDialog.getByRole('button', { name: '编辑待开药品 磷酸奥司他韦胶囊' })).toBeTruthy()
    expect(pendingInDialog.getByText('75 mg · 10粒/盒 · 单次 75 mg · 每日两次（BID） · 口服（po） · 5 天 · 10 粒')).toBeTruthy()

    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const pendingPanel = within(screen.getByRole('region', { name: '待开具处方' }))
    expect(pendingPanel.getByText('75 mg · 每日两次（BID） · 口服（po） · 5 天 · 10')).toBeTruthy()
    expect(pendingPanel.getByText('75 mg · 10粒/盒 · 发药总量 10 粒')).toBeTruthy()

    mounted.rerender(<PrescriptionPage {...mounted.props} catalog={[oseltamivir]} detail={{
      ...detail,
      medicationConclusion: {
        draftVersion: 2,
        prescription: {
          ...issuedPrescription,
          authoredByName: '合成门诊医生',
          items: [{
            catalogItemId: oseltamivir.id,
            courseDays: 5,
            display: oseltamivir.nameZh,
            doseText: '75 mg',
            frequencyCode: 'BID',
            medicationRequestId: 'request-oseltamivir',
            medicationRequestVersion: '1',
            packageDescription: '10粒/盒',
            quantity: 10,
            routeCode: 'PO',
            strength: '75 mg',
            unit: '粒',
          }],
        },
      },
    }} />)
    const statusRow = document.querySelector('[data-prescription-status]') as HTMLElement
    expect(statusRow.textContent).toContain('开方医生 合成门诊医生')
    expect(screen.getByRole('list', { name: '处方进度' })).toBeTruthy()
    const issuedTable = within(screen.getByRole('region', { name: '药品列表' }))
    expect(issuedTable.getByText('75 mg · 10粒/盒')).toBeTruthy()
    expect(issuedTable.getByText('75 mg · 每日两次（BID） · 口服（po） · 5 天')).toBeTruthy()
    expect(issuedTable.getByText('10 粒')).toBeTruthy()
    expect(issuedTable.queryByText('—')).toBeNull()
  })

  it('门诊选药弹窗、待开清单与国家参考目录支持只读查阅合成说明书摘要及空态，切换或关闭抽屉不丢失草稿', async () => {
    const metoprolol: Medication = {
      ...medication,
      id: 'medication-metoprolol',
      nameEn: 'Metoprolol succinate extended-release tablets',
      nameZh: '琥珀酸美托洛尔缓释片',
      dosageForm: '片剂',
      strength: '47.5 mg',
      packageDescription: '7片/盒',
      unit: '片',
      priceFen: 80,
      allowedCombinationIds: ['medication-plain', 'medication-amlodipine'],
      allowedDoseTexts: ['47.5 mg'],
      allowedFrequencyCodes: ['QD'],
      allowedCourseDays: [7, 14, 30],
      allowedQuantities: [1],
      defaultCourseDays: 14,
      defaultDoseText: '47.5 mg',
      defaultFrequencyCode: 'QD',
      defaultQuantity: 1,
      safety: {
        pharmacologyClasses: ['beta-blocker'],
        indicationPrefixes: ['I10', 'I20', 'I25'],
        doseLimits: { unit: 'mg', minimumSingleDose: 23.75, maximumSingleDose: 190, maximumDailyDose: 190 },
        maximumDailyQuantity: 4,
      },
      packageInsert: {
        genericName: '琥珀酸美托洛尔缓释片',
        specificationAndForm: '片剂 · 47.5 mg · 7片/盒',
        indicationsSummary: '用于高血压、冠心病心绞痛及慢性稳定性心力衰竭。',
        dosageAndAdministration: '口服，常规每次 47.5 mg，每日一次（QD），单日最大剂量 190 mg。',
        contraindications: '显著心动过缓（心率 < 50 次/分）或低血压（收缩压 < 90 mmHg）禁用。',
        precautions: '心率 < 60 次/分或收缩压 < 100 mmHg 时谨慎起始并复测生命体征。',
        adverseReactions: '常见窦性心动过缓、头晕与疲乏。',
        disclaimer: '合成教学参考，非真实上市产品法定说明书',
      },
    }
    const amlodipine: Medication = {
      ...medication,
      id: 'medication-amlodipine',
      nameEn: 'Amlodipine besylate tablets',
      nameZh: '苯磺酸氨氯地平片',
      dosageForm: '片剂',
      strength: '5 mg',
      packageDescription: '7片/盒',
      unit: '片',
      priceFen: 500,
      allowedCombinationIds: ['medication-metoprolol', 'medication-plain'],
      allowedDoseTexts: ['5 mg'],
      allowedFrequencyCodes: ['QD'],
      allowedCourseDays: [7, 14, 30],
      allowedQuantities: [1, 2],
      defaultCourseDays: 14,
      defaultDoseText: '5 mg',
      defaultFrequencyCode: 'QD',
      defaultQuantity: 2,
      safety: {
        pharmacologyClasses: ['ccb'],
        indicationPrefixes: ['I10', 'I20', 'I25'],
        doseLimits: { unit: 'mg', minimumSingleDose: 2.5, maximumSingleDose: 10, maximumDailyDose: 10 },
        maximumDailyQuantity: 2,
      },
      packageInsert: {
        genericName: '苯磺酸氨氯地平片',
        specificationAndForm: '片剂 · 5 mg · 7片/盒',
        indicationsSummary: '用于高血压及慢性稳定性心绞痛。',
        dosageAndAdministration: '口服，常规每次 5 mg，每日一次（QD），单日最大剂量不超过 10 mg。',
        contraindications: '对二氢吡啶类钙通道阻滞剂过敏或重度低血压禁用。',
        precautions: '老年或肝功能不全患者谨慎加量，注意监测下肢水肿。',
        adverseReactions: '常见踝部水肿、头痛与潮红。',
        disclaimer: '合成教学参考，非真实上市产品法定说明书',
      },
    }
    const plainLocal: Medication = {
      ...medication,
      id: 'medication-plain',
      nameEn: 'Plain synthetic tablet',
      nameZh: '无说明书合成片',
      allowedCombinationIds: ['medication-metoprolol', 'medication-amlodipine'],
    }
    renderPage({
      catalog: [metoprolol, amlodipine, plainLocal],
      detail: {
        ...detail,
        medicationConclusion: {
          draftVersion: 1,
          draft: {
            items: [{
              catalogItemId: amlodipine.id,
              courseDays: 14,
              doseText: '5 mg',
              frequencyCode: 'QD',
              routeCode: 'PO',
              quantity: 14,
            }],
          },
        },
      },
      referenceSearch: {
        data: { items: [referenceProduct], page: 1, pageSize: 20, releaseId: 'synthetic', total: 1 },
        error: null,
        isError: false,
        isFetching: false,
        isPending: false,
        onSearch: vi.fn(),
      },
    })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    expect(document.querySelectorAll('button button')).toHaveLength(0)

    await user.click(dialog.getByRole('button', { name: '选择 琥珀酸美托洛尔缓释片' }))
    const doseInput = dialog.getByRole('textbox', { name: '剂量' }) as HTMLInputElement
    const quantityInput = dialog.getByRole('spinbutton', { name: '数量' }) as HTMLInputElement
    const instructionsInput = dialog.getByRole('textbox', { name: '给药说明' }) as HTMLInputElement
    await user.clear(doseInput)
    await user.type(doseInput, '95 mg')
    await user.clear(quantityInput)
    await user.type(quantityInput, '14')
    await user.type(instructionsInput, '餐后整片吞服')

    const detailsSection = within(dialog.getByRole('region', { name: '用药信息' }))
    await user.click(detailsSection.getByRole('button', { name: '说明书' }))
    const insertDialog = within(await screen.findByRole('dialog', { name: '药品说明书摘要' }))
    expect(insertDialog.getByText('合成教学参考，非真实上市产品法定说明书')).toBeTruthy()
    expect(insertDialog.getByText(/心率 < 50 次\/分/)).toBeTruthy()

    // 遮罩关闭：仅关闭说明书抽屉，保持底层选药弹窗与未加入草稿不丢
    const overlay = document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement | null
    expect(overlay).not.toBeNull()
    await user.click(overlay!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '药品说明书摘要' })).toBeNull())
    expect(screen.getByRole('dialog', { name: '选择药品' })).toBeTruthy()
    expect((dialog.getByRole('textbox', { name: '剂量' }) as HTMLInputElement).value).toBe('95 mg')
    expect((dialog.getByRole('spinbutton', { name: '数量' }) as HTMLInputElement).value).toBe('14')
    expect((dialog.getByRole('textbox', { name: '给药说明' }) as HTMLInputElement).value).toBe('餐后整片吞服')

    const plainCandidateRow = dialog.getByRole('button', { name: '选择 无说明书合成片' }).closest('li')!
    await user.click(within(plainCandidateRow).getByRole('button', { name: '说明书' }))
    const plainSheet = within(await screen.findByRole('dialog', { name: '药品说明书摘要' }))
    expect(plainSheet.getByText('暂无院内说明书摘要')).toBeTruthy()
    await user.click(plainSheet.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '药品说明书摘要' })).toBeNull())
    expect(screen.getByRole('dialog', { name: '选择药品' })).toBeTruthy()
    expect((dialog.getByRole('textbox', { name: '剂量' }) as HTMLInputElement).value).toBe('95 mg')

    await user.click(dialog.getByRole('tab', { name: '国家参考目录' }))
    const refCandidateRow = (await dialog.findByRole('button', { name: /^选择 合成参考药品/ })).closest('li')!
    await user.click(within(refCandidateRow).getByRole('button', { name: '说明书' }))
    expect(within(await screen.findByRole('dialog', { name: '药品说明书摘要' })).getByText('暂无院内说明书摘要')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '药品说明书摘要' })).toBeNull())

    await user.click(dialog.getByRole('tab', { name: '本院药房' }))
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    const pendingInDialog = within(dialog.getByRole('region', { name: '处方待开清单' }))
    const dialogInsertButtons = pendingInDialog.getAllByRole('button', { name: '说明书' })
    await user.click(dialogInsertButtons[dialogInsertButtons.length - 1]!)
    expect(within(await screen.findByRole('dialog', { name: '药品说明书摘要' })).getByText(/单日最大剂量 190 mg/)).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '药品说明书摘要' })).toBeNull())

    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择药品' })).toBeNull())

    const pendingPanel = within(screen.getByRole('region', { name: '待开具处方' }))
    await pendingPanel.findByRole('checkbox', { name: '选择苯磺酸氨氯地平片' })
    const insertButtons = pendingPanel.getAllByRole('button', { name: '说明书' })
    expect(insertButtons).toHaveLength(2)
    await user.click(insertButtons[0]!)
    expect(within(await screen.findByRole('dialog', { name: '药品说明书摘要' })).getByText(/单日最大剂量不超过 10 mg/)).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '药品说明书摘要' })).toBeNull())

    await user.click(insertButtons[1]!)
    expect(within(await screen.findByRole('dialog', { name: '药品说明书摘要' })).getByText(/单日最大剂量 190 mg/)).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '药品说明书摘要' })).toBeNull())
    expect(pendingPanel.getByText('95 mg · 每日一次（QD） · 口服（po） · 14 天 · 14 · 餐后整片吞服')).toBeTruthy()
  })

  it('多途径药品默认预填 defaultRouteCode，仅提供允许的受控给药途径并支持切换', async () => {
    const nitroglycerin: Medication = {
      ...medication,
      allowedCourseDays: [1, 7],
      allowedDoseTexts: ['0.5 mg'],
      allowedFrequencyCodes: ['PRN'],
      allowedQuantities: [1],
      allowedRouteCodes: ['SL', 'PO'],
      defaultCourseDays: 7,
      defaultDoseText: '0.5 mg',
      defaultFrequencyCode: 'PRN',
      defaultQuantity: 1,
      defaultRouteCode: 'SL',
      id: 'medication-nitroglycerin',
      nameEn: 'Nitroglycerin tablets',
      nameZh: '硝酸甘油片',
    }
    const mounted = renderPage({ catalog: [nitroglycerin] })
    const user = userEvent.setup()
    const dialog = await openComposer(user)
    await user.click(dialog.getByRole('button', { name: '选择 硝酸甘油片' }))
    const routeSelect = dialog.getByRole('combobox', { name: '给药途径' })
    expect(within(routeSelect).getByText('舌下含服（sl）')).toBeTruthy()
    await user.click(routeSelect)
    expect(await screen.findByRole('option', { name: '舌下含服（sl）' })).toBeTruthy()
    const oralOption = screen.getByRole('option', { name: '口服（po）' })
    expect(screen.queryByRole('option', { name: /静脉/ })).toBeNull()
    await user.click(oralOption)
    await user.click(dialog.getByRole('button', { name: '加入处方' }))
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByText('0.5 mg · 必要时（PRN） · 口服（po） · 7 天 · 1')).toBeTruthy()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([
      { catalogItemId: 'medication-nitroglycerin', courseDays: 7, doseText: '0.5 mg', frequencyCode: 'PRN', routeCode: 'PO', quantity: 1 },
    ]))
  })

  it('恢复缺少给药途径元数据的旧浏览器参考药品草稿时按剂型与通用名重算允许途径', async () => {
    const scope = JSON.stringify(['scope-legacy-ref', detail.caseId, detail.encounter.id, 'prescription'])
    const legacyInjectableProduct = {
      approvalNumber: '国药准字H20260099',
      brandName: '合成克赛',
      code: 'SYN-LEGACY-IH',
      dosageForm: '注射剂',
      genericName: '依诺肝素钠注射液',
      id: 'reference-legacy-enoxaparin',
      manufacturer: '合成制药有限公司',
      packageDescription: '0.4ml:4000AXaIU*2支/盒',
      sourceLocator: 'synthetic-fixture',
      status: 'active',
      strength: '0.4ml:4000AXaIU',
      system: 'https://example.test/medications',
      version: '1',
    }
    sessionStorage.setItem(
      `clinmesh.outpatient-investigation.prescription:v1:${scope}`,
      JSON.stringify({
        dirty: true,
        items: [{
          catalogItemId: legacyInjectableProduct.id,
          courseDays: 5,
          doseText: '4000 IU',
          frequencyCode: 'QD',
          key: 'legacy-line-1',
          quantity: 2,
          referenceProduct: legacyInjectableProduct,
        }],
        mode: 'prescription',
        version: 1,
      }),
    )
    const mounted = renderPage({
      recommendationScope: 'scope-legacy-ref',
      referenceSearch: {
        data: { items: [], page: 1, pageSize: 20, releaseId: 'synthetic', total: 0 },
        error: null,
        isError: false,
        isFetching: false,
        isPending: false,
        onSearch: vi.fn(),
      },
    })
    const user = userEvent.setup()
    const panel = within(screen.getByRole('region', { name: '待开具处方' }))
    await user.click(panel.getByRole('button', { name: /^编辑药品 依诺肝素钠注射液/ }))
    const dialog = within(screen.getByRole('dialog'))
    const routeSelect = dialog.getByRole('combobox', { name: '给药途径' })
    await user.click(routeSelect)
    const subcutaneousOption = await screen.findByRole('option', { name: '皮下注射（ih）' })
    expect(screen.queryByRole('option', { name: '口服（po）' })).toBeNull()
    await user.click(subcutaneousOption)
    await user.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(panel.getByText('4000 IU · 每日一次（QD） · 皮下注射（ih） · 5 天 · 2')).toBeTruthy()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([
      expect.objectContaining({
        catalogItemId: legacyInjectableProduct.id,
        courseDays: 5,
        doseText: '4000 IU',
        frequencyCode: 'QD',
        quantity: 2,
        routeCode: 'IH',
      }),
    ]))
  })
})
