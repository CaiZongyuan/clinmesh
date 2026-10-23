import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { c } from 'tar'
import { z } from 'zod'
import { inspectOfflineInventory } from './infrastructure/reference-data/offline-reference-inventory.ts'

const fileListSchema = z.object({ files: z.array(z.object({ path: z.string() }).loose()) }).loose()
const fixedMtime = new Date('2000-01-01T00:00:00.000Z')

export async function createDrgReferencePackage(options: {
  repositoryRoot: string
  lockPath: string
  outputPath: string
}): Promise<{
  sha256: string
  sizeBytes: number
  unpackedSizeBytes: number
  fileCount: number
  offlineLockSha256: string
  inventoryId: string
}> {
  const repositoryRoot = resolve(options.repositoryRoot)
  const lockPath = resolve(options.lockPath)
  const inventory = await inspectOfflineInventory(lockPath, repositoryRoot)
  const lockBytes = await readFile(lockPath)
  const lock = offlineReferenceLockSchema.parse(JSON.parse(lockBytes.toString('utf8')))
  const paths = new Set<string>()
  for (const input of lock.packages) {
    const indexPath = input.format === 'prepared-catalogues-v1' ? input.manifest.path : input.checksums?.path
    if (indexPath === undefined) throw new Error('OpenDRG requires a pinned checksum index')
    const index = fileListSchema.parse(JSON.parse(await readFile(join(repositoryRoot, input.root, indexPath), 'utf8')))
    for (const path of [input.manifest.path, indexPath, ...index.files.map(file => file.path)]) {
      paths.add(`${input.root}/${path}`)
    }
  }
  const files = [...paths].sort()
  const outputPath = resolve(options.outputPath)
  let unpackedSizeBytes = 0
  for (const path of files) {
    const sourcePath = join(repositoryRoot, path)
    if (resolve(sourcePath) === outputPath) throw new Error('Package output cannot replace a source artifact')
    const source = await lstat(sourcePath)
    if (!source.isFile() || source.nlink !== 1) throw new Error(`Package source must be a regular file without links: ${path}`)
    unpackedSizeBytes += source.size
  }
  await mkdir(dirname(outputPath), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputPath), 'clinmesh-drg-package-'))
  try {
    const archivePath = join(staging, 'package.tar.gz')
    await c({
      cwd: repositoryRoot, file: archivePath, portable: true, noDirRecurse: true,
      gzip: { level: 9 }, mtime: fixedMtime, strict: true,
    }, files)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk)
    const result = {
      sha256: hash.digest('hex'), sizeBytes: (await stat(archivePath)).size,
      unpackedSizeBytes, fileCount: files.length,
      offlineLockSha256: createHash('sha256').update(JSON.stringify(lock)).digest('hex'), inventoryId: inventory.inventoryId,
    }
    await rename(archivePath, outputPath)
    return result
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const repositoryRoot = option('--input-root') ?? fileURLToPath(new URL('../../../', import.meta.url))
  const outputPath = option('--output')
  if (outputPath === undefined) throw new Error('Usage: drg-reference-package --input-root <repository> --manifest <lock> --output <archive.tar.gz>')
  const result = await createDrgReferencePackage({
    repositoryRoot, outputPath,
    lockPath: option('--manifest') ?? join(repositoryRoot, 'apps/server/reference-data/drg-offline.lock.json'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
