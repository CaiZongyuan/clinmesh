import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { inspectOfflineInventory } from './infrastructure/reference-data/offline-reference-inventory.ts'
import { buildDerivedRecipes } from './infrastructure/reference-data/drg-derived-codecs.ts'
import { buildNormalizedArtifacts } from './infrastructure/reference-data/drg-normalized-codecs.ts'
import { compactDigest, compactFormat, containedArtifactPath, listPinnedArtifacts, resolveArtifactOutput, safeArtifactPath,
  type CompactIndex } from './infrastructure/reference-data/drg-compact-storage.ts'

/** Build current compact storage from the complete pinned logical source files. */
export async function createCompactDrgReference(options: {
  sourceRoot: string
  sourceLockPath: string
  outputDirectory: string
  inventoryId: string
  createdAt: string
  onProgress?: (line: string) => void
}) {
  const sourceRoot = await realpath(options.sourceRoot)
  const outputDirectory = await resolveArtifactOutput(options.outputDirectory)
  const lock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(options.sourceLockPath, 'utf8')))
  if (lock.packages.some(input => {
    const delta = relative(resolve(sourceRoot, input.root), outputDirectory)
    return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))
  })) throw new Error('Compact destination must be outside original package paths')
  try { await lstat(outputDirectory); throw new Error('Compact output directory already exists') }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const read = async (path: string) => readFile(await containedArtifactPath(sourceRoot, path))
  const pinned = await listPinnedArtifacts(lock, read)
  const readPinned = async (path: string) => {
    const expected = pinned.get(path)
    if (expected === undefined) throw new Error(`Conversion dependency is unlisted: ${path}`)
    const bytes = await read(path)
    if (compactDigest(bytes) !== expected) throw new Error(`Conversion source checksum mismatch: ${path}`)
    return bytes
  }
  options.onProgress?.('完整来源已核验，重建派生文件并验证模板转换')
  const derived = await buildDerivedRecipes({ packages: lock.packages, read: readPinned })
  const storageRoot = '.data/drg-compact/v1'
  const normalized = await buildNormalizedArtifacts({ packages: lock.packages, storageRoot, read: readPinned })
  const recipes = new Map<string, CompactIndex['files'][string]['recipe']>([...derived, ...normalized.recipes])
  for (const path of recipes.keys()) if (!pinned.has(path)) throw new Error(`Unpinned conversion recipe: ${path}`)
  await mkdir(dirname(outputDirectory), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputDirectory), '.clinmesh-drg-compact-'))
  try {
    const index: CompactIndex = { schemaVersion: compactFormat, files: {}, objects: {} }
    const byHash = new Map<string, string>()
    async function put(path: string, bytes: Buffer) {
      if (!safeArtifactPath(path)) throw new Error('Invalid compact object path')
      const sha256 = compactDigest(bytes)
      const canonical = byHash.get(sha256)
      if (canonical !== undefined) return canonical
      byHash.set(sha256, path)
      await mkdir(dirname(join(staging, path)), { recursive: true })
      await writeFile(join(staging, path), bytes, { flag: 'wx' })
      index.objects[path] = { sha256, sizeBytes: bytes.length }
      return path
    }
    // Template paths are dependencies of recipes, so retain their explicit names.
    for (const [path, bytes] of normalized.artifacts) {
      if (!safeArtifactPath(path) || !path.startsWith(`${storageRoot}/`)) throw new Error('Normalized artifact escaped compact storage')
      const canonical = await put(path, bytes)
      if (canonical !== path) throw new Error('Normalized artifact names must have distinct content')
    }
    let originalSizeBytes = 0
    for (const [path, sha256] of pinned) {
      const bytes = await readPinned(path)
      originalSizeBytes += bytes.length
      const recipe = recipes.get(path) ?? { kind: 'file' as const, path: await put(path, bytes) }
      index.files[path] = { sha256, sizeBytes: bytes.length, recipe }
    }
    const manifestPath = `${storageRoot}/index.json`
    const manifest = `${JSON.stringify(index)}\n`
    await mkdir(dirname(join(staging, manifestPath)), { recursive: true })
    await writeFile(join(staging, manifestPath), manifest)
    const compactLock = offlineReferenceLockSchema.parse({ ...lock, inventoryId: options.inventoryId, createdAt: options.createdAt,
      storage: { format: compactFormat, manifest: { path: manifestPath, sha256: compactDigest(manifest) } } })
    const lockPath = join(staging, 'drg-offline.lock.json')
    await writeFile(lockPath, `${JSON.stringify(compactLock, null, 2)}\n`)
    options.onProgress?.(`逐文件核对全部 ${pinned.size} 个原逻辑文件的字节与来源`)
    await inspectOfflineInventory(lockPath, staging)
    const residentSizeBytes = Object.values(index.objects).reduce((sum, object) => sum + object.sizeBytes, Buffer.byteLength(manifest))
    const result = { inventoryId: compactLock.inventoryId, lockPath: join(outputDirectory, 'drg-offline.lock.json'),
      logicalFileCount: pinned.size, physicalFileCount: Object.keys(index.objects).length + 1,
      originalSizeBytes, residentSizeBytes, savedBytes: originalSizeBytes - residentSizeBytes,
      derivedFileCount: derived.size, normalizedFileCount: normalized.recipes.size }
    await rename(staging, outputDirectory)
    return result
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] !== undefined && /^drg-reference-compact\.(ts|js)$/.test(basename(process.argv[1]))
  && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { 'input-root': { type: 'string' }, manifest: { type: 'string' },
    output: { type: 'string' }, inventory: { type: 'string' }, 'created-at': { type: 'string' } } })
  if (values['input-root'] === undefined || values.manifest === undefined || values.output === undefined
    || values.inventory === undefined || values['created-at'] === undefined) throw new Error('Usage: drg-reference-compact --input-root <logical-source> --manifest <current-lock> --output <new-directory> --inventory <inventory-id> --created-at <ISO datetime>')
  const result = await createCompactDrgReference({ sourceRoot: values['input-root'], sourceLockPath: values.manifest,
    outputDirectory: values.output, inventoryId: values.inventory, createdAt: values['created-at'],
    onProgress: line => process.stderr.write(`${line}\n`) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
