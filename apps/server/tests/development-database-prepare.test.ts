import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentDatabases, prepareDevelopmentEnvironment } from '../src/development-database-prepare.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createDrgReferenceFixture } from './fixtures/drg-reference.ts'
import { createGuidelineReleaseFixture } from './fixtures/guideline-release.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import {
  expectedSchemaVersion,
  openClinMeshDatabase,
  verifyMigrations,
} from '../src/infrastructure/sqlite/database.ts'
import {
  applyReferenceMigrations,
  openReferenceDatabase,
  verifyReferenceDatabase,
} from '../src/infrastructure/sqlite/reference-database.ts'

describe('development database preparation', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('migrates the operational and configured Reference databases before dev startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-databases-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'operational.sqlite')
    const referenceDatabasePath = join(directory, 'reference.sqlite')
    const legacyReferenceMigrations = join(directory, 'legacy-reference-migrations')
    await mkdir(legacyReferenceMigrations)
    const referenceMigrationDirectory = join(process.cwd(), 'reference-drizzle')
    const legacyFiles = (await readdir(referenceMigrationDirectory))
      .filter(file => /^000[1-8]_.+\.sql$/.test(file))
    await Promise.all(legacyFiles.map(file => copyFile(
      join(referenceMigrationDirectory, file),
      join(legacyReferenceMigrations, file),
    )))
    const legacyReference = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath: referenceDatabasePath,
    })
    expect(applyReferenceMigrations(legacyReference, legacyReferenceMigrations).schemaVersion).toBe(8)
    legacyReference.close()

    await expect(prepareDevelopmentDatabases({
      databasePath,
      referenceDatabasePath,
    })).resolves.toMatchObject({
      operational: { schemaVersion: expectedSchemaVersion() },
      reference: { schemaVersion: 11 },
    })

    const operational = openClinMeshDatabase({ busyTimeoutMs: 5_000, databasePath })
    expect(verifyMigrations(operational)).toMatchObject({ schemaVersion: expectedSchemaVersion() })
    operational.close()
    const reference = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath: referenceDatabasePath,
      readonly: true,
    })
    expect(verifyReferenceDatabase(reference)).toMatchObject({ schemaVersion: 11 })
    reference.close()

    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts.dev).toContain('pnpm db:prepare')
    expect(packageJson.scripts['dev:prepared']).toContain('pnpm db:prepare --migrations-only')
  })

  it('prepares DRG materials during normal startup with an existing clinical reference release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-references-'))
    temporaryDirectories.push(directory)
    const fixture = await createDrgReferenceFixture(directory)
    const guidelines = await createGuidelineReleaseFixture(join(directory, 'guidelines'))
    const databasePath = join(directory, 'operational.sqlite')
    const referenceDatabasePath = join(directory, 'reference.sqlite')
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [], valueSetEntries: [] })
    await writeFile(join(directory, 'clinical.json'), artifact)
    await writeFile(join(directory, 'clinical-release.json'), JSON.stringify({
      createdAt: '2026-10-22T00:00:00.000Z', releaseId: 'synthetic-clinical-reference', schemaVersion: '1',
      sources: [{ acquisitionMethod: 'generated', artifactPath: 'clinical.json',
        checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'LicenseRef-Synthetic-Test',
        retrievedAt: '2026-10-22T00:00:00.000Z', sourceId: 'synthetic-clinical-reference',
        sourceUrl: 'https://example.test/synthetic-clinical-reference', upstreamVersion: 'synthetic-v1' }],
    }))
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'clinical-release.json')])

    await prepareDevelopmentEnvironment({
      databasePath,
      referenceDatabasePath,
      referenceReleaseId: 'synthetic-clinical-reference',
      repositoryRoot: directory,
      drgReference: { lockPath: fixture.lockPath },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })

    expect(await runReferenceDatabaseCli(['list-inventories', '--database', referenceDatabasePath]))
      .toMatchObject({ items: [{ inventoryId: 'synthetic-inventory-v1', runtimeEnabled: false }] })
  })

  it('keeps explicitly unconfigured fixture mode free of unused reference downloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-fixture-'))
    temporaryDirectories.push(directory)
    const guidelines = await createGuidelineReleaseFixture(join(directory, 'guidelines'))
    await expect(prepareDevelopmentEnvironment({
      databasePath: join(directory, 'operational.sqlite'), repositoryRoot: directory,
      drgReference: { lockPath: join(directory, 'absent-lock.json') },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })).resolves.toMatchObject({ reference: null })
    expect(await readdir(directory)).not.toContain('drg-reference')
    expect(await readdir(directory)).not.toContain('reference.sqlite')
  })

  it('attempts guidelines with an existing operational database and no configured Reference database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-guidelines-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'operational.sqlite')
    await prepareDevelopmentDatabases({ databasePath })

    await expect(prepareDevelopmentEnvironment({
      databasePath,
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: join(directory, 'absent-guideline-lock.json') },
    })).rejects.toThrow()
    expect(await readdir(directory)).not.toContain('guidelines.sqlite')
  })

  it('loads prepared guideline passages from the same target database on repeated Server preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-guideline-load-'))
    temporaryDirectories.push(directory)
    const guidelines = await createGuidelineReleaseFixture(join(directory, 'guidelines'))
    const guidelineDatabasePath = join(directory, 'guidelines.sqlite')
    const input = {
      databasePath: join(directory, 'operational.sqlite'),
      guidelineDatabasePath,
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot,
        deploymentPolicy: 'internal-testing' },
    } satisfies Parameters<typeof prepareDevelopmentEnvironment>[0]
    await prepareDevelopmentEnvironment(input)
    const before = await readFile(guidelineDatabasePath)
    await prepareDevelopmentEnvironment(input)
    expect(await readFile(guidelineDatabasePath)).toEqual(before)
    const corpus = new GuidelineCorpus({ databasePath: guidelineDatabasePath, readOnly: true,
      deploymentPolicy: 'internal-testing' })
    try {
      expect(corpus.sources()).toMatchObject([{ source: { id: 'synthetic-free-diabetes', license: { usage: 'unverified' } } }])
      expect(corpus.search('糖尿病').guidelines).toHaveLength(1)
    } finally { corpus.close() }
  })

  it('only migrates databases when the launcher has already prepared reference materials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-prepared-'))
    temporaryDirectories.push(directory)
    const referenceDatabasePath = join(directory, 'reference.sqlite')

    await expect(prepareDevelopmentEnvironment({
      databasePath: join(directory, 'operational.sqlite'),
      referenceDatabasePath,
      repositoryRoot: directory,
      drgReference: { lockPath: join(directory, 'absent-lock.json') },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: join(directory, 'absent-guideline-lock.json') },
      migrationsOnly: true,
    })).resolves.toMatchObject({
      operational: { schemaVersion: expectedSchemaVersion() },
      reference: { schemaVersion: 11 },
    })
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', referenceDatabasePath]))
      .toMatchObject({ items: [], total: 0 })
    expect(await readdir(directory)).not.toContain('drg-reference')
    expect(await readdir(directory)).not.toContain('guidelines.sqlite')
  })

  it('attempts full reference acquisition for a new deployment and stops when acquisition fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-acquisition-'))
    temporaryDirectories.push(directory)
    const guidelines = await createGuidelineReleaseFixture(join(directory, 'guidelines'))
    const launcherDirectory = join(directory, 'node_modules/cn-health/bin')
    await mkdir(launcherDirectory, { recursive: true })
    const markerPath = join(directory, 'acquisition-requested')
    await writeFile(join(launcherDirectory, 'cn-health.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'requested'); process.exit(1)\n`)
    const publicKey = Buffer.alloc(32)
    const publicKeySha256 = createHash('sha256').update(publicKey).digest('hex')
    await writeFile(join(directory, 'reference-data.lock.json'), JSON.stringify({
      schemaVersion: 1, retrievedAt: '2026-10-22T00:00:00.000Z',
      cli: { package: 'cn-health', version: '0.5.2' },
      compositeRelease: { createdAt: '2026-10-22T00:00:00.000Z', releaseId: 'synthetic-clinical-reference', schemaVersion: '1' },
      registry: { keyId: publicKeySha256.slice(0, 16), publicKeyHex: publicKey.toString('hex'),
        publicKeySha256, url: 'https://example.test/synthetic-registry' },
      datasets: [{ datasetId: 'laboratory-cn', datasetSchemaVersion: 1, licenseId: 'LicenseRef-Synthetic-Test',
        manifestSha256: '0'.repeat(64), releaseId: 'laboratory-cn@synthetic-v1',
        sourceId: 'synthetic-laboratory-cn', sourceUrl: 'https://example.test/synthetic-laboratory' }],
    }))
    const referenceDatabasePath = join(directory, 'reference.sqlite')

    await expect(prepareDevelopmentEnvironment({
      databasePath: join(directory, 'operational.sqlite'),
      referenceDatabasePath,
      repositoryRoot: directory,
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })).rejects.toThrow('materialize 失败')

    expect(await readFile(markerPath, 'utf8')).toBe('requested')
    expect(await runReferenceDatabaseCli(['list', '--database', referenceDatabasePath])).toEqual({ items: [] })
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', referenceDatabasePath]))
      .toMatchObject({ items: [], total: 0 })
  })
})
