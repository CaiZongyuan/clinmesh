import type { OfflineReferenceLock } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'

const containedPath = z.string().min(1).refine(value => !value.includes('\\') && !value.includes(':')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a contained relative path')
const lineFormat = {
  newline: z.enum(['\n', '\r\n']), bom: z.boolean(), finalNewline: z.boolean(),
}
export const normalizedRecipeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('readiness-templates'), dataPath: containedPath, templatesPath: containedPath, ...lineFormat }).strict(),
  z.object({ kind: z.literal('member-page-lines'), dataPath: containedPath, pagesPath: containedPath, ...lineFormat }).strict(),
])
export type NormalizedRecipe = z.infer<typeof normalizedRecipeSchema>
type Read = (path: string) => Promise<Buffer>
type Field = { key: string; start: number; end: number; raw: string }
type LineFormat = Pick<NormalizedRecipe, 'newline' | 'bom' | 'finalNewline'>
// JSON.parse already validates nested JSON; avoid cloning every nested source fact again.
const recordSchema = z.record(z.string(), z.unknown())
const arraySchema = z.array(z.unknown())
const stringSchema = z.string()
const templateIdSchema = z.number().int().nonnegative()
const templatesSchema = z.array(z.array(z.string()).min(1))
const pageSchema = z.object({ source: z.object({ pdfPage: z.number().int().positive() }).loose(), text: z.string() }).loose()
const memberSchema = z.object({ source: z.object({ pdfPage: z.number().int().positive(), nativeTextLine: z.number().int().nonnegative() }).strict() }).loose()
const originalMemberSchema = memberSchema.extend({ source: memberSchema.shape.source.loose() })

function lines(bytes: Buffer): { rows: string[]; format: LineFormat } {
  let text = bytes.toString('utf8')
  const bom = text.startsWith('\ufeff')
  if (bom) text = text.slice(1)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = text.endsWith(newline)
  const body = finalNewline ? text.slice(0, -newline.length) : text
  const rows = body === '' ? [] : body.split(newline)
  if (rows.some(row => row.trim() === '' || /[\r\n]/.test(row))) throw new Error('Normalized JSONL requires consistent nonempty lines')
  return { rows, format: { newline, bom, finalNewline } }
}

function encode(rows: string[], format: LineFormat): Buffer {
  return Buffer.from(`${format.bom ? '\ufeff' : ''}${rows.join(format.newline)}${format.finalNewline ? format.newline : ''}`)
}

// Keep JSON token spelling intact: a parse/stringify roundtrip changes facts such as 151.0 to 151.
function valueEnd(text: string, start: number): number {
  let depth = 0
  let quoted = false
  let escaped = false
  let end = start
  for (; end < text.length; end += 1) {
    const char = text[end]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      if (depth === 0) break
      depth -= 1
    } else if (char === ',' && depth === 0) break
  }
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1
  return end
}

function fields(text: string): Field[] {
  recordSchema.parse(JSON.parse(text))
  const result: Field[] = []
  const seen = new Set<string>()
  let index = text.indexOf('{') + 1
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1
    if (text[index] === '}') return result
    const keyStart = index
    index += 1
    while (index < text.length) {
      if (text[index] === '\\') index += 2
      else if (text[index++] === '"') break
    }
    const key = stringSchema.parse(JSON.parse(text.slice(keyStart, index)))
    if (seen.has(key)) throw new Error('Duplicate normalized JSON property')
    seen.add(key)
    while (/\s/.test(text[index] ?? '')) index += 1
    if (text[index++] !== ':') throw new Error('Invalid JSON property')
    while (/\s/.test(text[index] ?? '')) index += 1
    const start = index
    const end = valueEnd(text, start)
    result.push({ key, start, end, raw: text.slice(start, end) })
    index = end
    while (/\s/.test(text[index] ?? '')) index += 1
    if (text[index] === ',') index += 1
  }
  throw new Error('Unterminated normalized JSON object')
}

function arrayValues(text: string): string[] {
  arraySchema.parse(JSON.parse(text))
  const values: string[] = []
  let index = text.indexOf('[') + 1
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1
    if (text[index] === ']') return values
    const end = valueEnd(text, index)
    values.push(text.slice(index, end))
    index = end
    while (/\s/.test(text[index] ?? '')) index += 1
    if (text[index] === ',') index += 1
  }
  throw new Error('Unterminated normalized JSON array')
}

function normalizeReadiness(bytes: Buffer) {
  const input = lines(bytes)
  const templates: string[][] = []
  const lookup = new Map<string, number>()
  const identityKeys = new Set(['id', 'recordId', 'code', 'name'])
  const rows = input.rows.map(row => {
    const identities = fields(row).filter(field => identityKeys.has(field.key))
    const parts: string[] = []
    let position = 0
    for (const field of identities) {
      parts.push(row.slice(position, field.start))
      position = field.end
    }
    parts.push(row.slice(position))
    const key = JSON.stringify(parts)
    let templateId = lookup.get(key)
    if (templateId === undefined) {
      templateId = templates.length
      templates.push(parts)
      lookup.set(key, templateId)
    }
    return `[${templateId}${identities.map(field => `,${field.raw}`).join('')}]`
  })
  return { data: Buffer.from(`${rows.join('\n')}${rows.length === 0 ? '' : '\n'}`), templates: Buffer.from(`${JSON.stringify(templates)}\n`), format: input.format }
}

