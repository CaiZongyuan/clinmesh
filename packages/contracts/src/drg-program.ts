import { z } from 'zod'

export const drgProgramFieldSchema = z.enum(['gender', 'age', 'ageDay', 'weight', 'zdList', 'ssList', 'mccList', 'ccList', 'ssValidList'])
export type DrgProgramField = z.infer<typeof drgProgramFieldSchema>
export type DrgProgramExpression =
  | { kind: 'literal', value: string | number | boolean | null }
  | { kind: 'field', field: DrgProgramField }
  | { kind: 'variable', name: string }
  | { kind: 'table', id: string }
  | { kind: 'not' | 'void' | 'length', value: DrgProgramExpression }
  | { kind: 'at' | 'slice', value: DrgProgramExpression, index: number }
  | { kind: 'binary', operator: '&&' | '||' | ',' | '==' | '!=' | '===' | '!==' | '<' | '<=' | '>' | '>=', left: DrgProgramExpression, right: DrgProgramExpression }
  | { kind: 'conditional', condition: DrgProgramExpression, yes: DrgProgramExpression, no: DrgProgramExpression }
  | { kind: 'contains' | 'intersects' | 'match-count', list: DrgProgramExpression, value: DrgProgramExpression }
  | { kind: 'assign', name: string, value: DrgProgramExpression }
  | { kind: 'call', id: string }
  | { kind: 'terminal', code: string }
  | { kind: 'log', message: string }
  | { kind: 'trauma-regions', table: string }

export type DrgProgramStatement =
  | { kind: 'return' | 'expression', value: DrgProgramExpression }
  | { kind: 'let', name: string, value: DrgProgramExpression }
  | { kind: 'if', condition: DrgProgramExpression, yes: DrgProgramStatement[], no: DrgProgramStatement[] }
  | { kind: 'block', statements: DrgProgramStatement[] }

const expression: z.ZodType<DrgProgramExpression> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ kind: z.literal('field'), field: drgProgramFieldSchema }).strict(),
  z.object({ kind: z.literal('variable'), name: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('table'), id: z.string().min(1).max(64) }).strict(),
  ...(['not', 'void', 'length'] as const).map(kind => z.object({ kind: z.literal(kind), value: expression }).strict()),
  ...(['at', 'slice'] as const).map(kind => z.object({ kind: z.literal(kind), value: expression, index: z.number().int().min(0).max(200) }).strict()),
  z.object({ kind: z.literal('binary'), operator: z.enum(['&&', '||', ',', '==', '!=', '===', '!==', '<', '<=', '>', '>=']), left: expression, right: expression }).strict(),
  z.object({ kind: z.literal('conditional'), condition: expression, yes: expression, no: expression }).strict(),
  ...(['contains', 'intersects', 'match-count'] as const).map(kind => z.object({ kind: z.literal(kind), list: expression, value: expression }).strict()),
  z.object({ kind: z.literal('assign'), name: z.string().min(1).max(64), value: expression }).strict(),
  z.object({ kind: z.literal('call'), id: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('terminal'), code: z.string().regex(/^[A-Z][A-Z0-9]{3}$/) }).strict(),
  z.object({ kind: z.literal('log'), message: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal('trauma-regions'), table: z.string().min(1).max(64) }).strict(),
]))

const statement: z.ZodType<DrgProgramStatement> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('return'), value: expression }).strict(),
  z.object({ kind: z.literal('expression'), value: expression }).strict(),
  z.object({ kind: z.literal('let'), name: z.string().min(1).max(64), value: expression }).strict(),
  z.object({ kind: z.literal('if'), condition: expression, yes: z.array(statement), no: z.array(statement) }).strict(),
  z.object({ kind: z.literal('block'), statements: z.array(statement) }).strict(),
]))

