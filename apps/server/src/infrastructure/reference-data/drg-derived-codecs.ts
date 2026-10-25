import type { OfflineReferenceLock } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'

const pathSchema = z.string().min(1).refine(path => !path.includes('\\') && !path.includes(':')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a contained logical path')
const grouperExportSchema = z.enum(['CC', 'CCE', 'MCC', 'SS_VALID'])

export const derivedRecipeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted-jsonl'), source: pathSchema }).strict(),
  z.object({ kind: z.literal('hierarchy-jsonl'), source: pathSchema,
    catalog: z.enum(['icd10', 'icd9']), newline: z.enum(['\n', '\r\n']) }).strict(),
  z.object({ kind: z.literal('json-pretty'), source: pathSchema }).strict(),
  z.object({ kind: z.literal('dataset-csv'), source: pathSchema }).strict(),
  z.object({ kind: z.literal('grouper-csv'), source: pathSchema, export: grouperExportSchema }).strict(),
  z.object({ kind: z.literal('merged-payments-csv'), source: pathSchema, schemes: pathSchema, root: pathSchema }).strict(),
  z.object({ kind: z.literal('rule-dat'), source: pathSchema, key: pathSchema }).strict(),
])
export type DerivedRecipe = z.infer<typeof derivedRecipeSchema>
type Read = (path: string) => Promise<Buffer>

const indexSchema = z.object({ files: z.array(z.object({ path: pathSchema }).loose()) }).loose()
const jsonRecordSchema = z.record(z.string(), z.json())
const hierarchyRecordSchema = z.object({ id: z.string(), fields: jsonRecordSchema, source: jsonRecordSchema }).loose()
const rulePacks = new WeakMap<Buffer, Record<string, string>>()
const datasetSchema = z.object({
  jsonPath: pathSchema, csvPath: pathSchema.nullish(), moduleId: z.number().int().nonnegative().optional(),
  category: z.string().optional(),
}).loose()
const paymentDatasetSchema = datasetSchema.extend({ category: z.literal('payments'), name: z.string(), sourceUrl: z.url() })
const grouperSchema = z.object({
  jsonPath: pathSchema,
  exports: z.partialRecord(grouperExportSchema, z.object({ csvPath: pathSchema }).loose()),
}).loose()
type Json = z.infer<ReturnType<typeof z.json>>

function csv(rows: Json[][]): Buffer {
  const cell = (value: Json) => value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return Buffer.from(`\uFEFF${rows.map(row => row.map(value => `"${cell(value).replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`)
}

async function mergedPayments(recipe: Extract<DerivedRecipe, { kind: 'merged-payments-csv' }>, source: Buffer, read: Read): Promise<Buffer> {
  const datasets = z.array(datasetSchema).parse(JSON.parse(source.toString('utf8')))
    .filter(dataset => dataset.category === 'payments').map(dataset => paymentDatasetSchema.parse(dataset))
  const schemes = new Map(z.array(z.object({ id: z.string(), label: z.string() }).loose())
    .parse(JSON.parse((await read(recipe.schemes)).toString('utf8'))).map(scheme => [scheme.id, scheme.label]))
  const union: Json[] = []
  const payments = []
  for (const dataset of datasets) {
    const values = z.array(z.array(z.json())).parse(JSON.parse((await read(`${recipe.root}/${dataset.jsonPath}`)).toString('utf8')))
    const header = values[0]
    if (header === undefined) throw new Error('DRG payment dataset has no header')
    for (const heading of header) if (!union.includes(heading)) union.push(heading)
    payments.push({ dataset, values, header })
  }
  const rows: Json[][] = [['来源表', '方案显示名称', '原始行号', '来源URL', ...union]]
  for (const { dataset, values, header } of payments) {
    const name = dataset.name.replace(/\.csv$/, '')
    for (let row = 1; row < values.length; row += 1) {
      const value = values[row]!
      if (!value.some(cell => cell !== null && cell !== '')) continue
      rows.push([name, schemes.get(name) ?? null, row + 1, dataset.sourceUrl,
        ...union.map(heading => value[header.indexOf(heading)] ?? null)])
    }
  }
  return csv(rows)
}

/** Locate a top-level field without reserializing floating-point source coordinates. */
function rawObjectField(text: string, field: string): string {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    if (char !== '"') continue
    const start = index
    for (index += 1; index < text.length; index += 1) {
      if (text[index] === '\\') index += 1
      else if (text[index] === '"') break
    }
    if (depth !== 1 || JSON.parse(text.slice(start, index + 1)) !== field) continue
    const tail = text.slice(index + 1)
    const colon = /^\s*:\s*/.exec(tail)
    if (colon === null) continue
    const valueStart = index + 1 + colon[0].length
    let nested = 0
    let quoted = false
    for (let end = valueStart; end < text.length; end += 1) {
      const current = text[end]
      if (quoted) {
        if (current === '\\') end += 1
        else if (current === '"') quoted = false
      } else {
        if (current === '"') quoted = true
        else if ((current === ',' || current === '}') && nested === 0) return text.slice(valueStart, end).trimEnd()
        else if (current === '{' || current === '[') nested += 1
        else if (current === '}' || current === ']') nested -= 1
      }
    }
  }
  throw new Error(`DRG source field is missing: ${field}`)
}

