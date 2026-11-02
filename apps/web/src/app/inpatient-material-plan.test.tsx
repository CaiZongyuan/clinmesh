// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { InpatientMaterialPlanBasis } from '@clinmesh/contracts/inpatient-material-plan'
import { InpatientMaterialPlanBasisDetails } from './inpatient-material-plan.tsx'

const original = {
  reference: 'MaterialPlan/plan-1', requestId: 'request-1', source: 'material-estimate' as const,
  sourceId: 'estimate-1', sourceVersion: 1, basisFingerprint: 'a'.repeat(64), confirmedBy: 'actor-doctor',
  confirmedAt: '2026-08-24T09:00:00+08:00', supersedes: null,
  items: [{ materialId: 'material-catheter', catalogVersion: 3, display: '合成双根导管', specification: '合成 5F',
    unit: '根', quantity: 2, unitPriceFen: 5000, estimatedFen: 10000, reason: '医生核对双根方案',
    quantityBasis: '合成院内双根方案', evidenceIds: ['synthetic-catheter'] }], reservationIds: ['reservation-1'],
}
afterEach(cleanup)

it('展示医生原确认清单、冻结目录价格及跨来源取代历史', () => {
  const current = { ...original, reference: 'MaterialPlan/plan-2', source: 'drg-agent' as const,
    sourceId: 'task-1', sourceVersion: 2, supersedes: original.reference, confirmedAt: '2026-08-24T10:00:00+08:00' }
  const basis: InpatientMaterialPlanBasis = { requestId: 'request-1', status: 'confirmed', effectiveReference: current.reference,
    history: [original, current] }
  render(<InpatientMaterialPlanBasisDetails basis={basis} locale="zh-CN" />)
  const panel = screen.getByRole('region', { name: '手术术前确认依据 request-1' })
  expect(within(panel).getByText('当前有效依据：持续跟进确认计划 v2')).toBeDefined()
  expect(within(panel).getByText('已被取代')).toBeDefined()
  expect(within(panel).getByText('单次耗材清单确认 v1')).toBeDefined()
  expect(within(panel).getAllByText('原确认数量：2根 · 冻结单价 ¥50.00/根 · 确认金额 ¥100.00')).toHaveLength(2)
  expect(within(panel).getAllByText('合成双根导管 · material-catheter v3 · 合成 5F')).toHaveLength(2)
  expect(within(panel).getByText('取代依据：MaterialPlan/plan-1')).toBeDefined()
  expect(within(panel).getAllByText(/actor-doctor · 2026-08-24T/)).toHaveLength(2)
})

it.each([
  ['missing', '尚无可核验的术前确认清单；未确认工作稿和单项预留不作为核查依据。'],
  ['unverifiable', '历史记录缺少可核验的原确认快照或绑定关系，请核实原始记录。'],
  ['conflict', '确认来源存在冲突，核实有效依据及取代关系前不比较术前数量。'],
] as const)('%s 状态明确提示核实，不把来源历史显示为有效清单', (status, message) => {
  render(<InpatientMaterialPlanBasisDetails basis={{ requestId: 'request-1', status, effectiveReference: null,
    history: status === 'conflict' ? [original] : [] }} locale="zh-CN" />)
  expect(screen.getByRole('alert').textContent).toContain(message)
  expect(screen.queryByText(/当前有效依据：/)).toBeNull()
})
