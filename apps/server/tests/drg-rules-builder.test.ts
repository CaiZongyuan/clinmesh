import { describe, expect, it } from 'vitest'
import { buildDrgRules } from '../src/infrastructure/reference-data/drg-rules-builder.ts'
import { extractOfficialProgram } from '../src/infrastructure/reference-data/drg-opendrg-extract.ts'
import { syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'

const groups = [
  { level: 'MDC', code: 'MDCR', name: '合成系统', parentCode: null },
  { level: 'ADRG', code: 'RA1', name: '合成入口', parentCode: 'MDCR' },
  { level: 'DRG', code: 'RA15', name: '含有误导性的伴严重文字不参与计算', parentCode: 'RA1' },
]
const program = extractOfficialProgram(syntheticDrgSource())
const identity = { rulesId: 'synthetic-v2', version: 'test-1' }

describe('完整条件程序与层级、参数交叉核对', () => {
  it('组名变化不改变计算规则，规则身份独立保留', () => {
    const original = buildDrgRules({ groups, program, ...identity })
    const renamed = buildDrgRules({ groups: groups.map(row => ({ ...row, name: '任意展示名' })), program, ...identity })
    expect(renamed).toEqual(original)
    expect(original.rulesId).toBe('synthetic-v2')
  })
  it('检出遗漏终端、额外终端和错误父级，不以部分成员成功代替完整覆盖', () => {
    expect(() => buildDrgRules({ groups: groups.slice(0, 2), program, ...identity })).toThrow(/coverage mismatch/)
    expect(() => buildDrgRules({ groups: [...groups, { ...groups[2], code: 'RA19' }], program, ...identity })).toThrow(/coverage mismatch/)
    expect(() => buildDrgRules({ groups: groups.map(row => row.code === 'RA15' ? { ...row, parentCode: 'MDCR' } : row), program, ...identity })).toThrow(/parent mismatch/)
  })
  it('源码参数与独立参数表失配时拒绝构建', () => {
    expect(() => buildDrgRules({ groups, program, ...identity,
      complicationTables: { CC: { X: '1' }, MCC: {}, CCE: {} } })).toThrow(/parameter mismatch: CC/)
    expect(() => buildDrgRules({ groups, program, ...identity,
      complicationTables: { CC: {}, MCC: {}, CCE: {}, SS_VALID: ['OP'] } })).toThrow(/parameter mismatch: SS_VALID/)
  })
})