function hierarchy(lines: string[], catalog: 'icd10' | 'icd9', newline: string): Buffer {
  const levels = catalog === 'icd10' ? ['chapter', 'section', 'category', 'subcategory'] : ['chapter', 'category', 'subcategory', 'detail']
  const nodes = new Map<string, { prefix: string, source: string, occurrences: string[] }>()
  for (const line of lines) {
    if (line.trim() === '') continue
    const record = hierarchyRecordSchema.parse(JSON.parse(line))
    let parentId: string | null = null
    for (const level of levels) {
      const code = record.fields[`${level}${level === 'section' ? '_range' : '_code'}`]
      if (code === null || code === undefined || code === '') continue
      const id = `${catalog}:${level}:${z.string().parse(code)}`
      let node = nodes.get(id)
      if (node === undefined) {
        node = {
          prefix: JSON.stringify({ id, level, code, name: record.fields[`${level}_name`] ?? null, parentId }).slice(0, -1),
          source: rawObjectField(line, 'source'), occurrences: [],
        }
        nodes.set(id, node)
      }
      node.occurrences.push(record.id)
      parentId = id
    }
  }
  return Buffer.from([...nodes.values()].map(node => `${node.prefix},"source":${node.source},"occurrenceRecordIds":${JSON.stringify(node.occurrences)},"variants":[],"reviewFlags":[]}${newline}`).join(''))
}

