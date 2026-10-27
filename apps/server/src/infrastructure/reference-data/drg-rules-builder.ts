import { z } from 'zod'
import { drgRulesSchema, type DrgRules } from '@clinmesh/contracts/drg'

const groupRowSchema = z.object({
  level: z.enum(['MDC', 'ADRG', 'DRG']), code: z.string().min(1), name: z.string().min(1),
  parentCode: z.string().nullable(),
})
const complicationTablesSchema = z.object({
  CC: z.record(z.string(), z.string()), MCC: z.record(z.string(), z.string()), CCE: z.record(z.string(), z.string()),
  SS_VALID: z.array(z.string()).optional(),
})
export type DrgGroupRow = z.infer<typeof groupRowSchema>

/** 原程序定义计算，层级投影负责检出缺组/错父级；名称不参与谓词生成。 */
export function buildDrgRules(input: {
  groups: unknown, program: unknown, complicationTables?: unknown, rulesId: string, version: string,
}): DrgRules {
  const groups = z.array(groupRowSchema).parse(input.groups)
  const rules = drgRulesSchema.parse({ rulesId: input.rulesId, version: input.version, program: input.program })
  const { program } = rules
  const tables = input.complicationTables === undefined ? null : complicationTablesSchema.parse(input.complicationTables)
  const identity = (table: Record<string, string>) => JSON.stringify(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
  for (const [name, actual] of [['CC', program.complications.cc], ['MCC', program.complications.mcc], ['CCE', program.complications.cce]] as const) {
    if (tables !== null && identity(tables[name]) !== identity(actual)) throw new Error(`DRG source parameter mismatch: ${name}`)
  }
  if (tables?.SS_VALID !== undefined && JSON.stringify([...new Set(tables.SS_VALID)].sort()) !== JSON.stringify([...new Set(program.validOperations)].sort())) {
    throw new Error('DRG source parameter mismatch: SS_VALID')
  }
  const entries = new Map(groups.map(group => [group.code, group]))
  if (entries.size !== groups.length) throw new Error('DRG hierarchy contains duplicate codes')
  for (const row of groups) {
    if (row.level === 'MDC') {
      if (row.parentCode !== null) throw new Error(`MDC has unexpected parent: ${row.code}`)
      continue
    }
    const parent = row.parentCode === null ? undefined : entries.get(row.parentCode)
    if (parent?.level !== (row.level === 'DRG' ? 'ADRG' : 'MDC')) throw new Error(`DRG hierarchy parent mismatch: ${row.code}`)
    if (row.level === 'DRG' && (row.parentCode !== row.code.slice(0, 3) || parent.parentCode !== `MDC${row.code[0]}`)) {
      throw new Error(`DRG hierarchy differs from source result identity: ${row.code}`)
    }
  }
  for (const [level, declared] of [['DRG', program.coverage.drgCodes], ['ADRG', program.coverage.adrgCodes.filter(code => !code.includes('QY'))], ['MDC', program.coverage.mdcCodes]] as const) {
    const expected = groups.filter(row => row.level === level).map(row => row.code).sort()
    if (JSON.stringify(expected) !== JSON.stringify([...new Set(declared)].sort())) {
      const missing = expected.filter(code => !declared.includes(code))
      const extra = declared.filter(code => !expected.includes(code))
      throw new Error(`DRG condition coverage mismatch (${level}): missing=${missing.join(',')}; extra=${extra.join(',')}`)
    }
  }
  return rules
}
