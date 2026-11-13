import { expect, it } from 'vitest'
import { inpatientMaterialPlanSchema } from '@clinmesh/contracts/inpatient-material-plan'
import { inpatientSurgeryExecutionSchema } from '@clinmesh/contracts/inpatient-surgery'
import { completionReviewNote, postoperativeDispositionNote } from './inpatient-surgery-notes.ts'
import { inpatientDrgReviewTodoSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { CompletionDraftRow } from './inpatient-surgery-completion-draft.ts'

const time = '2026-11-13T09:00:00+08:00'
const item = { id: 'wire', version: 1, display: '合成导丝', chargeDefinition: { id: 'wire-price', priceFen: 20000, unit: '根', synthetic: true, trigger: 'execution' } }
const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: 'admission-1', requestId: 'request-1', actualProcedure: {
  id: 'pci', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { ...item.chargeDefinition, unit: '次' } },
  performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术', materials: [],
  materialHistory: [{ id: 'use-1', item, quantity: 2, amountFen: 40000, recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', reservationId: null, note: '首根无法通过病变，更换', correction: null }] })
const plan = inpatientMaterialPlanSchema.parse({ reference: 'InpatientMaterialPlan/plan-1', requestId: 'request-1', source: 'material-estimate', sourceId: 'estimate-1', sourceVersion: 1, basisFingerprint: 'a'.repeat(64),
  sources: { requestId: 'request-1', evidencePackageId: 'synthetic-evidence', evidencePackageVersion: '1', materialEvidence: [] }, confirmedBy: 'doctor', confirmedAt: time, supersedes: null, reservationIds: ['reservation-1'],
  items: [{ materialId: 'wire', catalogVersion: 1, display: '合成导丝', specification: '合成规格', quantity: 1, unit: '根', unitPriceFen: 20000, estimatedFen: 20000, reason: '按计划', quantityBasis: '合成单病变', evidenceIds: ['wire-evidence'] }] })
const row: CompletionDraftRow = { key: 'use-1', materialId: 'wire', catalogVersion: 1, quantity: '1', previousQuantity: 1, display: '合成导丝', unit: '根', priceFen: 20000, materialUseIds: ['use-1'], reservationId: 'reservation-1', expectedReservationVersion: 1 }

it('无差异的核实说明不要求再次输入，也不宣称模型起草', () => {
  expect(completionReviewNote([row], plan, execution, [], 'zh-CN')).toBe('最终用量与术中登记、术前计划一致。')
})
it('多用带出登记依据，未用明确保留或释放的去向', () => {
  expect(completionReviewNote([{ ...row, quantity: '2', previousQuantity: 2 }], plan, execution, [], 'zh-CN')).toBe('最终用量按术中已登记量核实；合成导丝多用1 根，首根无法通过病变，更换。')
  expect(completionReviewNote([{ ...row, quantity: '0', previousQuantity: 0 }], plan, execution, [], 'zh-CN')).toBe('最终用量按术中已登记量核实；合成导丝未用1 根，保留预留。')
  expect(completionReviewNote([{ ...row, quantity: '0', previousQuantity: 0 }], plan, execution, [{ reservationId: 'reservation-1', expectedReservationVersion: 1, display: '合成导丝' }], 'zh-CN')).toContain('释放预留')
})
it('术后多用说明引用正式登记原因，缺少预留记录时不假定已经释放', () => {
  const todo = inpatientDrgReviewTodoSchema.parse({ id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire', kind: 'extra-use', ownerRole: 'inpatient-doctor', materialId: 'wire', display: '合成导丝', plannedQuantity: 1, actualQuantity: 2, explanation: '导丝多用1根。', evidence: ['Procedure/execution-1'], requestId: 'request-1', executionId: 'execution-1', status: 'pending', reason: null })
  expect(postoperativeDispositionNote(todo, [execution], [], 'zh-CN')).toBe('导丝多用1根。登记依据：首根无法通过病变，更换')
  expect(postoperativeDispositionNote({ ...todo, kind: 'unused-plan', actualQuantity: 0 }, [], [], 'zh-CN')).toBe('合成导丝未使用原计划全部数量；预留状态待核实。')
})
