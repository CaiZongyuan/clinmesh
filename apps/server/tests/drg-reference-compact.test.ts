import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCompactDrgReference } from '../src/drg-reference-compact.ts'
import { exportDrgReferenceFile } from '../src/drg-reference-export.ts'
import { inspectOfflineInventory } from '../src/infrastructure/reference-data/offline-reference-inventory.ts'
import { openCompactStorage } from '../src/infrastructure/reference-data/drg-compact-storage.ts'
import { createDrgReferenceFixture, sha256 } from './fixtures/drg-reference.ts'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('converts the complete source to a new identity and preserves source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-compact-create-'))
  roots.push(root)
  const source = await createDrgReferenceFixture(root)
  const alias = `${source.packageRoot}/services/alias.jsonl`
  await writeFile(join(root, alias), source.records)
  const manifest = JSON.parse(source.manifest)
  manifest.files.push({ ...manifest.files[0], path: 'services/alias.jsonl' })
  const manifestBytes = JSON.stringify(manifest)
  await writeFile(join(root, source.packageRoot, 'manifest.json'), manifestBytes)
  const lock = JSON.parse(source.lockBytes)
  lock.packages[0].manifest.sha256 = sha256(manifestBytes)
  await writeFile(source.lockPath, JSON.stringify(lock))
  const before = await inspectOfflineInventory(source.lockPath, root)
  const outputDirectory = join(root, 'compact')
  const result = await createCompactDrgReference({ sourceRoot: root, sourceLockPath: source.lockPath, outputDirectory,
    inventoryId: 'synthetic-compact-v1', createdAt: '2026-10-25T00:00:00.000Z' })
  expect(result).toMatchObject({ logicalFileCount: 3, physicalFileCount: 3, inventoryId: 'synthetic-compact-v1' })
  const compactLock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(result.lockPath, 'utf8')))
  const storage = await openCompactStorage(compactLock, outputDirectory)
  expect((await storage!.read(alias)).toString()).toBe(source.records)
  expect((await readdir(join(outputDirectory, source.packageRoot, 'services')))).toHaveLength(1)
  const after = await inspectOfflineInventory(result.lockPath, outputDirectory)
  expect(after.packages).toEqual(before.packages)
  expect(after.runtimeEnabled).toBe(false)
  expect(await readFile(join(root, alias), 'utf8')).toBe(source.records)
  const exportPath = join(root, 'export', 'alias.jsonl')
  expect(await exportDrgReferenceFile({ repositoryRoot: outputDirectory, lockPath: result.lockPath, path: alias, outputPath: exportPath }))
    .toMatchObject({ sha256: sha256(source.records), sizeBytes: Buffer.byteLength(source.records) })
  expect(await readFile(exportPath, 'utf8')).toBe(source.records)
  await expect(exportDrgReferenceFile({ repositoryRoot: outputDirectory, lockPath: result.lockPath, path: alias,
    outputPath: join(outputDirectory, alias) })).rejects.toThrow(/outside managed/)
  await expect(exportDrgReferenceFile({ repositoryRoot: outputDirectory, lockPath: result.lockPath, path: alias,
    outputPath: join(outputDirectory, 'accepted.jsonl') })).rejects.toThrow(/outside managed/)
  const repeat = await createCompactDrgReference({ sourceRoot: root, sourceLockPath: source.lockPath,
    outputDirectory: join(root, 'repeat'), inventoryId: 'synthetic-compact-v1', createdAt: '2026-10-25T00:00:00.000Z' })
  expect(await readFile(repeat.lockPath)).toEqual(await readFile(result.lockPath))
  expect(await readFile(join(root, 'repeat', compactLock.storage!.manifest.path)))
    .toEqual(await readFile(join(outputDirectory, compactLock.storage!.manifest.path)))
})

it('does not overwrite an existing destination or publish a conversion from damaged sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-compact-failure-'))
  roots.push(root)
  const source = await createDrgReferenceFixture(root)
  await writeFile(join(root, source.packageRoot, 'services/records.jsonl'), '{"code":"damaged"}\n')
  const options = { sourceRoot: root, sourceLockPath: source.lockPath, outputDirectory: join(root, 'compact'),
    inventoryId: 'synthetic-compact-v1', createdAt: '2026-10-25T00:00:00.000Z' }
  await expect(createCompactDrgReference(options)).rejects.toThrow(/checksum/)
  await expect(readFile(join(options.outputDirectory, 'drg-offline.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(options.outputDirectory, 'previous')
  await expect(createCompactDrgReference(options)).rejects.toThrow()
  expect(await readFile(options.outputDirectory, 'utf8')).toBe('previous')
})

it('rejects a destination whose linked parent points into the original sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-compact-junction-'))
  roots.push(root)
  const source = await createDrgReferenceFixture(root)
  await symlink(join(root, source.packageRoot), join(root, 'source-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(createCompactDrgReference({ sourceRoot: root, sourceLockPath: source.lockPath,
    outputDirectory: join(root, 'source-alias', 'compact'), inventoryId: 'synthetic-compact-v1',
    createdAt: '2026-10-25T00:00:00.000Z' })).rejects.toThrow(/outside original/)
  await expect(readFile(join(root, source.packageRoot, 'compact', 'drg-offline.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a package identity containing traversal before writing normalized data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-compact-identity-'))
  roots.push(root)
  const source = await createDrgReferenceFixture(root)
  const rows = '{"id":"synthetic","recordId":"record","code":"SYN","name":"合成","state":"quarantined"}\n'
  await mkdir(join(root, source.packageRoot, 'assessment'))
  await writeFile(join(root, source.packageRoot, 'assessment/record-readiness.jsonl'), rows)
  const manifest = JSON.parse(source.manifest)
  manifest.files.push({ path: 'assessment/record-readiness.jsonl', sha256: sha256(rows), rows: 1, sourceVersion: 'synthetic-2026' })
  const manifestBytes = JSON.stringify(manifest)
  await writeFile(join(root, source.packageRoot, 'manifest.json'), manifestBytes)
  const lock = JSON.parse(source.lockBytes)
  lock.packages[0].id = '../../../../../escaped'
  lock.packages[0].manifest.sha256 = sha256(manifestBytes)
  await writeFile(source.lockPath, JSON.stringify(lock))
  await expect(createCompactDrgReference({ sourceRoot: root, sourceLockPath: source.lockPath,
    outputDirectory: join(root, 'out', 'compact'), inventoryId: 'synthetic-compact-v1', createdAt: '2026-10-25T00:00:00.000Z' })).rejects.toThrow(/path/)
  await expect(stat(join(root, 'out'))).rejects.toMatchObject({ code: 'ENOENT' })
})
