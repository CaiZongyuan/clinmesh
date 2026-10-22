import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { offlineReferenceInventoryListSchema } from '@clinmesh/contracts/reference-data'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

describe('offline reference inventory maintenance CLI', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function fixture(records = '{"code":"synthetic-service","unit":"次","runtimeEnabled":false}\n') {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-offline-inventory-'))
    directories.push(root)
    await mkdir(join(root, 'prepared/services'), { recursive: true })
    await writeFile(join(root, 'prepared/services/records.jsonl'), records)
    const manifest = JSON.stringify({
      schemaVersion: 'clinmesh.prepared-catalogues.v1', releaseId: 'synthetic-prepared-v1',
      createdAt: '2026-10-21T00:00:00.000Z', archiveChecksumsSha256: '1'.repeat(64), sources: {},
      files: [{ path: 'services/records.jsonl', dataset: 'services', table: 'records',
        sha256: hash(records), rows: 1, sourceVersion: 'synthetic-2026' }],
    })
    await writeFile(join(root, 'prepared/manifest.json'), manifest)
    const lock = {
      schemaVersion: 'clinmesh.offline-inventory.v1', inventoryId: 'synthetic-inventory-v1',
      createdAt: '2026-10-21T00:00:00.000Z', scheme: 'CHS-DRG-3.0',
      packages: [{ id: 'prepared-five-catalogues', format: 'prepared-catalogues-v1', root: 'prepared',
        version: 'synthetic-prepared-v1', manifest: { path: 'manifest.json', sha256: hash(manifest) },
        sourceUrl: 'https://example.test/synthetic-prepared',
        quarantineReasons: ['coding-compatibility-unverified', 'source-applicability-unverified'] }],
    }
    const lockPath = join(root, 'offline.lock.json')
    await writeFile(lockPath, JSON.stringify(lock))
    const databasePath = join(root, 'reference.sqlite')
    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    return { root, lock, lockPath, databasePath }
  }

  it('prepares an immutable inventory, reads source units and quarantine, and repeats without publishing runtime catalogues', async () => {
    const input = await fixture()
    const args = ['prepare-inventory', '--database', input.databasePath, '--manifest', input.lockPath, '--input-root', input.root]
    expect(await runReferenceDatabaseCli(args)).toMatchObject({ created: true, inventory: {
      inventoryId: 'synthetic-inventory-v1', validationScope: 'integrity-only', runtimeEnabled: false,
      packages: [{ version: 'synthetic-prepared-v1', runtimeEnabled: false, verifiedFileCount: 1,
        tables: [{ path: 'services/records.jsonl', rows: 1, units: ['次'] }],
        quarantineReasons: ['coding-compatibility-unverified', 'source-applicability-unverified'] }],
    } })
    expect(await runReferenceDatabaseCli(args)).toMatchObject({ created: false })
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
      .toMatchObject({ items: [{ inventoryId: 'synthetic-inventory-v1', runtimeEnabled: false }] })
    expect(await runReferenceDatabaseCli(['list', '--database', input.databasePath])).toEqual({ items: [] })
  })

  it('preserves explicit source units on repeated preparation and inventory readback', async () => {
    const input = await fixture('{"code":"synthetic-drug-payment-schedule","sourceUnit":"毫居","packageUnit":"盒"}\n')
    const args = ['prepare-inventory', '--database', input.databasePath, '--manifest', input.lockPath, '--input-root', input.root]
    await runReferenceDatabaseCli(args)
    expect(await runReferenceDatabaseCli(args)).toMatchObject({ created: false })
    const saved = offlineReferenceInventoryListSchema.parse(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
    expect(saved.items[0]?.packages[0]).toMatchObject({
      runtimeEnabled: false,
      tables: [{ units: ['毫居'], unitStatus: 'source-only-unverified' }],
    })
  })

  it('exposes the prepared inventory to administrators through the reference-data HTTP query and rejects clinical roles', async () => {
    const input = await fixture()
    await runReferenceDatabaseCli(['prepare-inventory', '--database', input.databasePath, '--manifest', input.lockPath, '--input-root', input.root])
    await runReferenceDatabaseCli(['import', '--database', input.databasePath, '--manifest',
      fileURLToPath(new URL('./fixtures/reference-data/hospital-reference-release.json', import.meta.url))])
    const password = 'Synthetic-offline-inventory-test-2026!'
    const runtime = await createClinMeshRuntime({
      databasePath: join(input.root, 'operational.sqlite'), referenceDatabasePath: input.databasePath,
      authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'], demoPassword: password,
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters', migrationMode: 'apply',
    })
    try {
      const url = '/api/sim/v1/reference-data/offline-inventories'
      expect((await runtime.app.request(url)).status).toBe(401)
      for (const role of ['admin', 'doctor']) {
        const login = await runtime.app.request('/api/auth/sign-in/email', {
          method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
          body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }),
        })
        expect(login.status).toBe(200)
        const headers = { cookie: login.headers.get('set-cookie')?.split(';', 1)[0] ?? '' }
        const response = await runtime.app.request(`${url}?page=2&pageSize=1`, { headers })
        expect(response.status).toBe(role === 'admin' ? 200 : 403)
        if (role === 'admin') expect(offlineReferenceInventoryListSchema.parse(await response.json()))
          .toMatchObject({ items: [], page: 2, pageSize: 1, total: 1 })
        if (role === 'admin') expect((await runtime.app.request(`${url}?pageSize=51`, { headers })).status).toBe(400)
      }
    } finally {
      await runtime.close()
    }
  })

  it('reports the selected OpenDRG scheme and missing parameters while keeping other schemes and executable assets isolated', async () => {
    const input = await fixture()
    await mkdir(join(input.root, 'opendrg/catalog'), { recursive: true })
    await mkdir(join(input.root, 'opendrg/payments'), { recursive: true })
    await mkdir(join(input.root, 'opendrg/groupers'), { recursive: true })
    const files = [
      { path: 'catalog/schemes.json', data: [
        { id: 'chs_drg_30', grouperSourceUrl: 'https://example.test/synthetic/algorithm.js', groupDataPath: 'groupers/chs_drg_30.json' },
        { id: 'unavailable', grouperSourceUrl: null, groupDataPath: null },
      ] },
      { path: 'groupers/chs_drg_30.json', data: { CC: { SYNTHETIC: '1' }, MCC: {}, CCE: {}, SS_VALID: [] } },
      { path: 'catalog/datasets.json', data: [
        { jsonPath: 'payments/chs_drg_30.json', hasHeader: true, recordCount: 2, sourceUrl: 'https://example.test/synthetic/30.js' },
        { jsonPath: 'payments/chs_drg_20.json', hasHeader: true, recordCount: 1, sourceUrl: 'https://example.test/synthetic/20.js' },
      ] },
      { path: 'payments/chs_drg_30.json', data: [['code', 'name', 'weight', 'reference cost'], ['BT3C', '合成病组', '1.25', '100.00'], ['AA19', '合成缺参组', '', ''], ['']] },
      { path: 'payments/chs_drg_20.json', data: [['code', 'name'], ['SYNTHETIC20', '其他方案']] },
    ]
    const checksums = []
    for (const file of files) {
      const text = JSON.stringify(file.data)
      await writeFile(join(input.root, 'opendrg', file.path), text)
      checksums.push({ path: file.path, sha256: hash(text) })
    }
    const script = "throw new Error('bundled code must never execute')"
    await writeFile(join(input.root, 'opendrg/algorithm.js'), script)
    checksums.push({ path: 'algorithm.js', sha256: hash(script) })
    const manifest = JSON.stringify({ completed: '2026-10-20T00:00:00.000Z', baseUrl: 'https://example.test/synthetic/',
      assets: [{ url: 'https://example.test/synthetic/algorithm.js', localPath: 'algorithm.js' }] })
    const index = JSON.stringify({ algorithm: 'SHA-256', files: checksums })
    await writeFile(join(input.root, 'opendrg/manifest.json'), manifest)
    await writeFile(join(input.root, 'opendrg/checksums.json'), index)
    const lock = { ...input.lock, packages: [{ id: 'opendrg-public-data', format: 'opendrg-public-data-v1', root: 'opendrg',
      version: '2026-10-20', manifest: { path: 'manifest.json', sha256: hash(manifest) },
      checksums: { path: 'checksums.json', sha256: hash(index) }, sourceUrl: 'https://example.test/synthetic/',
      quarantineReasons: ['usage-terms-unconfirmed', 'coding-compatibility-unverified', 'missing-payment-parameters', 'source-applicability-unverified', 'algorithm-unvalidated'] }] }
    await writeFile(input.lockPath, JSON.stringify(lock))
    const args = ['prepare-inventory', '--database', input.databasePath, '--manifest', input.lockPath, '--input-root', input.root]
    expect(await runReferenceDatabaseCli(args)).toMatchObject({ inventory: { packages: [{
      runtimeEnabled: false, verifiedFileCount: 6, approvedUse: 'offline-review',
      selectedGrouper: { program: { path: 'algorithm.js' }, parameters: { counts: { CC: 1, MCC: 0, CCE: 0, SS_VALID: 0 } } },
      tables: [
        { path: 'payments/chs_drg_30.json', rows: 2, scope: 'selected-scheme', missingParameterCodes: ['AA19'], units: [] },
        { path: 'payments/chs_drg_20.json', scope: 'excluded-other-scheme' },
      ],
    }] } })
    expect(await runReferenceDatabaseCli(args)).toMatchObject({ created: false })
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
      .toMatchObject({ total: 1, items: [{ packages: [{ selectedGrouper: { schemeId: 'chs_drg_30' } }] }] })
    await writeFile(join(input.root, 'opendrg/algorithm.js'), 'changed')
    await expect(runReferenceDatabaseCli(args)).rejects.toThrow('checksum')
    expect((await readFile(join(input.root, 'opendrg/algorithm.js'), 'utf8'))).toBe('changed')
  })

  it.each(['checksum', 'missing-file', 'version', 'schema', 'rows', 'traversal', 'duplicate', 'immutable'])(
    'rejects %s without replacing the previous inventory and records the failed preparation', async fault => {
      const input = await fixture()
      const args = ['prepare-inventory', '--database', input.databasePath, '--manifest', input.lockPath, '--input-root', input.root]
      const previous = await runReferenceDatabaseCli(args)
      const manifestPath = join(input.root, 'prepared/manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (fault === 'checksum') await writeFile(join(input.root, 'prepared/services/records.jsonl'), 'changed\n')
      if (fault === 'missing-file') await rm(join(input.root, 'prepared/services/records.jsonl'))
      if (fault === 'version') input.lock.packages[0]!.version = 'incompatible-v2'
      if (fault === 'schema') manifest.schemaVersion = 'unsupported.v2'
      if (fault === 'rows') manifest.files[0].rows = 2
      if (fault === 'traversal') manifest.files[0].path = '../outside.jsonl'
      if (fault === 'duplicate') manifest.files.push(manifest.files[0])
      if (fault === 'immutable') input.lock.createdAt = '2026-10-22T00:00:00.000Z'
      const manifestText = JSON.stringify(manifest)
      await writeFile(manifestPath, manifestText)
      input.lock.packages[0]!.manifest.sha256 = hash(manifestText)
      await writeFile(input.lockPath, JSON.stringify(input.lock))
      await expect(runReferenceDatabaseCli(args)).rejects.toThrow()
      const saved = offlineReferenceInventoryListSchema.parse(await runReferenceDatabaseCli(['list-inventories', '--database', input.databasePath]))
      expect(previous).toMatchObject({ inventory: saved.items[0] })
      expect(await runReferenceDatabaseCli(['inventory-audit', '--database', input.databasePath]))
        .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ operation: 'prepare', outcome: 'failure' })]) })
    },
  )

  it('pages all inventories and verifies corruption beyond the first batch with failed query audit', async () => {
    const input = await fixture()
    for (let index = 0; index < 51; index += 1) {
      input.lock.inventoryId = `synthetic-${String(index).padStart(2, '0')}`
      await writeFile(input.lockPath, JSON.stringify(input.lock))
      await runReferenceDatabaseCli(['prepare-inventory', '--database', input.databasePath, '--manifest', input.lockPath, '--input-root', input.root])
    }
    const listArgs = ['list-inventories', '--database', input.databasePath]
    expect(await runReferenceDatabaseCli([...listArgs, '--page', '26', '--page-size', '2']))
      .toMatchObject({ items: [{ inventoryId: 'synthetic-50' }], page: 26, pageSize: 2, total: 51 })
    await expect(runReferenceDatabaseCli([...listArgs, '--page-size', '51'])).rejects.toThrow()
    const database = openReferenceDatabase({ databasePath: input.databasePath, busyTimeoutMs: 5000 })
    try {
      database.driver.prepare('UPDATE reference_offline_inventory SET content_hash = ? WHERE inventory_id = ?')
        .run('0'.repeat(64), 'synthetic-50')
    } finally { database.close() }
    await expect(runReferenceDatabaseCli(['verify', '--database', input.databasePath])).rejects.toThrow('content hash')
    await expect(runReferenceDatabaseCli([...listArgs, '--page', '2', '--page-size', '50'])).rejects.toThrow('content hash')
    expect(await runReferenceDatabaseCli(['inventory-audit', '--database', input.databasePath]))
      .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ operation: 'list', outcome: 'failure' })]) })
  })
})
