import { describe, expect, it } from 'vitest'
import { drgGroupingInputSchema, drgRulesSchema, type DrgGroupingInput, type DrgRules } from '@clinmesh/contracts/drg'
import { groupDrgCase } from '../src/application/drg-grouping.ts'

/** 手工维护的最小规则集：每个预期结果都可按官方方案的三步流程手工推导。 */
const fixture: DrgRules = drgRulesSchema.parse({
  rulesId: 'fixture-chs-drg-30-mini',
  version: 'test-1',
  mdcEntries: [
    { codePrefix: 'I21', mdcCode: 'MDCC' },
    { codePrefix: 'A00', mdcCode: 'MDCA' },
  ],
  members: [
    { code: 'I21.000x001', adrgCode: 'C11', chapter: 'medical' },
    { code: 'A00.900x002', adrgCode: 'A01', chapter: 'medical' },
  ],
  validOperations: [
    { code: '36.0700x001', adrgCode: 'C12' },
    { code: '48.1100x009', adrgCode: 'A02' },
  ],
  complications: [
    { code: 'I50.000x002', severity: 2 },
    { code: 'J18.900x003', severity: 1 },
  ],
  exclusions: [
    { tableId: 'T1', ownerCode: 'C12', excludedCode: 'J18.900x003' },
  ],
  terminalGroups: [
    { adrgCode: 'C11', withMccCode: 'C11x1', withCcCode: 'C11x2', withoutCode: 'C11x3' },
    { adrgCode: 'C12', withMccCode: 'C12x1', withCcCode: 'C12x2', withoutCode: 'C12x3' },
    { adrgCode: 'A01', withMccCode: 'A01x1', withCcCode: 'A01x2', withoutCode: 'A01x3' },
    { adrgCode: 'A02', withMccCode: 'A02x1', withCcCode: 'A02x2', withoutCode: 'A02x3' },
  ],
})

function input(overrides: Partial<DrgGroupingInput> = {}): DrgGroupingInput {
  return drgGroupingInputSchema.parse({
    diagnoses: [{ code: 'I21.000x001', role: 'main' }],
    operations: [],
    gender: 'male',
    ageYears: 63,
    ageDays: null,
    birthWeightGrams: null,
    dischargeMode: '2',
    inpatientDays: 5,
    ...overrides,
  })
}

describe('CHS-DRG 3.0 分组流程（固定规则 fixture）', () => {
  it('内科病例：主诊断定 MDC 与内科 ADRG，次诊断 CC 进入伴并发症组，并输出三步解释', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [
        { code: 'I21.000x001', role: 'main' },
        { code: 'J18.900x003', role: 'secondary' },
      ],
    }))
    expect(result.status).toBe('grouped')
    expect(result.drgCode).toBe('C11x2')
    expect(result.mdcCode).toBe('MDCC')
    expect(result.adrgCode).toBe('C11')
    expect(result.steps.map(step => step.stage)).toEqual(['mdc', 'adrg', 'drg'])
  })

  it('外科病例：主操作命中有效操作表进入手术 ADRG，次诊断 MCC 进入伴严重并发症组', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [
        { code: 'I21.000x001', role: 'main' },
        { code: 'I50.000x002', role: 'secondary' },
      ],
      operations: [{ code: '36.0700x001', primary: true }],
    }))
    expect(result.status).toBe('grouped')
    expect(result.drgCode).toBe('C12x1')
    expect(result.adrgCode).toBe('C12')
  })

  it('排除关系：ADRG 排除表中列明的次诊断不按 CC 计，落到不伴并发症组', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [
        { code: 'I21.000x001', role: 'main' },
        { code: 'J18.900x003', role: 'secondary' },
      ],
      operations: [{ code: '36.0700x001', primary: true }],
    }))
    expect(result.status).toBe('grouped')
    expect(result.drgCode).toBe('C12x3')
  })

  it('主诊断不属于任何成员且无有效主操作时显式报告无法入组', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [{ code: 'U99.900x009', role: 'main' }],
    }))
    expect(result.status).toBe('ungroupable')
    expect(result.drgCode).toBeNull()
    expect(result.reason).toBeTruthy()
  })

  it('多个主操作命中不同 ADRG 时显式报告歧义，不虚构病组', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [{ code: 'A00.900x002', role: 'main' }],
      operations: [
        { code: '36.0700x001', primary: true },
        { code: '48.1100x009', primary: true },
      ],
    }))
    expect(result.status).toBe('ambiguous')
    expect(result.drgCode).toBeNull()
    expect(result.reason).toBeTruthy()
  })

  it('缺少主诊断时按输入不完整处理，不进入分组', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [{ code: 'J18.900x003', role: 'secondary' }],
    }))
    expect(result.status).toBe('invalid-input')
    expect(result.drgCode).toBeNull()
  })
})
