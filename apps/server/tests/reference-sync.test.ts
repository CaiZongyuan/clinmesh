import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { cnHealthInvocation, runReferenceSync } from '../src/reference-sync.ts'
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

interface FakeDatasetPlan {
  candidate: Awaited<ReturnType<typeof createCandidate>>
  datasetId: string
  failExitCode?: number
  releaseId: string
}

async function createFakeCli(directory: string, plans: FakeDatasetPlan[]) {
  const cliPath = join(directory, 'cn-health')
  const markers = join(directory, 'markers')
  await mkdir(markers)
  const candidates = Object.fromEntries(await Promise.all(plans.map(async plan => [
    plan.datasetId,
    {
      databasePath: plan.candidate.databasePath,
      manifestPath: plan.candidate.manifestPath,
      manifestSha256: plan.candidate.manifestSha256,
      manifestSizeBytes: (await stat(plan.candidate.manifestPath)).size,
      releaseId: plan.releaseId,
      sqliteSha256: plan.candidate.sqliteSha256,
      sqliteSizeBytes: plan.candidate.sqliteSizeBytes,
    },
  ] as const)))
  await writeFile(cliPath, `#!/usr/bin/env node
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
if (args[0] !== '--data-dir' || args[2] !== 'dataset' || args[3] !== 'materialize') process.exit(2)
const plan = ${JSON.stringify(plans.map(plan => ({
    failExitCode: plan.failExitCode ?? 0,
    datasetId: plan.datasetId,
    releaseId: plan.releaseId,
  })))}.find(plan => plan.datasetId === args[4])
if (plan === undefined || plan.releaseId !== args[5]) process.exit(3)
const output = value('--output')
mkdirSync(output)
process.stderr.write('[' + plan.datasetId + '@fixture.r1] download 1/1 B (100%)\\n')
writeFileSync(${JSON.stringify(markers)} + '/started-' + plan.datasetId, '')
if (plan.failExitCode !== 0) process.exit(plan.failExitCode)
const candidate = ${JSON.stringify(candidates)}[plan.datasetId]
copyFileSync(candidate.manifestPath, output + '/manifest.json')
copyFileSync(candidate.databasePath, output + '/data.sqlite')
const receipt = {
  schemaVersion: 1,
  command: 'dataset.materialize',
  cliVersion: '0.5.0',
  dataset: {id: plan.datasetId, releaseId: plan.releaseId, datasetSchemaVersion: 1},
  registry: {url: value('--registry'), keyId: '66687aadf862bd77', trust: 'signed-registry'},
  manifest: {path: 'manifest.json', sha256: candidate.manifestSha256, sizeBytes: candidate.manifestSizeBytes},
  sqlite: {path: 'data.sqlite', sha256: candidate.sqliteSha256, sizeBytes: candidate.sqliteSizeBytes}
}
writeFileSync(output + '/materialization.json', JSON.stringify(receipt) + '\\n')
process.stdout.write(JSON.stringify(receipt) + '\\n')
`)
  await chmod(cliPath, 0o755)
  return cliPath
}

async function createLock(
  directory: string,
  manifestSha256: string,
  extraDatasets: Array<{ datasetId: string; releaseId: string }> = [],
): Promise<string> {
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
    }, ...extraDatasets.map(extra => ({
      datasetId: extra.datasetId,
      datasetSchemaVersion: 1,
      licenseId: 'LicenseRef-Synthetic-Test',
      manifestSha256: '0'.repeat(64),
      releaseId: extra.releaseId,
      sourceId: `${extra.datasetId}-fixture`,
      sourceUrl: `https://example.test/${extra.datasetId}`,
    }))],
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

