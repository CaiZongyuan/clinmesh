import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { compactDigest, listPinnedArtifacts, openCompactStorage, resolveArtifactOutput } from './infrastructure/reference-data/drg-compact-storage.ts'

/** Export a single original file to an explicit destination outside managed data. */
export async function exportDrgReferenceFile(options: { repositoryRoot: string; lockPath: string; path: string; outputPath: string }) {
  const root = await realpath(options.repositoryRoot)
  const lock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(options.lockPath, 'utf8')))
  const outputPath = resolve(options.outputPath)
  const resolvedOutput = await resolveArtifactOutput(outputPath)
  const delta = relative(root, resolvedOutput)
  if (resolvedOutput === await realpath(options.lockPath)
    || delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))) {
    throw new Error('Export destination must be outside managed source and installation paths')
  }
  const storage = await openCompactStorage(lock, root)
  const read = (path: string) => storage.read(path)
  const pinned = await listPinnedArtifacts(lock, read)
  const expected = pinned.get(options.path)
  if (expected === undefined) throw new Error('Export path is not in the pinned inventory')
  const bytes = await read(options.path)
  if (compactDigest(bytes) !== expected) throw new Error('Export checksum mismatch')
  await mkdir(dirname(outputPath), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputPath), '.clinmesh-drg-export-'))
  try {
    const temporary = join(staging, 'file')
    await writeFile(temporary, bytes)
    await rename(temporary, outputPath)
    return { path: options.path, sha256: expected, sizeBytes: bytes.length }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] !== undefined && /^drg-reference-export\.(ts|js)$/.test(basename(process.argv[1]))
  && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { 'input-root': { type: 'string' }, manifest: { type: 'string' },
    path: { type: 'string' }, output: { type: 'string' } } })
  if (values['input-root'] === undefined || values.manifest === undefined || values.path === undefined || values.output === undefined) {
    throw new Error('Usage: drg-reference-export --input-root <installation> --manifest <lock> --path <logical-path> --output <destination>')
  }
  const result = await exportDrgReferenceFile({ repositoryRoot: values['input-root'], lockPath: values.manifest, path: values.path, outputPath: values.output })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
