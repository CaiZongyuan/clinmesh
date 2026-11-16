// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { inpatientCostsSchema, inpatientDrgSimulationSchema, type InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { DrgProgressBar } from './inpatient-drg-progress.tsx'

const grouped: InpatientDrgSimulation['grouping']['formal'] = { status: 'grouped', drgCode: 'FR59', mdcCode: 'F', adrgCode: 'FR5', reason: null, steps: [] }
const simulation = inpatientDrgSimulationSchema.parse({
  admissionId: 'admission-1', evaluatedAt: '2026-11-13T10:00:00+08:00', fingerprint: 'a'.repeat(64), rulesId: 'synthetic-rules', rulesVersion: '1',
  formal: { chargesFen: 150000, items: [] }, committed: { items: [] }, reserved: { items: [] }, draft: { items: [], missing: [] },
  coverage: { coveredFen: 150000, estimatedTotalFen: 150000, coveredRatioBp: 10000, note: '合成费用' },
  grouping: { formal: grouped, projected: null, note: '合成分组' },
  paymentReference: { parameterSetId: 'synthetic-reference', parameterVersion: '1', drgCode: 'FR59', referenceFen: 400000, note: '合成参考' },
  incompleteness: { costMissing: false, paymentReferenceMissing: false },
})
afterEach(cleanup)

it('没有待实施计划时展示当前病组、已用、支付参考和余额，点击进入 DRG 预分组', async () => {
  const open = vi.fn()
  render(<DrgProgressBar data={simulation} costs={undefined} locale="zh-CN" onOpenDrg={open} />)
  const button = screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  expect(button.textContent).toContain('当前病组 FR59')
  expect(button.textContent).toContain('已用 ¥1,500.00')
  expect(button.textContent).toContain('支付参考 ¥4,000.00')
  expect(button.textContent).toContain('还剩 ¥2,500.00')
  expect(button.textContent).toContain('未超')
  await userEvent.setup().click(button)
  expect(open).toHaveBeenCalledOnce()
})

it.each([
  [359999, '未超'], [360000, '接近'], [400000, '接近'], [400001, '已超'],
])('当前已用 %s 分时按接近和严格超出边界显示 %s', (spent, expected) => {
  render(<DrgProgressBar data={{ ...simulation, formal: { ...simulation.formal, chargesFen: spent } }} costs={undefined} locale="zh-CN" onOpenDrg={() => {}} />)
  expect(screen.getByRole('button').textContent).toContain(expected)
})


it('待实施或进行中的可分组手术按预计病组、预计总费用与预计支付参考比较，保留已用金额', () => {
  const projected = { ...grouped, drgCode: 'FM39', adrgCode: 'FM3' }
  const data = { ...simulation, grouping: { ...simulation.grouping, projected }, coverage: { ...simulation.coverage, estimatedTotalFen: 1080000 } }
  const costs = inpatientCostsSchema.parse({ fingerprint: 'b'.repeat(64),
    components: { formalChargesFen: 150000, pendingOrdersFen: 0, remainingMaterialsFen: 750000, plannedSurgeryFen: 180000, projectedTotalFen: 1080000 },
    currentGrouping: grouped, projectedGrouping: projected, currentPaymentReference: simulation.paymentReference,
    projectedPaymentReference: { ...simulation.paymentReference, drgCode: 'FM39', referenceFen: 1200000 },
    currentDifferenceFen: -680000, projectedDifferenceFen: 120000, paymentStatus: 'available', paymentMessage: '合成参考', exceptionAlert: 'below-threshold',
  })
  render(<DrgProgressBar data={data} costs={costs} locale="zh-CN" onOpenDrg={() => {}} />)
  const button = screen.getByRole('button')
  expect(button.textContent).toContain('按计划手术预计 FM39')
  expect(button.textContent).toContain('已用 ¥1,500.00')
  expect(button.textContent).toContain('做完预计 ¥10,800.00')
  expect(button.textContent).toContain('支付参考 ¥12,000.00')
  expect(button.textContent).toContain('预计还剩 ¥1,200.00')
  expect(button.textContent).toContain('接近')
})

