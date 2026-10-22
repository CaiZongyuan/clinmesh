import { describe, expect, it } from 'vitest'
import { drgGroupingInputSchema, drgRulesSchema, type DrgGroupingInput, type DrgRules } from '@clinmesh/contracts/drg'
import { groupDrgCase } from '../src/application/drg-grouping.ts'

/**
 * 手工维护的最小规则集：每个预期结果都可按官方方案的三步流程手工推导。
 * 排除语义与官方分组器同构：主诊断查排除组表得组号，次诊断与主诊断同组号时不按 CC/MCC 计。
 * fixture 中 I21.000x001（主诊断）属于排除组 '2'；J18.900x003（CC）同属组 '2'——
 * 因此 I21 病例中肺炎不计并发症；A00 病例（无排除组）中肺炎正常计 CC。
 */
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
    // 官方组合成员形态「主诊断+星号副诊断」：主诊断与指定次诊断同时出现才命中。
    { code: 'A00.900x002+J99.0*', adrgCode: 'A02', chapter: 'medical' },
  ],
  validOperations: [
    { code: '36.0700x001', adrgCode: 'C12' },
    { code: '48.1100x009', adrgCode: 'A02' },
  ],
  complications: [
    { code: 'I50.000x002', severity: 2, groupRef: '1' },
    { code: 'J18.900x003', severity: 1, groupRef: '2' },
    { code: 'N17.900x004', severity: 1, groupRef: '3' },
  ],
  exclusionGroups: [
    { code: 'I21.000x001', groupRef: '2' },
  ],
  adrgMdcEntries: [
    { adrgCode: 'C11', mdcCode: 'MDCC' },
    { adrgCode: 'C12', mdcCode: 'MDCC' },
    { adrgCode: 'A01', mdcCode: 'MDCA' },
    { adrgCode: 'A02', mdcCode: 'MDCA' },
  ],
  terminalGroups: [
    { adrgCode: 'C11', drgCode: 'C11x1', requires: 'mcc', minAgeYears: null },
    { adrgCode: 'C11', drgCode: 'C11x2', requires: 'mcc-or-cc', minAgeYears: null },
    { adrgCode: 'C11', drgCode: 'C11x3', requires: 'any', minAgeYears: null },
    { adrgCode: 'C12', drgCode: 'C12x1', requires: 'mcc', minAgeYears: null },
    { adrgCode: 'C12', drgCode: 'C12x2', requires: 'mcc-or-cc', minAgeYears: null },
    { adrgCode: 'C12', drgCode: 'C12x3', requires: 'any', minAgeYears: null },
    { adrgCode: 'A01', drgCode: 'A01x1', requires: 'mcc', minAgeYears: null },
    { adrgCode: 'A01', drgCode: 'A01x2', requires: 'mcc-or-cc', minAgeYears: null },
    { adrgCode: 'A01', drgCode: 'A01x3', requires: 'any', minAgeYears: null },
    { adrgCode: 'A02', drgCode: 'A02x9', requires: 'any', minAgeYears: null },
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
        { code: 'N17.900x004', role: 'secondary' },
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

  it('排除关系：次诊断与主诊断同排除组号时不计 CC，落到不伴并发症组', () => {
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

  it('同一次诊断在不同主诊断下不被排除：无排除组号的主诊断正常计 CC', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [
        { code: 'A00.900x002', role: 'main' },
        { code: 'J18.900x003', role: 'secondary' },
      ],
    }))
    expect(result.status).toBe('grouped')
    expect(result.drgCode).toBe('A01x2')
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

  it('组合成员：主诊断与星号副诊断同时出现时优先命中组合成员路径', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [
        { code: 'A00.900x002', role: 'main' },
        { code: 'J99.0', role: 'secondary' },
      ],
    }))
    expect(result.status).toBe('grouped')
    expect(result.adrgCode).toBe('A02')
    expect(result.drgCode).toBe('A02x9')
  })

  it('组合成员副诊断缺失时回落普通成员路径', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [
        { code: 'A00.900x002', role: 'main' },
        { code: 'J18.900x003', role: 'secondary' },
      ],
    }))
    expect(result.status).toBe('grouped')
    expect(result.adrgCode).toBe('A01')
    expect(result.drgCode).toBe('A01x2')
  })

  it('缺少主诊断时按输入不完整处理，不进入分组', () => {
    const result = groupDrgCase(fixture, input({
      diagnoses: [{ code: 'J18.900x003', role: 'secondary' }],
    }))
    expect(result.status).toBe('invalid-input')
    expect(result.drgCode).toBeNull()
  })

  it('MDC 前缀表未命中时按 ADRG 归属回填 MDC 判定', () => {
    const withoutMdcPrefix: DrgRules = drgRulesSchema.parse({
      ...fixture, mdcEntries: [],
    })
    const result = groupDrgCase(withoutMdcPrefix, input({
      diagnoses: [{ code: 'I21.000x001', role: 'main' }],
    }))
    expect(result.status).toBe('grouped')
    expect(result.mdcCode).toBe('MDCC')
    expect(result.adrgCode).toBe('C11')
    expect(result.steps[0]?.stage).toBe('mdc')
  })

  it('年龄变体组优先：≥70 岁伴 MCC 病例进入带年龄下限的变体组而非普通组', () => {
    const withAgeVariant: DrgRules = drgRulesSchema.parse({
      ...fixture,
      terminalGroups: [
        { adrgCode: 'C11', drgCode: 'C11xE', requires: 'mcc', minAgeYears: 70 },
        ...fixture.terminalGroups.filter(group => group.adrgCode === 'C11'),
      ],
    })
    const result = groupDrgCase(withAgeVariant, input({
      diagnoses: [
        { code: 'I21.000x001', role: 'main' },
        { code: 'I50.000x002', role: 'secondary' },
      ],
      ageYears: 72,
    }))
    expect(result.status).toBe('grouped')
    expect(result.drgCode).toBe('C11xE')
    const younger = groupDrgCase(withAgeVariant, input({
      diagnoses: [
        { code: 'I21.000x001', role: 'main' },
        { code: 'I50.000x002', role: 'secondary' },
      ],
      ageYears: 63,
    }))
    expect(younger.drgCode).toBe('C11x1')
  })

  it('两级 ADRG 无 MCC 专属组时，MCC 病例按序落入「有 MCC 或 CC」组', () => {
    const twoLevel: DrgRules = drgRulesSchema.parse({
      ...fixture,
      terminalGroups: fixture.terminalGroups.filter(group => !(group.adrgCode === 'C11' && group.drgCode === 'C11x1')),
    })
    const result = groupDrgCase(twoLevel, input({
      diagnoses: [
        { code: 'I21.000x001', role: 'main' },
        { code: 'I50.000x002', role: 'secondary' },
      ],
    }))
    expect(result.status).toBe('grouped')
    expect(result.drgCode).toBe('C11x2')
  })
})
