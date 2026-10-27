import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { GuidelineSyncResult } from './guideline-sync.ts'
import { defaultGuidelineDatabasePath, guidelineDeploymentPolicySchema, guidelineLocalEvaluationSchema, guidelineNonCommercialUseSchema, readServerEnvironment } from './config.ts'
import { isGuidelineSourceUsable, localEvaluationSourcePrefix, type GuidelineDeploymentPolicy } from './application/guideline-corpus.ts'
import { GuidelineCorpus, guidelineSourceDefinitionSchema } from './infrastructure/sqlite/guideline-corpus.ts'
import { extractGuidelinePdf } from './infrastructure/guidelines/import-guideline-source.ts'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const owned = (id: string) => id.startsWith(localEvaluationSourcePrefix) && id.length > localEvaluationSourcePrefix.length
const page = z.number().int().min(1).max(5000)
const entrySchema = z.object({
  source: guidelineSourceDefinitionSchema.refine(source => source.format === 'pdf' && owned(source.id),
    'Local sources require a controlled source ID and an original PDF')
    .refine(source => [source.url, source.license.url].every(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
    }), 'Local publication links require HTTPS without credentials or a custom port'),
  pages: z.array(z.tuple([page, page])).min(1).max(5000)
    .refine(ranges => ranges.every(([from, to], index) => from <= to && (index === 0 || ranges[index - 1]![1] < from)),
      'PDF page ranges must be ordered, disjoint and nonempty'),
}).strict()
const registrySchema = z.object({ schemaVersion: z.literal(1), sources: z.array(entrySchema).max(5000) }).strict()
  .refine(registry => new Set(registry.sources.map(entry => entry.source.id)).size === registry.sources.length, 'Duplicate local source IDs')

export async function runLocalGuidelineSync(args: readonly string[], options: {
  allowLocalEvaluation?: boolean; allowNonCommercial?: boolean; deploymentPolicy?: GuidelineDeploymentPolicy; onProgress?: (line: string) => void
} = {}): Promise<GuidelineSyncResult> {
  const { values } = parseArgs({ args: [...args], allowPositionals: false, strict: true, options: {
    manifest: { type: 'string' }, database: { type: 'string' }, 'source-dir': { type: 'string' },
  } })
  const manifest = resolve(values.manifest ?? join(repositoryRoot, 'apps/server/reference-data/local-guideline-sources.json'))
  if ((await stat(manifest)).size > 2 * 1024 * 1024) throw new Error('Local guideline manifest exceeds 2 MiB')
  const registry = registrySchema.parse(JSON.parse(await readFile(manifest, 'utf8')))
  const entries = registry.sources.map(entry => {
    const scope = `${entry.source.scope} 来源使用条件：${entry.source.license.id}；说明链接：${entry.source.license.url}。原文未改写；纳入物理页 ${entry.pages.map(([from, to]) => from === to ? from : `${from}–${to}`).join('、')}。`
    return { ...entry, source: guidelineSourceDefinitionSchema.parse({ ...entry.source, scope }) }
  })
  const databasePath = resolve(values.database ?? defaultGuidelineDatabasePath)
  const directory = resolve(values['source-dir'] ?? join(repositoryRoot, '.data/guidelines/local-originals'))
  const corpus = new GuidelineCorpus({ databasePath, allowLocalEvaluation: options.allowLocalEvaluation === true,
    allowNonCommercial: options.allowNonCommercial === true, deploymentPolicy: options.deploymentPolicy ?? 'default' })
  const items: GuidelineSyncResult['items'] = []
  try {
    const next = new Map(entries.map(entry => [entry.source.id, entry]))
    for (const previous of corpus.sources()) {
      if (!owned(previous.source.id)) continue
      const replacement = next.get(previous.source.id)
      if (replacement !== undefined && JSON.stringify(previous.source) === JSON.stringify(replacement.source)) continue
      corpus.importDocument({ source: previous.source, passages: [] })
    }
    for (const entry of entries) {
      const { source } = entry
      try {
        if (source.status !== 'active') {
          corpus.importDocument({ source, passages: [] })
          items.push({ sourceId: source.id, status: source.status, passageCount: 0 })
          continue
        }
        const file = await open(join(directory, `${source.sha256}.pdf`), 'r')
        let bytes: Buffer
        try {
          if ((await file.stat()).size > 32 * 1024 * 1024) throw new Error('Local original exceeds 32 MiB')
          bytes = await file.readFile()
        } finally { await file.close() }
        if (bytes.length > 32 * 1024 * 1024) throw new Error('Local original exceeds 32 MiB')
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Local original SHA-256 mismatch')
        const included = new Set(entry.pages.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, index) => from + index)))
        const original = await extractGuidelinePdf(bytes, included)
        // oxlint-disable-next-line no-control-regex -- 拒绝文字层中无法解释的医学符号，不能猜测替换。
        if (original.some(passage => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(passage.text))) {
          throw new Error('Selected original pages contain uninterpretable control characters; review the original without guessing replacements')
        }
        const imported = corpus.importDocument({ source, passages: original })
        items.push({ sourceId: source.id, status: imported.created ? 'imported' : 'unchanged', passageCount: imported.passageCount })
        options.onProgress?.(`${source.id}: ${imported.passageCount} 段原文`)
      } catch (error) {
        items.push({ sourceId: source.id, status: 'failed', passageCount: 0,
          reason: error instanceof Error ? error.message : 'Local guideline import failed' })
      }
    }
    const installed = corpus.sources()
    const knownSources = installed.map(item => item.source)
    const usable = installed.filter(item => item.passageCount > (item.unusablePassageCount ?? 0) && isGuidelineSourceUsable(item.source, options.allowNonCommercial,
      { deploymentPolicy: options.deploymentPolicy ?? 'default', allowLocalEvaluation: options.allowLocalEvaluation === true, knownSources }))
    return { databasePath, sourceCount: installed.length, passageCount: installed.reduce((sum, item) => sum + item.passageCount, 0),
      searchableSourceCount: usable.length, searchablePassageCount: usable.reduce((sum, item) => sum + item.passageCount - (item.unusablePassageCount ?? 0), 0),
      failedSourceCount: items.filter(item => item.status === 'failed').length, items }
  } finally { corpus.close() }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runLocalGuidelineSync(process.argv.slice(2).filter(argument => argument !== '--'), {
    allowLocalEvaluation: guidelineLocalEvaluationSchema.parse(readServerEnvironment(process.env).CLINMESH_GUIDELINE_LOCAL_EVALUATION),
    allowNonCommercial: guidelineNonCommercialUseSchema.parse(readServerEnvironment(process.env).CLINMESH_GUIDELINE_NON_COMMERCIAL_USE),
    deploymentPolicy: guidelineDeploymentPolicySchema.parse(readServerEnvironment(process.env).CLINMESH_GUIDELINE_DEPLOYMENT_POLICY),
    onProgress: line => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.failedSourceCount > 0) process.exitCode = 1
}
