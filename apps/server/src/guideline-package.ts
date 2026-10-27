import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { create } from 'tar'
import { guidelineDigest, guidelineReleaseLockSchema, inspectGuidelineRelease } from './infrastructure/guidelines/guideline-release.ts'

export async function createGuidelinePackage(options: { inputRoot: string; outputPath: string; url: string }) {
  const inputRoot = resolve(options.inputRoot)
  const bytes = await readFile(join(inputRoot, 'manifest.json'))
  const manifestPin = { path: 'manifest.json', sha256: guidelineDigest(bytes), sizeBytes: bytes.length }
  const inspected = await inspectGuidelineRelease(inputRoot, manifestPin)
  const outputPath = resolve(options.outputPath)
  if (outputPath.startsWith(`${inputRoot}/`) || outputPath.startsWith(`${inputRoot}\\`)) throw new Error('Guideline output must be outside the input snapshot')
  await mkdir(dirname(outputPath), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputPath), '.clinmesh-guideline-package-'))
  try {
    const archivePath = join(staging, 'guidelines.tar.gz')
    await create({ cwd: inputRoot, file: archivePath, portable: true, noDirRecurse: true, strict: true,
      gzip: { level: 9 }, mtime: new Date('2000-01-01T00:00:00.000Z') }, inspected.files.map(file => file.path))
    const archive = await readFile(archivePath)
    const lock = guidelineReleaseLockSchema.parse({ schemaVersion: 1, packageId: inspected.manifest.packageId,
      releaseId: inspected.manifest.releaseId, manifest: manifestPin, counts: inspected.counts,
      artifact: { url: options.url, sha256: guidelineDigest(archive), sizeBytes: (await stat(archivePath)).size,
        unpackedSizeBytes: inspected.unpackedSizeBytes, fileCount: inspected.files.length } })
    await rename(archivePath, outputPath)
    return lock
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] !== undefined && /^guideline-package\.(ts|js)$/.test(basename(process.argv[1]))
  && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { 'input-root': { type: 'string' }, output: { type: 'string' }, url: { type: 'string' } } })
  if (values['input-root'] === undefined || values.output === undefined || values.url === undefined) {
    throw new Error('Usage: guidelines:package --input-root <snapshot> --output <archive.tar.gz> --url <fixed-release-url>')
  }
  process.stdout.write(`${JSON.stringify(await createGuidelinePackage({ inputRoot: values['input-root'], outputPath: values.output, url: values.url }))}\n`)
}
