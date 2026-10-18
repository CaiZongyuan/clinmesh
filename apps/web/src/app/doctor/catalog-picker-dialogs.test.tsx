// @vitest-environment jsdom
import { act, cleanup, isInaccessible, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaseLaboratoryCatalogSearch } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { DiagnosisCatalogDialog, DiagnosisCatalogPicker, LaboratoryCatalogDialog, LaboratoryCatalogPicker, MedicationCatalogDialog, MedicationCatalogPicker } from './catalog-picker-dialogs.tsx'

const product: ReferenceMedicationProduct = {
  brandName: null, id: 'product-1', code: 'SYN-1', genericName: '合成测试片',
  dosageForm: '片剂', strength: '10 mg', manufacturer: '合成药厂',
  approvalNumber: '合成批准号', packageDescription: '10片/盒', status: 'active',
  system: 'urn:synthetic:medication', version: '1', sourceLocator: 'synthetic:test',
}
const service: CaseLaboratoryCatalogSearch['items'][number] = {
  allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: [], doctorOrderable: true,
  executingDepartmentId: 'laboratory', id: 'synthetic-laboratory-service', localCode: 'SYN-LAB',
  nameEn: 'Synthetic laboratory test', nameZh: '合成检验项目', priceFen: 2500,
  referenceConcept: { id: 'synthetic-reference', code: 'SYN-1', display: '合成检验项目',
    system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test' },
  referenceReleaseId: 'synthetic-release', reportDefinition: {
    conclusionTemplate: '合成检验结果。', results: [{
      referenceConcept: { id: 'synthetic-reference', code: 'SYN-1', display: '合成指标',
        system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test' },
      alternateCodings: [], referenceRange: { low: 0, high: 10, text: '0–10' },
      unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, valueType: 'quantity',
    }],
  }, specimen: { code: 'blood', display: '静脉血' }, serviceKind: 'laboratory', tatMinutes: 180, version: 1,
}
function mount(items: ReferenceMedicationProduct[], excludedIds = new Set<string>()) {
  const onSearch = vi.fn()
  const onSelect = vi.fn()
  render(<MedicationCatalogDialog
    excludedIds={excludedIds} localCatalog={[]} locale="zh-CN" onSelect={onSelect}
    search={{ data: { items, page: 1, pageSize: 20, total: items.length, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch }}
  />)
  return { onSearch, onSelect }
}
afterEach(cleanup)
describe('medication catalog picker', () => {
  it('collapses after selecting an actual package and preserves that package when reopened', async () => {
    const onSelect = vi.fn()
    render(<MedicationCatalogPicker collapsible excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={onSelect}
      search={{ data: { items: [product, { ...product, id: 'product-2', packageDescription: '20片/盒' }], page: 1, pageSize: 20, total: 2, releaseId: 'synthetic' },
        error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }} />)
    const user = userEvent.setup()
    expect(screen.getByRole('textbox', { name: '搜索药品目录' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '包装 合成测试片 合成药厂' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开目录' }))
    act(() => screen.getByRole('combobox', { name: '包装 合成测试片 合成药厂' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '20片/盒' }))
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /选择 合成测试片 10 mg 20片\/盒/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'reference', product: expect.objectContaining({ id: 'product-2' }) })
    expect(screen.queryByRole('combobox', { name: '包装 合成测试片 合成药厂' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开目录' }))
    expect(screen.getByRole('combobox', { name: '包装 合成测试片 合成药厂' }).textContent).toContain('20片/盒')
  })
  it('waits for an explicit inline choice after changing a package in an already added product group', async () => {
    const onSelect = vi.fn()
    render(<MedicationCatalogPicker excludedIds={new Set([product.id])} localCatalog={[]} locale="zh-CN" onSelect={onSelect} selectedId={product.id}
      search={{ data: { items: [product, { ...product, id: 'product-2', packageDescription: '20片/盒' }, { ...product, id: 'product-3', packageDescription: '30片/盒' }],
        page: 1, pageSize: 20, total: 3, releaseId: 'synthetic' }, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }} />)
    const user = userEvent.setup()
    act(() => screen.getByRole('combobox', { name: '包装 合成测试片 合成药厂' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '30片/盒' }))
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /选择 合成测试片 10 mg 30片\/盒/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'reference', product: expect.objectContaining({ id: 'product-3' }) })
  })
  it('selects a real package inline without selecting the first product on mount', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<MedicationCatalogPicker excludedIds={new Set(['product-3'])} localCatalog={[]} locale="zh-CN" onSelect={onSelect}
      search={{ data: { items: [product, { ...product, id: 'product-2', packageDescription: '20片/盒' },
        { ...product, id: 'product-3', packageDescription: '30片/盒' }, { ...product, id: 'product-4', status: 'inactive', packageDescription: '40片/盒' }],
        page: 1, pageSize: 20, total: 4, releaseId: 'synthetic' }, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }} />)
    expect(onSelect).not.toHaveBeenCalled()
    act(() => screen.getByRole('combobox', { name: '包装 合成测试片 合成药厂' }).focus())
    await user.keyboard('{Enter}')
    const selectedPackage = await screen.findByRole('option', { name: '20片/盒' })
    expect(screen.getByRole('option', { name: /30片\/盒/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: /40片\/盒/ }).getAttribute('aria-disabled')).toBe('true')
    await user.click(selectedPackage)
    await user.click(screen.getByRole('button', { name: /选择 合成测试片 10 mg 20片\/盒/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'reference', product: expect.objectContaining({ id: 'product-2' }) })
  })
  it('deselects a selected product without closing and preserves package changes', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount([product, { ...product, id: 'product-2', packageDescription: '20片/盒' }])
    await user.click(screen.getByRole('button', { name: '添加药品' }))
    const dialog = screen.getByRole('dialog', { name: '选择药品' })
    const confirm = within(dialog).getByRole('button', { name: '加入处方' })
    const select = () => within(dialog).getByRole('button', { name: /^选择 合成测试片/ })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    await user.click(select())
    expect(confirm.hasAttribute('disabled')).toBe(false)
    await user.click(select())
    expect(confirm.hasAttribute('disabled')).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    await user.dblClick(select())
    expect(screen.getByRole('dialog', { name: '选择药品' })).toBe(dialog)
    expect(confirm.hasAttribute('disabled')).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(select())
    act(() => within(dialog).getByRole('combobox', { name: '包装 合成测试片 合成药厂' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '20片/盒' }))
    expect(confirm.hasAttribute('disabled')).toBe(false)
    await user.click(select())
    expect(confirm.hasAttribute('disabled')).toBe(true)
    await user.click(select())
    await user.click(confirm)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'reference', product: expect.objectContaining({ id: 'product-2' }) })
  })

  it('keeps packaging in one row and disables inactive and already selected packages', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount([
      { ...product, status: 'inactive' },
      { ...product, id: 'product-2', packageDescription: '20片/盒' },
      { ...product, id: 'product-3', packageDescription: '30片/盒' },
      { ...product, id: 'product-4', packageDescription: '40片/盒' },
      { ...product, id: 'product-5', manufacturer: '停用合成药厂', status: 'inactive' },
    ], new Set(['product-3']))
    await user.click(screen.getByRole('button', { name: '添加药品' }))
    const dialog = screen.getByRole('dialog', { name: '选择药品' })
    expect(within(dialog).getAllByRole('row')).toHaveLength(3)
    const picker = within(dialog).getByRole('combobox', { name: '包装 合成测试片 合成药厂' })
    expect(picker.textContent).toContain('20片/盒')
    act(() => picker.focus())
    await user.keyboard('{Enter}')
    const selectedPackage = await screen.findByRole('option', { name: '40片/盒' })
    expect(screen.getByRole('option', { name: /10片\/盒/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: /30片\/盒/ }).getAttribute('aria-disabled')).toBe('true')
    await user.click(selectedPackage)
    await user.click(within(dialog).getByRole('button', { name: /选择 合成测试片 10 mg 40片\/盒 合成药厂/ }))
    await user.click(within(dialog).getByRole('button', { name: '加入处方' }))
    expect(onSelect).toHaveBeenCalledWith({ kind: 'reference', product: expect.objectContaining({ id: 'product-4' }) })
  })
  it('debounces typing and cancels pending searches when closed', async () => {
    const user = userEvent.setup()
    const { onSearch } = mount([product])
    await user.click(screen.getByRole('button', { name: '添加药品' }))
    onSearch.mockClear()
    const input = screen.getByLabelText('搜索药品目录')
    await user.type(input, '合成 药厂')
    expect(onSearch).not.toHaveBeenCalled()
    await waitFor(() => expect(onSearch).toHaveBeenCalledExactlyOnceWith('合成 药厂', 1))
    await user.type(input, '新')
    await user.click(screen.getByRole('button', { name: '取消' }))
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(onSearch).toHaveBeenCalledTimes(1)
  })
})

