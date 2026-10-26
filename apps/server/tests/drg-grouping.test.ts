import { describe, expect, it } from 'vitest'
import { drgGroupingResultSchema, type DrgGroupingInput } from '@clinmesh/contracts/drg'
import { buildDrgRules } from '../src/infrastructure/reference-data/drg-rules-builder.ts'
import { extractOfficialProgram } from '../src/infrastructure/reference-data/drg-opendrg-extract.ts'
import { groupDrgCase } from '../src/application/drg-grouping.ts'
import { syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'
const rules = buildDrgRules({ rulesId: 'synthetic-v2', version: 'v2', program: extractOfficialProgram(syntheticDrgSource()), groups: [
  { level: 'MDC', code: 'MDCR', parentCode: null, name: '合成系统' },
  { level: 'ADRG', code: 'RA1', parentCode: 'MDCR', name: '合成入口' },
  { level: 'DRG', code: 'RA15', parentCode: 'RA1', name: '合成终端' },
] })
const input: DrgGroupingInput = { diagnoses: [{ code: 'I10.x09', role: 'main' }], operations: [], gender: 'female',
  ageYears: 42, ageDays: null, birthWeightGrams: null, dischargeMode: '2', inpatientDays: 5 }

describe('固定版本分组公共纯函数', () => {
  it('分组成功结果符合持久化和网络合同，保留有序条件解释', () => {
    const result = drgGroupingResultSchema.parse(groupDrgCase(rules, input))
    expect(result).toMatchObject({ status: 'grouped', drgCode: 'RA15', mdcCode: 'MDCR', adrgCode: 'RA1' })
    expect([...new Set(result.steps.map(step => step.stage))]).toEqual(expect.arrayContaining(['mdc', 'adrg', 'drg']))
  })
  it('无主诊断和无效人口输入作为明确结果返回，不向HTTP抛出schema错误', () => {
    expect(groupDrgCase(rules, { ...input, diagnoses: [] })).toMatchObject({ status: 'invalid-input', drgCode: null })
    expect(groupDrgCase(rules, { ...input, ageYears: -1 })).toMatchObject({ status: 'invalid-input', drgCode: null })
  })
  it('不兼容主诊断无法入组，重复主操作显式歧义', () => {
    expect(groupDrgCase(rules, { ...input, diagnoses: [{ code: 'UNSUPPORTED', role: 'main' }] })).toMatchObject({ status: 'ungroupable', drgCode: null })
    expect(groupDrgCase(rules, { ...input, operations: [{ code: 'A', primary: true }, { code: 'B', primary: true }] }))
      .toMatchObject({ status: 'ambiguous', drgCode: null })
  })
})
