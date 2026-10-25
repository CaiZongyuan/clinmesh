import { createHash } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { z } from 'zod'
import ts from 'typescript'
import { drgGroupingInputSchema, type DrgGroupingInput, type DrgGroupingResult } from '@clinmesh/contracts/drg'

export const lockedOpenDrg30SourceSha256 = '70c00d9ef9b02c1556b8a96ece350f6ce3d1fd2b6f9dd8ea80c2ec7d2ba0f0ff'

const oracleResultSchema = z.object({
  status: z.enum(['分组成功', '无法入组', '歧义病案', '信息校验不通过']),
  mdc: z.string(), adrg: z.string(), drg: z.string(), messages: z.array(z.string()),
})

export interface DrgOracleResult {
  status: DrgGroupingResult['status']
  drgCode: string | null
  adrgCode: string | null
  mdcCode: string | null
  messages: string[]
}

export interface DrgVerificationCase {
  id: string
  input: DrgGroupingInput
  inputSource: string
  sourceOffset: number
  conditionKinds: string[]
  /** 人工独立推导；省略时仅以锁定原程序作实现一致性对照。 */
  expected?: { status: DrgGroupingResult['status'], drgCode: string | null }
}

/** 预期按锁定源的命名条件及 CC/MCC/CCE 参数逐例推导，独立于 ClinMesh 的输出。 */
export function createDrgIndependentVerificationCases(): DrgVerificationCase[] {
  const base: DrgGroupingInput = { diagnoses: [{ code: 'I10.x09', role: 'main' }], operations: [], gender: 'male',
    ageYears: 40, ageDays: 365, birthWeightGrams: 3000, dischargeMode: '1', inpatientDays: 5 }
  const diagnosis = (main: string, secondary: string[] = []) => [{ code: main, role: 'main' as const },
    ...secondary.map(code => ({ code, role: 'secondary' as const }))]
  const operation = (primary: string, secondary: string[] = []) => [{ code: primary, primary: true },
    ...secondary.map(code => ({ code, primary: false }))]
  const result: DrgVerificationCase[] = []
  const add = (id: string, expected: string | null, input: Partial<DrgGroupingInput>, explanation: string,
    offset: number, kinds: string[], status: DrgGroupingResult['status'] = 'grouped'): void => {
    result.push({ id: `independent:${id}`, input: { ...base, ...input }, inputSource: `合成固定病例；${explanation}`,
      sourceOffset: offset, conditionKinds: kinds, expected: { status, drgCode: expected } })
  }
  add('hypertension', 'FV29', {}, 'I10.x09 命中 FV2；FV29 不细分', 1185104, ['main-diagnosis'])
  add('pre-mdc-priority', 'AA19', { operations: operation('33.6x00') }, 'MDCA 肺移植先于主诊断 MDC，AA19 不细分', 680859, ['mdc-priority', 'main-operation'])
  add('combined-operation', 'AC19', { operations: operation('52.8000', ['55.6100']) }, 'AC1_1 要求胰腺主操作与肾脏副操作', 681707, ['secondary-operation', 'main-operation'])
  add('combined-operation-reverse', 'AC19', { operations: operation('55.6100', ['52.8000']) }, 'AC1_2 明确支持相反主次顺序', 681927, ['secondary-operation', 'operation-order'])
  add('no-complication', 'EZ15', { diagnoses: diagnosis('A19.800') }, 'EZ1 无并发症进入 EZ15', 1102907, ['main-diagnosis', 'cc-mcc'])
  add('cc', 'EZ13', { diagnoses: diagnosis('A19.800', ['A01.000x009']) }, 'CCE(A19.800)=2，CC(A01.000x009)=1，不被排除', 1102907, ['cc-mcc', 'exclusion'])
  add('cc-excluded', 'EZ15', { diagnoses: diagnosis('A19.800', ['A15.000x001']) }, 'CCE 与 CC 同为排除组 2，不计并发症', 1102907, ['cc-mcc', 'exclusion'])
  add('mcc-excluded', 'EZ15', { diagnoses: diagnosis('A19.800', ['A19.000']) }, 'CCE 与 MCC 同为排除组 2，不计并发症', 1102907, ['cc-mcc', 'exclusion'])
  const newborn = { ageYears: 0, ageDays: 10, birthWeightGrams: 2000 }
  add('premature-no-cc', 'PS45', { ...newborn, diagnoses: diagnosis('A04.000x001', ['P07.200']) }, '任一诊断 P07.200、出生体重 <2500g、日龄 <=28；无 CC/MCC', 709878, ['age-days', 'birth-weight', 'secondary-diagnosis'])
  add('premature-cc', 'PS43', { ...newborn, diagnoses: diagnosis('A04.000x001', ['P07.200', 'A15.000x001']) }, 'CCE 主诊断为1，次诊断 CC 为2，PS4 进入伴 CC 组', 709878, ['age-days', 'birth-weight', 'cc-mcc'])
  add('premature-mcc', 'PS41', { ...newborn, diagnoses: diagnosis('A04.000x001', ['P07.200', 'A19.000']) }, 'CCE 主诊断为1，次诊断 MCC 为2，PS4 优先进入 MCC 组', 709878, ['age-days', 'birth-weight', 'cc-mcc'])
  add('day-29', 'PV15', { ageYears: 0, ageDays: 29, birthWeightGrams: 2000, diagnoses: diagnosis('A04.000x001') }, '日龄 >28 的非新生儿分支；无并发症', 717580, ['age-days'])
  add('day-29-cc', 'PV13', { ageYears: 0, ageDays: 29, birthWeightGrams: 2000, diagnoses: diagnosis('A04.000x001', ['A15.000x001']) }, '日龄 >28 且 CC 不被主诊断排除', 717580, ['age-days', 'cc-mcc'])
  add('robot-secondary', 'GB40', { diagnoses: diagnosis('A00.000x001'), operations: operation('17.3100', ['17.4100']) }, 'GB4 主操作与副操作中的机器人码，终端 GB40 优先', 1227596, ['robot-assisted', 'secondary-operation'])
  const trauma = diagnosis('S01.800x011', ['S21.100x002', 'S31.800x003'])
  add('multiple-trauma', 'ZZ15', { diagnoses: trauma }, '头颈、胸、腹至少两个独立创伤部位，无有效操作和 MCC', 795683, ['multi-trauma', 'secondary-diagnosis'])
  add('multiple-trauma-mcc', 'ZZ11', { diagnoses: [...trauma, { code: 'A00.000x001', role: 'secondary' }] }, '跨部位创伤与不被排除的 MCC', 795683, ['multi-trauma', 'cc-mcc'])
  add('obstetric-severity', 'OB11', { gender: 'female', diagnoses: diagnosis('A34.x00'), operations: operation('74.0x00', ['38.8609']) }, '产科严重诊断表含 A34.x00，OB1 联合操作后进入 OB11', 1630513, ['gender', 'obstetric-severity', 'secondary-operation'])
  add('obstetric-uncomplicated', 'OB15', { gender: 'female', diagnoses: diagnosis('Z64.000x001'), operations: operation('74.0x00', ['38.8609']) }, 'Z64.000x001 不在严重产科诊断表，且无 MCC，进入 OB15', 1630513, ['gender', 'obstetric-severity'])
  add('valid-operation', 'SB15', { diagnoses: diagnosis('A01.000'), operations: operation('39.8101') }, 'MDCS 的有效手术分支 SB1，无并发症', 1801924, ['valid-operation'])
  add('valid-operation-mcc', 'SB11', { diagnoses: diagnosis('A01.000', ['A19.000']), operations: operation('39.8101') }, '有效操作与不被排除的 MCC', 1801924, ['valid-operation', 'cc-mcc'])
  add('age-70', 'XJ1G', { ageYears: 70, diagnoses: diagnosis('B90.000', ['A01.000x009']), operations: operation('39.8101') }, 'XJ1 无 MCC 且年龄 >=70，先命中年龄终端 XJ1G', 1957062, ['age-years', 'terminal-priority'])
  add('hiv-valid-operation', 'YC19', { diagnoses: diagnosis('B20.000x001'), operations: operation('39.8101') }, 'MDCY 主诊断与有效操作，YC19 不细分', 1973678, ['valid-operation', 'main-diagnosis'])
  add('unknown-gender', null, { gender: 'unknown' }, '原程序性别必须为1或2，明确输入无效', 680442, ['gender'], 'invalid-input')
  return result
}

