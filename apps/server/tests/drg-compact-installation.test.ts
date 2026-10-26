import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCompactDrgReference } from '../src/drg-reference-compact.ts'
import { createDrgReferencePackage } from '../src/drg-reference-package.ts'
import { runDrgReferenceSync } from '../src/drg-reference-sync.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createDrgReferenceFixture } from './fixtures/drg-reference.ts'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { exportDrgReferenceFile } from '../src/drg-reference-export.ts'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error === undefined ? resolve() : reject(error))
  })))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('installs the physical compact package, reuses it offline and repairs without changing immutable facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-compact-install-'))
  roots.push(root)
  const fixture = await createDrgReferenceFixture(root)
  const compactRoot = join(root, 'compact-source')
  const compact = await createCompactDrgReference({ sourceRoot: root, sourceLockPath: fixture.lockPath,
    outputDirectory: compactRoot, inventoryId: 'synthetic-compact-v1', createdAt: '2026-10-25T00:00:00.000Z' })
  const archivePath = join(root, 'compact.tar.gz')
  const archive = await createDrgReferencePackage({ repositoryRoot: compactRoot, lockPath: compact.lockPath, outputPath: archivePath })
  const repeatArchivePath = join(root, 'repeat.tar.gz')
  await createDrgReferencePackage({ repositoryRoot: compactRoot, lockPath: compact.lockPath, outputPath: repeatArchivePath })
  expect(await readFile(repeatArchivePath)).toEqual(await readFile(archivePath))
  expect(archive.fileCount).toBe(compact.physicalFileCount)
  expect(archive.unpackedSizeBytes).toBe(compact.residentSizeBytes)
  const archiveBytes = await readFile(archivePath)
  let response = archiveBytes
  let requests = 0
  const server = createServer((_request, result) => { requests += 1; result.end(response) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server')
  const distributionPath = join(root, 'distribution.json')
  await writeFile(distributionPath, JSON.stringify({ schemaVersion: 1, inventoryId: compact.inventoryId,
    offlineLockSha256: archive.offlineLockSha256, artifact: { ...archive, url: `http://127.0.0.1:${address.port}/compact.tar.gz`,
      // Distribution metadata deliberately has only the pinned artifact fields.
      inventoryId: undefined, offlineLockSha256: undefined } }))
  const options = { databasePath: join(root, 'reference.sqlite'), installDirectory: join(root, 'installed'),
    repositoryRoot: join(root, 'empty'), lockPath: compact.lockPath, distributionPath }
  await runDrgReferenceSync({ ...options, checkOnly: true })
  await expect(stat(options.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(options.installDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  const first = await runDrgReferenceSync(options)
  expect(first).toMatchObject({ source: 'download', created: true, inventoryId: 'synthetic-compact-v1' })
  expect(await runDrgReferenceSync(options)).toMatchObject({ source: 'installed', created: false })
  expect(requests).toBe(2)
  const lock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(compact.lockPath, 'utf8')))
  const exportPath = join(root, 'export.jsonl')
  await exportDrgReferenceFile({ repositoryRoot: first.inputRoot, lockPath: compact.lockPath,
    path: `${fixture.packageRoot}/services/records.jsonl`, outputPath: exportPath })
  expect(await readFile(exportPath, 'utf8')).toBe(fixture.records)
  const damaged = join(first.inputRoot, fixture.packageRoot, 'services/records.jsonl')
  await writeFile(damaged, 'damaged')
  const databaseBefore = await readFile(options.databasePath)
  response = Buffer.from('bad-archive')
  await expect(runDrgReferenceSync(options)).rejects.toThrow(/SHA-256/)
  expect(await readFile(damaged, 'utf8')).toBe('damaged')
  expect(await readFile(options.databasePath)).toEqual(databaseBefore)
  response = archiveBytes
  expect(await runDrgReferenceSync(options)).toMatchObject({ source: 'download', created: false })
  expect(await readFile(damaged, 'utf8')).toBe(fixture.records)
  expect(await runReferenceDatabaseCli(['list-inventories', '--database', options.databasePath]))
    .toMatchObject({ total: 1, items: [{ storage: lock.storage, runtimeEnabled: false,
      packages: [{ approvedUse: 'offline-review', tables: [{ units: ['次'], unitStatus: 'source-only-unverified' }] }] }] })
}, 30_000)