it('没有支付参考时仍显示病组和已用，但不画进度或报告未超状态；不可分组的计划退回当前口径', () => {
  render(<DrgProgressBar data={{ ...simulation, paymentReference: null, grouping: { ...simulation.grouping, projected: { ...grouped, status: 'ungroupable', drgCode: null } } }} costs={undefined} locale="zh-CN" onOpenDrg={() => {}} />)
  expect(screen.getByRole('button').textContent).toContain('当前病组 FR59')
  expect(screen.getByRole('button').textContent).toContain('暂无支付参考')
  expect(screen.getByRole('button').textContent).not.toContain('未超')
  expect(screen.queryByRole('img')).toBeNull()
})


it('已开未执行医嘱只计入预计，不计为当前已用收费', () => {
  const data = { ...simulation, committed: { items: [{ kind: 'medication' as const, id: 'pending-order', display: '合成未执行医嘱', quantity: 1, estimatedFen: 50000 }] },
    coverage: { ...simulation.coverage, estimatedTotalFen: 200000 } }
  render(<DrgProgressBar data={data} costs={undefined} locale="zh-CN" onOpenDrg={() => {}} />)
  expect(screen.getByRole('button').textContent).toContain('已用 ¥1,500.00')
  expect(screen.getByRole('button').textContent).toContain('还剩 ¥2,500.00')
})

it('新完成手术待确认主操作时使用当前术后预计参考，不按旧正式参考报警', () => {
  const data = inpatientDrgSimulationSchema.parse({ ...simulation,
    formal: { ...simulation.formal, chargesFen: 405000 },
    coverage: { ...simulation.coverage, estimatedTotalFen: 425000 },
    postoperativeEstimate: { pendingExecutionIds: ['completed-pci'], grouping: { ...grouped, drgCode: 'FM39' },
      paymentReference: { ...simulation.paymentReference, drgCode: 'FM39', referenceFen: 1200000 } } })
  render(<DrgProgressBar data={data} costs={undefined} locale="zh-CN" onOpenDrg={() => {}} />)
  const button = screen.getByRole('button')
  expect(button.textContent).toContain('术后预计 FM39')
  expect(button.textContent).toContain('待确认主操作')
  expect(button.textContent).toContain('已用 ¥4,050.00')
  expect(button.textContent).toContain('预计 ¥4,250.00')
  expect(button.textContent).toContain('支付参考 ¥12,000.00')
  expect(button.textContent).toContain('预计还剩 ¥7,750.00')
  expect(button.textContent).not.toContain('已超')
  expect(button.textContent).not.toContain('¥4,000.00')
})

it('术后多候选分组不一致或不可分组时保持待确认，不使用旧参考、旧病组或进度', () => {
  const data = inpatientDrgSimulationSchema.parse({ ...simulation, formal: { ...simulation.formal, chargesFen: 405000 },
    postoperativeEstimate: { pendingExecutionIds: ['angiography', 'pci'], grouping: null, paymentReference: null } })
  render(<DrgProgressBar data={data} costs={undefined} locale="zh-CN" onOpenDrg={() => {}} />)
  const button = screen.getByRole('button')
  expect(button.textContent).toContain('待确认主操作')
  expect(button.textContent).toContain('暂无支付参考')
  expect(button.textContent).not.toContain('FR59')
  expect(button.textContent).not.toContain('¥4,000.00')
  expect(button.textContent).not.toContain('已超')
  expect(button.textContent).not.toContain('接近')
  expect(screen.queryByRole('img')).toBeNull()
})

it('可分组待实施计划优先于未确认的术后预计', () => {
  const data = inpatientDrgSimulationSchema.parse({ ...simulation,
    grouping: { ...simulation.grouping, projected: { ...grouped, drgCode: 'FR25' } },
    postoperativeEstimate: { pendingExecutionIds: ['completed-pci'], grouping: { ...grouped, drgCode: 'FM39' },
      paymentReference: { ...simulation.paymentReference, drgCode: 'FM39', referenceFen: 1200000 } } })
  render(<DrgProgressBar data={data} costs={undefined} locale="zh-CN" onOpenDrg={() => {}} />)
  expect(screen.getByRole('button').textContent).toContain('按计划手术预计 FR25')
  expect(screen.getByRole('button').textContent).not.toContain('待确认主操作')
  expect(screen.getByRole('button').textContent).not.toContain('FM39')
})
