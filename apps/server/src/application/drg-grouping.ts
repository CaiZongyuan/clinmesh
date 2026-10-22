import { drgGroupingInputSchema, drgRulesSchema,
  type DrgGroupingInput, type DrgGroupingResult, type DrgRules } from '@clinmesh/contracts/drg'

interface Step {
  stage: 'mdc' | 'adrg' | 'drg'
  basis: string
  matchedCode: string | null
  result: string
}

function findMdc(rules: DrgRules, mainCode: string): { mdcCode: string | null, basis: string } {
  let best: { prefix: string, mdcCode: string } | null = null
  for (const entry of rules.mdcEntries) {
    if (!mainCode.startsWith(entry.codePrefix)) continue
    if (best === null || entry.codePrefix.length > best.prefix.length) best = { prefix: entry.codePrefix, mdcCode: entry.mdcCode }
  }
  return best === null
    ? { mdcCode: null, basis: `主诊断 ${mainCode} 未命中任何 MDC 规则前缀` }
    : { mdcCode: best.mdcCode, basis: `主诊断前缀 ${best.prefix} 命中 MDC 规则` }
}

/** 次诊断的并发症分级：返回命中的最高级别（2=MCC，1=CC），被所在 ADRG 排除或未命中返回 null。 */
function complicationSeverity(rules: DrgRules, adrgCode: string, secondaryCode: string): 1 | 2 | null {
  const excluded = rules.exclusions.some(entry => entry.ownerCode === adrgCode && entry.excludedCode === secondaryCode)
  if (excluded) return null
  let severity: 1 | 2 | null = null
  for (const entry of rules.complications) {
    if (entry.code !== secondaryCode) continue
    if (severity === null || entry.severity > severity) severity = entry.severity
  }
  return severity
}

function terminalCode(rules: DrgRules, adrgCode: string, severity: 1 | 2 | null): { code: string | null, basis: string } {
  const group = rules.terminalGroups.find(entry => entry.adrgCode === adrgCode)
  if (group === undefined) return { code: null, basis: `ADRG ${adrgCode} 缺少病组终端表` }
  const selected = severity === 2 ? (group.withMccCode ?? group.withCcCode ?? group.withoutCode)
    : severity === 1 ? (group.withCcCode ?? group.withoutCode)
      : group.withoutCode
  const level = severity === 2 ? '伴严重并发症' : severity === 1 ? '伴并发症' : '不伴并发症'
  return { code: selected, basis: `按并发症级别「${level}」选择病组` }
}

/**
 * CHS-DRG 3.0 分组流程：有顺序的诊断/操作与人口属性 → 病组与解释路径。
 * 输入口径为医保版编码；规则集必须为固定版本，分组结果可追溯到 rulesId/version。
 */
export function groupDrgCase(rules: DrgRules, rawInput: DrgGroupingInput): DrgGroupingResult {
  const input = drgGroupingInputSchema.parse(rawInput)
  drgRulesSchema.parse(rules)
  const steps: Step[] = []
  const main = input.diagnoses.find(entry => entry.role === 'main')
  if (main === undefined) {
    return { status: 'invalid-input', drgCode: null, mdcCode: null, adrgCode: null,
      steps, reason: '缺少主诊断，无法进入分组' }
  }

  const mdc = findMdc(rules, main.code)
  if (mdc.mdcCode === null) {
    return { status: 'ungroupable', drgCode: null, mdcCode: null, adrgCode: null,
      steps, reason: mdc.basis }
  }
  steps.push({ stage: 'mdc', basis: mdc.basis, matchedCode: main.code, result: mdc.mdcCode })

  const primaryOperations = input.operations.filter(operation => operation.primary)
  const operationAdrgs = [...new Set(primaryOperations
    .map(operation => rules.validOperations.find(entry => entry.code === operation.code)?.adrgCode)
    .filter((value): value is string => value !== undefined))]
  let adrgCode: string | null
  if (operationAdrgs.length > 1) {
    return { status: 'ambiguous', drgCode: null, mdcCode: mdc.mdcCode, adrgCode: null,
      steps, reason: `多个主操作命中不同 ADRG（${operationAdrgs.join('、')}），病案歧义` }
  }
  if (operationAdrgs.length === 1) {
    adrgCode = operationAdrgs[0]!
    steps.push({ stage: 'adrg', basis: `主操作命中有效操作表`, matchedCode: primaryOperations[0]!.code, result: adrgCode })
  } else {
    const member = rules.members.find(entry => entry.code === main.code && entry.chapter === 'medical')
    if (member === undefined) {
      return { status: 'ungroupable', drgCode: null, mdcCode: mdc.mdcCode, adrgCode: null,
        steps, reason: `主诊断 ${main.code} 不属于内科成员且无命中有效操作表的主操作` }
    }
    adrgCode = member.adrgCode
    steps.push({ stage: 'adrg', basis: '无有效主操作，按主诊断内科成员表进入', matchedCode: main.code, result: adrgCode })
  }

  let severity: 1 | 2 | null = null
  const matchedSecondary: string[] = []
  for (const entry of input.diagnoses) {
    if (entry.role !== 'secondary') continue
    const level = complicationSeverity(rules, adrgCode, entry.code)
    if (level === null) continue
    if (severity === null || level > severity) severity = level
    matchedSecondary.push(entry.code)
  }
  const terminal = terminalCode(rules, adrgCode, severity)
  if (terminal.code === null) {
    return { status: 'ungroupable', drgCode: null, mdcCode: mdc.mdcCode, adrgCode,
      steps, reason: terminal.basis }
  }
  steps.push({
    stage: 'drg',
    basis: matchedSecondary.length > 0 ? `次诊断 ${matchedSecondary.join('、')} 参与并发症判定` : '无次诊断参与并发症判定',
    matchedCode: severity === null ? null : matchedSecondary[0] ?? null,
    result: terminal.code,
  })

  return { status: 'grouped', drgCode: terminal.code, mdcCode: mdc.mdcCode, adrgCode, steps, reason: null }
}
