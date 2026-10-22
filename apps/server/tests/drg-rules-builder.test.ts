import { describe, expect, it } from 'vitest'
import { drgRulesSchema } from '@clinmesh/contracts/drg'
import { buildDrgRules } from '../src/infrastructure/reference-data/drg-rules-builder.ts'

/** 按官方投影真实字段形态手工构造的最小切片（字段名与取值来自 r3 投影抽样）。 */
const groups = [
  { level: 'MDC', code: 'MDCA', name: '先期分组疾病', parentCode: null },
  { level: 'MDC', code: 'MDCE', name: '呼吸系统疾病', parentCode: null },
  { level: 'ADRG', code: 'AA1', name: '心肺移植', parentCode: 'MDCA' },
  { level: 'ADRG', code: 'ER1', name: '呼吸系统肿瘤', parentCode: 'MDCE' },
  { level: 'DRG', code: 'AA19', name: '心肺移植', parentCode: 'AA1' },
  { level: 'DRG', code: 'ER11', name: '呼吸系统肿瘤，伴严重合并症或并发症', parentCode: 'ER1' },
  { level: 'DRG', code: 'ER15', name: '呼吸系统肿瘤，不伴合并症或并发症', parentCode: 'ER1' },
  // 官方 ≥70 岁年龄变体（尾码 E/F/G），与普通组同挂一个 ADRG：
  { level: 'DRG', code: 'ER1E', name: '呼吸系统肿瘤，伴严重合并症或并发症，大于等于70 岁', parentCode: 'ER1' },
  { level: 'DRG', code: 'ER1G', name: '呼吸系统肿瘤，不伴合并症或并发症，大于等于70 岁', parentCode: 'ER1' },
]

/** 官方分组器 JS 提取产物形态（extractOfficialMembers 输出）。 */
const officialMembers = {
  medical: { ER1: ['C33.x00', 'C34.000', 'B33.400x001+J17.1*'] },
  surgical: { AA1: ['33.6x00'] },
}

/** OpenDRG chs_drg_30.json 三表切片（形态与真实一致：码 → 排除组号）。 */
const complicationTables = {
  cc: { 'J18.900x003': '2' },
  mcc: { 'I50.000x002': '1' },
  cce: { 'C33.x00': '2' },
}

describe('官方分组器提取产物 + OpenDRG 三表 → 分组规则集转换', () => {
  it('内科成员与主操作分别来自官方成员表两翼；并发症与排除组以 OpenDRG 三表为准', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, officialMembers, complicationTables }))
    expect(rules.members).toContainEqual({ code: 'C33.x00', adrgCode: 'ER1' })
    expect(rules.members).toContainEqual({ code: 'B33.400x001+J17.1*', adrgCode: 'ER1' })
    expect(rules.validOperations).toContainEqual({ code: '33.6x00', adrgCode: 'AA1' })
    expect(rules.complications).toContainEqual({ code: 'I50.000x002', severity: 2, groupRef: '1' })
    expect(rules.complications).toContainEqual({ code: 'J18.900x003', severity: 1, groupRef: '2' })
    expect(rules.exclusionGroups).toContainEqual({ code: 'C33.x00', groupRef: '2' })
  })

  it('MDC 层级与回填表由 groups 派生：ADRG 归属 MDC，内科成员码精确命中', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, officialMembers, complicationTables }))
    expect(rules.adrgMdcEntries).toContainEqual({ adrgCode: 'ER1', mdcCode: 'MDCE' })
    expect(rules.mdcEntries).toContainEqual({ codePrefix: 'C33.x00', mdcCode: 'MDCE' })
    expect(rules.mdcEntries).not.toContainEqual({ codePrefix: '33.6x00', mdcCode: 'MDCA' })
  })

  it('终端组转换为有序谓词：年龄变体排前，名称定并发症条件与年龄下限', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, officialMembers, complicationTables }))
    const er1 = rules.terminalGroups.filter(group => group.adrgCode === 'ER1')
    expect(er1).toEqual([
      { adrgCode: 'ER1', drgCode: 'ER1E', requires: 'mcc', minAgeYears: 70 },
      { adrgCode: 'ER1', drgCode: 'ER1G', requires: 'any', minAgeYears: 70 },
      { adrgCode: 'ER1', drgCode: 'ER11', requires: 'mcc', minAgeYears: null },
      { adrgCode: 'ER1', drgCode: 'ER15', requires: 'any', minAgeYears: null },
    ])
    expect(rules.terminalGroups).toContainEqual({ adrgCode: 'AA1', drgCode: 'AA19', requires: 'any', minAgeYears: null })
  })

  it('未提供 OpenDRG 三表时不构造并发症与排除组，分组仍可用内外科入口', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, officialMembers }))
    expect(rules.complications).toEqual([])
    expect(rules.exclusionGroups).toEqual([])
    expect(rules.members).toContainEqual({ code: 'C33.x00', adrgCode: 'ER1' })
    expect(rules.validOperations).toContainEqual({ code: '33.6x00', adrgCode: 'AA1' })
  })
})
