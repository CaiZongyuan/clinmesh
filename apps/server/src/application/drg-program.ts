import { drgGroupingInputSchema, type DrgGroupingInput, type DrgGroupingResult } from '@clinmesh/contracts/drg'
import type { DrgProgram, DrgProgramExpression as Expression, DrgProgramStatement as Statement } from '@clinmesh/contracts/drg-program'

type Value = string | number | boolean | null | undefined | string[]
type Frame = Map<string, Value>
interface Return { value: Value }

class MissingInput extends Error {}

const programIndexes = new WeakMap<DrgProgram, { diagnoses: ReadonlySet<string>, operations: ReadonlySet<string>, validOperations: ReadonlySet<string> }>()
function indexesFor(program: DrgProgram) {
  let indexes = programIndexes.get(program)
  if (indexes === undefined) {
    // 装载后的固定版本程序不可原地修改；弱引用索引随该程序一起释放。
    indexes = { diagnoses: new Set(program.vocabulary.diagnoses), operations: new Set(program.vocabulary.operations),
      validOperations: new Set(program.validOperations) }
    programIndexes.set(program,indexes)
  }
  return indexes
}

const primitive = (value: Value): string | number | boolean | null | undefined => Array.isArray(value) ? value.join(',') : value
function equal(left: Value, right: Value): boolean {
  const a = primitive(left)
  const b = primitive(right)
  if (typeof a === typeof b) return a === b
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  return Number(a) === Number(b)
}

