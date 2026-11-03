// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { inpatientPciSelectionDraftSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { InpatientPciDraftFields, type PciSelectionDraft } from './inpatient-pci-draft-fields.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const parametersSchema = inpatientPciSelectionDraftSchema.shape.parameters
const draft = inpatientPciSelectionDraftSchema.parse({ requestId: 'pci-plan', version: 1, reportId: 'report-1', reportVersion: 1, edited: false, confirmedSelectionVersion: null,
  parameters: { requestId: 'pci-plan', treatmentPlan: '合成 PCI 方案', targetSite: 'LAD 中段', approvedMaterialIds: [],
    measurements: [
      { kind: 'proximal-reference-diameter', object: 'reference-lumen', value: 3 },
      { kind: 'lesion-length', object: 'lesion', value: 12 },
      { kind: 'distal-reference-diameter', object: 'reference-lumen', value: 3 },
    ].map(item => ({ ...item, site: 'LAD 中段', unit: 'mm', method: '合成定量造影', source: { reference: 'DiagnosticReport/report-1', version: '1', note: '合成报告原值', synthetic: true } })),
    plannedQuantities: [{ category: 'stent', quantity: 1, basis: '合成单病变方案' }, { category: 'guidewire', quantity: 1, basis: '合成导丝方案' }],
  } })
afterEach(cleanup)

function mount(locale: WorkspaceLocale = 'zh-CN', initial = draft.parameters) {
  const saved: PciSelectionDraft['parameters'][] = []
  function Editor() {
    const [value, setValue] = useState(initial)
    const parsed = parametersSchema.safeParse(value)
    return <><InpatientPciDraftFields draft={draft} value={value} report={undefined} locale={locale} disabled={false}
      issues={parsed.success ? [] : parsed.error.issues} onChange={setValue} />
      <button disabled={!parsed.success} onClick={() => { if (parsed.success) saved.push(parsed.data) }}>保存选型草稿</button></>
  }
  render(<Editor />)
  return saved
}

function expectError(input: HTMLElement, message: string) {
  expect(input.getAttribute('aria-invalid')).toBe('true')
  const field = input.closest<HTMLElement>('[data-slot="field"]')!
  expect(field.dataset.invalid).toBe('true')
  const error = within(field).getByRole('alert')
  expect(error.dataset.slot).toBe('field-error')
  expect(error.textContent).toBe(message)
  expect(error.id).not.toBe('')
  expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
  expect(screen.getByRole('button', { name: '保存选型草稿' }).hasAttribute('disabled')).toBe(true)
}

function expectClear(input: HTMLElement) {
  expect(input.getAttribute('aria-invalid')).not.toBe('true')
  const field = input.closest<HTMLElement>('[data-slot="field"]')!
  expect(field.dataset.invalid).not.toBe('true')
  expect(within(field).queryByRole('alert')).toBeNull()
}

it('测量为 0 时关联字段错误，合法小数清错，未知数值、单位和靶部位仍可留空保存', () => {
  const saved = mount()
  const length = screen.getByRole('spinbutton', { name: '病变长度 数值' })
  fireEvent.change(length, { target: { value: '0' } })
  expectError(length, '请输入大于 0 且不超过 1000 的有限数值，未知可留空。')
  fireEvent.change(length, { target: { value: '12.5' } })
  expectClear(length)
  expect(screen.getByRole('button', { name: '保存选型草稿' }).hasAttribute('disabled')).toBe(false)
  fireEvent.change(length, { target: { value: '' } })
  const unit = screen.getByRole('textbox', { name: '病变长度 单位' }), site = screen.getByRole('textbox', { name: '靶病变部位' })
  fireEvent.change(unit, { target: { value: '' } })
  fireEvent.change(site, { target: { value: '' } })
  expectClear(length); expectClear(unit); expectClear(site)
  fireEvent.click(screen.getByRole('button', { name: '保存选型草稿' }))
  expect(saved).toHaveLength(1)
  expect(saved[0]?.targetSite).toBeNull()
  expect(saved[0]?.measurements.find(item => item.kind === 'lesion-length')).toMatchObject({ value: null, unit: null })
})