/** 编译期只接受明确支持的语法；运行时仅解释这些封闭的领域节点，不装载来源 JS。 */
const programShape = z.object({
  schemaVersion: z.literal('clinmesh.drg-program.v1'),
  entry: z.string().min(1),
  functions: z.record(z.string(), z.array(statement)),
  terminals: z.record(z.string(), z.array(statement)),
  tables: z.record(z.string(), z.array(z.string())),
  complications: z.object({ cc: z.record(z.string(), z.string()), mcc: z.record(z.string(), z.string()), cce: z.record(z.string(), z.string()) }).strict(),
  validOperations: z.array(z.string()),
  vocabulary: z.object({ diagnoses: z.array(z.string()), operations: z.array(z.string()) }).strict(),
  coverage: z.object({
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mdcCodes: z.array(z.string()),
    adrgCodes: z.array(z.string()),
    drgCodes: z.array(z.string()),
    conditionKinds: z.record(z.string(), z.number().int().nonnegative()),
  }).strict(),
}).strict()

export type DrgProgram = z.infer<typeof programShape>

export const drgProgramSchema = programShape.superRefine((program, context) => {
  const graph = new Map<string, Set<string>>()
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  function expressionReferences(node: DrgProgramExpression, edges: Set<string>, variables: ReadonlySet<string>): void {
    switch (node.kind) {
      case 'literal': case 'field': case 'log': return
      case 'variable':
        if (!variables.has(node.name)) issue(`DRG 程序引用未声明变量 ${node.name}`)
        return
      case 'assign':
        if (!variables.has(node.name)) issue(`DRG 程序赋值未声明变量 ${node.name}`)
        expressionReferences(node.value,edges,variables)
        return
      case 'table': case 'trauma-regions': {
        const id = node.kind === 'table' ? node.id : node.table
        if (!Object.hasOwn(program.tables,id)) issue(`DRG 程序缺少成员表 ${id}`)
        return
      }
      case 'call':
        if (!Object.hasOwn(program.functions,node.id)) issue(`DRG 程序缺少分支 ${node.id}`)
        edges.add(`function:${node.id}`)
        return
      case 'terminal':
        if (!Object.hasOwn(program.terminals,node.code)) issue(`DRG 程序缺少终端条件 ${node.code}`)
        edges.add(`terminal:${node.code}`)
        return
      case 'binary': expressionReferences(node.left,edges,variables); expressionReferences(node.right,edges,variables); return
      case 'conditional':
        expressionReferences(node.condition,edges,variables); expressionReferences(node.yes,edges,variables); expressionReferences(node.no,edges,variables); return
      case 'contains': case 'intersects': case 'match-count':
        expressionReferences(node.list,edges,variables); expressionReferences(node.value,edges,variables); return
      default: expressionReferences(node.value,edges,variables)
    }
  }
  function statementReferences(nodes: readonly DrgProgramStatement[], edges: Set<string>, variables: Set<string>): void {
    for (const node of nodes) {
      if (node.kind === 'if') {
        expressionReferences(node.condition,edges,variables)
        statementReferences(node.yes,edges,new Set(variables))
        statementReferences(node.no,edges,new Set(variables))
      } else if (node.kind === 'block') statementReferences(node.statements,edges,new Set(variables))
      else {
        if (node.kind === 'let' && variables.has(node.name)) issue(`DRG 程序不支持重复声明或变量遮蔽 ${node.name}`)
        expressionReferences(node.value,edges,variables)
        if (node.kind === 'let') variables.add(node.name)
      }
    }
  }
  for (const [kind, records] of [['function',program.functions],['terminal',program.terminals]] as const) {
    for (const [id, statements] of Object.entries(records)) {
      const edges = new Set<string>()
      graph.set(`${kind}:${id}`,edges)
      statementReferences(statements,edges,new Set())
    }
  }
  if (!Object.hasOwn(program.functions,program.entry)) issue('DRG 程序缺少分组入口')
  const visited = new Set<string>()
  const pending = new Set<string>()
  function visit(id: string): void {
    if (pending.has(id)) { issue(`DRG 程序不允许循环调用 ${id}`); return }
    if (visited.has(id)) return
    pending.add(id)
    for (const target of graph.get(id) ?? []) visit(target)
    pending.delete(id)
    visited.add(id)
  }
  for (const id of graph.keys()) visit(id)
  const actual = Object.keys(program.terminals).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...program.coverage.drgCodes].sort())) issue('DRG 终端覆盖清单与实际程序不一致')
})
