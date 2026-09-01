import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceSync } from '../src/reference-sync.ts'
import { listReferenceDataReleases, openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => {
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true })
  }))
})

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function createCandidate(directory: string) {
  const candidateDirectory = join(directory, 'candidate')
  await mkdir(candidateDirectory)
  const databasePath = join(candidateDirectory, 'data.sqlite')
  const database = new Database(databasePath)
  database.pragma('application_id = 0x434e4844')
  database.exec(`
    CREATE TABLE laboratory_concept (
      code TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      terminology_version TEXT NOT NULL,
      display_zh TEXT NOT NULL,
      category TEXT NOT NULL,
      specimen TEXT NOT NULL,
      result_type TEXT NOT NULL,
      ucum_unit TEXT,
      status TEXT NOT NULL,
      source_note TEXT NOT NULL,
      source_row INTEGER NOT NULL UNIQUE,
      source_version TEXT NOT NULL,
      source_sha256 TEXT NOT NULL
    ) STRICT;
    INSERT INTO laboratory_concept VALUES (
      '8310-5', 'http://loinc.org', '2.83', '体温', 'vital-sign', 'body',
      'quantity', 'Cel', 'active', 'synthetic fixture', 2,
      '2026-08-30', '${'4'.repeat(64)}'
    );
  `)
  database.close()
  const sqliteSha256 = await sha256(databasePath)
  const sqliteSizeBytes = (await stat(databasePath)).size
  const manifestPath = join(candidateDirectory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify({
    artifacts: [{
      mediaType: 'application/vnd.sqlite3',
      name: 'data.sqlite',
      sha256: sqliteSha256,
      sizeBytes: sqliteSizeBytes,
      url: 'data.sqlite',
    }],
    canonical: {
      recordCount: 1,
      serialization: 'canonical-ndjson-v1',
      sha256: 'c'.repeat(64),
    },
    dataset: {
      datasetSchemaVersion: 1,
      id: 'laboratory-cn',
      sourceVersion: '2026-08-30',
    },
    release: { id: 'laboratory-cn@fixture.r1', revoked: false },
    schemaVersion: 1,
    validation: { passed: true },
  })}\n`)
  return {
    databasePath,
    manifestPath,
    manifestSha256: await sha256(manifestPath),
    sqliteSha256,
    sqliteSizeBytes,
  }
}

async function createFakeCli(directory: string, candidate: Awaited<ReturnType<typeof createCandidate>>) {
  const cliPath = join(directory, 'cn-health')
  await writeFile(cliPath, `#!/usr/bin/env node
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
if (args[0] !== '--data-dir' || args[2] !== 'dataset' || args[3] !== 'materialize') process.exit(2)
if (args[4] !== 'laboratory-cn' || args[5] !== 'laboratory-cn@fixture.r1') process.exit(3)
const output = value('--output')
mkdirSync(output)
copyFileSync(${JSON.stringify(candidate.manifestPath)}, output + '/manifest.json')
copyFileSync(${JSON.stringify(candidate.databasePath)}, output + '/data.sqlite')
const receipt = {
  schemaVersion: 1,
  command: 'dataset.materialize',
  cliVersion: '0.5.0',
  dataset: {id: 'laboratory-cn', releaseId: 'laboratory-cn@fixture.r1', datasetSchemaVersion: 1},
  registry: {url: value('--registry'), keyId: '66687aadf862bd77', trust: 'signed-registry'},
  manifest: {path: 'manifest.json', sha256: ${JSON.stringify(candidate.manifestSha256)}, sizeBytes: ${await stat(candidate.manifestPath).then(value => value.size)}},
  sqlite: {path: 'data.sqlite', sha256: ${JSON.stringify(candidate.sqliteSha256)}, sizeBytes: ${candidate.sqliteSizeBytes}}
}
writeFileSync(output + '/materialization.json', JSON.stringify(receipt) + '\\n')
process.stdout.write(JSON.stringify(receipt) + '\\n')
`)
  await chmod(cliPath, 0o755)
  return cliPath
}

async function createLock(directory: string, manifestSha256: string): Promise<string> {
  const publicKey = Buffer.alloc(32)
  const publicKeySha256 = createHash('sha256').update(publicKey).digest('hex')
  const lockPath = join(directory, 'reference-data.lock.json')
  await writeFile(lockPath, `${JSON.stringify({
    cli: { package: 'cn-health', version: '0.5.0' },
    compositeRelease: {
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'clinmesh-reference-sync-fixture',
      schemaVersion: '1',
    },
    datasets: [{
      datasetId: 'laboratory-cn',
      datasetSchemaVersion: 1,
      licenseId: 'LicenseRef-Synthetic-Test',
      manifestSha256,
      publishedAt: '2026-09-01',
      releaseId: 'laboratory-cn@fixture.r1',
      sourceId: 'laboratory-cn-fixture',
      sourceUrl: 'https://example.test/laboratory-cn',
    }],
    registry: {
      keyId: publicKeySha256.slice(0, 16),
      publicKeyHex: publicKey.toString('hex'),
      publicKeySha256,
      url: 'https://example.test/registry.json',
    },
    retrievedAt: '2026-09-02T00:00:00.000Z',
    schemaVersion: 1,
  })}\n`)
  return lockPath
}

describe('reference sync', () => {
  it('checks without writing the formal database and imports the same lock idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const cliPath = await createFakeCli(directory, candidate)
    const lockPath = await createLock(directory, candidate.manifestSha256)
    const databasePath = join(directory, 'formal-reference.sqlite')

    const options = {
      cliPath,
      databasePath,
      lockPath,
      runtimeDataDirectory: join(directory, 'runtime'),
    }
    await expect(runReferenceSync({ ...options, checkOnly: true }))
      .resolves.toMatchObject({
        checkOnly: true,
        datasets: [{
          datasetId: 'laboratory-cn',
          datasetSchemaVersion: 1,
          recordCount: 1,
          releaseId: 'laboratory-cn@fixture.r1',
          tables: [],
        }],
        release: { conceptCount: 1, created: true, releaseId: 'clinmesh-reference-sync-fixture' },
      })
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(runReferenceSync({ ...options, checkOnly: false }))
      .resolves.toMatchObject({
        checkOnly: false,
        release: { conceptCount: 1, created: true, releaseId: 'clinmesh-reference-sync-fixture' },
      })
    await expect(runReferenceSync({ ...options, checkOnly: false }))
      .resolves.toMatchObject({
        release: { created: false, releaseId: 'clinmesh-reference-sync-fixture' },
      })
    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath, readonly: true })
    expect(listReferenceDataReleases(database).items).toMatchObject([{
      releaseId: 'clinmesh-reference-sync-fixture',
      sources: [{
        candidate: { releaseId: 'laboratory-cn@fixture.r1' },
        materialization: {
          cliVersion: '0.5.0',
          registryKeyId: '66687aadf862bd77',
        },
      }],
    }])
    database.close()
  })

  it('rejects a receipt hash mismatch before creating the formal database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-invalid-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const cliPath = await createFakeCli(directory, candidate)
    const lockPath = await createLock(directory, 'f'.repeat(64))
    const databasePath = join(directory, 'formal-reference.sqlite')

    await expect(runReferenceSync({
      checkOnly: false,
      cliPath,
      databasePath,
      lockPath,
      runtimeDataDirectory: join(directory, 'runtime'),
    }))
      .rejects.toThrow('Manifest SHA256 does not match lock')
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
