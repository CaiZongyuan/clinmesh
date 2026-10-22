import { z } from 'zod'

/**
 * 从 OpenDRG 官方分组器 JS 文本中提取官方成员表。
 * 只做正则文本解析，绝不加载或执行 JS 本体（项目规则：OpenDRG 打包 JS 仅作离线事实）。
 * 「主要手术或操作+其他手术或操作」等条件型判定不进参数表，按 ADRG 归并计数报告缺口。
 */

const codeArray = '\\[((?:"[^"]+",?)+)\\]'

/** 判定点形态：`…includes(x.zdList[0])){Q("符合X入组条件，匹配规则：主诊断匹配"` 或 `…includes(x.ssList[0])?(Q("符合X入组条件，匹配规则：主手术匹配"`。MDC 分区判定（组名 MDC 开头）不在此列。 */
const memberPattern = /\[((?:"[^"]+",?\s*)+)\]\.includes\(x\.(zdList|ssList)\[0\]\)[)\s]*(?:\?\s*\(\s*)?\{?\s*Q\("符合((?!MDC)[A-Z0-9]+)入组条件，匹配规则：(主诊断|主手术)匹配"/g
const comboPattern = /符合([A-Z0-9_]+)入组条件，匹配规则：主要手术或操作\+其他手术或操作/g

const extractionStatsSchema = z.object({
  medicalAdrgCount: z.number().int().nonnegative(),
  surgicalAdrgCount: z.number().int().nonnegative(),
  comboOperationAdrgs: z.array(z.string()),
})

export interface OfficialMembers {
  /** ADRG → 内科主诊断成员码（含「主诊断+星号副诊断」组合形态）。 */
  medical: Record<string, string[]>
  /** ADRG → 主手术成员码（仅「主手术匹配」判定；组合手术判定不在此列）。 */
  surgical: Record<string, string[]>
  stats: z.infer<typeof extractionStatsSchema>
}

function collectCodes(innerListText: string): string[] {
  return [...new Set(z.array(z.string().min(1)).parse(
    innerListText.split(',').map(entry => entry.replaceAll('"', '').trim()).filter(entry => entry !== ''),
  ))]
}

export function extractOfficialMembers(jsText: string): OfficialMembers {
  const medical: Record<string, string[]> = {}
  const surgical: Record<string, string[]> = {}
  for (const match of jsText.matchAll(memberPattern)) {
    const listKind = match[2] ?? ''
    const adrgCode = match[3] ?? ''
    const codes = collectCodes(match[1] ?? '')
    const target = listKind === 'zdList' ? medical : surgical
    target[adrgCode] = [...(target[adrgCode] ?? []), ...codes]
  }
  const comboOperationAdrgs = [...new Set(
    [...jsText.matchAll(comboPattern)].map(match => (match[1] ?? '').replace(/_\d+$/, '')),
  )]
  return {
    medical,
    surgical,
    stats: extractionStatsSchema.parse({
      medicalAdrgCount: Object.keys(medical).length,
      surgicalAdrgCount: Object.keys(surgical).length,
      comboOperationAdrgs,
    }),
  }
}
