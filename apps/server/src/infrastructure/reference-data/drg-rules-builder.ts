import { drgRulesSchema, type DrgRules } from '@clinmesh/contracts/drg'
import { z } from 'zod'

/** groups.jsonl 投影行（宽松读取，仅取转换所需字段）。 */
const groupRowSchema = z.object({
  level: z.enum(['MDC', 'ADRG', 'DRG']),
  code: z.string().min(1),
  name: z.string().min(1),
  parentCode: z.string().nullable(),
})

/** 官方分组器 JS 提取产物（extractOfficialMembers 输出）。 */
const officialMembersSchema = z.object({
  medical: z.record(z.string(), z.array(z.string().min(1))),
  surgical: z.record(z.string(), z.array(z.string().min(1))),
})

/** OpenDRG chs_drg_30.json 三表（码 → 排除组号）。 */
const complicationTablesSchema = z.object({
  cc: z.record(z.string(), z.string()),
  mcc: z.record(z.string(), z.string()),
  cce: z.record(z.string(), z.string()),
})

export type DrgGroupRow = z.infer<typeof groupRowSchema>
export type DrgOfficialMembers = z.infer<typeof officialMembersSchema>
export type DrgComplicationTables = z.infer<typeof complicationTablesSchema>

const requiresWeight = { 'mcc': 0, 'mcc-or-cc': 1, 'any': 2 } as const

/** 终端病组名称 → 入组谓词；「大于等于70 岁」为官方年龄变体（尾码 E/F/G）。 */
function terminalPredicate(name: string): { requires: 'mcc' | 'mcc-or-cc' | 'any', minAgeYears: number | null } {
  const minAgeYears = name.includes('大于等于70') ? 70 : null
  if (name.includes('不伴')) return { requires: 'any', minAgeYears }
  if (name.includes('伴严重')) return { requires: 'mcc', minAgeYears }
  if (name.includes('伴')) return { requires: 'mcc-or-cc', minAgeYears }
  return { requires: 'any', minAgeYears: null }
}

/**
 * 官方层级投影（groups）+ 官方成员提取产物 + OpenDRG 三表 → 固定版本分组规则集。
 * 成员归属以官方分组器提取为准（r3 rule-members 投影的 ADRG 归属存在错位，不进参数表）；
 * 排除语义与官方分组器同构：主诊断查排除组表（CCE）得组号，次诊断与主诊断同组号时不计。
 * 「主要手术或操作+其他手术或操作」等条件型判定不在首版参数表内，由提取器 stats 如实报告缺口。
 */
export function buildDrgRules(input: {
  groups: unknown
  officialMembers: unknown
  complicationTables?: unknown
}): DrgRules {
  const groups = z.array(groupRowSchema).parse(input.groups)
  const officialMembers = officialMembersSchema.parse(input.officialMembers)
  const tables = input.complicationTables === undefined
    ? null : complicationTablesSchema.parse(input.complicationTables)

  const adrgMdc = new Map<string, string>()
  for (const row of groups) {
    if (row.level === 'ADRG' && row.parentCode !== null) adrgMdc.set(row.code, row.parentCode)
  }
  if (adrgMdc.size === 0) throw new Error('groups 层级中没有任何 ADRG→MDC 归属')

  const members: DrgRules['members'] = []
  const validOperations: DrgRules['validOperations'] = []
  const mdcEntries: DrgRules['mdcEntries'] = []
  const collect = (source: Record<string, string[]>, chapter: 'medical' | 'surgical'): void => {
    for (const [adrgCode, codes] of Object.entries(source)) {
      if (!adrgMdc.has(adrgCode)) throw new Error(`官方成员表的 ADRG ${adrgCode} 不在 groups 层级中`)
      for (const memberCode of codes) {
        if (chapter === 'medical') {
          members.push({ code: memberCode, adrgCode })
          mdcEntries.push({ codePrefix: memberCode, mdcCode: adrgMdc.get(adrgCode)! })
        } else {
          validOperations.push({ code: memberCode, adrgCode })
        }
      }
    }
  }
  collect(officialMembers.medical, 'medical')
  collect(officialMembers.surgical, 'surgical')

  const complications: DrgRules['complications'] = tables === null ? [] : [
    ...Object.entries(tables.mcc).map(([entryCode, groupRef]) => ({ code: entryCode, severity: 2 as const, groupRef })),
    ...Object.entries(tables.cc).map(([entryCode, groupRef]) => ({ code: entryCode, severity: 1 as const, groupRef })),
  ]
  const exclusionGroups: DrgRules['exclusionGroups'] = tables === null ? []
    : Object.entries(tables.cce).map(([entryCode, groupRef]) => ({ code: entryCode, groupRef }))

  const terminalGroups = groups.filter(group => group.level === 'DRG').map(row => {
    if (row.parentCode === null) throw new Error(`DRG 行缺少父 ADRG：${row.code}`)
    return { adrgCode: row.parentCode, drgCode: row.code, ...terminalPredicate(row.name) }
  }).sort((a, b) => {
    // 年龄变体先于普通组（官方函数表顺序：无年龄条件组恒真兜底，顺序颠倒会吞掉变体命中）。
    const ageOrder = (b.minAgeYears === null ? 0 : 1) - (a.minAgeYears === null ? 0 : 1)
    return ageOrder !== 0 ? ageOrder : requiresWeight[a.requires] - requiresWeight[b.requires]
  })

  const rules = drgRulesSchema.parse({
    rulesId: 'drg-chs30-official-projection',
    version: 'placeholder',
    mdcEntries,
    members,
    validOperations,
    complications,
    exclusionGroups,
    adrgMdcEntries: [...adrgMdc].map(([adrgCode, mdcCode]) => ({ adrgCode, mdcCode })),
    terminalGroups,
  })
  return rules
}
