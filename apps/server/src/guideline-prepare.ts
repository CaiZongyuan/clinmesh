import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { extract } from 'tar'
import { defaultGuidelineDatabasePath, guidelineDeploymentPolicySchema, guidelineLocalEvaluationSchema, guidelineNonCommercialUseSchema, readServerEnvironment } from './config.ts'
import { guidelineCorpusStatistics, isGuidelinePassageUsable, isGuidelineSourceUsable, type GuidelineDeploymentPolicy } from './application/guideline-corpus.ts'
import { GuidelineCorpus } from './infrastructure/sqlite/guideline-corpus.ts'
import { inspectGuidelineDocuments } from './infrastructure/sqlite/guideline-corpus-check.ts'
import { guidelinePathSchema, guidelineReleaseLockSchema, inspectGuidelineRelease,
  type GuidelineReleaseLock } from './infrastructure/guidelines/guideline-release.ts'

export interface GuidelinePrepareOptions {
  databasePath: string
  lockPath?: string
  installDirectory?: string
  inputRoot?: string
  checkOnly?: boolean
  restoreSourceIds?: readonly string[]
  deploymentPolicy?: GuidelineDeploymentPolicy
  allowNonCommercial?: boolean
  allowLocalEvaluation?: boolean
  onProgress?: (line: string) => void
}
type Snapshot = Awaited<ReturnType<typeof inspectGuidelineRelease>>

function checkLock(lock: GuidelineReleaseLock, snapshot: Snapshot) {
  if (lock.packageId !== snapshot.manifest.packageId || lock.releaseId !== snapshot.manifest.releaseId
    || JSON.stringify(lock.counts) !== JSON.stringify(snapshot.counts)
    || lock.artifact.fileCount !== snapshot.files.length || lock.artifact.unpackedSizeBytes !== snapshot.unpackedSizeBytes) {
    throw new Error('Guideline release identity or scale differs from the lock')
  }
}

function publish(options: GuidelinePrepareOptions, snapshot: Snapshot, source: 'local' | 'installed' | 'download', inputRoot: string) {
  const restoreSourceIds = options.restoreSourceIds ?? []
  for (const sourceId of restoreSourceIds) {
    const document = snapshot.documents.find(item => item.source.id === sourceId)
    if (document === undefined) throw new Error(`Guideline restore source is not in the locked release: ${sourceId}`)
    if (document.source.status !== 'active' || document.source.distribution?.textStatus !== 'verified'
      || !document.passages.some(isGuidelinePassageUsable)) {
      throw new Error(`Guideline restore requires an active source with verified, readable text: ${sourceId}`)
    }
  }
  const inspection = inspectGuidelineDocuments(options.databasePath, snapshot.documents, { preserveRestrictions: true })
  if (options.checkOnly && !inspection.matches) throw new Error('Guideline files are valid but the target database is missing or does not match')
  let created = false
  let sources = inspection.sources
  if (!inspection.matches || restoreSourceIds.length > 0) {
    const writer = new GuidelineCorpus({ databasePath: options.databasePath })
    try {
      const result = writer.importReleaseDocuments(snapshot.documents, restoreSourceIds)
      created = result.created
      sources = result.sources
    } finally { writer.close() }
  }
  const installed = new Map(sources.map(item => [item.source.id, item]))
  const policy = { deploymentPolicy: options.deploymentPolicy ?? 'default', allowLocalEvaluation: options.allowLocalEvaluation === true,
    knownSources: sources.filter(item => item.integrityValid !== false).map(item => item.source) }
  const statisticsOptions = { ...policy, allowNonCommercial: options.allowNonCommercial === true }
  const packageStatisticsOptions = { ...statisticsOptions, sourceIds: snapshot.items.map(item => item.sourceId) }
  const packageStatistics = guidelineCorpusStatistics(sources, packageStatisticsOptions)
  const corpus = guidelineCorpusStatistics(sources, statisticsOptions)
  const items = snapshot.items.map(item => {
    const { source, passageCount, unusablePassageCount = 0, integrityValid } = installed.get(item.sourceId)!
    const usablePassageCount = passageCount - unusablePassageCount
    const searchable = integrityValid !== false && usablePassageCount > 0 && isGuidelineSourceUsable(source, options.allowNonCommercial, policy)
    const textStatus = source.distribution?.textStatus ?? item.textStatus
    const withheldReason = source.status !== 'active' ? `来源状态：${source.status}`
      : textStatus !== 'verified' ? `正文核验状态：${textStatus}`
      : integrityValid === false ? '正文完整性校验未通过'
      : usablePassageCount === 0 ? '没有可可靠读取的正文段落'
      : '当前部署用途策略未启用该来源'
    return { ...item, textStatus, passageCount, searchable, unusablePassageCount,
      ...(searchable ? {} : { withheldReason }) }
  })
  return { packageId: snapshot.manifest.packageId, releaseId: snapshot.manifest.releaseId,
    databasePath: resolve(options.databasePath), inputRoot, source, created, ...snapshot.counts,
    documentCount: packageStatistics.documentCount,
    searchableSourceCount: packageStatistics.searchableSourceCount,
    searchableDocumentCount: packageStatistics.searchableDocumentCount,
    searchablePassageCount: packageStatistics.searchablePassageCount,
    unusablePassageCount: packageStatistics.unusablePassageCount,
    corpus,
    failedSourceCount: items.filter(item => item.textStatus === 'unreadable').length,
    manualReviewPendingSourceCount: snapshot.items.filter(item => item.manualReview === 'pending').length,
    items }
}