/** 仅解释已装载验证的声明式节点；来源程序、动态属性和任意函数均不进入运行时。 */
export function evaluateDrgProgram(program: DrgProgram, rawInput: DrgGroupingInput): DrgGroupingResult {
  const parsed = drgGroupingInputSchema.safeParse(rawInput)
  const steps: DrgGroupingResult['steps'] = []
  const failed = (status: DrgGroupingResult['status'], reason: string, mdcCode: string | null = null): DrgGroupingResult =>
    ({ status, drgCode: null, adrgCode: null, mdcCode, steps, reason })
  if (!parsed.success) return failed('invalid-input', `分组输入不符合合同：${parsed.error.issues[0]?.message ?? '无效输入'}`)
  const input = parsed.data
  const main = input.diagnoses.filter(diagnosis => diagnosis.role === 'main')
  if (main.length !== 1) return failed('invalid-input', '必须提供且只能提供一个主诊断')
  if (input.gender === 'unknown') return failed('invalid-input', '分组需要明确的性别输入')
  const primary = input.operations.filter(operation => operation.primary)
  if (primary.length > 1) return failed('ambiguous', '存在多个主手术或操作，必须先明确主次顺序')
  if (input.operations.length > 0 && primary.length === 0) return failed('invalid-input', '存在操作但缺少主操作标记')
  if (input.ageYears === 0 && input.ageDays === null) return failed('invalid-input', '婴儿分组缺少日龄 ageDays')
  const diagnoses = [main[0]!.code, ...input.diagnoses.filter(diagnosis => diagnosis.role === 'secondary').map(diagnosis => diagnosis.code)]
  const operations = [...primary.map(operation => operation.code), ...input.operations.filter(operation => !operation.primary).map(operation => operation.code)]
  const indexes = indexesFor(program)
  const unknownDiagnosis = diagnoses.find(code => !indexes.diagnoses.has(code))
  const unknownOperation = operations.find(code => !indexes.operations.has(code))
  if (unknownDiagnosis !== undefined) return failed('ungroupable', `coding-incompatible：当前来源规则未声明兼容诊断编码 ${unknownDiagnosis}`)
  if (unknownOperation !== undefined) return failed('ungroupable', `coding-incompatible：当前来源规则未声明兼容操作编码 ${unknownOperation}`)
  const ownValue = (table: Record<string, string>, code: string): string | undefined => Object.hasOwn(table,code) ? table[code] : undefined
  const cce = ownValue(program.complications.cce,diagnoses[0]!) ?? ''
  const mcc: string[] = []
  const cc: string[] = []
  const excluded: string[] = []
  // 与锁定程序的预处理一致：遍历完整有序诊断；终端谓词另行要求诊断数 > 1。
  for (const code of diagnoses) {
    const mccGroup = ownValue(program.complications.mcc,code)
    const ccGroup = ownValue(program.complications.cc,code)
    if (mccGroup !== undefined && (cce === '' || mccGroup !== cce)) mcc.push(code)
    else if (ccGroup !== undefined && (cce === '' || ccGroup !== cce)) cc.push(code)
    else if (mccGroup !== undefined || ccGroup !== undefined) excluded.push(code)
  }
  const summary = (codes: readonly string[]): string => `${codes.length} 项${codes.length === 0 ? '' : `（${codes.slice(0,3).join('、')}${codes.length > 3 ? '等' : ''}）`}`
  steps.push({ stage: 'drg', matchedCode: main[0]!.code,
    basis: `主诊断排除组：${cce || '无'}；MCC ${summary(mcc)}；CC ${summary(cc)}；按排除组忽略 ${summary(excluded)}`,
    result: `MCC=${mcc.length}，CC=${cc.length}，排除=${excluded.length}` })
  const fields: Record<string, Value> = { gender: input.gender === 'male' ? '1' : '2', age: input.ageYears,
    ageDay: input.ageDays ?? 0, weight: input.birthWeightGrams,
    zdList: diagnoses, ssList: operations, mccList: mcc, ccList: cc, ssValidList: operations.filter(code => indexes.validOperations.has(code)) }
  let budget = 100_000
  const list = (value: Value): string[] => {
    if (!Array.isArray(value)) throw new Error('DRG 程序需要列表值')
    return value
  }

  function expression(node: Expression, frame: Frame): Value {
    if (--budget < 0) throw new Error('DRG 程序超过确定性执行上限')
    switch (node.kind) {
      case 'literal': return node.value
      case 'field': {
        const value = fields[node.field]
        if (node.field === 'weight' && value === null) throw new MissingInput('当前分组条件缺少出生体重 birthWeightGrams')
        return value
      }
      case 'variable': {
        if (!frame.has(node.name)) throw new Error(`DRG 程序引用未声明变量 ${node.name}`)
        return frame.get(node.name)
      }
      case 'table': {
        const value = program.tables[node.id]
        if (value === undefined) throw new Error(`DRG 程序缺少成员表 ${node.id}`)
        return value
      }
      case 'not': return !expression(node.value, frame)
      case 'void': expression(node.value, frame); return undefined
      case 'length': return list(expression(node.value, frame)).length
      case 'at': return list(expression(node.value, frame))[node.index]
      case 'slice': return list(expression(node.value, frame)).slice(node.index)
      case 'conditional': return expression(node.condition, frame) ? expression(node.yes, frame) : expression(node.no, frame)
      case 'contains': return list(expression(node.list, frame)).includes(String(expression(node.value, frame)))
      case 'intersects': {
        const candidates = new Set(list(expression(node.value, frame)))
        return list(expression(node.list, frame)).some(value => candidates.has(value))
      }
      case 'match-count': {
        const candidates = new Set(list(expression(node.value, frame)))
        return list(expression(node.list, frame)).filter(value => candidates.has(value)).length
      }
      case 'assign': {
        if (!frame.has(node.name)) throw new Error(`DRG 程序赋值未声明变量 ${node.name}`)
        const value = expression(node.value, frame)
        frame.set(node.name, value)
        return value
      }
      case 'binary': {
        const left = expression(node.left, frame)
        if (node.operator === '&&') return left ? expression(node.right, frame) : left
        if (node.operator === '||') return left ? left : expression(node.right, frame)
        const right = expression(node.right, frame)
        switch (node.operator) {
          case ',': return right
          case '==': return equal(left, right)
          case '!=': return !equal(left, right)
          case '===': return left === right
          case '!==': return left !== right
          case '<': return Number(primitive(left)) < Number(primitive(right))
          case '<=': return Number(primitive(left)) <= Number(primitive(right))
          case '>': return Number(primitive(left)) > Number(primitive(right))
          case '>=': return Number(primitive(left)) >= Number(primitive(right))
        }
      }
      case 'call': {
        const fn = program.functions[node.id]
        if (fn === undefined) throw new Error(`DRG 程序缺少分组分支 ${node.id}`)
        return statements(fn, new Map())?.value
      }
      case 'terminal': {
        const fn = program.terminals[node.code]
        if (fn === undefined) throw new Error(`DRG 程序缺少终端条件 ${node.code}`)
        const result = statements(fn, new Map())?.value
        if (steps.length < 49) steps.push({ stage: 'drg', basis: `按原程序顺序核对终端条件 ${node.code}`,
          matchedCode: null, result: result ? `满足 ${node.code}` : `不满足 ${node.code}` })
        return result
      }
      case 'log': {
        const match = /^符合(MDC[A-Z]|[A-Z][A-Z0-9_]+)入组条件/.exec(node.message)
        if (match !== null && (match[1]!.startsWith('MDC') || match[1]!.length !== 4) && steps.length < 49) {
          steps.push({ stage: match[1]!.startsWith('MDC') ? 'mdc' : 'adrg', basis: node.message,
            matchedCode: main[0]!.code, result: match[1]!.replace(/_\d+$/, '') })
        }
        return undefined
      }
      case 'trauma-regions': {
        const codes = program.tables[node.table]
        if (codes === undefined) throw new Error('DRG 程序缺少创伤部位表')
        if (!codes.includes(diagnoses[0]!)) return false
        const regions = new Map<string, string>()
        let region = ''
        for (const code of codes) {
          if (code.endsWith('创伤')) region = code
          else regions.set(code, region)
        }
        return new Set(diagnoses.filter(code => regions.has(code)).map(code => regions.get(code))).size >= 2
      }
    }
  }

  function statements(nodes: readonly Statement[], frame: Frame): Return | undefined {
    for (const node of nodes) {
      if (node.kind === 'return') return { value: expression(node.value, frame) }
      if (node.kind === 'expression') expression(node.value, frame)
      else if (node.kind === 'let') frame.set(node.name, expression(node.value, frame))
      else if (node.kind === 'if' || node.kind === 'block') {
        const nested = node.kind === 'block' ? node.statements : expression(node.condition, frame) ? node.yes : node.no
        const result = statements(nested, frame)
        if (result !== undefined) return result
      }
    }
    return undefined
  }

  try {
    const entry = program.functions[program.entry]
    if (entry === undefined) throw new Error('DRG 程序缺少分组入口')
    const value = statements(entry, new Map())?.value
    if (typeof value !== 'string' || value === '' || value === '0000') return failed('ungroupable', '未满足固定方案的完整分组条件')
    const mdcCode = `MDC${value[0]}`
    if (value.slice(1,3) === 'QY') return failed('ambiguous', `原程序返回歧义病案 ${value}，有效主操作不属于该 MDC 的已实现 ADRG`, mdcCode)
    if (value.slice(1,3) === '00') return failed('ungroupable', `原程序未能进入 ${mdcCode} 的终端病组`, mdcCode)
    if (!Object.hasOwn(program.terminals, value)) throw new Error(`DRG 程序返回未声明病组 ${value}`)
    const adrgCode = value.slice(0,3)
    if (steps.length < 50) steps.push({ stage: 'drg', basis: '按锁定原程序的完整条件及优先级取得终端病组', matchedCode: null, result: value })
    return { status: 'grouped', drgCode: value, adrgCode, mdcCode, steps, reason: null }
  } catch (error) {
    if (error instanceof MissingInput) return failed('invalid-input', error.message)
    throw error
  }
}