function csvInput(rawInput: DrgGroupingInput): string {
  const input = drgGroupingInputSchema.parse(rawInput)
  const codes = [...input.diagnoses.map(entry => entry.code), ...input.operations.map(entry => entry.code), input.dischargeMode]
  if (codes.some(code => /[,|\r\n]/.test(code))) throw new Error('DRG oracle input contains CSV delimiters')
  return ['synthetic-verification', input.gender === 'male' ? '1' : input.gender === 'female' ? '2' : '9',
    input.ageYears, input.ageDays ?? '', input.birthWeightGrams ?? '', 'synthetic', input.inpatientDays,
    input.dischargeMode, [...input.diagnoses.filter(entry => entry.role === 'main'), ...input.diagnoses.filter(entry => entry.role === 'secondary')].map(entry => entry.code).join('|'),
    [...input.operations.filter(entry => entry.primary), ...input.operations.filter(entry => !entry.primary)].map(entry => entry.code).join('|')].join(',')
}

interface SourceRoute {
  code: string
  offset: number
  node: ts.FunctionExpression
  parent: SourceRoute | undefined
  kinds: string[]
}

interface SourceMembership {
  field: 'diagnosis' | 'operation'
  primary: boolean
  secondaryOnly: boolean
  codes: string[]
}

export interface DrgSourceInventory {
  routes: Array<{ code: string, offset: number, conditionKinds: string[] }>
  terminals: Array<{ code: string, offset: number, predicate: string }>
  shadowedRoutes?: Array<{ code: string, offset: number, shadowedBy: string, shadowingOffset: number,
    mainDiagnosisCount: number, reason: string }>
}

