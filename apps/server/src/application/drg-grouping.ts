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

/**
 * 次诊断的并发症分级：返回命中的最高级别（2=MCC，1=CC），被主诊断排除或未命中返回 null。
 * 排除语义与官方分组器同构：主诊断查排除组表得组号；次诊断与主诊断同组号时不计。
 */
function complicationSeverity(rules: DrgRules, mainCode: string, secondaryCode: string): 1 | 2 | null {
  const mainGroup = rules.exclusionGroups.find(entry => entry.code === mainCode)?.groupRef ?? ''
  let severity: 1 | 2 | null = null
  for (const entry of rules.complications) {
    if (entry.code !== secondaryCode) continue
    if (mainGroup !== '' && entry.groupRef === mainGroup) continue
    if (severity === null || entry.severity > severity) severity = entry.severity
  }
  return severity
}

/**
 * 终端病组选择：与官方函数表同构，按列表顺序取首个满足并发症与年龄条件的组。
 * 「any」为无条件兜底（官方「无 MCC 和 CC」组谓词恒真，语义由匹配顺序保证）。
 */
function terminalCode(rules: DrgRules, adrgCode: string, severity: 1 | 2 | null, ageYears: number): { code: string | null, basis: string } {
  const requiresLabel: Record<DrgRules['terminalGroups'][number]['requires'], string> = {
    'mcc': '有严重并发症或合并症（MCC）',
    'mcc-or-cc': '有并发症或合并症（MCC 或 CC）',
    'any': '不伴并发症或合并症',
  }
  for (const group of rules.terminalGroups) {
    if (group.adrgCode !== adrgCode) continue
    const severityOk = group.requires === 'mcc' ? severity === 2
      : group.requires === 'mcc-or-cc' ? severity !== null
      : true
    const ageOk = group.minAgeYears === null || ageYears >= group.minAgeYears
    if (severityOk && ageOk) {
      const ageLabel = group.minAgeYears === null ? '' : `，年龄 ≥ ${group.minAgeYears} 岁`
      return { code: group.drgCode, basis: `按条件「${requiresLabel[group.requires]}${ageLabel}」选择病组` }
    }
  }
  return { code: null, basis: `ADRG ${adrgCode} 没有满足病例条件的终端病组` }
}

/** 星号副诊断组合成员（「主诊断+副诊断*」）：主诊断与指定副诊断同时出现才命中。 */
function comboMemberMatches(input: DrgGroupingInput, entryCode: string, mainCode: string): boolean {
  const plus = entryCode.indexOf('+')
  if (plus === -1) return entryCode === mainCode
  if (entryCode.slice(0, plus) !== mainCode) return false
  const companion = entryCode.slice(plus + 1).replace(/\*$/, '')
  return input.diagnoses.some(diagnosis => diagnosis.role === 'secondary' && diagnosis.code === companion)
}

/** 内科成员查找：组合成员更特异，优先于普通成员。 */
function findMedicalMember(rules: DrgRules, input: DrgGroupingInput, mainCode: string): DrgRules['members'][number] | undefined {
  const combo = rules.members.find(entry => entry.chapter === 'medical' && entry.code.includes('+')
    && comboMemberMatches(input, entry.code, mainCode))
  if (combo !== undefined) return combo
  return rules.members.find(entry => entry.chapter === 'medical' && !entry.code.includes('+') && entry.code === mainCode)
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
  let mdcCode = mdc.mdcCode
  if (mdcCode === null) {
    // MDC 前缀表缺失时的回填：先按主诊断内科成员或主操作定位候选 ADRG，再由 ADRG 归属得 MDC。
    const memberAdrg = findMedicalMember(rules, input, main.code)?.adrgCode ?? null
    const candidateAdrg = memberAdrg ?? [...new Set(input.operations.filter(operation => operation.primary)
      .map(operation => rules.validOperations.find(entry => entry.code === operation.code)?.adrgCode)
      .filter((value): value is string => value !== undefined))][0] ?? null
    const backfilled = candidateAdrg === null
      ? null : rules.adrgMdcEntries.find(entry => entry.adrgCode === candidateAdrg)?.mdcCode ?? null
    if (backfilled === null) {
      return { status: 'ungroupable', drgCode: null, mdcCode: null, adrgCode: null,
        steps, reason: mdc.basis }
    }
    mdcCode = backfilled
    steps.push({ stage: 'mdc', basis: `MDC 前缀表未命中，按候选 ADRG ${candidateAdrg} 归属回填`,
      matchedCode: main.code, result: backfilled })
  } else {
    steps.push({ stage: 'mdc', basis: mdc.basis, matchedCode: main.code, result: mdcCode })
  }
  const mdcResolved = mdcCode

  const primaryOperations = input.operations.filter(operation => operation.primary)
  const operationAdrgs = [...new Set(primaryOperations
    .map(operation => rules.validOperations.find(entry => entry.code === operation.code)?.adrgCode)
    .filter((value): value is string => value !== undefined))]
  let adrgCode: string | null
  if (operationAdrgs.length > 1) {
    return { status: 'ambiguous', drgCode: null, mdcCode: mdcResolved, adrgCode: null,
      steps, reason: `多个主操作命中不同 ADRG（${operationAdrgs.join('、')}），病案歧义` }
  }
  if (operationAdrgs.length === 1) {
    adrgCode = operationAdrgs[0]!
    steps.push({ stage: 'adrg', basis: `主操作命中有效操作表`, matchedCode: primaryOperations[0]!.code, result: adrgCode })
  } else {
    const member = findMedicalMember(rules, input, main.code)
    if (member === undefined) {
      return { status: 'ungroupable', drgCode: null, mdcCode: mdcResolved, adrgCode: null,
        steps, reason: `主诊断 ${main.code} 不属于内科成员且无命中有效操作表的主操作` }
    }
    adrgCode = member.adrgCode
    steps.push({ stage: 'adrg', basis: '无有效主操作，按主诊断内科成员表进入', matchedCode: main.code, result: adrgCode })
  }

  let severity: 1 | 2 | null = null
  const matchedSecondary: string[] = []
  for (const entry of input.diagnoses) {
    if (entry.role !== 'secondary') continue
    const level = complicationSeverity(rules, main.code, entry.code)
    if (level === null) continue
    if (severity === null || level > severity) severity = level
    matchedSecondary.push(entry.code)
  }
  const terminal = terminalCode(rules, adrgCode, severity, input.ageYears)
  if (terminal.code === null) {
    return { status: 'ungroupable', drgCode: null, mdcCode: mdcResolved, adrgCode,
      steps, reason: terminal.basis }
  }
  steps.push({
    stage: 'drg',
    basis: matchedSecondary.length > 0 ? `次诊断 ${matchedSecondary.join('、')} 参与并发症判定` : '无次诊断参与并发症判定',
    matchedCode: severity === null ? null : matchedSecondary[0] ?? null,
    result: terminal.code,
  })

  return { status: 'grouped', drgCode: terminal.code, mdcCode: mdcResolved, adrgCode, steps, reason: null }
}
