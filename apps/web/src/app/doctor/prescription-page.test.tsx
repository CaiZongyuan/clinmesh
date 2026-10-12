// @vitest-environment jsdom

import type { ClinicalCatalog, DoctorCaseDetail } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  return { ...render(<PrescriptionPage {...props} />), props }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PrescriptionPage', () => {
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
    await user.click(screen.getByLabelText('剂量 2'))
    await user.click(screen.getByRole('option', { name: '1 g' }))
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
