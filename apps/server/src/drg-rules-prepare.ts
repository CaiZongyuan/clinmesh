import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import { loadDrgRules } from './infrastructure/reference-data/drg-rules-package.ts'
import { prepareDrgRulesPackage } from './infrastructure/reference-data/drg-rules-prepare.ts'
import { listPinnedArtifacts, openCompactStorage, safeArtifactPath } from './infrastructure/reference-data/drg-compact-storage.ts'

const sourceFileSchema = z.object({
  path: z.string().min(1).refine(safeArtifactPath, 'DRG source path must be a contained logical path'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const sourceLockSchema = z.object({
  schemaVersion: z.literal('clinmesh.drg-rules-source.v1'),
  releaseId: z.string().min(1), sourceVersion: z.string().min(1),
  inputs: z.object({ groups: sourceFileSchema, js: sourceFileSchema, tables: sourceFileSchema }).strict(),
}).strict()
const complicationTablesSchema = z.object({
  CC: z.record(z.string(), z.string()), MCC: z.record(z.string(), z.string()), CCE: z.record(z.string(), z.string()), SS_VALID: z.array(z.string()),
})

function sha256(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex') }

/** 只物化并核验锁定的离线输入；不执行上游程序、不生成启用审核。 */
export async function runDrgRulesPrepare(input: {
  inputRoot: string
  outputDirectory: string
  sourceLockPath?: string
  offlineLockPath?: string
}) {
  const sourceLockPath = input.sourceLockPath ?? join(import.meta.dirname, '../reference-data/drg-rules-source.lock.json')
  const source = sourceLockSchema.parse(JSON.parse(await readFile(sourceLockPath, 'utf8')))
  const offlineLockPath = input.offlineLockPath ?? join(import.meta.dirname, '../reference-data/drg-offline.lock.json')
  const offlineLock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(offlineLockPath, 'utf8')))
  const storage = await openCompactStorage(offlineLock, input.inputRoot)
  const pinned = await listPinnedArtifacts(offlineLock, path => storage.read(path))
  const lockedInput = async (file: z.infer<typeof sourceFileSchema>) => {
    if (pinned.get(file.path) !== file.sha256) throw new Error(`DRG input is not pinned by the offline inventory: ${file.path}`)
    const bytes = await storage.read(file.path)
    if (sha256(bytes) !== file.sha256) throw new Error(`DRG input checksum mismatch: ${file.path}`)
    return bytes.toString('utf8')
  }
  const [groupsText, jsText, tablesText] = await Promise.all([
    lockedInput(source.inputs.groups), lockedInput(source.inputs.js), lockedInput(source.inputs.tables),
  ])
  const files = prepareDrgRulesPackage({
    groups: groupsText.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)),
    jsText, complicationTables: complicationTablesSchema.parse(JSON.parse(tablesText)),
    input: { openDrgJsSha256: source.inputs.js.sha256, openDrgTablesSha256: source.inputs.tables.sha256,
      r3GroupsSha256: source.inputs.groups.sha256 }, releaseId: source.releaseId, sourceVersion: source.sourceVersion,
  })
  const outputDirectory = resolve(input.outputDirectory)
  const result = { outputDirectory, releaseId: source.releaseId, sourceVersion: source.sourceVersion,
    manifestSha256: sha256(files['manifest.json']!), runtimeEnabled: false as const }
  const existingOutput = await lstat(outputDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existingOutput !== null) {
    if (!existingOutput.isDirectory() || existingOutput.isSymbolicLink()) throw new Error('DRG output must be an immutable package directory without links')
    const existingManifest = await readFile(join(outputDirectory, 'manifest.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('DRG output exists without a manifest; use a new immutable release directory')
      throw error
    })
    if (existingManifest !== files['manifest.json']) throw new Error('DRG output already contains a different rules package')
    await loadDrgRules(outputDirectory)
    return { status: 'already-prepared' as const, ...result }
  }
  await mkdir(dirname(outputDirectory), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputDirectory), '.drg-rules-'))
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(staging, name), content, 'utf8')
    await loadDrgRules(staging)
    await rename(staging, outputDirectory)
  } finally { await rm(staging, { recursive: true, force: true }) }
  return { status: 'prepared' as const, ...result }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'input-root': { type: 'string' }, 'output-directory': { type: 'string' }, manifest: { type: 'string' } } })
  const options = z.object({ 'input-root': z.string().min(1), 'output-directory': z.string().min(1), manifest: z.string().min(1).optional() }).parse(values)
  console.info(JSON.stringify(await runDrgRulesPrepare({ inputRoot: options['input-root'], outputDirectory: options['output-directory'],
    ...(options.manifest === undefined ? {} : { offlineLockPath: options.manifest }) })))
}
