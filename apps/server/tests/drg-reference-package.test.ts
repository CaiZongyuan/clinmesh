import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { t } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { createDrgReferencePackage } from '../src/drg-reference-package.ts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

describe('DRG reference distribution package', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function fixture() {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'clinmesh-drg-package-'))
    directories.push(repositoryRoot)
    const preparedRoot = '.data/reference-prepared/r3'
    const openDrgRoot = '.data/exports/opendrg-2026-10-20'
    async function put(path: string, text: string) {
      await mkdir(dirname(join(repositoryRoot, path)), { recursive: true })
      await writeFile(join(repositoryRoot, path), text)
      return { path, sha256: hash(text) }
    }
    const records = '{"code":"SYNTHETIC","sourceUnit":"次"}\n'
    await put(`${preparedRoot}/services/records.jsonl`, records)
    const prepared = JSON.stringify({
      schemaVersion: 'clinmesh.prepared-catalogues.v1', releaseId: 'synthetic-prepared-v1', sources: {},
      files: [{ path: 'services/records.jsonl', sha256: hash(records), rows: 1, sourceVersion: 'synthetic-2026' }],
    })
    await put(`${preparedRoot}/manifest.json`, prepared)
    const checksums = []
    for (const [path, value] of [
      ['catalog/schemes.json', [{ id: 'chs_drg_30', grouperSourceUrl: 'https://example.test/algorithm.js', groupDataPath: 'groupers/chs_drg_30.json' }]],
      ['groupers/chs_drg_30.json', { CC: {}, MCC: {}, CCE: {}, SS_VALID: [] }],
      ['catalog/datasets.json', [{ jsonPath: 'payments/chs_drg_30.json', hasHeader: true, recordCount: 1, sourceUrl: 'https://example.test/payment.js' }]],
      ['payments/chs_drg_30.json', [['code', 'name', 'weight', 'cost'], ['SYNTHETIC', '合成病组', '1', '100']]],
    ] satisfies [string, unknown][]) {
      const text = JSON.stringify(value)
      await put(`${openDrgRoot}/${path}`, text)
      checksums.push({ path, sha256: hash(text) })
    }
    const program = "throw new Error('bundled code must never execute')\n"
    await put(`${openDrgRoot}/algorithm.js`, program)
    checksums.push({ path: 'algorithm.js', sha256: hash(program) })
    const openDrg = JSON.stringify({
      completed: '2026-10-20T00:00:00.000Z', baseUrl: 'https://example.test/',
      assets: [{ url: 'https://example.test/algorithm.js', localPath: 'algorithm.js' }],
    })
    await put(`${openDrgRoot}/manifest.json`, openDrg)
    checksums.push({ path: 'manifest.json', sha256: hash(openDrg) })
    const index = JSON.stringify({ algorithm: 'SHA-256', files: checksums })
    await put(`${openDrgRoot}/checksums.json`, index)
    const lock = JSON.stringify({
      schemaVersion: 'clinmesh.offline-inventory.v1', inventoryId: 'synthetic-inventory-v1',
      createdAt: '2026-10-22T00:00:00.000Z', scheme: 'CHS-DRG-3.0', packages: [
        { id: 'prepared-five-catalogues', format: 'prepared-catalogues-v1', root: preparedRoot,
          version: 'synthetic-prepared-v1', manifest: { path: 'manifest.json', sha256: hash(prepared) },
          sourceUrl: 'https://example.test/prepared', quarantineReasons: ['usage-terms-unconfirmed'] },
        { id: 'opendrg-public-data', format: 'opendrg-public-data-v1', root: openDrgRoot,
          version: '2026-10-20', manifest: { path: 'manifest.json', sha256: hash(openDrg) },
          checksums: { path: 'checksums.json', sha256: hash(index) }, sourceUrl: 'https://example.test/',
          quarantineReasons: ['usage-terms-unconfirmed', 'algorithm-unvalidated'] },
      ],
    })
    const lockPath = join(repositoryRoot, 'offline.lock.json')
    await writeFile(lockPath, lock)
    await put(`${preparedRoot}/unlisted.txt`, 'must not be distributed')
    await put(`${openDrgRoot}/unlisted.txt`, 'must not be distributed')
    await put('.data/unrelated.sqlite', 'must not be distributed')
    return { repositoryRoot, lockPath, preparedRoot, openDrgRoot, lock }
  }

  it('creates identical archives containing only the complete pinned files', async () => {
    const input = await fixture()
    const firstPath = join(input.repositoryRoot, 'first.tar.gz')
    const secondPath = join(input.repositoryRoot, 'second.tar.gz')
    const first = await createDrgReferencePackage({ ...input, outputPath: firstPath })
    await utimes(join(input.repositoryRoot, input.preparedRoot, 'services/records.jsonl'), new Date(), new Date('2035-01-01'))
    await writeFile(input.lockPath, `${JSON.stringify(JSON.parse(input.lock), null, 2).replaceAll('\n', '\r\n')}\r\n`)
    const second = await createDrgReferencePackage({ ...input, outputPath: secondPath })
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath))
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      sha256: hash(await readFile(firstPath)), offlineLockSha256: hash(input.lock),
      inventoryId: 'synthetic-inventory-v1', fileCount: 9,
    })
    const entries: string[] = []
    let unpackedSizeBytes = 0
    await t({ file: firstPath, onReadEntry(entry) {
      expect(entry.type).toBe('File')
      expect(entry.mtime?.toISOString()).toBe('2000-01-01T00:00:00.000Z')
      unpackedSizeBytes += entry.size
      entries.push(entry.path)
    } })
    expect(entries).toEqual([
      '.data/exports/opendrg-2026-10-20/algorithm.js',
      '.data/exports/opendrg-2026-10-20/catalog/datasets.json',
      '.data/exports/opendrg-2026-10-20/catalog/schemes.json',
      '.data/exports/opendrg-2026-10-20/checksums.json',
      '.data/exports/opendrg-2026-10-20/groupers/chs_drg_30.json',
      '.data/exports/opendrg-2026-10-20/manifest.json',
      '.data/exports/opendrg-2026-10-20/payments/chs_drg_30.json',
      '.data/reference-prepared/r3/manifest.json',
      '.data/reference-prepared/r3/services/records.jsonl',
    ])
    expect(first.unpackedSizeBytes).toBe(unpackedSizeBytes)
    expect(first.sizeBytes).toBe((await readFile(firstPath)).length)
  })

  it.each(['checksum', 'missing-file', 'wrong-version'])(
    'rejects %s before creating an archive and preserves existing output', async fault => {
      const input = await fixture()
      const outputPath = join(input.repositoryRoot, 'package.tar.gz')
      const recordsPath = join(input.repositoryRoot, input.preparedRoot, 'services/records.jsonl')
      if (fault === 'checksum') await writeFile(recordsPath, '{"code":"changed"}\n')
      if (fault === 'missing-file') await rm(recordsPath)
      if (fault === 'wrong-version') {
        const lock = offlineReferenceLockSchema.parse(JSON.parse(input.lock))
        lock.packages[0]!.version = 'wrong-version'
        await writeFile(input.lockPath, JSON.stringify(lock))
      }
      await expect(createDrgReferencePackage({ ...input, outputPath })).rejects.toThrow()
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(outputPath, 'previous-package')
      await expect(createDrgReferencePackage({ ...input, outputPath })).rejects.toThrow()
      expect(await readFile(outputPath, 'utf8')).toBe('previous-package')
    },
  )

  it('rejects linked source files so distribution archives contain regular files only', async () => {
    const input = await fixture()
    await link(join(input.repositoryRoot, input.preparedRoot, 'services/records.jsonl'), join(input.repositoryRoot, 'record-link'))
    const outputPath = join(input.repositoryRoot, 'package.tar.gz')
    await expect(createDrgReferencePackage({ ...input, outputPath })).rejects.toThrow('regular file without links')
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prints the package summary through the maintainer CLI', async () => {
    const input = await fixture()
    const outputPath = join(input.repositoryRoot, 'package.tar.gz')
    const result = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('../src/drg-reference-package.ts', import.meta.url)),
      '--input-root', input.repositoryRoot, '--manifest', input.lockPath, '--output', outputPath,
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      sha256: hash(await readFile(outputPath)), offlineLockSha256: hash(input.lock),
      inventoryId: 'synthetic-inventory-v1', fileCount: 9,
    })
  })
})
