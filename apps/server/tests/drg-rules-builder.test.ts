import { describe, expect, it } from 'vitest'
import { drgRulesSchema } from '@clinmesh/contracts/drg'
import { buildDrgRules, type DrgGroupRow, type DrgMemberRow } from '../src/infrastructure/reference-data/drg-rules-builder.ts'

/** 按官方投影真实字段形态手工构造的最小切片（字段名与取值来自 r3 投影抽样）。 */
const groups: DrgGroupRow[] = [
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

const members: DrgMemberRow[] = [
  { id: 'm1', code: '33.6x00', nameText: '心脏-肺联合移植术', chapter: 'core_group_rules', subsection: null,
    adrgCode: 'AA1', exclusionTable: null, conditionRole: '包含以下主要手术或操作：', memberId: null },
  { id: 'm2', code: 'C33.x00', nameText: '气管恶性肿瘤', chapter: 'core_group_rules', subsection: null,
    adrgCode: 'ER1', exclusionTable: null, conditionRole: '包含以下主要诊断：', memberId: null },
  { id: 'm3', code: 'C34.000', nameText: '主支气管恶性肿瘤', chapter: 'core_group_rules', subsection: null,
    adrgCode: 'ER1', exclusionTable: null, conditionRole: '包含以下主要诊断：', memberId: null },
]

/** OpenDRG chs_drg_30.json 三表切片（形态与真实一致：码 → 排除组号）。 */
const complicationTables = {
  cc: { 'J18.900x003': '2' },
  mcc: { 'I50.000x002': '1' },
  cce: { 'C33.x00': '2' },
}

describe('官方投影 + OpenDRG 三表 → 分组规则集转换', () => {
  it('成员行按条件角色分流内外科；并发症与排除组以 OpenDRG 三表为准', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, members, complicationTables }).rules)
    expect(rules.validOperations).toContainEqual({ code: '33.6x00', adrgCode: 'AA1' })
    expect(rules.members).toContainEqual({ code: 'C33.x00', adrgCode: 'ER1', chapter: 'medical' })
    expect(rules.complications).toContainEqual({ code: 'I50.000x002', severity: 2, groupRef: '1' })
    expect(rules.complications).toContainEqual({ code: 'J18.900x003', severity: 1, groupRef: '2' })
    expect(rules.exclusionGroups).toContainEqual({ code: 'C33.x00', groupRef: '2' })
  })

  it('r3 子组行（CC/MCC/排除列表）不与 OpenDRG 三表重复入库', () => {
    const withSubgroups: DrgMemberRow[] = [...members,
      { id: 'm4', code: 'J18.900x003', nameText: '肺炎', chapter: 'subgroup_rules', subsection: '4.合并症或并发症（CC）',
        adrgCode: null, exclusionTable: null, conditionRole: null, memberId: null },
      { id: 'm5', code: 'I50.000x002', nameText: '心力衰竭', chapter: 'subgroup_rules', subsection: '3.严重合并症或并发症（MCC）',
        adrgCode: null, exclusionTable: null, conditionRole: null, memberId: null },
      { id: 'm6', code: 'A00.900', nameText: '霍乱', chapter: 'subgroup_rules', subsection: '5.合并症或并发症排除列表',
        adrgCode: null, exclusionTable: '6-5-1', conditionRole: null, memberId: null },
    ]
    const { rules, stats } = buildDrgRules({ groups, members: withSubgroups, complicationTables })
    expect(rules.complications.filter(entry => entry.code === 'J18.900x003')).toHaveLength(1)
    expect(rules.complications.filter(entry => entry.code === 'I50.000x002')).toHaveLength(1)
    expect(stats.skippedExclusions).toBe(1)
  })

  it('未提供 OpenDRG 三表时，r3 CC/MCC 行降级入库（组号取表号尾段），排除行只计数', () => {
    const withSubgroups: DrgMemberRow[] = [
      { id: 'm4', code: 'J18.900x003', nameText: '肺炎', chapter: 'subgroup_rules', subsection: '4.合并症或并发症（CC）',
        adrgCode: null, exclusionTable: '6-5-2', conditionRole: null, memberId: null },
      { id: 'm5', code: 'I50.000x002', nameText: '心力衰竭', chapter: 'subgroup_rules', subsection: '3.严重合并症或并发症（MCC）',
        adrgCode: null, exclusionTable: null, conditionRole: null, memberId: null },
      { id: 'm6', code: 'A00.900', nameText: '霍乱', chapter: 'subgroup_rules', subsection: '5.合并症或并发症排除列表',
        adrgCode: null, exclusionTable: '6-5-1', conditionRole: null, memberId: 'm2' },
    ]
    const { rules, stats } = buildDrgRules({ groups, members: withSubgroups })
    expect(rules.complications).toContainEqual({ code: 'J18.900x003', severity: 1, groupRef: '2' })
    expect(rules.complications).toContainEqual({ code: 'I50.000x002', severity: 2, groupRef: '' })
    expect(rules.exclusionGroups).toEqual([])
    expect(stats.skippedExclusions).toBe(1)
  })

  it('MDC 层级与回填表由 groups 派生：ADRG 归属 MDC，内科成员码精确命中', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, members, complicationTables }).rules)
    expect(rules.adrgMdcEntries).toContainEqual({ adrgCode: 'ER1', mdcCode: 'MDCE' })
    expect(rules.mdcEntries).toContainEqual({ codePrefix: 'C33.x00', mdcCode: 'MDCE' })
    expect(rules.mdcEntries).not.toContainEqual({ codePrefix: '33.6x00', mdcCode: 'MDCA' })
  })

  it('终端组转换为有序谓词：年龄变体排前，名称定并发症条件与年龄下限', () => {
    const rules = drgRulesSchema.parse(buildDrgRules({ groups, members, complicationTables }).rules)
    const er1 = rules.terminalGroups.filter(group => group.adrgCode === 'ER1')
    expect(er1).toEqual([
      { adrgCode: 'ER1', drgCode: 'ER1E', requires: 'mcc', minAgeYears: 70 },
      { adrgCode: 'ER1', drgCode: 'ER1G', requires: 'any', minAgeYears: 70 },
      { adrgCode: 'ER1', drgCode: 'ER11', requires: 'mcc', minAgeYears: null },
      { adrgCode: 'ER1', drgCode: 'ER15', requires: 'any', minAgeYears: null },
    ])
    expect(rules.terminalGroups).toContainEqual({ adrgCode: 'AA1', drgCode: 'AA19', requires: 'any', minAgeYears: null })
  })

  it('特殊子组规则行不进入首版参数表，避免虚构分组能力', () => {
    const { rules } = buildDrgRules({ groups, members: [...members,
      { id: 'm7', code: 'O80.000', nameText: '高危妊娠示例', chapter: 'subgroup_rules', subsection: '2.高危妊娠',
        adrgCode: null, exclusionTable: null, conditionRole: null, memberId: null },
    ], complicationTables })
    expect(rules.complications.some(entry => entry.code === 'O80.000')).toBe(false)
    expect(rules.members.some(entry => entry.code === 'O80.000')).toBe(false)
  })
})
