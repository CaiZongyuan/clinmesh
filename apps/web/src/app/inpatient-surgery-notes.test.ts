import { inpatientMaterialReservationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { expect, it } from 'vitest'
import { inpatientMaterialPlanSchema } from '@clinmesh/contracts/inpatient-material-plan'
import { inpatientMaterialItemSchema, inpatientSurgeryExecutionSchema } from '@clinmesh/contracts/inpatient-surgery'
import { completionReviewNote, postoperativeDispositionNote } from './inpatient-surgery-notes.ts'
import { inpatientDrgReviewTodoSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { initialCompletionDraft, type CompletionDraftRow } from './inpatient-surgery-completion-draft.ts'

const time = '2026-11-13T09:00:00+08:00'
const item = inpatientMaterialItemSchema.parse({ id: 'wire', version: 1, display: '合成导丝', chargeDefinition: { id: 'wire-price', priceFen: 20000, unit: '根', synthetic: true, trigger: 'execution' } })
const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: 'admission-1', requestId: 'request-1', actualProcedure: {
  id: 'pci', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { ...item.chargeDefinition, unit: '次' } },
  performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术', materials: [],
  materialHistory: [{ id: 'use-1', item, quantity: 2, amountFen: 40000, recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', reservationId: null, note: '首根无法通过病变，更换', correction: null }] })
const plan = inpatientMaterialPlanSchema.parse({ reference: 'InpatientMaterialPlan/plan-1', requestId: 'request-1', source: 'material-estimate', sourceId: 'estimate-1', sourceVersion: 1, basisFingerprint: 'a'.repeat(64),
  sources: { requestId: 'request-1', evidencePackageId: 'synthetic-evidence', evidencePackageVersion: '1', materialEvidence: [] }, confirmedBy: 'doctor', confirmedAt: time, supersedes: null, reservationIds: ['reservation-1'],
  items: [{ materialId: 'wire', catalogVersion: 1, display: '合成导丝', specification: '合成规格', quantity: 1, unit: '根', unitPriceFen: 20000, estimatedFen: 20000, reason: '按计划', quantityBasis: '合成单病变', evidenceIds: ['wire-evidence'] }] })
const row: CompletionDraftRow = { key: 'use-1', materialId: 'wire', catalogVersion: 1, quantity: '1', previousQuantity: 1, display: '合成导丝', unit: '根', priceFen: 20000, materialUseIds: ['use-1'], reservationId: 'reservation-1', expectedReservationVersion: 1 }

const reservation = inpatientMaterialReservationSchema.parse({ id: 'reservation-1', admissionId: 'admission-1', requestId: 'request-1', materialId: 'wire', materialDisplay: '合成导丝', catalogVersion: 1, quantity: 1, consumedQuantity: 0, version: 1, priceFen: 20000, status: 'reserved', reason: '原计划预留', createdAt: time })

it('无差异的核实说明不要求再次输入，也不宣称模型起草', () => {
  expect(completionReviewNote([row], plan, execution, [], 'zh-CN', [reservation])).toBe('最终用量与术中登记、术前计划一致。')
})
it('多用带出登记依据，未用明确保留或释放的去向', () => {
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2 }], plan, execution, [], 'zh-CN', [reservation])).toBe('最终用量按术中已登记量核实；合成导丝多用1 根，首根无法通过病变，更换。')
  expect(completionReviewNote([{ ...row, quantity: '0', previousQuantity: 0 }], plan, execution, [], 'zh-CN', [reservation])).toBe('最终用量按术中已登记量核实；合成导丝未用1 根，保留预留。')
  expect(completionReviewNote([{ ...row, quantity: '0', previousQuantity: 0 }], plan, execution, [{ reservationId: 'reservation-1', expectedReservationVersion: 1, display: '合成导丝' }], 'zh-CN', [reservation])).toContain('释放预留')
})
it('计划内用完后再次登记，只把超出计划那笔的依据带入多用说明', () => {
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝' }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const current = { ...execution, materialHistory: [plannedUse, extraUse], materials: [
    { id: 'planned-use', item, quantity: 1, amountFen: 20000 }, { id: 'extra-use', item, quantity: 1, amountFen: 20000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2, materialUseIds: ['planned-use', 'extra-use'] }], plan, current, [], 'zh-CN', [reservation]))
    .toBe('最终用量按术中已登记量核实；合成导丝多用1 根，分支保护。')
})
it('将额外原笔清零再新增同版本用量时，不借用已冲减原笔的原因', () => {
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, reservationId: 'reservation-1', note: '按计划：单病变导丝' }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '污染更换' }
  const current = { ...execution, materialHistory: [plannedUse, extraUse], materials: [
    { id: 'planned-use', item, quantity: 1, amountFen: 20000 }, { id: 'extra-use', item, quantity: 1, amountFen: 20000 },
  ] }
  const draft = initialCompletionDraft(current, [reservation], 'request-1')
  expect(draft.rows).toHaveLength(2)
  const finalRows = draft.rows.map(row => row.materialUseIds.includes('extra-use') ? { ...row, quantity: '0' } : row)
  finalRows.push({ key: 'new-use', materialId: item.id, catalogVersion: item.version, display: item.display, unit: '根', priceFen: 20000,
    quantity: '1', previousQuantity: 0, materialUseIds: [] })
  expect(completionReviewNote(finalRows, plan, current, [], 'zh-CN', [reservation]))
    .toBe('最终用量已按逐项核实调整；合成导丝多用1 根。')
})
it('聚合行减少用量时末笔先减，仍保留前一笔部分额外用量的依据', () => {
  const largerPlan = { ...plan, items: [{ ...plan.items[0]!, quantity: 2, estimatedFen: 40000 }] }
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', note: '按计划：两根导丝' }
  const firstExtra = { ...execution.materialHistory[0]!, id: 'first-extra', note: '分支保护' }
  const lastExtra = { ...execution.materialHistory[0]!, id: 'last-extra', note: '污染更换' }
  const current = { ...execution, materialHistory: [plannedUse, firstExtra, lastExtra], materials: [
    { id: 'planned-use', item, quantity: 2, amountFen: 40000 }, { id: 'first-extra', item, quantity: 2, amountFen: 40000 },
    { id: 'last-extra', item, quantity: 2, amountFen: 40000 },
  ] }
  const draft = initialCompletionDraft(current, [], 'request-1')
  expect(draft.rows).toHaveLength(1)
  expect(completionReviewNote(draft.rows.map(row => ({ ...row, quantity: '3' })), largerPlan, current, [], 'zh-CN', []))
    .toBe('最终用量已按逐项核实调整；合成导丝多用1 根，分支保护。')
})
it('计划内原笔被替换更正后，按原登记位置累计，不把计划内更正当作多用依据', () => {
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝',
    correction: { id: 'correction-1', recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '核实计划内原笔',
      replacementMaterialUseId: 'replacement-use', originalChargeId: 'original-charge', reversalChargeId: 'reversal-charge' } }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const replacementUse = { ...execution.materialHistory[0]!, id: 'replacement-use', quantity: 1, amountFen: 20000, note: '已核实计划内原笔' }
  const current = { ...execution, materialHistory: [plannedUse, extraUse, replacementUse], materials: [
    { id: 'extra-use', item, quantity: 1, amountFen: 20000 }, { id: 'replacement-use', item, quantity: 1, amountFen: 20000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2, materialUseIds: ['extra-use', 'replacement-use'] }], plan, current, [], 'zh-CN', [reservation]))
    .toBe('最终用量按术中已登记量核实；合成导丝多用1 根，分支保护。')
})
it('一笔数量跨过累计计划边界时，带出该笔额外依据', () => {
  const largerPlan = { ...plan, items: [{ ...plan.items[0]!, quantity: 3, estimatedFen: 60000 }] }
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝' }
  const crossingUse = { ...execution.materialHistory[0]!, id: 'crossing-use', quantity: 3, amountFen: 60000, note: '追加支路保护' }
  const current = { ...execution, materialHistory: [plannedUse, crossingUse], materials: [
    { id: 'planned-use', item, quantity: 1, amountFen: 20000 }, { id: 'crossing-use', item, quantity: 3, amountFen: 60000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '4', previousQuantity: 4, materialUseIds: ['planned-use', 'crossing-use'] }], largerPlan, current, [], 'zh-CN', []))
    .toBe('最终用量按术中已登记量核实；合成导丝多用1 根，追加支路保护。')
})
it('已撤销登记既不占计划量，也不把旧依据带入多用说明', () => {
  const voidedUse = { ...execution.materialHistory[0]!, id: 'voided-use', note: '已撤销的误登记原因',
    correction: { id: 'correction-1', recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '撤销误登记',
      replacementMaterialUseId: null, originalChargeId: 'original-charge', reversalChargeId: 'reversal-charge' } }
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝' }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const current = { ...execution, materialHistory: [voidedUse, plannedUse, extraUse], materials: [
    { id: 'planned-use', item, quantity: 1, amountFen: 20000 }, { id: 'extra-use', item, quantity: 1, amountFen: 20000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2, materialUseIds: ['planned-use', 'extra-use'] }], plan, current, [], 'zh-CN', []))
    .toBe('最终用量按术中已登记量核实；合成导丝多用1 根，分支保护。')
})
it('计划内登记连续替换更正时，仅在原位置计最终有效记录一次', () => {
  const correction = { id: 'correction-1', recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '核实计划内原笔',
    replacementMaterialUseId: 'middle-use', originalChargeId: 'original-charge', reversalChargeId: 'reversal-charge' }
  const original = { ...execution.materialHistory[0]!, id: 'original-use', quantity: 1, amountFen: 20000, note: '原计划内依据', correction }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const middle = { ...execution.materialHistory[0]!, id: 'middle-use', quantity: 1, amountFen: 20000, note: '中间更正依据',
    correction: { ...correction, id: 'correction-2', replacementMaterialUseId: 'final-use', originalChargeId: 'middle-charge', reversalChargeId: 'middle-reversal' } }
  const finalUse = { ...execution.materialHistory[0]!, id: 'final-use', quantity: 1, amountFen: 20000, note: '最终计划内更正依据' }
  const current = { ...execution, materialHistory: [original, extraUse, middle, finalUse], materials: [
    { id: 'extra-use', item, quantity: 1, amountFen: 20000 }, { id: 'final-use', item, quantity: 1, amountFen: 20000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2, materialUseIds: ['extra-use', 'final-use'] }], plan, current, [], 'zh-CN', []))
    .toBe('最终用量按术中已登记量核实；合成导丝多用1 根，分支保护。')
})
it('另一目录版本不占用本版本的计划量，也不混入本版本多用依据', () => {
  const oldItem = { ...item, version: 2, display: '合成导丝另一目录版本' }
  const otherVersion = { ...execution.materialHistory[0]!, id: 'other-version', item: oldItem, quantity: 1, amountFen: 20000, note: '另一版本依据' }
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝' }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const current = { ...execution, materialHistory: [otherVersion, plannedUse, extraUse], materials: [
    { id: 'other-version', item: oldItem, quantity: 1, amountFen: 20000 }, { id: 'planned-use', item, quantity: 1, amountFen: 20000 },
    { id: 'extra-use', item, quantity: 1, amountFen: 20000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2, materialUseIds: ['planned-use', 'extra-use'] },
    { ...row, key: 'other-version', catalogVersion: 2, display: oldItem.display, quantity: '0', previousQuantity: 1, materialUseIds: ['other-version'] }], plan, current, [], 'zh-CN', []))
    .toBe('最终用量已按逐项核实调整；合成导丝多用1 根，分支保护。')
})
it('术后多用说明引用正式登记原因，缺少预留记录时不假定已经释放', () => {
  const todo = inpatientDrgReviewTodoSchema.parse({ id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire', kind: 'extra-use', ownerRole: 'inpatient-doctor', materialId: 'wire', display: '合成导丝', plannedQuantity: 1, actualQuantity: 2, explanation: '导丝多用1根。', evidence: ['Procedure/execution-1'], requestId: 'request-1', executionId: 'execution-1', status: 'pending', reason: null })
  expect(postoperativeDispositionNote(todo, [execution], [], 'zh-CN')).toBe('导丝多用1根。登记依据：首根无法通过病变，更换')
  expect(postoperativeDispositionNote({ ...todo, kind: 'unused-plan', actualQuantity: 0 }, [], [], 'zh-CN')).toBe('合成导丝未使用原计划全部数量；预留状态待核实。')
})
it('术后多用待办只带出其有效来源中的额外依据，不混入计划内或其他目录版本', () => {
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝' }
  const otherVersion = { ...execution.materialHistory[0]!, id: 'other-version', item: { ...item, version: 2 }, quantity: 10, amountFen: 200000, note: '另一目录版本的登记依据' }
  const extraUse = { ...execution.materialHistory[0]!, id: 'extra-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const current = { ...execution, materialHistory: [plannedUse, otherVersion, extraUse], materials: [
    { id: 'planned-use', item, quantity: 1, amountFen: 20000 }, { id: 'other-version', item: { ...item, version: 2 }, quantity: 10, amountFen: 200000 },
    { id: 'extra-use', item, quantity: 1, amountFen: 20000 },
  ] }
  const todo = inpatientDrgReviewTodoSchema.parse({ id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire-v1',
    kind: 'extra-use', ownerRole: 'inpatient-doctor', materialId: 'wire', display: '合成导丝', plannedQuantity: 1, actualQuantity: 2,
    explanation: '导丝多用1根。', evidence: ['InpatientSurgeryMaterial/planned-use', 'InpatientSurgeryMaterial/extra-use', 'Procedure/execution-1'],
    requestId: 'request-1', executionId: 'execution-1', status: 'pending', reason: null })
  expect(postoperativeDispositionNote(todo, [current], [], 'zh-CN')).toBe('导丝多用1根。登记依据：分支保护')
})
it('额外登记更正后，完成与术后说明均只引用最终有效数量的更正依据', () => {
  const plannedUse = { ...execution.materialHistory[0]!, id: 'planned-use', quantity: 1, amountFen: 20000, note: '按计划：单病变导丝' }
  const oldExtra = { ...execution.materialHistory[0]!, id: 'old-extra', note: '已被替代的额外依据',
    correction: { id: 'correction-1', recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '核实额外使用仅一根',
      replacementMaterialUseId: 'replacement-use', originalChargeId: 'original-charge', reversalChargeId: 'reversal-charge' } }
  const replacement = { ...execution.materialHistory[0]!, id: 'replacement-use', quantity: 1, amountFen: 20000, note: '分支保护' }
  const current = { ...execution, materialHistory: [plannedUse, oldExtra, replacement], materials: [
    { id: 'planned-use', item, quantity: 1, amountFen: 20000 }, { id: 'replacement-use', item, quantity: 1, amountFen: 20000 },
  ] }
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2, materialUseIds: ['planned-use', 'replacement-use'] }], plan, current, [], 'zh-CN', []))
    .toBe('最终用量按术中已登记量核实；合成导丝多用1 根，分支保护。')
  const todo = inpatientDrgReviewTodoSchema.parse({ id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire-v1',
    kind: 'extra-use', ownerRole: 'inpatient-doctor', materialId: 'wire', display: '合成导丝', plannedQuantity: 1, actualQuantity: 2,
    explanation: '导丝多用1根。', evidence: ['InpatientSurgeryMaterial/planned-use', 'InpatientSurgeryMaterial/replacement-use', 'Procedure/execution-1'],
    requestId: 'request-1', executionId: 'execution-1', status: 'pending', reason: null })
  expect(postoperativeDispositionNote(todo, [current], [], 'zh-CN')).toBe('导丝多用1根。登记依据：分支保护')
})

it('术前已经释放的未用预留在完成说明中保持已释放事实', () => {
  expect(completionReviewNote([{ ...row, quantity: '0', previousQuantity: 0 }], plan, execution, [], 'zh-CN', [{ ...reservation, status: 'released', releaseReason: '术前已核实释放' }])).toBe('最终用量按术中已登记量核实；合成导丝未用1 根，预留已释放。')
})