describe('diagnosis and laboratory catalog search', () => {
  it.each(['diagnosis', 'medication', 'laboratory'])('collapses the %s directory on entering the ordered stage while keeping its query', async kind => {
    const search = { data: { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' }, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }
    const picker = (collapsible: boolean) => kind === 'diagnosis'
      ? <DiagnosisCatalogPicker collapsible={collapsible} excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()} search={search} />
      : kind === 'medication'
        ? <MedicationCatalogPicker collapsible={collapsible} excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()} search={search} />
        : <LaboratoryCatalogPicker collapsible={collapsible} locale="zh-CN" onSelect={vi.fn()} search={search} />
    const view = render(picker(false))
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), '合成')
    await user.click(screen.getByRole('button', { name: /执行.*目录搜索/ }))
    expect(screen.getByText('没有匹配记录')).toBeTruthy()
    view.rerender(picker(true))
    expect(screen.getByDisplayValue('合成')).toBeTruthy()
    expect(isInaccessible(screen.getByText('没有匹配记录'))).toBe(true)
    expect(screen.getByRole('button', { name: '展开目录' }).getAttribute('aria-expanded')).toBe('false')
  })
  it('keeps a collapsed laboratory search and pagination after a selection', async () => {
    const onSearch = vi.fn()
    const onSelect = vi.fn()
    render(<LaboratoryCatalogPicker collapsible locale="zh-CN" onSelect={onSelect}
      search={{ data: { items: [service], page: 1, pageSize: 20, total: 21 }, error: null, isError: false, isFetching: false, isPending: false, onSearch }} />)
    const user = userEvent.setup()
    const search = screen.getByRole('textbox', { name: '搜索检验目录' })
    expect(screen.queryByRole('button', { name: '选择 合成检验项目 SYN-1' })).toBeNull()
    await user.type(search, '合成')
    await user.click(screen.getByRole('button', { name: '执行检验目录搜索' }))
    await user.click(screen.getByRole('button', { name: '选择 合成检验项目 SYN-1' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ catalogItemId: service.id, laboratoryService: service }))
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull()
    expect(search.getAttribute('value')).toBe('合成')
    await user.click(screen.getByRole('button', { name: '展开目录' }))
    await user.click(screen.getByRole('button', { name: '下一页' }))
    expect(onSearch).toHaveBeenLastCalledWith('合成', 2)
  })
  it('keeps diagnosis search visible while its collapsible directory opens on focus and closes after selection', async () => {
    const onSelect = vi.fn()
    render(<DiagnosisCatalogPicker collapsible excludedIds={new Set()} localCatalog={[
      { id: 'diagnosis-synthetic', code: 'SYN-1', nameZh: '合成诊断', nameEn: 'Synthetic diagnosis', system: 'synthetic', version: 1 },
    ]} locale="zh-CN" onSelect={onSelect}
      search={{ data: { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' }, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }} />)
    const user = userEvent.setup()
    const search = screen.getByRole('textbox', { name: '搜索疾病目录' })
    expect(screen.queryByRole('button', { name: '选择 合成诊断 SYN-1' })).toBeNull()
    expect(screen.getByRole('button', { name: '展开目录' }).getAttribute('aria-expanded')).toBe('false')
    await user.click(search)
    await user.click(screen.getByRole('button', { name: '选择 合成诊断 SYN-1' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ catalogItemId: 'diagnosis-synthetic', code: 'SYN-1', display: '合成诊断' })
    expect(screen.queryByRole('button', { name: '选择 合成诊断 SYN-1' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '搜索疾病目录' })).toBe(search)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开目录' }))
    await user.click(screen.getByRole('button', { name: '展开目录' }))
    expect(screen.getByRole('button', { name: '收起目录' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '选择 合成诊断 SYN-1' })).toBeTruthy()
  })
  it.each(['diagnosis', 'medication'])('restores the current %s search when the inline directory becomes active again', async kind => {
    const onSearch = vi.fn()
    const search = { data: { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' }, error: null, isError: false, isFetching: false, isPending: false, onSearch }
    const picker = (active: boolean) => kind === 'diagnosis'
      ? <DiagnosisCatalogPicker active={active} excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()} search={search} />
      : <MedicationCatalogPicker active={active} excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()} search={search} />
    const mounted = render(picker(true))
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(kind === 'diagnosis' ? '搜索疾病目录' : '搜索药品目录'), '合成')
    await user.click(screen.getByRole('button', { name: kind === 'diagnosis' ? '执行疾病目录搜索' : '执行药品目录搜索' }))
    expect(onSearch).toHaveBeenLastCalledWith('合成', 1)
    mounted.rerender(picker(false))
    onSearch.mockClear()
    mounted.rerender(picker(true))
    expect(onSearch).toHaveBeenLastCalledWith('合成', 1)
  })
  it('allows retrying a failed inline diagnosis directory even when there are no local fallback items', async () => {
    const onSearch = vi.fn()
    render(<DiagnosisCatalogPicker excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()}
      search={{ data: undefined, error: new Error('Synthetic catalog failure'), isError: true, isFetching: false, isPending: false, onSearch }} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '重试目录' }))
    expect(onSearch).toHaveBeenCalledTimes(2)
    expect(onSearch).toHaveBeenLastCalledWith('', 1)
  })
  it('keeps inline diagnosis entries unavailable while a new directory page is fetching', () => {
    const onSelect = vi.fn()
    render(<DiagnosisCatalogPicker excludedIds={new Set()} localCatalog={[{ id: 'diagnosis-synthetic', code: 'SYN-1', nameZh: '合成诊断', nameEn: 'Synthetic diagnosis', system: 'synthetic', version: 1 }]} locale="zh-CN" onSelect={onSelect}
      search={{ data: { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' }, error: null, isError: false, isFetching: true, isPending: false, onSearch: vi.fn() }} />)
    expect(screen.getByRole('button', { name: '选择 合成诊断 SYN-1' }).hasAttribute('disabled')).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('announces diagnosis directory loading before enabling selection', async () => {
    const user = userEvent.setup()
    render(<DiagnosisCatalogDialog excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()}
      search={{ data: undefined, error: null, isError: false, isFetching: true, isPending: true, onSearch: vi.fn() }} />)
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    expect(screen.getByRole('status', { name: '正在加载疾病目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '加入诊断' }).hasAttribute('disabled')).toBe(true)
  })
  it('announces inline laboratory directory loading without displaying selectable entries', () => {
    const onSelect = vi.fn()
    render(<LaboratoryCatalogPicker locale="zh-CN" onSelect={onSelect}
      search={{ data: undefined, error: null, isError: false, isFetching: true, isPending: true, onSearch: vi.fn() }} />)
    expect(screen.getByRole('status', { name: '正在加载检验目录' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('switches and clears a reference diagnosis while keeping excluded entries disabled', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<DiagnosisCatalogDialog excludedIds={new Set(['diag-3'])} localCatalog={[]} locale="zh-CN" onSelect={onSelect}
      search={{ data: { items: [1, 2, 3].map(id => ({
        id: `diag-${id}`, code: `SYN-${id}`, display: `合成诊断${id}`, domain: 'diagnosis',
        sourceLocator: 'synthetic:test', system: 'https://clinmesh.example.com/icd-10', version: '1', status: 'active',
      })), page: 1, pageSize: 20, total: 3, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }} />)
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    const first = screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' })
    const second = screen.getByRole('button', { name: '选择 合成诊断2 SYN-2' })
    const excluded = screen.getByRole('button', { name: '选择 合成诊断3 SYN-3' })
    const confirm = screen.getByRole('button', { name: '加入诊断' })
    expect(excluded.hasAttribute('disabled')).toBe(true)
    await user.click(first)
    await user.click(second)
    expect(first.getAttribute('aria-pressed')).toBe('false')
    expect(second.getAttribute('aria-pressed')).toBe('true')
    second.focus()
    await user.keyboard(' ')
    expect(second.getAttribute('aria-pressed')).toBe('false')
    expect(confirm.hasAttribute('disabled')).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(first)
    await user.click(confirm)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ catalogItemId: 'diag-1' }))
  })

  it.each(['diagnosis', 'laboratory'])('debounces %s input without a submit click', async kind => {
    const user = userEvent.setup()
    const onSearch = vi.fn()
    const search = { data: { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch }
    if (kind === 'diagnosis') {
      render(<DiagnosisCatalogDialog excludedIds={new Set()} localCatalog={[]} locale="zh-CN" onSelect={vi.fn()} search={search} />)
    } else {
      render(<LaboratoryCatalogDialog locale="zh-CN" onSelect={vi.fn()} search={search} />)
    }
    await user.click(screen.getByRole('button', { name: kind === 'diagnosis' ? '添加诊断' : '选择检验项目' }))
    onSearch.mockClear()
    await user.type(screen.getByLabelText(kind === 'diagnosis' ? '搜索疾病目录' : '搜索检验目录'), '合成 项目')
    expect(onSearch).not.toHaveBeenCalled()
    await waitFor(() => expect(onSearch).toHaveBeenCalledExactlyOnceWith('合成 项目', 1))
  })
})