export async function renderDerivedRecipe(recipe: DerivedRecipe, read: Read): Promise<Buffer> {
  const source = await read(recipe.source)
  if (recipe.kind === 'rule-dat') {
    let packed = rulePacks.get(source)
    if (packed === undefined) {
      packed = z.record(z.string(), z.string()).parse(JSON.parse(source.toString('utf8')))
      rulePacks.set(source, packed)
    }
    const value = packed[recipe.key]
    if (value === undefined) throw new Error(`DRG packed rule is missing: ${recipe.key}`)
    return Buffer.from(value.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'))
  }
  if (recipe.kind === 'merged-payments-csv') return mergedPayments(recipe, source, read)
  if (recipe.kind === 'json-pretty') return Buffer.from(`${JSON.stringify(JSON.parse(source.toString('utf8')), null, 2)}\n`)
  if (recipe.kind === 'dataset-csv') return csv(z.array(z.array(z.json())).parse(JSON.parse(source.toString('utf8'))))
  if (recipe.kind === 'grouper-csv') {
    const values = jsonRecordSchema.parse(JSON.parse(source.toString('utf8')))[recipe.export]
    return csv(Array.isArray(values)
      ? [['手术编码'], ...values.map(value => [value])]
      : [['诊断编码', '排除表编号'], ...Object.entries(jsonRecordSchema.parse(values))])
  }
  const lines = source.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []
  if (recipe.kind === 'hierarchy-jsonl') return hierarchy(lines, recipe.catalog, recipe.newline)
  return Buffer.from(lines.filter(line => line.trim() !== ''
    && jsonRecordSchema.parse(JSON.parse(line)).eligibleReferenceCandidate === true).join(''))
}

export async function buildDerivedRecipes(options: {
  packages: OfflineReferenceLock['packages']
  read: Read
}): Promise<Map<string, DerivedRecipe>> {
  const recipes = new Map<string, DerivedRecipe>()
  for (const input of options.packages) {
    const indexPath = input.format === 'prepared-catalogues-v1' ? input.manifest.path : input.checksums?.path
    if (indexPath === undefined) throw new Error('OpenDRG derived recipes require an indexed checksum list')
    const index = indexSchema.parse(JSON.parse((await options.read(`${input.root}/${indexPath}`)).toString('utf8')))
    const files = new Set(index.files.map(file => file.path))
    async function add(path: string, recipe: DerivedRecipe, read = options.read) {
      if (!files.has(path)) return
      const logicalPath = `${input.root}/${path}`
      if (!(await renderDerivedRecipe(recipe, read)).equals(await options.read(logicalPath))) {
        throw new Error(`DRG derived artifact is not byte-identical: ${logicalPath}`)
      }
      recipes.set(logicalPath, recipe)
    }
    if (input.format === 'opendrg-public-data-v1') {
      if (files.has('catalog/datasets.json')) {
        const datasets = z.array(datasetSchema).parse(JSON.parse((await options.read(`${input.root}/catalog/datasets.json`)).toString('utf8')))
        for (const dataset of datasets) {
          if (!files.has(dataset.jsonPath)) continue
          const source = `${input.root}/${dataset.jsonPath}`
          if (dataset.moduleId !== undefined) await add(`data/modules/${dataset.moduleId}.json`, { kind: 'json-pretty', source })
          if (dataset.csvPath !== null && dataset.csvPath !== undefined) await add(dataset.csvPath, { kind: 'dataset-csv', source })
        }
        if (files.has('catalog/schemes.json') && datasets.filter(dataset => dataset.category === 'payments')
          .every(dataset => files.has(dataset.jsonPath))) {
          await add('catalog/权重费用合并表.csv', { kind: 'merged-payments-csv', source: `${input.root}/catalog/datasets.json`,
            schemes: `${input.root}/catalog/schemes.json`, root: input.root })
        }
      }
      if (files.has('catalog/groupers.json')) {
        const groupers = z.array(grouperSchema).parse(JSON.parse((await options.read(`${input.root}/catalog/groupers.json`)).toString('utf8')))
        for (const grouper of groupers) {
          if (!files.has(grouper.jsonPath)) continue
          for (const [key, info] of Object.entries(grouper.exports)) {
            await add(info.csvPath, { kind: 'grouper-csv', source: `${input.root}/${grouper.jsonPath}`,
              export: grouperExportSchema.parse(key) })
          }
        }
      }
      if (files.has('catalog/rules.json') && files.has('rules/rule-dat-pack.json')) {
        const rules = z.array(z.object({ path: pathSchema }).loose())
          .parse(JSON.parse((await options.read(`${input.root}/catalog/rules.json`)).toString('utf8')))
        const source = `${input.root}/rules/rule-dat-pack.json`
        const pack = await options.read(source)
        for (const rule of rules) await add(`rules/files/${rule.path}`, {
          kind: 'rule-dat', source, key: rule.path,
        }, path => path === source ? Promise.resolve(pack) : options.read(path))
      }
      continue
    }
    for (const catalog of ['icd10', 'icd9'] as const) {
      const source = `${catalog}/records.jsonl`
      for (const artifact of ['accepted', 'hierarchy'] as const) {
        const path = `${catalog}/${artifact}.jsonl`
        if (!files.has(path) || !files.has(source)) continue
        const logicalPath = `${input.root}/${path}`
        const original = await options.read(logicalPath)
        const recipe: DerivedRecipe = artifact === 'accepted'
          ? { kind: 'accepted-jsonl', source: `${input.root}/${source}` }
          : { kind: 'hierarchy-jsonl', source: `${input.root}/${source}`, catalog,
            newline: original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n' }
        await add(path, recipe)
      }
    }
  }
  return recipes
}
