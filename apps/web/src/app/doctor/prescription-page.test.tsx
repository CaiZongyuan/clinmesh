// @vitest-environment jsdom

import type { ClinicalCatalog, DoctorCaseDetail } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import type { DoctorRecommendationState, DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPageRegistryProvider, useAgentPageRegistration, useRegisterAgentPage } from '../agent-page-context.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { ReferenceCatalogSearches } from './catalog-picker-dialogs.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './prescription-page.tsx'

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
    caseEvidence: [{ id: 'synthetic-case-evidence', kind: 'draft', label: '合成已知资料', text: '合成病例资料，用于测试建议采纳。' }],
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

afterEach(() => {
  cleanup()
  queryClients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PrescriptionPage', () => {
  it('adopts a complete recommendation alongside the currently unsaved medication edits without issuing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const secondMedication: Medication = { ...medication, allowedCombinationIds: [medication.id], id: 'medication-b', nameZh: '合成第二药品' }
    const mounted = renderPage({ catalog: [medication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 }] },
      draftVersion: 1,
    } } })
    const user = userEvent.setup()
    act(() => screen.getByRole('combobox', { name: '剂量' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '1 g' }))
    await user.click(await screen.findByRole('button', { name: '采纳 合成第二药品' }))
    expect(within(screen.getByRole('group', { name: '已选药品' })).getByRole('button', { name: '合成第二药品' })).toBeTruthy()
    expect(within(screen.getByLabelText('疗程 2')).getByText('5 天')).toBeTruthy()
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenLastCalledWith([
      { catalogItemId: medication.id, courseDays: 3, doseText: '1 g', frequencyCode: 'PRN', quantity: 6 },
      { catalogItemId: secondMedication.id, courseDays: 5, doseText: '1 g', frequencyCode: 'BID', quantity: 10 },
    ]))
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
    expect(mounted.props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['issue', 'confirmNoMedication', 'deleteDraft'] as const)('prevents recommendation adoption while %s is pending', async operation => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const actions = createActions()
    actions[operation].pending = true
    renderPage({ actions, catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    expect((await screen.findByRole('button', { name: '采纳 合成第二药品' })).hasAttribute('disabled')).toBe(true)
    expect(actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps missing suggested fields blank in the editor and Agent form until the doctor completes them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([{
      ...recommendation, courseDays: null, doseText: null, frequencyCode: null, quantity: null,
      missingInformation: ['合成病例尚需核对具体用药方案'],
    }]))))
    const secondMedication: Medication = { ...medication, allowedCombinationIds: [medication.id], id: 'medication-b', nameZh: '合成第二药品' }
    const mounted = renderPage({ catalog: [medication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 }] },
      draftVersion: 1,
    } } })
    const adopt = await screen.findByRole('button', { name: '采纳 合成第二药品' })
    vi.useFakeTimers()
    fireEvent.click(adopt)
    for (const name of ['剂量 2', '频次 2', '疗程 2', '数量 2']) {
      expect(within(screen.getByRole('combobox', { name })).getByText('待医生补充')).toBeTruthy()
    }
    expect(mounted.readAgentState()).toEqual({ forms: { prescription: { mode: 'prescription', items: [
      { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 },
      { catalogItemId: secondMedication.id, courseDays: null, doseText: '', frequencyCode: '', quantity: null },
    ] } } })
    expect(screen.getByRole('button', { name: '正式开具处方' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    vi.useRealTimers()
    const user = userEvent.setup()
    for (const { name, option } of [
      { name: '剂量 2', option: '1 g' }, { name: '频次 2', option: 'BID' },
      { name: '疗程 2', option: '5 天' }, { name: '数量 2', option: '10' },
    ]) {
      act(() => screen.getByRole('combobox', { name }).focus())
      await user.keyboard('{Enter}')
      await user.click(await screen.findByRole('option', { name: option }))
    }
    await waitFor(() => expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenLastCalledWith([
      { catalogItemId: medication.id, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 },
      { catalogItemId: secondMedication.id, courseDays: 5, doseText: '1 g', frequencyCode: 'BID', quantity: 10 },
    ]))
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['dose', { allowedDoseTexts: ['500 mg'] }],
    ['frequency', { allowedFrequencyCodes: ['PRN'] }],
    ['course', { allowedCourseDays: [3] }],
    ['quantity', { allowedQuantities: [6] }],
  ] satisfies [string, Partial<Medication>][])('prevents adoption when the current catalog no longer accepts the suggested %s', async (_field, changes) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const mounted = renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    const adopt = await screen.findByRole('button', { name: '采纳 合成第二药品' })
    expect(adopt.hasAttribute('disabled')).toBe(false)
    mounted.rerender(<PrescriptionPage {...mounted.props} catalog={[{
      ...medication, ...changes, id: 'medication-b', nameZh: '合成第二药品',
    }]} />)
    expect(adopt.hasAttribute('disabled')).toBe(true)
    fireEvent.click(adopt)
    expect(screen.queryByRole('group', { name: '已选药品' })).toBeNull()
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'duplicate', 'outward-combination', 'inward-combination'] as const)('rejects a currently %s medication recommendation without changing the draft', async conflict => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const secondMedication: Medication = { ...medication, allowedCombinationIds: conflict === 'inward-combination' ? [] : [medication.id], id: 'medication-b', nameZh: '合成第二药品' }
    const firstMedication: Medication = { ...medication, allowedCombinationIds: conflict === 'outward-combination' ? [] : ['medication-b'] }
    const existingId = conflict === 'duplicate' ? secondMedication.id : firstMedication.id
    const mounted = renderPage({ catalog: conflict === 'unavailable' ? [firstMedication] : [firstMedication, secondMedication], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: existingId, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 }] },
      draftVersion: 1,
    } } })
    const adopt = await screen.findByRole('button', { name: '采纳 合成第二药品' })
    expect(adopt.hasAttribute('disabled')).toBe(true)
    fireEvent.click(adopt)
    expect(within(screen.getByRole('group', { name: '已选药品' })).getAllByRole('button')).toHaveLength(1)
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the eight medication limit for recommendation adoption', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const ids = [...Array.from({ length: 8 }, (_, index) => `medication-limit-${index}`), recommendation.catalogItemId]
    const catalog = ids.map(id => ({ ...medication, id, allowedCombinationIds: ids, nameZh: id === recommendation.catalogItemId ? '合成第二药品' : id }))
    const mounted = renderPage({ catalog, detail: { ...detail, medicationConclusion: {
      draft: { items: ids.slice(0, 8).map(catalogItemId => ({ catalogItemId, courseDays: 3, doseText: '500 mg', frequencyCode: 'PRN', quantity: 6 })) },
      draftVersion: 1,
    } } })
    const adopt = await screen.findByRole('button', { name: '采纳 合成第二药品' })
    expect(adopt.hasAttribute('disabled')).toBe(true)
    fireEvent.click(adopt)
    expect(within(screen.getByRole('group', { name: '已选药品' })).getAllByRole('button')).toHaveLength(8)
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it.each(['signed', 'paid', 'dispensed', 'withdrawn'] as const)('does not generate or adopt suggestions once a %s prescription exists', async status => {
    const network = vi.fn(async () => Response.json(recommendationState([recommendation])))
    vi.stubGlobal('fetch', network)
    renderPage({ detail: { ...detail, medicationConclusion: { draftVersion: 2, prescription: { ...issuedPrescription, status } } } })
    expect(screen.queryByRole('region', { name: '处方建议' })).toBeNull()
    await act(async () => {})
    expect(network).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'read-only', props: { readOnly: true } },
    { name: 'formal no-medication', props: { detail: { ...detail, medicationConclusion: { draftVersion: 2,
      noMedication: { id: 'no-medication-1', version: 1, authoredAt: '2026-10-13T09:00:00+08:00',
        authoredByActorId: 'doctor-1', authoredByPractitionerRoleId: 'doctor-role-1' },
    } } } },
  ])('does not generate or adopt suggestions in a $name state', async ({ props }) => {
    const network = vi.fn(async () => Response.json(recommendationState([recommendation])))
    vi.stubGlobal('fetch', network)
    renderPage(props)
    expect(screen.queryByRole('region', { name: '处方建议' })).toBeNull()
    await act(async () => {})
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps the adopted draft while no-medication mode suspends suggestions and autosave', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recommendationState([recommendation]))))
    const mounted = renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }] })
    const adopt = await screen.findByRole('button', { name: '采纳 合成第二药品' })
    vi.useFakeTimers()
    fireEvent.click(adopt)
    fireEvent.click(screen.getByRole('button', { name: '无需用药' }))
    expect(screen.queryByRole('region', { name: '处方建议' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '开具处方' }))
    expect(within(screen.getByRole('combobox', { name: '剂量' })).getByText('1 g')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).toHaveBeenCalledWith([{
      catalogItemId: 'medication-b', courseDays: 5, doseText: '1 g', frequencyCode: 'BID', quantity: 10,
    }])
    expect(mounted.props.actions.confirmNoMedication.onSubmit).not.toHaveBeenCalled()
  })

  it('cancels an unsaved draft timer when the case becomes read-only', async () => {
    const mounted = renderPage({ detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: '剂量' }), { target: { value: '150 mg' } })
    mounted.rerender(<PrescriptionPage {...mounted.props} readOnly />)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(mounted.props.actions.saveDraft.onSubmit).not.toHaveBeenCalled()
  })

  it('preserves adopted edits when the source revision refreshes and the new suggestion changes', async () => {
    const initial = recommendationState([recommendation])
    let state = initial
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(state)))
    const mounted = renderPage({ catalog: [{ ...medication, id: 'medication-b', nameZh: '合成第二药品' }], recommendationRevision: 'source-1' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '采纳 合成第二药品' }))
    act(() => screen.getByRole('combobox', { name: '剂量' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '500 mg' }))
    state = { ...initial, inputFingerprint: '2'.repeat(64), generation: 2,
      items: [{ ...recommendation, doseText: '1 g', rationale: '更新后的合成建议依据' }],
    }
    mounted.rerender(<PrescriptionPage {...mounted.props} recommendationRevision="source-2" />)
    await screen.findByText('更新后的合成建议依据')
    expect(within(screen.getByRole('combobox', { name: '剂量' })).getByText('500 mg')).toBeTruthy()
    expect(screen.getByRole('button', { name: '采纳 合成第二药品' }).hasAttribute('disabled')).toBe(true)
    expect(within(screen.getByRole('group', { name: '已选药品' })).getAllByRole('button')).toHaveLength(1)
    expect(mounted.props.actions.issue.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps edits made while deletion is pending and autosaves them after the deletion refresh', async () => {
    const user = userEvent.setup()
    const pageActions = createActions()
    const mounted = renderPage({ actions: pageActions, detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: referenceProduct.id, courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10, referenceProduct }] },
      draftVersion: 1,
    } } })
    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    await user.click(within(screen.getByRole('alertdialog', { name: '确认删除处方草稿' })).getByRole('button', { name: '确认删除' }))
    expect(pageActions.deleteDraft.onSubmit).toHaveBeenCalledOnce()

    vi.useFakeTimers()
    const pendingActions = { ...pageActions, deleteDraft: { ...pageActions.deleteDraft, pending: true } }
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={pendingActions} />)
    fireEvent.change(screen.getByLabelText('剂量'), { target: { value: '150 mg' } })
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
    await userEvent.setup().click(screen.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))
    mounted.rerender(<PrescriptionPage {...mounted.props} actions={{ ...pageActions, deleteDraft: { ...pageActions.deleteDraft, data: { ...deletion } } }} />)
    expect(screen.getByRole('combobox', { name: '剂量' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '合成对乙酰氨基酚' })).toBeTruthy()
  })
  it('adds medication from the inline catalog and opens its only dosage editor', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByLabelText('搜索药品目录')).toBeTruthy()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    await user.click(screen.getByRole('button', { name: '选择 合成对乙酰氨基酚' }))

    const editor = screen.getByRole('region', { name: '药品详情' })
    expect(within(editor).getByLabelText('剂量')).toBeTruthy()
    expect(within(editor).getByLabelText('频次')).toBeTruthy()
    expect(within(editor).getByLabelText('疗程')).toBeTruthy()
    expect(within(editor).getByLabelText('数量')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
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

    const editor = screen.getByRole('region', { name: '药品详情' })
    expect(within(editor).getByText('12粒/盒')).toBeTruthy()
    await user.clear(within(editor).getByLabelText('剂量'))
    await user.type(within(editor).getByLabelText('剂量'), '150 mg')
    expect(within(editor).getByDisplayValue('150 mg')).toBeTruthy()
    expect(screen.getByRole('button', { name: '正式开具处方' }).hasAttribute('disabled')).toBe(true)
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

    fireEvent.change(screen.getByLabelText('疗程'), { target: { value: '31' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '1001' } })
    expect(screen.getByLabelText('疗程').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('数量').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: '正式开具处方' }).hasAttribute('disabled')).toBe(true)
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
    expect(screen.getByRole('button', { name: '选择 合成药品 9' }).hasAttribute('disabled')).toBe(true)
    unmount()

    renderPage({ catalog: [medication, { ...medication, id: 'incompatible', nameZh: '合成不兼容药品', allowedCombinationIds: [] }], detail: { ...detail, medicationConclusion: {
      draft: { items: [{ catalogItemId: medication.id, doseText: '500 mg', frequencyCode: 'PRN', courseDays: 3, quantity: 6 }] },
      draftVersion: 1,
    } } })
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
    expect(screen.queryByLabelText('搜索药品目录')).toBeNull()
    expect(screen.queryByLabelText('剂量')).toBeNull()
    for (const name of ['正式开具处方', '删除处方草稿', '撤回处方', '确认无需用药']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
})