function localWalk(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node)
  ts.forEachChild(node, child => {
    if (!ts.isFunctionLike(child)) localWalk(child, callback)
  })
}

function conditionKinds(text: string): string[] {
  const kinds: string[] = []
  if (/zdList\[0\]/.test(text)) kinds.push('main-diagnosis')
  if (/zdList\.slice\(1\)/.test(text)) kinds.push('secondary-diagnosis')
  if (/ssList\[0\]/.test(text)) kinds.push('main-operation')
  if (/ssList\.slice\(1\)/.test(text)) kinds.push('secondary-operation')
  if (/ssValidList/.test(text)) kinds.push('valid-operation')
  if (/\.gender/.test(text)) kinds.push('gender')
  if (/\.age\b/.test(text)) kinds.push('age-years')
  if (/\.ageDay\b/.test(text)) kinds.push('age-days')
  if (/\.weight\b/.test(text)) kinds.push('birth-weight')
  if (/mccList|ccList/.test(text)) kinds.push('cc-mcc')
  if (/同时包含两个手术/.test(text)) kinds.push('operation-count')
  if (/部位数量/.test(text)) kinds.push('multi-trauma')
  return kinds
}

function sourceRoutes(source: string) {
  const file = ts.createSourceFile('opendrg-chs30.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const routes: SourceRoute[] = []
  const terminals: DrgSourceInventory['terminals'] = []
  function walk(node: ts.Node, parent: SourceRoute | undefined): void {
    let route = parent
    if (ts.isFunctionExpression(node)) {
      const logs: string[] = []
      localWalk(node.body, child => {
        if (ts.isCallExpression(child) && child.expression.getText(file) === 'Q' && child.arguments[0] !== undefined
          && ts.isStringLiteral(child.arguments[0])) logs.push(child.arguments[0].text)
      })
      const match = logs.map(log => /^符合([A-Z0-9_]+)入组条件，匹配规则：/.exec(log)).find(value => value !== null)
      if (match !== undefined) {
        const localText: string[] = []
        localWalk(node.body, child => { if (ts.isExpression(child) && !ts.isFunctionLike(child)) localText.push(child.getText(file).slice(0, 150)) })
        route = { code: match[1]!, offset: node.getStart(file), node, parent, kinds: conditionKinds(localText.join(' ')) }
        routes.push(route)
      }
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(file).endsWith('_group')) {
      const statement = node.body?.statements.find(ts.isReturnStatement)
      if (statement?.expression !== undefined) terminals.push({ code: node.name.getText(file).replace(/_group$/, ''),
        offset: node.getStart(file), predicate: statement.expression.getText(file).replace(/Q\("[^"]+"\),/, '') })
    }
    ts.forEachChild(node, child => walk(child, route))
  }
  walk(file, undefined)
  return { file, routes, terminals }
}

export function inspectDrgProgramSource(source: string): DrgSourceInventory {
  const { file, routes, terminals } = sourceRoutes(source)
  const shadowedRoutes: NonNullable<DrgSourceInventory['shadowedRoutes']> = []
  for (const route of routes) {
    const parent = route.parent
    if (parent === undefined || !parent.code.startsWith('MDC')) continue
    const parentCodes = routeMemberships(parent, file).filter(entry => entry.field === 'diagnosis' && entry.primary).flatMap(entry => entry.codes)
    if (parentCodes.length === 0) continue
    for (const earlier of routes.filter(entry => entry.parent === parent && entry.offset < route.offset)) {
      const gate = earlier.node.body.statements[0]
      if (gate === undefined || !ts.isIfStatement(gate) || !ts.isCallExpression(gate.expression)
        || !ts.isPropertyAccessExpression(gate.expression.expression) || gate.expression.expression.name.text !== 'includes'
        || gate.expression.arguments[0]?.getText(file) !== 'x.zdList[0]' || !ts.isBlock(gate.thenStatement)) continue
      const returnStatement = gate.thenStatement.statements.at(-1)
      if (returnStatement === undefined || !ts.isReturnStatement(returnStatement) || returnStatement.expression === undefined) continue
      let expression = returnStatement.expression
      let alwaysReturnsGroup = false
      while (ts.isConditionalExpression(expression) && ts.isStringLiteral(expression.whenTrue) && expression.whenTrue.text !== '') {
        if (ts.isStringLiteral(expression.whenFalse) && expression.whenFalse.text === ''
          && ts.isCallExpression(expression.condition) && ts.isPropertyAccessExpression(expression.condition.expression)) {
          const code = expression.condition.expression.name.text.replace(/_group$/, '')
          alwaysReturnsGroup = expression.whenTrue.text === code && terminals.some(terminal => terminal.code === code && terminal.predicate === '!0')
        }
        expression = expression.whenFalse
      }
      if (!alwaysReturnsGroup) continue
      const priorCodes = new Set(routeMemberships(earlier, file).filter(entry => entry.field === 'diagnosis' && entry.primary).flatMap(entry => entry.codes))
      if (!parentCodes.every(code => priorCodes.has(code))) continue
      shadowedRoutes.push({ code: route.code, offset: route.offset, shadowedBy: earlier.code, shadowingOffset: earlier.offset,
        mainDiagnosisCount: new Set(parentCodes).size,
        reason: '所属 MDC 的全部主诊断均被更早的单一主诊断入口包含，且该入口最终终端恒真；按源程序顺序后续路由不可达' })
      break
    }
  }
  return { routes: routes.map(route => ({ code: route.code, offset: route.offset, conditionKinds: route.kinds })), terminals, shadowedRoutes }
}

function routeMemberships(route: SourceRoute, file: ts.SourceFile): SourceMembership[] {
  function codes(expression: ts.Expression, origin: ts.Node): string[] {
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.filter(ts.isStringLiteral).map(element => element.text).filter(value => /^[A-Z0-9][A-Z0-9.]/.test(value))
    if (!ts.isIdentifier(expression)) return []
    let scope: ts.Node | undefined = origin
    while (scope !== undefined) {
      if ((ts.isFunctionExpression(scope) || ts.isFunctionDeclaration(scope) || ts.isMethodDeclaration(scope)
        || ts.isArrowFunction(scope)) && scope.body !== undefined) {
        let result: ts.Expression | undefined
        localWalk(scope.body, node => {
          if (ts.isVariableDeclaration(node) && node.name.getText(file) === expression.text && node.initializer !== undefined) result = node.initializer
        })
        if (result !== undefined && result !== expression) return codes(result, scope.parent)
      }
      scope = scope.parent
    }
    return []
  }
  const memberships: SourceMembership[] = []
  localWalk(route.node.body, node => {
    if (!ts.isCallExpression(node)) return
    let list: ts.Expression | undefined
    let selector = ''
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'includes') {
      list = node.expression.expression
      selector = node.arguments[0]?.getText(file) ?? ''
    } else if (node.expression.getText(file) === 'G') {
      list = node.arguments[1]
      selector = node.arguments[0]?.getText(file) ?? ''
    }
    if (list === undefined || !/x\.(zdList|ssList)/.test(selector)) return
    const values = codes(list, node)
    if (values.length === 0) return
    memberships.push({ field: selector.includes('zdList') ? 'diagnosis' : 'operation', primary: selector.includes('[0]'),
      secondaryOnly: selector.includes('slice(1)'), codes: values })
  })
  return memberships
}

/** 每个源路由取得独立成员样例，再按标量边界/CC表生成合成病例；不读取 ClinMesh 分组输出。 */
export function createDrgSourceVerificationCases(source: string, tables: {
  CC: Record<string, string>, MCC: Record<string, string>, CCE: Record<string, string>, SS_VALID?: string[]
}): DrgVerificationCase[] {
  const { file, routes } = sourceRoutes(source)
  const cases: DrgVerificationCase[] = []
  const seen = new Set<string>()
  const add = (route: SourceRoute, suffix: string, input: DrgGroupingInput): void => {
    const identity = JSON.stringify(input)
    if (seen.has(identity)) return
    seen.add(identity)
    cases.push({ id: `${route.code}@${route.offset}:${suffix}`, input, inputSource: '固定锁定原程序路由成员与边界值组成的合成输入',
      sourceOffset: route.offset, conditionKinds: route.kinds })
  }
  for (const route of routes.filter(entry => !entry.code.startsWith('MDC'))) {
    const memberships = routeMemberships(route, file)
    let ancestor = route.parent
    while (ancestor !== undefined && !ancestor.code.startsWith('MDC')) ancestor = ancestor.parent
    const inherited = ancestor === undefined ? [] : routeMemberships(ancestor, file)
    const mainDiagnosis = memberships.filter(entry => entry.field === 'diagnosis' && entry.primary)
    const parentDiagnosis = inherited.filter(entry => entry.field === 'diagnosis' && entry.primary)
    const diagnosisLists = mainDiagnosis.length > 0 ? mainDiagnosis : parentDiagnosis
    const mainCodes = [...new Set(diagnosisLists.flatMap(entry => [entry.codes[0]!, entry.codes[1] ?? entry.codes[0]!, entry.codes.at(-1)!]))].slice(0, 4)
    if (mainDiagnosis.length === 0 && memberships.some(entry => entry.field === 'diagnosis' && entry.secondaryOnly)) {
      const earlierMainCodes = new Set(routes.filter(entry => entry.parent === route.parent && entry.offset < route.offset)
        .flatMap(entry => routeMemberships(entry, file).filter(member => member.field === 'diagnosis' && member.primary).flatMap(member => member.codes)))
      const remainingMain = parentDiagnosis.flatMap(entry => entry.codes).find(code => !earlierMainCodes.has(code))
      if (remainingMain !== undefined && !mainCodes.includes(remainingMain)) mainCodes.push(remainingMain)
    }
    if (ancestor?.code === 'MDCO') {
      const neutralObstetric = parentDiagnosis.flatMap(entry => entry.codes).find(code => code.startsWith('O80'))
      if (neutralObstetric !== undefined && !mainCodes.includes(neutralObstetric)) mainCodes.push(neutralObstetric)
    }
    const traumaRegions: string[] = []
    if (ancestor?.code === 'MDCZ') localWalk(ancestor.node.body, node => {
      if (!ts.isArrayLiteralExpression(node)) return
      for (let index = 0; index < node.elements.length - 1; index += 1) {
        const label = node.elements[index], code = node.elements[index + 1]
        if (label !== undefined && code !== undefined && ts.isStringLiteral(label) && ts.isStringLiteral(code)
          && label.text.endsWith('创伤')) traumaRegions.push(code.text)
      }
    })
    if (mainCodes.length === 0 && traumaRegions[0] !== undefined) mainCodes.push(traumaRegions[0])
    if (mainCodes.length === 0) mainCodes.push('I10.x09')
    const operationLists = memberships.filter(entry => entry.field === 'operation' && entry.primary)
    const operationCodes = [...new Set(operationLists.flatMap(entry => [entry.codes[0]!, entry.codes[1] ?? entry.codes[0]!, entry.codes.at(-1)!]))].slice(0, 4)
    if (operationCodes.length === 0) {
      const anyOperation = memberships.find(entry => entry.field === 'operation' && !entry.primary && !entry.secondaryOnly)
      if (anyOperation !== undefined) operationCodes.push(anyOperation.codes[0]!)
    }
    if (operationCodes.length === 0 && route.kinds.includes('valid-operation') && !route.node.getText(file).includes('匹配规则：无手术')) {
      operationCodes.push(tables.SS_VALID?.at(-1) ?? '01.0100')
    }
    if (operationCodes.length === 0) operationCodes.push('')
    const secondaryDiagnoses = [...memberships.filter(entry => entry.field === 'diagnosis' && !entry.primary).map(entry => entry.codes[0]!), ...traumaRegions.slice(1, 3)]
    const secondaryOperations = memberships.filter(entry => entry.field === 'operation' && !entry.primary).map(entry => entry.codes[0]!)
    if (route.kinds.includes('operation-count') && operationLists[0]?.codes[1] !== undefined) secondaryOperations.push(operationLists[0].codes[1])
    const neonatal = ancestor?.code === 'MDCP'
    const firstMain = mainCodes[0]!
    const diagnosisEntries = (main: string, extra: string[] = []) => [
      { code: main, role: 'main' as const }, ...[...new Set([...secondaryDiagnoses, ...extra])].filter(code => code !== main)
        .map(code => ({ code, role: 'secondary' as const })),
    ]
    const operations = (main: string) => main === '' ? [] : [
      { code: main, primary: true }, ...[...new Set(secondaryOperations)].filter(code => code !== main).map(code => ({ code, primary: false })),
    ]
    const base: DrgGroupingInput = { diagnoses: diagnosisEntries(firstMain), operations: operations(operationCodes[0]!),
      gender: 'male', ageYears: neonatal ? 0 : 40, ageDays: neonatal ? 10 : 365, birthWeightGrams: 3000, dischargeMode: '1', inpatientDays: 5 }
    const cc = Object.keys(tables.CC).find(code => tables.CC[code] !== tables.CCE[firstMain] && code !== firstMain)
    const mcc = Object.keys(tables.MCC).find(code => tables.MCC[code] !== tables.CCE[firstMain] && code !== firstMain)
    add(route, 'base', base)
    for (const [label, extra] of [['cc', cc], ['mcc', mcc]] as const) if (extra !== undefined) {
      add(route, label, { ...base, diagnoses: diagnosisEntries(firstMain, [extra]) })
      if (!neonatal) add(route, `${label}-70`, { ...base, ageYears: 70, diagnoses: diagnosisEntries(firstMain, [extra]) })
    }
    add(route, 'female', { ...base, gender: 'female' })
    add(route, 'female-70', { ...base, gender: 'female', ageYears: 70 })
    for (const [label, extra] of [['cc', cc], ['mcc', mcc]] as const) if (extra !== undefined) {
      add(route, `${label}-female`, { ...base, gender: 'female', diagnoses: diagnosisEntries(firstMain, [extra]) })
      add(route, `${label}-neonatal-low-weight`, { ...base, ageYears: 0, ageDays: 10, birthWeightGrams: 2000, diagnoses: diagnosisEntries(firstMain, [extra]) })
      add(route, `${label}-neonatal-day-29`, { ...base, ageYears: 0, ageDays: 29, birthWeightGrams: 2000, diagnoses: diagnosisEntries(firstMain, [extra]) })
    }
    if (base.operations.length > 0) {
      const robot = { ...base, operations: [...base.operations, { code: '17.4100', primary: false }] }
      add(route, 'robot', robot)
      add(route, 'robot-female', { ...robot, gender: 'female' })
    }
    for (const ageYears of [6, 7, 69, 70]) add(route, `age-${ageYears}`, { ...base, ageYears })
    for (const main of mainCodes.slice(1)) {
      add(route, `main-${main}`, { ...base, diagnoses: diagnosisEntries(main) })
      add(route, `main-${main}-female`, { ...base, gender: 'female', diagnoses: diagnosisEntries(main) })
    }
    for (const main of operationCodes.slice(1)) {
      add(route, `operation-${main}`, { ...base, operations: operations(main) })
      if (cc !== undefined) add(route, `operation-${main}-cc`, { ...base, operations: operations(main), diagnoses: diagnosisEntries(firstMain, [cc]) })
      if (mcc !== undefined) add(route, `operation-${main}-mcc`, { ...base, operations: operations(main), diagnoses: diagnosisEntries(firstMain, [mcc]) })
    }
    if (neonatal || route.kinds.includes('age-days') || route.kinds.includes('birth-weight')) {
      for (const ageDays of [0, 28, 29, 364, 365]) add(route, `day-${ageDays}`, { ...base, ageYears: 0, ageDays })
      for (const birthWeightGrams of [500, 999, 1000, 1499, 1500, 1999, 2000, 2499, 2500]) {
        add(route, `weight-${birthWeightGrams}`, { ...base, ageYears: 0, birthWeightGrams })
      }
    }
  }
  return cases
}

/** 只用于显式离线核验；服务运行时不导入，也不把原 JavaScript 放入规则包。 */
export function createDrgProgramOracle(source: string, expectedSha256: string): (input: DrgGroupingInput) => DrgOracleResult {
  const actualSha256 = createHash('sha256').update(source).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256) throw new Error('OpenDRG source SHA-256 mismatch')
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  runInContext('globalThis.self={webpackChunkpack_drg_ce:{push(parts){const module={exports:{}};if(!parts[1][3258])throw Error("Missing CHS-DRG 3.0 module 3258");parts[1][3258](module);globalThis.__oracle=module.exports}}}', context, { timeout: 1_000 })
  runInContext(source, context, { timeout: 5_000 })
  if (runInContext('typeof __oracle.group_record_str', context, { timeout: 1_000 }) !== 'function') throw new Error('OpenDRG group_record_str is missing')
  return input => {
    context.__csv = csvInput(input)
    const response: unknown = runInContext('__oracle.group_record_str(__csv)', context, { timeout: 1_000 })
    const raw = z.tuple([z.unknown(), oracleResultSchema]).parse(response)[1]
    const status = raw.status === '分组成功' ? 'grouped' : raw.status === '无法入组' ? 'ungroupable'
      : raw.status === '歧义病案' ? 'ambiguous' : 'invalid-input'
    return { status, drgCode: status === 'grouped' ? raw.drg : null,
      adrgCode: status === 'grouped' ? raw.adrg : null,
      mdcCode: raw.mdc !== '' && raw.mdc !== '0000' ? raw.mdc : null, messages: raw.messages }
  }
}

export function verifyDrgProgramCases(options: {
  sourceSha256: string
  oracle: (input: DrgGroupingInput) => DrgOracleResult
  evaluate: (input: DrgGroupingInput) => DrgGroupingResult
  cases: readonly DrgVerificationCase[]
  inventory?: DrgSourceInventory
}) {
  const cases = options.cases.map(testCase => {
    const expected = options.oracle(testCase.input)
    const actual = options.evaluate(testCase.input)
    const differences: string[] = []
    for (const field of ['status', 'drgCode', 'adrgCode', 'mdcCode'] as const) {
      if (expected[field] !== actual[field]) differences.push(field)
    }
    if (testCase.expected !== undefined) {
      for (const field of ['status', 'drgCode'] as const) {
        if (testCase.expected[field] !== expected[field]) differences.push(`independentExpected.${field}`)
      }
    }
    return { ...testCase, independentExpected: testCase.expected ?? null, expected, actual, differences }
  })
  const selected = new Set(cases.flatMap(testCase => testCase.expected.drgCode === null ? [] : [testCase.expected.drgCode]))
  const matchedRoutes = new Set(cases.flatMap(testCase => testCase.expected.messages.flatMap(message => {
    const match = /^符合([A-Z0-9_]+)入组条件，匹配规则：/.exec(message)
    return match?.[1] === undefined ? [] : [match[1]]
  })))
  const predicates = new Map<string, string[]>()
  for (const terminal of options.inventory?.terminals ?? []) {
    const codes = predicates.get(terminal.predicate) ?? []
    codes.push(terminal.code)
    predicates.set(terminal.predicate, codes)
  }
  const unmatchedRouteCodes = [...new Set(options.inventory?.routes.map(route => route.code) ?? [])].filter(code => !matchedRoutes.has(code))
  return {
    schemaVersion: 'clinmesh.drg-verification.v1' as const,
    sourceSha256: options.sourceSha256,
    scope: '锁定 OpenDRG CHS-DRG 3.0 程序的合成输入实现一致性；不证明地方正式医保结算一致',
    caseCount: cases.length,
    mismatchCount: cases.filter(testCase => testCase.differences.length > 0).length,
    coverage: {
      conditionKinds: [...new Set(options.cases.flatMap(testCase => testCase.conditionKinds))].sort(),
      selectedDrgCodes: [...selected].sort(),
      statuses: [...new Set(cases.map(testCase => testCase.expected.status))].sort(),
      sourceInventory: options.inventory ?? null,
      unselectedDrgCodes: (options.inventory?.terminals ?? []).map(terminal => terminal.code)
        .filter(code => !selected.has(code)),
      unmatchedRouteCodes,
      unexplainedRouteCodes: unmatchedRouteCodes.filter(code => !options.inventory?.shadowedRoutes?.some(route => route.code === code)),
      terminalPredicateClasses: [...predicates].map(([predicate, codes]) => ({ predicate, codes, selectedCodes: codes.filter(code => selected.has(code)) })),
    },
    cases,
  }
}
