import { readFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { defaultGuidelineDatabasePath } from './config.ts'
import { GuidelineCorpus, guidelineSourceDefinitionSchema } from './infrastructure/sqlite/guideline-corpus.ts'
import { importGuidelineSource } from './infrastructure/guidelines/import-guideline-source.ts'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const registrySchema = z.object({ schemaVersion: z.literal(1), sources: z.array(guidelineSourceDefinitionSchema).min(1).max(5_000) })
  .strict().refine(registry => new Set(registry.sources.map(source => source.id)).size === registry.sources.length,
    'Guideline source IDs must be unique')

export interface GuidelineSyncResult {
  databasePath: string
  sourceCount: number
  searchableSourceCount: number
  passageCount: number
  searchablePassageCount: number
  failedSourceCount: number
  items: Array<{ sourceId: string; status: string; passageCount: number; reason?: string }>
}

export async function runGuidelineSync(args: readonly string[], options: {
  fetch?: typeof fetch; onProgress?: (line: string) => void
} = {}): Promise<GuidelineSyncResult> {
  const { values } = parseArgs({ args: [...args], allowPositionals: false, strict: true, options: {
    manifest: { type: 'string' }, database: { type: 'string' }, 'cache-dir': { type: 'string' }, check: { type: 'boolean' },
  } })
  const databasePath = resolve(values.database ?? defaultGuidelineDatabasePath)
  const cacheDirectory = resolve(values['cache-dir'] ?? join(repositoryRoot, '.data/guidelines/cache'))
  let sources: z.output<typeof registrySchema>['sources'] = []
  if (!values.check) {
    const manifestPath = resolve(values.manifest ?? join(repositoryRoot, 'apps/server/reference-data/guideline-sources.json'))
    if ((await stat(manifestPath)).size > 2 * 1024 * 1024) throw new Error('Guideline source registry exceeds 2 MiB')
    sources = registrySchema.parse(JSON.parse(await readFile(manifestPath, 'utf8'))).sources
  }
  const corpus = new GuidelineCorpus({ databasePath, ...(values.check ? { readOnly: true } : {}) })
  const items: GuidelineSyncResult['items'] = []
  try {
    const previous = new Map(corpus.sources().map(item => [item.source.id, item.source]))
    for (const source of sources) {
      options.onProgress?.(`${source.id}: 读取与校验原文`)
      try {
        if (source.status !== 'active') {
          corpus.importDocument({ source, passages: [] })
          items.push({ sourceId: source.id, status: source.status, passageCount: 0 })
          continue
        }
        // 权限撤销先生效，即使后续原文已经无法取得。
        const installed = previous.get(source.id)
        if (source.license.usage === 'unverified' && installed !== undefined && installed.license.usage !== 'unverified') {
          corpus.importDocument({ source, passages: [] })
        }
        const document = await importGuidelineSource(source, { cacheDirectory,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
        const imported = corpus.importDocument(document)
        items.push({ sourceId: source.id, status: source.license.usage === 'unverified' ? 'withheld'
          : imported.created ? 'imported' : 'unchanged', passageCount: imported.passageCount })
        options.onProgress?.(`${source.id}: ${imported.passageCount} 段，${source.license.usage === 'unverified' ? '用途待核验' : '可检索'}`)
      } catch (error) {
        items.push({ sourceId: source.id, status: 'failed', passageCount: 0,
          reason: error instanceof Error ? error.message : 'Guideline source import failed' })
        options.onProgress?.(`${source.id}: 导入未完成`)
      }
    }
    const installed = corpus.sources()
    const searchable = installed.filter(item => item.source.status === 'active'
      && item.source.license.usage !== 'unverified' && item.passageCount > 0)
    return { databasePath, sourceCount: installed.length, searchableSourceCount: searchable.length,
      passageCount: installed.reduce((total, item) => total + item.passageCount, 0),
      searchablePassageCount: searchable.reduce((total, item) => total + item.passageCount, 0),
      failedSourceCount: items.filter(item => item.status === 'failed').length,
      items: values.check ? installed.map(item => ({ sourceId: item.source.id,
        status: item.source.status !== 'active' ? item.source.status
          : item.source.license.usage === 'unverified' ? 'withheld' : 'available', passageCount: item.passageCount })) : items }
  } finally { corpus.close() }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runGuidelineSync(process.argv.slice(2).filter(argument => argument !== '--'), {
    onProgress: line => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.failedSourceCount > 0) process.exitCode = 1
}
