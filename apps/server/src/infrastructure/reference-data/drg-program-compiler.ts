import { createHash } from 'node:crypto'
import ts from 'typescript'
import { z } from 'zod'
import { drgProgramSchema, type DrgProgram, type DrgProgramExpression as Expression,
  type DrgProgramStatement as Statement, drgProgramFieldSchema } from '@clinmesh/contracts/drg-program'

const literal = (value: string | number | boolean | null): Expression => ({ kind: 'literal', value })
const stringTable = z.record(z.string(), z.string())
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/** 维护期源码编译器；只解释 AST，不导入或执行上游程序。未知语法拒绝整个产物。 */
export function compileDrgProgram(jsText: string): DrgProgram {
  const source = ts.createSourceFile('opendrg.js', jsText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length > 0) throw new Error('DRG 原程序存在语法错误')
  const functions: DrgProgram['functions'] = {}
  const terminals: DrgProgram['terminals'] = {}
  const tables: DrgProgram['tables'] = {}
  const declarations = new Map<string, ts.Expression>()
  const namedFunctions = new Map<string, ts.FunctionDeclaration>()
  const exports = new Map<string, string>()
  const methodNodes: ts.MethodDeclaration[] = []
  const terminalClasses = new Set<string>()
  let sourceEntry: ts.FunctionExpression | undefined
  let nextFunction = 0
  const kinds: Record<string, number> = {}
  const mdcs = new Set<string>()
  const adrgs = new Set<string>()
  const diagnosisCodes = new Set<string>()
  const operationCodes = new Set<string>()

  function walk(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
      && !declarations.has(node.name.text)) declarations.set(node.name.text, node.initializer)
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) namedFunctions.set(node.name.text, node)
    if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer) && ts.isIdentifier(node.initializer.body)) {
      exports.set(node.name.getText(source), node.initializer.body.text)
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(source).endsWith('_group')) methodNodes.push(node)
    if (ts.isClassDeclaration(node) && node.name !== undefined
      && node.members.every(member => ts.isMethodDeclaration(member) && member.name.getText(source).endsWith('_group'))) terminalClasses.add(node.name.text)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
      && ts.isClassExpression(node.initializer) && node.initializer.members.every(member => ts.isMethodDeclaration(member)
        && member.name.getText(source).endsWith('_group'))) terminalClasses.add(node.name.text)
    if (ts.isStringLiteral(node) && node.text === '不符合所有MDC的入组条件，无法入组') {
      let parent: ts.Node | undefined = node.parent
      while (parent !== undefined && !ts.isFunctionExpression(parent)) parent = parent.parent
      if (parent !== undefined && ts.isFunctionExpression(parent)) sourceEntry = parent
    }
    ts.forEachChild(node, walk)
  }
  walk(source)

  // 预处理及结果包装由领域执行器负责。锁定它们的语法身份，避免上游新增条件被略过。
  // 这些检查只约束未编译的适配代码；路由和825个终端条件仍逐节点编译及独立对照。
  if (sourceEntry !== undefined && exports.has('group_record_str')) {
    const wrapper = namedFunctions.get(exports.get('group_record') ?? '')
    const preprocess = namedFunctions.get(exports.get('group_record_str') ?? '')
    const resultMapper = declarations.get('I')
    if (wrapper === undefined || preprocess === undefined || resultMapper === undefined
      || digest(wrapper.getText(source).replace(sourceEntry.getText(source),'ROUTE')) !== '4da3f32e5457100ba157bf7b22dc3069eee366c30fecd679684d78e78a63045f'
      || digest(preprocess.getText(source)) !== 'ba8ae658b2fd24287cf4283b1d7e1946b3d07c05d258e5b9f5379ee2de30e400'
      || digest(`I=${resultMapper.getText(source)}`) !== '1f3d6f4218a8fb4e1a1982b2942fa5cbb7d6759a2335e27bcbadd3807880f9e7') {
      throw new Error('未解析 DRG 条件：上游预处理、输入校验或结果映射发生不兼容变化')
    }
  }

  function unsupported(node: ts.Node): never {
    throw new Error(`未解析 DRG 条件：${ts.SyntaxKind[node.kind]}，源码偏移 ${node.getStart(source)}：${node.getText(source).slice(0,140)}`)
  }

  function table(values: string[]): Expression {
    const id = `t${createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0,24)}`
    tables[id] = values
    return { kind: 'table', id }
  }

  function parsedLiteral(node: ts.Expression): unknown {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'JSON.parse'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) return JSON.parse(node.arguments[0]!.text)
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(entry => {
      if (!ts.isStringLiteral(entry)) return unsupported(entry)
      return entry.text
    })
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, string> = {}
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) return unsupported(property)
        const key = ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(source)
        Object.defineProperty(out, key, { value: property.initializer.text, enumerable: true })
      }
      return out
    }
    return unsupported(node)
  }

  function parameter(name: string): unknown {
    const declaration = declarations.get(exports.get(name) ?? name)
    if (declaration === undefined) throw new Error(`DRG 原程序缺少参数表 ${name}`)
    return parsedLiteral(declaration)
  }

  function tableValues(node: ts.Expression): string[] | null {
    if (ts.isParenthesizedExpression(node)) return tableValues(node.expression)
    if (ts.isArrayLiteralExpression(node)) return z.array(z.string()).parse(parsedLiteral(node))
    if (!ts.isIdentifier(node)) return null
    // 局部表名称在多个 IIFE 中重复，必须按词法作用域解析，不能查全局同名首项。
    let parent: ts.Node | undefined = node.parent
    while (parent !== undefined) {
      if ((ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent) || ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent))
        && parent.body !== undefined && ts.isBlock(parent.body)) {
        for (const statement of parent.body.statements) {
          if (!ts.isVariableStatement(statement)) continue
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) {
              return declaration.initializer !== undefined && ts.isArrayLiteralExpression(declaration.initializer)
                ? z.array(z.string()).parse(parsedLiteral(declaration.initializer)) : null
            }
          }
        }
      }
      parent = parent.parent
    }
    const declaration = declarations.get(node.text)
    return declaration !== undefined && ts.isArrayLiteralExpression(declaration)
      ? z.array(z.string()).parse(parsedLiteral(declaration)) : null
  }

  function listDomain(node: ts.Expression): 'diagnoses' | 'operations' | null {
    if (ts.isParenthesizedExpression(node) || ts.isElementAccessExpression(node)) return listDomain(node.expression)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'slice') return listDomain(node.expression.expression)
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'x') {
      if (node.name.text === 'zdList') return 'diagnoses'
      if (node.name.text === 'ssList' || node.name.text === 'ssValidList') return 'operations'
    }
    return null
  }

  function recordVocabulary(memberTable: ts.Expression, selector: ts.Expression): void {
    const domain = listDomain(selector)
    if (domain === null) return
    const values = tableValues(memberTable)
    if (values === null) return
    const target = domain === 'diagnoses' ? diagnosisCodes : operationCodes
    for (const code of values) target.add(code)
  }

  function log(node: ts.Expression): Expression {
    let message: string
    if (ts.isStringLiteral(node)) message = node.text
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'format' && ts.isStringLiteral(node.expression.expression)) message = node.expression.expression.text
    else return unsupported(node)
    const match = /符合(MDC[A-Z]|[A-Z][A-Z0-9_]+)入组条件/.exec(message)
    if (match !== null) {
      if (match[1]!.startsWith('MDC')) mdcs.add(match[1]!)
      else if (match[1]!.replace(/_\d+$/, '').length === 3) adrgs.add(match[1]!.replace(/_\d+$/, ''))
    }
    return { kind: 'log', message }
  }

  function helper(node: ts.CallExpression): Expression | null {
    if (!ts.isIdentifier(node.expression)) return null
    const fn = namedFunctions.get(node.expression.text)
    if (fn === undefined || fn.body === undefined) return null
    const text = fn.getText(source)
    // 上游两个固定领域辅助函数：副操作机器人码、产科主诊断严重条件。
    const robot = /^function \w+\(x\)\{if\(x\.length>1\)for\(let \w+ of x\.slice\(1\)\)if\((\w+)\.includes\(\w+\)\)return!0;return!1\}$/.exec(text)
    if (robot !== null) {
      const codes = declarations.get(robot[1]!)
      if (codes === undefined || node.arguments.length !== 1) return unsupported(node)
      const values = z.array(z.string()).parse(parsedLiteral(codes))
      values.forEach(code => operationCodes.add(code))
      return { kind: 'intersects', list: { kind: 'slice', value: expression(node.arguments[0]!), index: 1 }, value: table(values) }
    }
    const obstetric = /^function \w+\(x\)\{return!!\(x\.length>0&&(\w+)\.includes\(x\[0\]\)\)\}$/.exec(text)
    if (obstetric !== null) {
      const codes = declarations.get(obstetric[1]!)
      if (codes === undefined || node.arguments.length !== 1) return unsupported(node)
      const values = z.array(z.string()).parse(parsedLiteral(codes))
      values.forEach(code => diagnosisCodes.add(code))
      return { kind: 'contains', list: table(values),
        value: { kind: 'at', value: expression(node.arguments[0]!), index: 0 } }
    }
    return null
  }

  function call(node: ts.CallExpression): Expression {
    const target = node.expression
    if (ts.isIdentifier(target) && target.text === 'Q' && node.arguments.length === 1) return log(node.arguments[0]!)
    if (ts.isIdentifier(target) && target.text === 'G' && node.arguments.length === 2) {
      const declaration = namedFunctions.get('G')
      if (declaration !== undefined && declaration.getText(source) !== 'function G(x,C){for(let S of x)if(C.includes(S))return!0;return!1}') return unsupported(declaration)
      recordVocabulary(node.arguments[1]!,node.arguments[0]!)
      return { kind: 'intersects', list: expression(node.arguments[0]!), value: expression(node.arguments[1]!) }
    }
    const mappedHelper = helper(node)
    if (mappedHelper !== null) return mappedHelper
    if (ts.isPropertyAccessExpression(target)) {
      if (target.name.text.endsWith('_group') && node.arguments.length === 1
        && node.arguments[0]!.getText(source) === 'x') {
        // 终端接收者在编译期验证；不能通过静态绑定略过构造器中的未知行为。
        let receiver: ts.Expression = target.expression
        while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression
        if (ts.isNewExpression(receiver)) expression(receiver)
        else if (!ts.isIdentifier(receiver)) return unsupported(receiver)
        const code = target.name.text.replace(/_group$/, '')
        if (!terminals[code]) throw new Error(`DRG 终端调用缺少定义 ${code}`)
        return { kind: 'terminal', code }
      }
      if (target.name.text === 'includes' && node.arguments.length === 1) {
        recordVocabulary(target.expression,node.arguments[0]!)
        return { kind: 'contains', list: expression(target.expression), value: expression(node.arguments[0]!) }
      }
      if (target.name.text === 'slice' && node.arguments.length === 1 && ts.isNumericLiteral(node.arguments[0]!)) {
        return { kind: 'slice', value: expression(target.expression), index: Number(node.arguments[0]!.text) }
      }
    }
    if (ts.isFunctionExpression(target)) {
      const count = /^function\(x,C\)\{let S=0;for\(let T of x\)C\.includes\(T\)&&\(S\+=1\);return S\}$/.test(target.getText(source))
      if (count && node.arguments.length === 2) {
        recordVocabulary(node.arguments[1]!,node.arguments[0]!)
        return { kind: 'match-count', list: expression(node.arguments[0]!), value: expression(node.arguments[1]!) }
      }
      if (node.arguments.length !== 1 || node.arguments[0]!.getText(source) !== 'x') return unsupported(node)
      return { kind: 'call', id: register(target) }
    }
    return unsupported(node)
  }

  function expression(node: ts.Expression): Expression {
    let result: Expression
    if (ts.isParenthesizedExpression(node)) return expression(node.expression)
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return literal(ts.isStringLiteral(node) ? node.text : Number(node.text))
    if (node.kind === ts.SyntaxKind.TrueKeyword) return literal(true)
    if (node.kind === ts.SyntaxKind.FalseKeyword) return literal(false)
    if (node.kind === ts.SyntaxKind.NullKeyword) return literal(null)
    if (ts.isArrayLiteralExpression(node)) return table(z.array(z.string()).parse(parsedLiteral(node)))
    if (ts.isIdentifier(node)) return node.text === 'undefined' ? literal(null) : { kind: 'variable', name: node.text }
    if (ts.isNewExpression(node)) {
      // 上游只将终端 method 的 class 实例存入局部变量；调用已静态绑定为 terminal 节点。
      if (!ts.isIdentifier(node.expression) || !terminalClasses.has(node.expression.text)
        || (node.arguments?.length ?? 0) > 0) return unsupported(node)
      return literal(null)
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) result = { kind: 'not', value: expression(node.operand) }
    else if (ts.isVoidExpression(node)) result = { kind: 'void', value: expression(node.expression) }
    else if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.getText(source) === 'x') {
        const field = drgProgramFieldSchema.safeParse(node.name.text)
        if (!field.success) return unsupported(node)
        result = { kind: 'field', field: field.data }
      } else if (node.name.text === 'length') result = { kind: 'length', value: expression(node.expression) }
      else return unsupported(node)
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined && ts.isNumericLiteral(node.argumentExpression)) {
      result = { kind: 'at', value: expression(node.expression), index: Number(node.argumentExpression.text) }
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.getText(source)
      if (operator === '=' && ts.isIdentifier(node.left)) result = { kind: 'assign', name: node.left.text, value: expression(node.right) }
      else if (['&&', '||', ',', '==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(operator)) result = {
        kind: 'binary', operator: operator as Extract<Expression,{kind:'binary'}>['operator'], left: expression(node.left), right: expression(node.right),
      }
      else return unsupported(node)
    } else if (ts.isConditionalExpression(node)) result = {
      kind: 'conditional', condition: expression(node.condition), yes: expression(node.whenTrue), no: expression(node.whenFalse),
    }
    else if (ts.isCallExpression(node)) result = call(node)
    else return unsupported(node)
    kinds[result.kind] = (kinds[result.kind] ?? 0) + 1
    return result
  }

  function statements(nodes: readonly ts.Statement[]): Statement[] {
    return nodes.flatMap(node => {
      if (ts.isReturnStatement(node)) return [{ kind: 'return', value: node.expression === undefined ? literal(null) : expression(node.expression) } as Statement]
      if (ts.isExpressionStatement(node)) return [{ kind: 'expression', value: expression(node.expression) } as Statement]
      if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(declaration => {
        if (!ts.isIdentifier(declaration.name)) return unsupported(declaration)
        return { kind: 'let', name: declaration.name.text,
          value: declaration.initializer === undefined ? literal(null) : expression(declaration.initializer) } as Statement
      })
      if (ts.isIfStatement(node)) return [{ kind: 'if', condition: expression(node.expression), yes: body(node.thenStatement),
        no: node.elseStatement === undefined ? [] : body(node.elseStatement) } as Statement]
      if (ts.isBlock(node)) return [{ kind: 'block', statements: statements(node.statements) } as Statement]
      if (ts.isEmptyStatement(node)) return []
      return unsupported(node)
    })
  }

  function body(node: ts.Statement): Statement[] {
    return ts.isBlock(node) ? statements(node.statements) : statements([node])
  }

  function register(node: ts.FunctionExpression): string {
    const id = `f${nextFunction++}`
    // MDCZ 使用原表标题切分创伤部位。将这一固定算法编译为封闭领域谓词。
    if (node.body.statements.some(statement => ts.isForOfStatement(statement))
      && node.getText(source).includes('诊断匹配部位数量不符合MDCZ要求')) {
      const first = node.body.statements[0]
      if (first === undefined || !ts.isVariableStatement(first)) return unsupported(node)
      const values = first.declarationList.declarations[0]?.initializer
      if (values === undefined || !ts.isArrayLiteralExpression(values)) return unsupported(node)
      const regionTable = table(z.array(z.string()).parse(parsedLiteral(values)))
      z.array(z.string()).parse(parsedLiteral(values)).filter(code => !code.endsWith('创伤')).forEach(code => diagnosisCodes.add(code))
      if (regionTable.kind !== 'table') return unsupported(node)
      let route: ts.Expression | undefined
      function find(current: ts.Node): void {
        if (current !== node && ts.isFunctionLike(current)) return
        if (ts.isConditionalExpression(current) && current.condition.getText(source) === 'M.length<2') route = current.whenFalse
        ts.forEachChild(current, find)
      }
      find(node)
      if (route === undefined) return unsupported(node)
      // 验证所有被折叠语句的结构，来源改变不得静默保留旧语义。
      const normalized = (jsText.slice(node.getStart(source), route.getStart(source)) + 'ROUTE' + jsText.slice(route.getEnd(), node.getEnd()))
        .replace(/\[(?:"[^"]*",?)+\]/g, 'TABLE')
      if (digest(normalized) !== '6dc98ef4b50d1853fa9f2a3a293731ed62f7f41a94fc752393fe273709d97601') return unsupported(node)
      functions[id] = [
        { kind: 'let', name: 'I', value: literal(null) },
        { kind: 'if', condition: { kind: 'trauma-regions', table: regionTable.id },
          yes: [{ kind: 'return', value: expression(route) }], no: [{ kind: 'return', value: literal('') }] },
      ]
      kinds['trauma-regions'] = (kinds['trauma-regions'] ?? 0) + 1
    } else functions[id] = statements(node.body.statements)
    return id
  }

  // 先登记名称，允许不同 class 内的有序终端调用静态绑定。
  for (const method of methodNodes) {
    const code = method.name.getText(source).replace(/_group$/, '')
    if (Object.hasOwn(terminals, code)) throw new Error(`DRG 终端条件重复定义 ${code}`)
    terminals[code] = []
    mdcs.add(`MDC${code[0]}`)
    adrgs.add(code.slice(0,3))
  }
  for (const method of methodNodes) {
    if (method.body === undefined) return unsupported(method)
    terminals[method.name.getText(source).replace(/_group$/, '')] = statements(method.body.statements)
  }
  if (methodNodes.length === 0) throw new Error('DRG 原程序没有终端分组条件')
  let entry: string
  if (sourceEntry !== undefined) entry = register(sourceEntry)
  else {
    const namedEntry = namedFunctions.get(exports.get('group_record') ?? 'group_record')
    if (namedEntry?.body === undefined) throw new Error('DRG 原程序没有受支持的 group_record 入口')
    entry = `f${nextFunction++}`
    functions[entry] = statements(namedEntry.body.statements)
  }
  const complications = { cc: stringTable.parse(parameter('CC')), mcc: stringTable.parse(parameter('MCC')), cce: stringTable.parse(parameter('CCE')) }
  const validOperations = z.array(z.string()).parse(parameter('SS_VALID'))
  for (const table of Object.values(complications)) Object.keys(table).forEach(code => diagnosisCodes.add(code))
  validOperations.forEach(code => operationCodes.add(code))
  const program = {
    schemaVersion: 'clinmesh.drg-program.v1', entry, functions, terminals, tables,
    complications, validOperations,
    vocabulary: { diagnoses: [...diagnosisCodes].sort(), operations: [...operationCodes].sort() },
    coverage: { sourceSha256: createHash('sha256').update(jsText).digest('hex'), mdcCodes: [...mdcs].sort(),
      adrgCodes: [...adrgs].sort(), drgCodes: Object.keys(terminals).sort(), conditionKinds: kinds },
  }
  return drgProgramSchema.parse(program)
}
