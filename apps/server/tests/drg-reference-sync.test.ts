import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'tar'
import { runDrgReferenceSync } from '../src/drg-reference-sync.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createDrgReferenceFixture, sha256 } from './fixtures/drg-reference.ts'
import { offlineReferenceInventoryListSchema } from '@clinmesh/contracts/reference-data'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'

vi.mock('node:fs/promises', { spy: true })
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

describe('DRG reference installation', () => {
  const roots: string[] = []
  const servers: Server[] = []
  afterEach(async () => {
    vi.mocked(filesystem.rename).mockRestore()
    vi.mocked(createReadStream).mockClear()
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => error === undefined ? resolve() : reject(error))
    })))
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-drg-sync-'))
    roots.push(root)
    const files = await createDrgReferenceFixture(root)
    return { root, ...files, databasePath: join(root, 'reference.sqlite'), installDirectory: join(root, 'installed') }
  }

  async function downloadable() {
    const input = await fixture()
    const archivePath = join(input.root, 'bundle.tar.gz')
    await create({ cwd: input.root, file: archivePath, gzip: true, portable: true }, input.physicalPaths)
    const bytes = await readFile(archivePath)
    let requests = 0
    let response: Buffer = bytes
    const server = createServer((_request, result) => { requests += 1; result.end(response) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP test server')
    const distributionPath = join(input.root, 'distribution.json')
    const distribution = { schemaVersion: 1, inventoryId: 'synthetic-inventory-v1', offlineLockSha256: sha256(input.lockBytes),
      artifact: { url: `http://127.0.0.1:${address.port}/bundle.tar.gz`, sha256: sha256(bytes), sizeBytes: bytes.length,
        unpackedSizeBytes: input.unpackedSizeBytes, fileCount: input.physicalPaths.length } }
    await writeFile(distributionPath, JSON.stringify(distribution))
    return { ...input, distributionPath, distribution, archiveBytes: bytes, options: {
      databasePath: input.databasePath, lockPath: input.lockPath, distributionPath,
      installDirectory: input.installDirectory, repositoryRoot: join(input.root, 'empty-repository'),
    }, requests: () => requests, respondWith: (value: Buffer) => { response = value },
    useArchive: async (value: Buffer, unpackedSizeBytes: number, fileCount = 1) => {
      response = value
      distribution.artifact = { ...distribution.artifact, sha256: sha256(value), sizeBytes: value.length, unpackedSizeBytes, fileCount }
      await writeFile(distributionPath, JSON.stringify(distribution))
    } }
  }

  it('rejects a lock without compact storage before publishing or installing files', async () => {
    const input = await fixture()
    const lock = JSON.parse(input.lockBytes)
    delete lock.storage
    await writeFile(input.lockPath, JSON.stringify(lock))
    await expect(runDrgReferenceSync({ ...input, repositoryRoot: input.root,
      distributionPath: join(input.root, 'absent-distribution.json') })).rejects.toThrow()
    await expect(stat(input.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(input.installDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(input.root, input.packageRoot, 'services/records.jsonl'), 'utf8')).toBe(input.records)
  })

  it('reuses complete local files without a distribution download and publishes the inventory once', async () => {
    const input = await fixture()
    const options = { ...input, repositoryRoot: input.root, distributionPath: join(input.root, 'does-not-exist.json') }
    expect(await runDrgReferenceSync(options)).toMatchObject({ source: 'local', created: true, inventoryId: 'synthetic-inventory-v1' })
    expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => String(path).endsWith('records.jsonl'))).toHaveLength(1)
    expect(await runDrgReferenceSync(options)).toMatchObject({ source: 'local', created: false })
    expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => String(path).endsWith('records.jsonl'))).toHaveLength(2)
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
      .toMatchObject({ total: 1, items: [{ inventoryId: 'synthetic-inventory-v1', runtimeEnabled: false,
        packages: [{ tables: [{ units: ['次'] }] }] }] })
    await expect(stat(input.installDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(input.root, input.packageRoot, 'services/records.jsonl'), 'utf8')).toBe(input.records)
  })

  it('downloads current compact storage when only complete logical source files are present', async () => {
    const input = await downloadable()
    await rm(join(input.root, input.storage.manifest.path))
    expect(await runDrgReferenceSync({ ...input.options, repositoryRoot: input.root }))
      .toMatchObject({ source: 'download', created: true })
    expect(input.requests()).toBe(1)
    expect(await readFile(join(input.root, input.packageRoot, 'services/records.jsonl'), 'utf8')).toBe(input.records)
  })

  it.each([false, true])('rejects a retired registration without modifying the database when the current inventory exists: %s', async currentExists => {
    const input = await fixture()
    const options = { ...input, repositoryRoot: input.root }
    await runDrgReferenceSync(options)
    const current = offlineReferenceInventoryListSchema.parse(
      await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]),
    ).items[0]!
    const { storage: _storage, contentHash: _contentHash, ...basis } = current
    basis.inventoryId = 'retired-inventory-v1'
    const retired = { ...basis, contentHash: sha256(JSON.stringify(basis)) }
    const database = openReferenceDatabase({ databasePath: input.databasePath, busyTimeoutMs: 5_000 })
    try {
      database.driver.prepare('INSERT INTO reference_offline_inventory VALUES (?, ?, ?)')
        .run(retired.inventoryId, retired.contentHash, JSON.stringify(retired))
      if (!currentExists) database.driver.prepare('DELETE FROM reference_offline_inventory WHERE inventory_id = ?').run(current.inventoryId)
    } finally { database.close() }
    const before = await readFile(input.databasePath)
    await expect(runDrgReferenceSync(options)).rejects.toThrow(/DRG.*校验失败/)
    expect(await readFile(input.databasePath)).toEqual(before)
  })

  it.each(['retired-format', 'content-hash'])('rejects %s on a later page even when the current registration is on the first page', async fault => {
    const input = await fixture()
    const options = { ...input, repositoryRoot: input.root }
    await runDrgReferenceSync(options)
    const current = offlineReferenceInventoryListSchema.parse(
      await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]),
    ).items[0]!
    const { contentHash: _contentHash, ...basis } = current
    const database = openReferenceDatabase({ databasePath: input.databasePath, busyTimeoutMs: 5_000 })
    try {
      const insert = database.driver.prepare('INSERT INTO reference_offline_inventory VALUES (?, ?, ?)')
      for (let index = 0; index < 49; index += 1) {
        const entry = { ...basis, inventoryId: `synthetic-inventory-v1-${index}` }
        const contentHash = sha256(JSON.stringify(entry))
        insert.run(entry.inventoryId, contentHash, JSON.stringify({ ...entry, contentHash }))
      }
      const { storage: _storage, ...retired } = basis
      const invalid = { ...(fault === 'retired-format' ? retired : basis), inventoryId: 'zz-retired-inventory-v1' }
      const contentHash = sha256(JSON.stringify(invalid))
      insert.run(invalid.inventoryId, fault === 'content-hash' ? '0'.repeat(64) : contentHash, JSON.stringify({ ...invalid, contentHash }))
    } finally { database.close() }
    const before = await readFile(input.databasePath)
    await expect(runDrgReferenceSync(options)).rejects.toThrow(/DRG.*校验失败/)
    expect(await readFile(input.databasePath)).toEqual(before)
  })

  it('prepares migrations for an existing empty reference database', async () => {
    const input = await fixture()
    openReferenceDatabase({ databasePath: input.databasePath, busyTimeoutMs: 5_000 }).close()
    expect(await runDrgReferenceSync({ ...input, repositoryRoot: input.root }))
      .toMatchObject({ created: true, source: 'local' })
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
      .toMatchObject({ total: 1, items: [{ inventoryId: 'synthetic-inventory-v1' }] })
  })

  it('downloads into an empty installation, exposes every source file and reuses it offline', async () => {
    const input = await downloadable()
    const first = await runDrgReferenceSync(input.options)
    expect(first).toMatchObject({ source: 'download', created: true, inventoryId: 'synthetic-inventory-v1' })
    expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => String(path).endsWith('records.jsonl'))).toHaveLength(1)
    expect(await readFile(join(first.inputRoot, input.packageRoot, 'services/records.jsonl'), 'utf8')).toBe(input.records)
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
      .toMatchObject({ total: 1, items: [{ runtimeEnabled: false }] })
    await rm(input.distributionPath)
    expect(await runDrgReferenceSync(input.options)).toMatchObject({ source: 'installed', created: false })
    expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => String(path).endsWith('records.jsonl'))).toHaveLength(2)
    expect(input.requests()).toBe(1)
  })

  it('checks a fresh download without creating the formal database or install directory', async () => {
    const input = await downloadable()
    expect(await runDrgReferenceSync({ ...input.options, checkOnly: true })).toMatchObject({ source: 'download' })
    expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => String(path).endsWith('records.jsonl'))).toHaveLength(1)
    await expect(stat(input.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(input.installDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks existing local files without changing the formal database or its audit', async () => {
    const input = await fixture()
    const options = { ...input, repositoryRoot: input.root }
    await runDrgReferenceSync(options)
    const before = await readFile(input.databasePath)
    await runDrgReferenceSync({ ...options, checkOnly: true })
    expect(await readFile(input.databasePath)).toEqual(before)
  })

  it('preserves files and inventory on failed repair, then repairs without duplicating the inventory', async () => {
    const input = await downloadable()
    const first = await runDrgReferenceSync(input.options)
    const path = join(first.inputRoot, input.packageRoot, 'services/records.jsonl')
    await writeFile(path, 'damaged')
    const before = await readFile(input.databasePath)
    input.respondWith(Buffer.from('truncated'))
    await expect(runDrgReferenceSync(input.options)).rejects.toThrow(/SHA-256/)
    expect(await readFile(path, 'utf8')).toBe('damaged')
    expect(await readFile(input.databasePath)).toEqual(before)
    input.respondWith(input.archiveBytes)
    expect(await runDrgReferenceSync(input.options)).toMatchObject({ source: 'download', created: false })
    expect(await readFile(path, 'utf8')).toBe(input.records)
  })

  it('rejects a distribution for a different inventory before making a request', async () => {
    const input = await downloadable()
    await writeFile(input.distributionPath, JSON.stringify({ ...input.distribution, inventoryId: 'another-inventory' }))
    await expect(runDrgReferenceSync(input.options)).rejects.toThrow(/does not match/)
    expect(input.requests()).toBe(0)
    await expect(stat(input.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an otherwise valid archive with an unlisted file inside a package root', async () => {
    const input = await downloadable()
    const extraPath = `${input.packageRoot}/unlisted.txt`
    await writeFile(join(input.root, extraPath), 'extra')
    const archivePath = join(input.root, 'extra.tar.gz')
    await create({ cwd: input.root, file: archivePath, gzip: true, portable: true }, [...input.physicalPaths, extraPath])
    await input.useArchive(await readFile(archivePath), input.distribution.artifact.unpackedSizeBytes + 5, input.physicalPaths.length + 1)
    await expect(runDrgReferenceSync(input.options)).rejects.toThrow(/unlisted/)
    await expect(stat(input.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the previous files when both installation and rollback renames fail', async () => {
    const input = await downloadable()
    const first = await runDrgReferenceSync(input.options)
    await writeFile(join(first.inputRoot, input.packageRoot, 'services/records.jsonl'), 'previous-files')
    const rename = (await vi.importActual<typeof filesystem>('node:fs/promises')).rename
    let calls = 0
    vi.mocked(filesystem.rename).mockImplementation(async (from, to) => {
      calls += 1
      if (calls > 1) throw new Error('synthetic filesystem rename failure')
      return rename(from, to)
    })
    await expect(runDrgReferenceSync(input.options)).rejects.toThrow(/backup preserved at/)
    const staging = (await readdir(input.installDirectory)).find(name => name.startsWith('.clinmesh-drg-'))
    expect(staging).toBeDefined()
    expect(await readFile(join(input.installDirectory, staging!, 'previous', input.packageRoot, 'services/records.jsonl'), 'utf8'))
      .toBe('previous-files')
  })

  it.each([
    ['../../escape', '0'],
    ['.data/reference-prepared/r3/link', '2'],
    ['.data/reference-prepared/r3/link', '1'],
    ['C:/escape', '0'],
  ])('rejects unsafe archive entry %s of type %s before publishing', async (path, type) => {
    const input = await downloadable()
    const header = Buffer.alloc(512)
    header.write(path, 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(type === '0' ? '00000000001\0' : '00000000000\0', 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write(type, 156)
    if (type !== '0') header.write('../../escape', 157)
    header.write('ustar\0', 257)
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')
    header.write(`${checksum}\0 `, 148)
    const archive = gzipSync(Buffer.concat([header, ...(type === '0' ? [Buffer.from('x'), Buffer.alloc(511)] : []), Buffer.alloc(1024)]))
    await input.useArchive(archive, 1)
    await expect(runDrgReferenceSync(input.options)).rejects.toThrow(/unsafe/)
    await expect(stat(input.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
