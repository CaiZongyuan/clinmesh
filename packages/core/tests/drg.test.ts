import { describe, expect, it } from 'vitest'
import { quoteFen, simulateGroup } from '../src/drg.ts'

describe('模拟 DRG 计价和规则', () => {
  it('保留高精度单价，只在总行金额边界舍入', () => {
    expect(quoteFen('48.375', 3)).toBe(14513)
    expect(quoteFen('0.004999', 1)).toBe(0)
    expect(quoteFen('0.005', 1)).toBe(1)
    expect(quoteFen('0.000125', 1000)).toBe(13)
    expect(quoteFen(null, 10)).toBeNull()
  })
  it('只按明确的已确认编码条件分组，无适用规则时不产生金额', () => {
    const rules = { mainDiagnosisId: 'pneumonia', complicationId: 'failure', completedProcedureId: 'intubation', basePaymentFen: 1000000, complicationPaymentFen: 1800000, procedurePaymentFen: 2800000 }
    const clinical = { mainDiagnosisId: 'pneumonia', secondaryDiagnosisIds: [], completedProcedureIds: [] }
    expect(simulateGroup(clinical, rules)?.code).toBe('SIM-PNEUMONIA')
    expect(simulateGroup({ ...clinical, secondaryDiagnosisIds: ['hypertension'] }, rules)?.code).toBe('SIM-PNEUMONIA')
    expect(simulateGroup({ ...clinical, secondaryDiagnosisIds: ['failure'] }, rules)?.referenceFen).toBe(1800000)
    expect(simulateGroup({ ...clinical, completedProcedureIds: ['intubation'] }, rules)?.referenceFen).toBe(2800000)
    expect(simulateGroup({ ...clinical, mainDiagnosisId: 'unknown' }, rules)).toBeNull()
  })
})
