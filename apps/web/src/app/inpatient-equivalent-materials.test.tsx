// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { inpatientEquivalentMaterialSuggestionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { EquivalentMaterialAdvice } from './inpatient-equivalent-materials.tsx'

const suggestion = inpatientEquivalentMaterialSuggestionSchema.parse({ groupId: 'synthetic-pci-stent-3.0x18',
  from: { id: 'stent-a', version: 1, display: '合成支架 A 3.0×18 mm', chargeDefinition: { id: 'charge-a', priceFen: 73000, unit: '枚', synthetic: true, trigger: 'execution' } },
  to: { id: 'stent-b', version: 1, display: '合成支架 B 3.0×18 mm', chargeDefinition: { id: 'charge-b', priceFen: 53000, unit: '枚', synthetic: true, trigger: 'execution' } },
  quantity: 1, unitSavingsFen: 20000, totalSavingsFen: 20000, beforeTotalFen: 1080000, afterTotalFen: 1060000, paymentReferenceFen: 1200000,
})
afterEach(cleanup)
it('只展示程序预筛候选与固定差价，点击才采用，实际模型说明独立标助手', async () => {
  const pick = vi.fn()
  render(<EquivalentMaterialAdvice locale="zh-CN" disabled={false} suggestions={[suggestion]} onPick={pick} assistantExplanation="已独立核验本合成等效组。" />)
  expect(screen.getByText('等效耗材')).toBeDefined()
  expect(screen.getByText('助手')).toBeDefined()
  expect(screen.getByText(/单价少 ¥200.00；换后预计 ¥10,600.00/)).toBeDefined()
  expect(pick).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByRole('button', { name: '换成这个' }))
  expect(pick).toHaveBeenCalledWith(suggestion)
})
it('没有等效建议时不占界面，采用后可以换回原耗材', async () => {
  const undo = vi.fn(), view = render(<EquivalentMaterialAdvice locale="zh-CN" disabled={false} suggestions={[]} onPick={() => {}} />)
  expect(view.container.textContent).toBe('')
  view.rerender(<EquivalentMaterialAdvice locale="zh-CN" disabled={false} suggestions={[]} onPick={() => {}} undo={{ savingsFen: 20000, onUndo: undo }} />)
  expect(screen.queryByText('助手')).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '换回原耗材' }))
  expect(undo).toHaveBeenCalledOnce()
})
