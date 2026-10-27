import { expect, it } from 'vitest'
import { inpatientDrgAgentSchema } from '../src/inpatient-drg-agent.ts'

it('建议状态保留依据、阶段、产品版本、数量依据和非零费用口径', () => {
  const result = inpatientDrgAgentSchema.safeParse({
    admissionId: 'admission-1', taskId: 'task-1', status: 'succeeded',
    basisFingerprint: 'a'.repeat(64), stage: 'preoperative', missing: [], failureCode: null,
    analysis: { id: 'analysis-1', revision: 1, basisFingerprint: 'a'.repeat(64), stage: 'preoperative',
      createdAt: '2026-10-27T00:00:00.000Z', model: 'synthetic-only',
      sources: { selectionConfirmationId: 'selection-1', selectionVersion: 1,
        evidencePackageId: 'synthetic-evidence-package', evidencePackageVersion: '1', materialEvidence: [] },
      items: [{ materialId: 'synthetic-stent', catalogVersion: 1, display: '合成支架', unit: '枚',
        quantity: 1, unitPriceFen: 80000, estimatedFen: 80000, reason: '仅供已确认合成条件内比较',
        quantityBasis: '医生确认本次单病变计划使用一枚', evidenceIds: ['synthetic-evidence-v1'] }],
    }, confirmedPlan: null, planHistory: [],
  })
  expect(result.success).toBe(true)
})
