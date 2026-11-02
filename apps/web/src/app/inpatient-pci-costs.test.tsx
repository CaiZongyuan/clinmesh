// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { inpatientCostsSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { afterEach, expect, it } from 'vitest'
import { InpatientPciCosts } from './inpatient-pci-costs.tsx'

const grouping = { status: 'grouped', drgCode: 'FM59', mdcCode: 'F', adrgCode: 'FM5', reason: null, steps: [] }
const costs = inpatientCostsSchema.parse({ fingerprint: 'a'.repeat(64),
  components: { formalChargesFen: 200000, pendingOrdersFen: 15000, remainingMaterialsFen: 100000, plannedSurgeryFen: 30000, projectedTotalFen: 345000 },
  currentGrouping: grouping, projectedGrouping: { ...grouping, drgCode: 'FM39' },
  currentPaymentReference: { parameterSetId: 'clinmesh-synthetic-angiography-payment', parameterVersion: '2026-11-02.r1', drgCode: 'FM59', referenceFen: 400000, note: '合成医院支付参数，不代表地区点值。' },
  projectedPaymentReference: { parameterSetId: 'clinmesh-synthetic-pci-payment', parameterVersion: '2026-11-02.r1', drgCode: 'FM39', referenceFen: 600000, note: '合成医院支付参数，不代表地区点值。' },
  currentDifferenceFen: 55000, projectedDifferenceFen: 255000, paymentStatus: 'available', paymentMessage: '医院支付参考参数可用。', exceptionAlert: 'below-threshold',
})
afterEach(cleanup)

it('按确定性金额展示费用组成、正式与推演分组、各支付参考和差额', () => {
  render(<InpatientPciCosts costs={costs} locale="zh-CN" />)
  const panel = screen.getByRole('region', { name: '住院费用与医保参考' })
  for (const [label, amount] of [['已发生正式收费（含造影）', '¥2,000.00'], ['待执行医嘱', '¥150.00'], ['剩余计划耗材', '¥1,000.00'], ['计划手术费', '¥300.00'], ['预计住院总费用', '¥3,450.00']]) {
    expect(within(panel).getByText(label!).parentElement?.textContent).toContain(amount)
  }
  const current = within(panel).getByRole('region', { name: '当前正式分组' })
  expect(current.textContent).toContain('FM59')
  expect(current.textContent).toContain('¥4,000.00')
  expect(current.textContent).toContain('¥550.00')
  const projected = within(panel).getByRole('region', { name: '计划实施推演分组' })
  expect(projected.textContent).toContain('FM39')
  expect(projected.textContent).toContain('¥6,000.00')
  expect(projected.textContent).toContain('¥2,550.00')
  expect(within(panel).getAllByText(/合成医院支付参数/).length).toBeGreaterThan(0)
})

it.each([
  ['rules-unavailable', '医院尚未启用医保分组'],
  ['grouping-incomplete', '诊断或手术记录不全，暂时无法分组'],
  ['reference-missing', '已分到 FM59 组，但暂无支付参考，金额暂不可估'],
] as const)('医保状态为 %s 时保留完整费用并显示具体自然语言原因', (paymentStatus, paymentMessage) => {
  render(<InpatientPciCosts costs={{ ...costs, paymentStatus, paymentMessage, currentPaymentReference: null, projectedPaymentReference: null, currentDifferenceFen: null, projectedDifferenceFen: null }} locale="zh-CN" />)
  expect(screen.getByText('预计住院总费用').parentElement?.textContent).toContain('¥3,450.00')
  expect(screen.getByText(paymentMessage)).toBeDefined()
  expect(screen.getAllByText('金额暂不可估')).toHaveLength(2)
  expect(screen.queryByText(paymentStatus)).toBeNull()
})

it('特例只呈现服务端严格阈值结论，不按计划费用自行预警或展示阈值距离', () => {
  const { rerender } = render(<InpatientPciCosts costs={{ ...costs, components: { ...costs.components, formalChargesFen: 1200000, projectedTotalFen: 9000000 } }} locale="zh-CN" />)
  expect(screen.queryByText('特例提醒')).toBeNull()
  rerender(<InpatientPciCosts costs={{ ...costs, exceptionAlert: 'unknown' }} locale="zh-CN" />)
  expect(screen.queryByText('特例提醒')).toBeNull()
  rerender(<InpatientPciCosts costs={{ ...costs, exceptionAlert: 'triggered' }} locale="zh-CN" />)
  expect(screen.getByText('特例提醒')).toBeDefined()
  expect(screen.queryByText(/距离阈值|距特例|还差.*触发/)).toBeNull()
})

it('尚无费用依据时不虚构零金额，英语金额与标签沿既有格式', () => {
  const { rerender, container } = render(<InpatientPciCosts costs={null} locale="zh-CN" />)
  expect(container.textContent).toBe('')
  rerender(<InpatientPciCosts costs={costs} locale="en-US" />)
  expect(screen.getByText('Projected admission total').parentElement?.textContent).toContain('3,450.00')
  expect(screen.getByRole('region', { name: 'Current formal group' }).textContent).toContain('FM59')
})