it.each([
  ['治疗方向与术式', '请填写治疗方向与术式，最多 2000 字。'],
  ['病变长度 部位', '请填写测量部位，最多 2000 字。'],
  ['病变长度 方法', '请填写测量方法，最多 2000 字。'],
  ['支架 数量依据', '请填写数量依据，最多 2000 字。'],
])('清空%s时在该字段给出具体错误，恢复内容后清除', (label, message) => {
  mount()
  const input = screen.getByRole('textbox', { name: label }), original = input.getAttribute('value')
  fireEvent.change(input, { target: { value: '' } })
  expectError(input, message)
  fireEvent.change(input, { target: { value: original } })
  expectClear(input)
  expect(screen.getByRole('button', { name: '保存选型草稿' }).hasAttribute('disabled')).toBe(false)
})

it('schema 的数组下标随编辑重排后，错误仍对应正确测量及数量类别', () => {
  mount()
  const proximal = screen.getByRole('spinbutton', { name: '近端参考直径 数值' })
  const lengthSite = screen.getByRole('textbox', { name: '病变长度 部位' })
  fireEvent.change(proximal, { target: { value: '0' } })
  fireEvent.change(lengthSite, { target: { value: '' } })
  expectError(proximal, '请输入大于 0 且不超过 1000 的有限数值，未知可留空。')
  expectError(lengthSite, '请填写测量部位，最多 2000 字。')
  expectClear(screen.getByRole('spinbutton', { name: '病变长度 数值' }))
  expectClear(screen.getByRole('spinbutton', { name: '远端参考直径 数值' }))
  const wire = screen.getByRole('spinbutton', { name: '导丝 预计数量' }), stent = screen.getByRole('spinbutton', { name: '支架 预计数量' })
  fireEvent.change(wire, { target: { value: '0' } })
  fireEvent.change(stent, { target: { value: '1.5' } })
  expectError(wire, '请输入 1 至 1000 的整数，未知可留空。')
  expectError(stent, '请输入 1 至 1000 的整数，未知可留空。')
  fireEvent.change(wire, { target: { value: '1' } })
  expectClear(wire)
  expectError(stent, '请输入 1 至 1000 的整数，未知可留空。')
})

it.each([0, -1, 1.5, 1001])('数量 %s 不符合原 schema 时说明整数范围，未知数量仍可保存', quantity => {
  const saved = mount(), input = screen.getByRole('spinbutton', { name: '支架 预计数量' })
  fireEvent.change(input, { target: { value: String(quantity) } })
  expectError(input, '请输入 1 至 1000 的整数，未知可留空。')
  fireEvent.change(input, { target: { value: '' } })
  expectClear(input)
  fireEvent.click(screen.getByRole('button', { name: '保存选型草稿' }))
  expect(saved[0]?.plannedQuantities.find(item => item.category === 'stent')?.quantity).toBeNull()
})

it.each([1001, Infinity])('测量 %s 沿原 schema 的上限与有限值规则显示自然语言', value => {
  mount('zh-CN', { ...draft.parameters, measurements: draft.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value } : item) })
  expectError(screen.getByRole('spinbutton', { name: '病变长度 数值' }), '请输入大于 0 且不超过 1000 的有限数值，未知可留空。')
})

it('英语界面使用当前语言的字段错误，不展示 Zod 内部消息或 code', () => {
  mount('en-US')
  const treatment = screen.getByRole('textbox', { name: 'Treatment direction and procedure' })
  fireEvent.change(treatment, { target: { value: '' } })
  expectError(treatment, 'Enter the treatment direction and procedure (up to 2,000 characters).')
  const length = screen.getByRole('spinbutton', { name: 'Lesion length value' })
  fireEvent.change(length, { target: { value: '0' } })
  expectError(length, 'Enter a finite number greater than 0 and no more than 1,000, or leave it empty if unknown.')
  expect(screen.queryByText(/Too small|Invalid input|too_small|invalid_type/)).toBeNull()
})

it.each([
  ['病变长度 单位', '请填写不超过 2000 字的测量单位，未知可留空。'],
  ['靶病变部位', '请填写不超过 2000 字的靶病变部位，未知可留空。'],
])('仅空格的%s显示错误，清空为未知后仍允许保存', (label, message) => {
  mount()
  const input = screen.getByRole('textbox', { name: label })
  fireEvent.change(input, { target: { value: '   ' } })
  expectError(input, message)
  fireEvent.change(input, { target: { value: '' } })
  expectClear(input)
  expect(screen.getByRole('button', { name: '保存选型草稿' }).hasAttribute('disabled')).toBe(false)
})
