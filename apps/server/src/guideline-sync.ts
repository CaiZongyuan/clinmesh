import { readFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { defaultGuidelineDatabasePath, guidelineDeploymentPolicySchema, guidelineLocalEvaluationSchema, guidelineNonCommercialUseSchema, readServerEnvironment } from './config.ts'
import { isGuidelinePassageUsable, isGuidelineSourceUsable, type GuidelineDeploymentPolicy } from './application/guideline-corpus.ts'
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
  items: Array<{ sourceId: string; status: string; passageCount: number; unusablePassageCount?: number; reason?: string }>
}

export async function runGuidelineSync(args: readonly string[], options: {
  fetch?: typeof fetch; onProgress?: (line: string) => void; allowNonCommercial?: boolean; deploymentPolicy?: GuidelineDeploymentPolicy; allowLocalEvaluation?: boolean
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
  const corpus = new GuidelineCorpus({ databasePath, allowNonCommercial: options.allowNonCommercial === true,
    deploymentPolicy: options.deploymentPolicy ?? 'default',
    allowLocalEvaluation: options.allowLocalEvaluation === true,
    ...(values.check ? { readOnly: true } : {}) })
  const items: GuidelineSyncResult['items'] = []
  try {
    const previous = new Map(corpus.sources().map(item => [item.source.id, item.source]))
    for (const source of sources) {
      options.onProgress?.(`${source.id}: 读取与校验原文`)
      try {
        const unavailableText = source.distribution !== undefined && source.distribution.textStatus !== 'verified'
        if (source.status !== 'active' || unavailableText) {
          corpus.importDocument({ source, passages: [] })
          items.push({ sourceId: source.id, status: unavailableText ? 'withheld' : source.status, passageCount: 0,
            ...(unavailableText ? { reason: `Text verification: ${source.distribution!.textStatus}` } : {}) })
          continue
        }
        // 权限撤销先生效，即使后续原文已经无法取得。
        const installed = previous.get(source.id)
        if (installed !== undefined && installed.license.usage !== source.license.usage
          && (source.license.usage === 'unverified' || installed.license.usage === 'open')) {
          corpus.importDocument({ source, passages: [] })
        }
        const document = await importGuidelineSource(source, { cacheDirectory,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
        const imported = corpus.importDocument(document)
        const usablePassageCount = document.passages.filter(isGuidelinePassageUsable).length
        const unusablePassageCount = document.passages.length - usablePassageCount
        items.push({ sourceId: source.id, status: imported.created ? 'imported' : 'unchanged', passageCount: imported.passageCount,
          ...(unusablePassageCount > 0 ? { unusablePassageCount } : {}) })
      } catch (error) {
        items.push({ sourceId: source.id, status: 'failed', passageCount: 0,
          reason: error instanceof Error ? error.message : 'Guideline source import failed' })
        options.onProgress?.(`${source.id}: 导入未完成`)
      }
    }
    const installed = corpus.sources()
    const policy = { deploymentPolicy: options.deploymentPolicy ?? 'default', allowLocalEvaluation: options.allowLocalEvaluation === true,
      knownSources: installed.map(item => item.source) }
    const searchable = installed.filter(item => isGuidelineSourceUsable(item.source, options.allowNonCommercial, policy)
      && item.passageCount > (item.unusablePassageCount ?? 0))
    const reportedItems = items.map(item => {
      if (!['imported', 'unchanged'].includes(item.status)) return item
      const available = searchable.find(source => source.source.id === item.sourceId)
      const searchablePassageCount = available === undefined ? 0 : available.passageCount - (available.unusablePassageCount ?? 0)
      options.onProgress?.(`${item.sourceId}: ${item.passageCount} 段，${searchablePassageCount} 段可检索`)
      return available === undefined ? { ...item, status: 'withheld' } : item
    })
    return { databasePath, sourceCount: installed.length, searchableSourceCount: searchable.length,
      passageCount: installed.reduce((total, item) => total + item.passageCount, 0),
      searchablePassageCount: searchable.reduce((total, item) => total + item.passageCount - (item.unusablePassageCount ?? 0), 0),
      failedSourceCount: items.filter(item => item.status === 'failed').length,
      items: values.check ? installed.map(item => ({ sourceId: item.source.id,
        status: item.source.status !== 'active' ? item.source.status
          : item.passageCount > (item.unusablePassageCount ?? 0) && isGuidelineSourceUsable(item.source, options.allowNonCommercial, policy) ? 'available' : 'withheld',
        passageCount: item.passageCount, ...(item.unusablePassageCount === undefined ? {} : { unusablePassageCount: item.unusablePassageCount }) }))
        : reportedItems }
  } finally { corpus.close() }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runGuidelineSync(process.argv.slice(2).filter(argument => argument !== '--'), {
    allowNonCommercial: guidelineNonCommercialUseSchema.parse(readServerEnvironment(process.env).CLINMESH_GUIDELINE_NON_COMMERCIAL_USE),
    deploymentPolicy: guidelineDeploymentPolicySchema.parse(readServerEnvironment(process.env).CLINMESH_GUIDELINE_DEPLOYMENT_POLICY),
    allowLocalEvaluation: guidelineLocalEvaluationSchema.parse(readServerEnvironment(process.env).CLINMESH_GUIDELINE_LOCAL_EVALUATION),
    onProgress: line => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.failedSourceCount > 0) process.exitCode = 1
}