export async function renderNormalizedRecipe(recipe: NormalizedRecipe, read: Read): Promise<Buffer> {
  const input = lines(await read(recipe.dataPath))
  if (recipe.kind === 'readiness-templates') {
    const templates = templatesSchema.parse(JSON.parse((await read(recipe.templatesPath)).toString('utf8')))
    return encode(input.rows.map(row => {
      const values = arrayValues(row)
      const templateId = templateIdSchema.parse(JSON.parse(values[0] ?? 'null'))
      const template = templates[templateId]
      if (template === undefined || template.length !== values.length) throw new Error('Readiness template reference or arity mismatch')
      return template.map((part, index) => `${part}${index + 1 < values.length ? values[index + 1] : ''}`).join('')
    }), recipe)
  }
  const pages = new Map<number, { source: string; lines: string[] }>()
  for (const row of lines(await read(recipe.pagesPath)).rows) {
    const page = pageSchema.parse(JSON.parse(row))
    if (pages.has(page.source.pdfPage)) throw new Error('Duplicate native PDF page')
    const source = fields(row).find(field => field.key === 'source')!.raw
    // oxlint-disable-next-line no-control-regex -- Preserve Python str.splitlines semantics used by the source audit.
    const nativeLines = page.text.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/)
    if (nativeLines.at(-1) === '') nativeLines.pop()
    pages.set(page.source.pdfPage, { source, lines: nativeLines })
  }
  return encode(input.rows.map(row => {
    const member = memberSchema.parse(JSON.parse(row))
    const page = pages.get(member.source.pdfPage)
    const rawLine = page?.lines[member.source.nativeTextLine]
    if (page === undefined || rawLine === undefined) throw new Error('Member references a missing native PDF page or zero-based line')
    const source = `${page.source.slice(0, -1)},"nativeTextLine":${member.source.nativeTextLine},"rawLine":${JSON.stringify(rawLine)}}`
    const field = fields(row).find(value => value.key === 'source')!
    return `${row.slice(0, field.start)}${source}${row.slice(field.end)}`
  }), recipe)
}

export async function buildNormalizedArtifacts(options: {
  packages: OfflineReferenceLock['packages']; storageRoot: string; read: Read
}): Promise<{ recipes: Map<string, NormalizedRecipe>; artifacts: Map<string, Buffer> }> {
  containedPath.parse(options.storageRoot)
  const recipes = new Map<string, NormalizedRecipe>()
  const artifacts = new Map<string, Buffer>()
  const read: Read = async path => artifacts.get(path) ?? options.read(path)
  for (const input of options.packages.filter(item => item.format === 'prepared-catalogues-v1')) {
    const manifest = z.object({ files: z.array(z.object({ path: containedPath }).loose()) }).loose()
      .parse(JSON.parse((await options.read(`${input.root}/${input.manifest.path}`)).toString('utf8')))
    const listed = new Set(manifest.files.map(file => file.path))
    for (const relative of ['assessment/record-readiness.jsonl', 'drg/rule-members.jsonl']) {
      if (!listed.has(relative)) continue
      const logicalPath = `${input.root}/${relative}`
      const original = await options.read(logicalPath)
      const dataPath = `${options.storageRoot}/normalized/${input.id}/${relative}`
      let recipe: NormalizedRecipe
      if (relative.startsWith('assessment/')) {
        const normalized = normalizeReadiness(original)
        const templatesPath = `${dataPath}.templates.json`
        artifacts.set(dataPath, normalized.data)
        artifacts.set(templatesPath, normalized.templates)
        recipe = { kind: 'readiness-templates', dataPath, templatesPath, ...normalized.format }
      } else {
        if (!listed.has('drg/native-page-text.jsonl')) throw new Error('Member normalization requires retained native PDF pages')
        const normalized = lines(original)
        const rows = normalized.rows.map(row => {
          const parsed = originalMemberSchema.parse(JSON.parse(row))
          const field = fields(row).find(value => value.key === 'source')!
          const source = JSON.stringify({ pdfPage: parsed.source.pdfPage, nativeTextLine: parsed.source.nativeTextLine })
          return `${row.slice(0, field.start)}${source}${row.slice(field.end)}`
        })
        artifacts.set(dataPath, Buffer.from(`${rows.join('\n')}${rows.length === 0 ? '' : '\n'}`))
        recipe = { kind: 'member-page-lines', dataPath, pagesPath: `${input.root}/drg/native-page-text.jsonl`, ...normalized.format }
      }
      const rebuilt = await renderNormalizedRecipe(recipe, read)
      if (!rebuilt.equals(original)) throw new Error(`Normalized artifact is not byte-identical: ${logicalPath}`)
      recipes.set(logicalPath, recipe)
    }
  }
  return { recipes, artifacts }
}
