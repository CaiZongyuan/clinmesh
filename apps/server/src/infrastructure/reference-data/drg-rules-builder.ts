import { drgRulesSchema, type DrgRules } from '@clinmesh/contracts/drg'
import { z } from 'zod'

/** groups.jsonl 投影行（宽松读取，仅取转换所需字段）。 */
const groupRowSchema = z.object({
  level: z.enum(['MDC', 'ADRG', 'DRG']),
  code: z.string().min(1),
  name: z.string().min(1),
  parentCode: z.string().nullable(),
})

/** rule-members.jsonl 投影行（宽松读取：真实行按章节缺省无关字段，统一归一化）。 */
const memberRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  nameText: z.string(),
  chapter: z.string().min(1),
  subsection: z.string().nullish(),
  adrgCode: z.string().nullish(),
  exclusionTable: z.string().nullish(),
  conditionRole: z.string().nullish(),
  memberId: z.string().nullish(),
}).transform(row => ({
  id: row.id,
  code: row.code,
  nameText: row.nameText,
  chapter: row.chapter,
  subsection: row.subsection ?? null,
  adrgCode: row.adrgCode ?? null,
  exclusionTable: row.exclusionTable ?? null,
  conditionRole: row.conditionRole ?? null,
  memberId: row.memberId ?? null,
}))

/** OpenDRG chs_drg_30.json 三表（码 → 排除组号）。 */
const complicationTablesSchema = z.object({
  cc: z.record(z.string(), z.string()),
  mcc: z.record(z.string(), z.string()),
  cce: z.record(z.string(), z.string()),
})

export type DrgGroupRow = z.infer<typeof groupRowSchema>
export type DrgMemberRow = z.infer<typeof memberRowSchema>
export type DrgComplicationTables = z.infer<typeof complicationTablesSchema>

const surgicalRole = '包含以下主要手术或操作'
const medicalRole = '包含以下主要诊断'

/** r3 排除表号（如 '6-5-141'）→ 官方排除组号（'141'）。 */
function groupRefOfTable(exclusionTable: string | null): string {
  if (exclusionTable === null) return ''
  const tail = exclusionTable.split('-').at(-1)
  return tail === undefined || tail === '' ? '' : tail
}

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
 * 官方 PDF 投影（groups + rule-members）+ OpenDRG 三表 → 固定版本分组规则集。
 * 排除语义与官方分组器同构：主诊断查排除组表（CCE）得组号，次诊断与主诊断同组号时不计。
 * 并发症与排除组以 OpenDRG 三表为准（携带组号）；未提供时 r3 子组行降级入库、排除行只计数。
 * 特殊子组规则（高危妊娠、机器人辅助）与人口学 MDC 规则不在首版参数表内，保持缺口而不是虚构覆盖。
 */
export function buildDrgRules(input: { groups: unknown, members: unknown, complicationTables?: unknown }): {
  rules: DrgRules, stats: { skippedExclusions: number },
} {
  const groups = z.array(groupRowSchema).parse(input.groups)
  const rows = z.array(memberRowSchema).parse(input.members)
  const tables = input.complicationTables === undefined
    ? null : complicationTablesSchema.parse(input.complicationTables)

  const members: DrgRules['members'] = []
  const validOperations: DrgRules['validOperations'] = []
  const mdcEntries: DrgRules['mdcEntries'] = []
  const adrgMdc = new Map<string, string>()
  for (const row of groups) {
    if (row.level === 'ADRG' && row.parentCode !== null) adrgMdc.set(row.code, row.parentCode)
  }
  let skippedExclusions = 0
  const complicationsList: DrgRules['complications'] = []

  for (const row of rows) {
    if (row.chapter === 'core_group_rules') {
      const adrgCode = row.adrgCode
      if (adrgCode === null) continue
      if (row.conditionRole !== null && row.conditionRole.includes(surgicalRole)) {
        validOperations.push({ code: row.code, adrgCode })
      } else if (row.conditionRole !== null && row.conditionRole.includes(medicalRole)) {
        members.push({ code: row.code, adrgCode, chapter: 'medical' })
        const mdcCode = adrgMdc.get(adrgCode)
        if (mdcCode !== undefined) mdcEntries.push({ codePrefix: row.code, mdcCode })
      }
      continue
    }
    if (row.chapter !== 'subgroup_rules') continue
    if (row.subsection?.includes('（CC）')) {
      if (tables === null) {
        complicationsList.push({ code: row.code, severity: 1, groupRef: groupRefOfTable(row.exclusionTable) })
      }
    } else if (row.subsection?.includes('（MCC）')) {
      if (tables === null) {
        complicationsList.push({ code: row.code, severity: 2, groupRef: groupRefOfTable(row.exclusionTable) })
      }
    } else if (row.subsection?.includes('排除列表')) {
      // 排除方向以 OpenDRG CCE 为主诊断→组号表；r3 排除行只作对照计数，不转换。
      skippedExclusions += 1
    }
  }

  const complications: DrgRules['complications'] = tables === null ? complicationsList : [
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
  return { rules, stats: { skippedExclusions } }
}