describe('cn-health CLI invocation', () => {
  it('invokes the package launcher through the current Node executable by default', () => {
    expect(cnHealthInvocation({
      execPath: '/usr/bin/node',
      repositoryRoot: '/repo',
    })).toEqual({
      file: '/usr/bin/node',
      prefix: [join('/repo', 'node_modules/cn-health/bin/cn-health.js')],
    })
  })

  it('uses an explicit cli path directly', () => {
    expect(cnHealthInvocation({
      cliPath: '/opt/tools/cn-health',
      execPath: '/usr/bin/node',
      repositoryRoot: '/repo',
    })).toEqual({
      file: '/opt/tools/cn-health',
      prefix: [],
    })
  })

  it('fails with a diagnosable error when the default launcher is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-nolauncher-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const lockPath = await createLock(directory, candidate.manifestSha256)

    await expect(runReferenceSync({
      checkOnly: true,
      databasePath: join(directory, 'formal-reference.sqlite'),
      lockPath,
      repositoryRoot: directory,
      runtimeDataDirectory: join(directory, 'runtime'),
    })).rejects.toThrow(/node_modules\/cn-health\/bin\/cn-health\.js/)
  })
})

describe('reference sync', () => {
  it('checks without writing the formal database and imports the same lock idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const cliPath = await createFakeCli(directory, [
      { candidate, datasetId: 'laboratory-cn', releaseId: 'laboratory-cn@fixture.r1' },
    ])
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

  it('reports staged progress for materialize and database phases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-progress-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const cliPath = await createFakeCli(directory, [
      { candidate, datasetId: 'laboratory-cn', releaseId: 'laboratory-cn@fixture.r1' },
    ])
    const lockPath = await createLock(directory, candidate.manifestSha256)
    const lines: string[] = []

    await runReferenceSync({
      checkOnly: true,
      cliPath,
      databasePath: join(directory, 'formal-reference.sqlite'),
      lockPath,
      onProgress: line => lines.push(line),
      runtimeDataDirectory: join(directory, 'runtime'),
    })

    expect(lines.some(line => line.includes('materialize') && line.includes('laboratory-cn@fixture.r1'))).toBe(true)
    expect(lines.some(line => line.includes('laboratory-cn@fixture.r1') && line.includes('完成'))).toBe(true)
    expect(lines.some(line => line.includes('download 1/1 B (100%)'))).toBe(true)
    expect(lines.some(line => line.includes('migrate'))).toBe(true)
    expect(lines.some(line => line.includes('import'))).toBe(true)
    expect(lines.some(line => line.includes('verify'))).toBe(true)
    expect(lines.some(line => line.includes('总耗时'))).toBe(true)
  })

  it('runs every materialize and aggregates failed datasets into one rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-parallel-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const cliPath = await createFakeCli(directory, [
      { candidate, datasetId: 'laboratory-cn', releaseId: 'laboratory-cn@fixture.r1' },
      { candidate, datasetId: 'nhsa-drugs', failExitCode: 7, releaseId: 'nhsa-drugs@fixture.r1' },
    ])
    const lockPath = await createLock(directory, candidate.manifestSha256, [
      { datasetId: 'nhsa-drugs', releaseId: 'nhsa-drugs@fixture.r1' },
    ])
    const databasePath = join(directory, 'formal-reference.sqlite')

    const error = await runReferenceSync({
      checkOnly: false,
      cliPath,
      databasePath,
      lockPath,
      runtimeDataDirectory: join(directory, 'runtime'),
    }).then(() => undefined, captured => captured)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('materialize 失败')
    expect(error.message).toContain('nhsa-drugs')
    expect(existsSync(join(directory, 'markers', 'started-laboratory-cn'))).toBe(true)
    expect(existsSync(join(directory, 'markers', 'started-nhsa-drugs'))).toBe(true)
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a receipt hash mismatch before creating the formal database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-invalid-'))
    temporaryDirectories.push(directory)
    const candidate = await createCandidate(directory)
    const cliPath = await createFakeCli(directory, [
      { candidate, datasetId: 'laboratory-cn', releaseId: 'laboratory-cn@fixture.r1' },
    ])
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