async function download(artifact: GuidelineReleaseLock['artifact'], outputPath: string) {
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error(`Guideline download failed: HTTP ${response.status}`)
  }
  const digest = createHash('sha256')
  let count = 0
  const checked = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    count += chunk.length
    if (count > artifact.sizeBytes) { callback(new Error('Guideline archive exceeds its locked size')); return }
    digest.update(chunk); callback(null, chunk)
  } })
  const body = response.body
  const chunks = async function* () {
    const reader = body.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        yield next.value
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  await pipeline(Readable.from(chunks()), checked, createWriteStream(outputPath, { flags: 'wx' }))
  if (count !== artifact.sizeBytes || digest.digest('hex') !== artifact.sha256) throw new Error('Guideline archive size or SHA-256 mismatch')
}

export async function runGuidelinePrepare(options: GuidelinePrepareOptions) {
  if (options.checkOnly && (options.restoreSourceIds?.length ?? 0) > 0) throw new Error('Guideline restore cannot be combined with read-only checking')
  const lockPath = resolve(options.lockPath ?? resolve(import.meta.dirname, '../reference-data/guideline-release.lock.json'))
  if ((await lstat(lockPath)).size > 2 * 1024 * 1024) throw new Error('Guideline release lock exceeds 2 MiB')
  const lock = guidelineReleaseLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')))
  const installDirectory = resolve(options.installDirectory ?? join(dirname(resolve(options.databasePath)), 'guidelines'))
  const installedRoot = join(installDirectory, lock.manifest.sha256)
  if (options.inputRoot !== undefined) {
    const root = resolve(options.inputRoot)
    const snapshot = await inspectGuidelineRelease(root, lock.manifest)
    checkLock(lock, snapshot)
    return publish(options, snapshot, 'local', root)
  }
  let existing: Snapshot | undefined
  try { existing = await inspectGuidelineRelease(installedRoot, lock.manifest); checkLock(lock, existing) }
  catch (error) {
    existing = undefined
    if (options.checkOnly) throw new Error('Guideline installation is missing or damaged; run guidelines:prepare to repair it', { cause: error })
    options.onProgress?.('指南固定资料尚未安装或已损坏，准备下载并核验。')
  }
  if (existing !== undefined) return publish(options, existing, 'installed', installedRoot)
  await mkdir(installDirectory, { recursive: true })
  const guardPath = join(installDirectory, '.prepare.lock')
  const guard = await open(guardPath, 'wx').catch(error => { throw new Error('Another guideline preparation may be running; verify before removing .prepare.lock', { cause: error }) })
  let staging: string | undefined
  let replaced = false
  let installed = false
  let preserve = false
  try {
    staging = await mkdtemp(join(installDirectory, '.clinmesh-guideline-'))
    const archivePath = join(staging, 'guidelines.tar.gz')
    const extractedRoot = join(staging, 'files')
    options.onProgress?.(`下载固定指南资料包 ${lock.releaseId} (${(lock.artifact.sizeBytes / 1_000_000).toFixed(1)} MB)`)
    await download(lock.artifact, archivePath)
    await mkdir(extractedRoot)
    const paths = new Set<string>()
    let bytes = 0
    let invalid: Error | undefined
    await extract({ cwd: extractedRoot, file: archivePath, strict: true, noMtime: true, filter: (path, entry) => {
      if (invalid !== undefined) return false
      if (!('type' in entry) || entry.type !== 'File' || !guidelinePathSchema.safeParse(path).success || paths.has(path.toLowerCase())
        || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
        invalid = new Error('Guideline archive contains an unsafe, duplicate or unsupported entry'); return false
      }
      paths.add(path.toLowerCase()); bytes += entry.size
      if (paths.size > lock.artifact.fileCount || bytes > lock.artifact.unpackedSizeBytes) {
        invalid = new Error('Guideline archive exceeds locked extraction limits'); return false
      }
      return true
    } })
    if (invalid !== undefined) throw invalid
    if (paths.size !== lock.artifact.fileCount || bytes !== lock.artifact.unpackedSizeBytes) throw new Error('Guideline archive is incomplete')
    const snapshot = await inspectGuidelineRelease(extractedRoot, lock.manifest)
    checkLock(lock, snapshot)
    if (existsSync(installedRoot)) { await rename(installedRoot, join(staging, 'previous')); replaced = true }
    await rename(extractedRoot, installedRoot); installed = true
    const result = publish(options, snapshot, 'download', installedRoot)
    options.onProgress?.(`指南库已加载：${result.sourceCount} 项来源，${result.searchableSourceCount} 项可检索，${result.failedSourceCount} 项正文不可读。`)
    return result
  } catch (error) {
    try {
      if (installed) await rm(installedRoot, { recursive: true, force: true })
      if (replaced && staging !== undefined) await rename(join(staging, 'previous'), installedRoot)
    } catch (recoveryError) {
      preserve = true
      throw new Error(`Guideline recovery failed; backup and staging preserved at ${staging}`, { cause: new AggregateError([error, recoveryError]) })
    }
    throw error
  } finally {
    await guard.close()
    await rm(guardPath, { force: true })
    if (staging !== undefined && !preserve) await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && /^guideline-prepare\.(ts|js)$/.test(basename(process.argv[1]))
  && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { database: { type: 'string' }, manifest: { type: 'string' },
    'install-directory': { type: 'string' }, 'input-root': { type: 'string' }, check: { type: 'boolean', default: false },
    'restore-source': { type: 'string', multiple: true } } })
  const environment = readServerEnvironment(process.env)
  const result = await runGuidelinePrepare({ databasePath: values.database ?? environment.CLINMESH_GUIDELINE_DATABASE_PATH ?? defaultGuidelineDatabasePath,
    ...(values.manifest === undefined ? {} : { lockPath: values.manifest }),
    ...(values['install-directory'] === undefined ? {} : { installDirectory: values['install-directory'] }),
    ...(values['input-root'] === undefined ? {} : { inputRoot: values['input-root'] }),
    ...(values['restore-source'] === undefined ? {} : { restoreSourceIds: values['restore-source'] }),
    checkOnly: values.check, deploymentPolicy: guidelineDeploymentPolicySchema.parse(environment.CLINMESH_GUIDELINE_DEPLOYMENT_POLICY),
    allowNonCommercial: guidelineNonCommercialUseSchema.parse(environment.CLINMESH_GUIDELINE_NON_COMMERCIAL_USE),
    allowLocalEvaluation: guidelineLocalEvaluationSchema.parse(environment.CLINMESH_GUIDELINE_LOCAL_EVALUATION),
    onProgress: line => process.stderr.write(`${line}\n`) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
