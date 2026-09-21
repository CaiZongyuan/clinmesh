// @vitest-environment jsdom
import { cleanup, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { DiagnosisCatalogDialog, LaboratoryCatalogDialog, MedicationCatalogDialog } from './catalog-picker-dialogs.tsx'

const product: ReferenceMedicationProduct = {
  brandName: null, id: 'product-1', code: 'SYN-1', genericName: '合成测试片',
  dosageForm: '片剂', strength: '10 mg', manufacturer: '合成药厂',
  approvalNumber: '合成批准号', packageDescription: '10片/盒', status: 'active',
  system: 'urn:synthetic:medication', version: '1', sourceLocator: 'synthetic:test',
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
    await user.click(within(dialog).getByRole('combobox', { name: '包装 合成测试片 合成药厂' }))
    await user.click(screen.getByRole('option', { name: '20片/盒' }))
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
    await user.click(picker)
    expect(screen.getByRole('option', { name: /10片\/盒/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: /30片\/盒/ }).getAttribute('aria-disabled')).toBe('true')
    await user.click(screen.getByRole('option', { name: '40片/盒' }))
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
