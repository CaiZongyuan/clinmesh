import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentDatabases, prepareDevelopmentEnvironment } from '../src/development-database-prepare.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createDrgReferenceFixture, writeDrgCompactFixtureIndex } from './fixtures/drg-reference.ts'
import { syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'
import { createGuidelineReleaseFixture } from './fixtures/guideline-release.ts'
import { loadDrgRules } from '../src/infrastructure/reference-data/drg-rules-package.ts'
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

    const prepared = await prepareDevelopmentEnvironment({
      databasePath,
      referenceDatabasePath,
      referenceReleaseId: 'synthetic-clinical-reference',
      repositoryRoot: directory,
      drgReference: { lockPath: fixture.lockPath },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })

    expect(prepared).toMatchObject({
      drgRules: {
        status: 'skipped',
        reason: 'source-inputs-absent',
        outputDirectory: null,
        reviewPath: null,
      },
    })
    expect(await runReferenceDatabaseCli(['list-inventories', '--database', referenceDatabasePath]))
      .toMatchObject({ items: [{ inventoryId: 'synthetic-inventory-v1', runtimeEnabled: false }] })
  })

  it('materializes locked DRG v2 rules and validates the committed review during startup preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-development-drg-rules-'))
    temporaryDirectories.push(directory)
    const guidelines = await createGuidelineReleaseFixture(join(directory, 'guidelines'))
    const databasePath = join(directory, 'operational.sqlite')
    const referenceDatabasePath = join(directory, 'reference.sqlite')
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    const clinicalArtifact = JSON.stringify({ schemaVersion: '1', concepts: [], valueSetEntries: [] })
    await writeFile(join(directory, 'clinical.json'), clinicalArtifact)
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    await writeFile(join(directory, 'clinical-release.json'), JSON.stringify({
      createdAt: '2026-10-22T00:00:00.000Z', releaseId: 'synthetic-clinical-reference', schemaVersion: '1',
      sources: [{ acquisitionMethod: 'generated', artifactPath: 'clinical.json',
        checksum: digest(clinicalArtifact), licenseId: 'LicenseRef-Synthetic-Test',
        retrievedAt: '2026-10-22T00:00:00.000Z', sourceId: 'synthetic-clinical-reference',
        sourceUrl: 'https://example.test/synthetic-clinical-reference', upstreamVersion: 'synthetic-v1' }],
    }))
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'clinical-release.json')])

    const preparedRoot = '.data/reference-prepared/r3'
    const openDrgRoot = '.data/exports/opendrg-2026-10-20'
    const groupsText = `${[
      { level: 'MDC', code: 'MDCR', name: '合成系统', parentCode: null },
      { level: 'ADRG', code: 'RA1', name: '合成入口', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA15', name: '合成终端', parentCode: 'RA1' },
    ].map(row => JSON.stringify(row)).join('\n')}\n`
    const jsText = syntheticDrgSource()
    const tablesText = JSON.stringify({ CC: {}, MCC: {}, CCE: {}, SS_VALID: [] })
    const datasetsText = '[]'
    const schemesText = JSON.stringify([{
      id: 'chs_drg_30',
      grouperSourceUrl: 'https://example.test/opendrg/raw/3258.b47bba5f.js',
      groupDataPath: 'groupers/chs_drg_30.json',
    }])
    const openDrgManifestText = JSON.stringify({
      completed: '2026-10-20T00:00:00.000Z',
      baseUrl: 'https://example.test/opendrg',
      assets: [{ url: 'https://example.test/opendrg/raw/3258.b47bba5f.js', localPath: 'raw/3258.b47bba5f.js' }],
    })
    const openDrgChecksumsText = JSON.stringify({
      algorithm: 'SHA-256',
      files: [
        { path: 'catalog/datasets.json', sha256: digest(datasetsText) },
        { path: 'catalog/schemes.json', sha256: digest(schemesText) },
        { path: 'raw/3258.b47bba5f.js', sha256: digest(jsText) },
        { path: 'groupers/chs_drg_30.json', sha256: digest(tablesText) },
      ],
    })
    const preparedManifestText = JSON.stringify({
      schemaVersion: 'clinmesh.prepared-catalogues.v1',
      releaseId: 'synthetic-prepared-v1',
      sources: {},
      files: [{ path: 'drg/groups.jsonl', sha256: digest(groupsText), rows: 3, sourceVersion: 'synthetic-2026' }],
    })

    await mkdir(join(directory, preparedRoot, 'drg'), { recursive: true })
    await mkdir(join(directory, openDrgRoot, 'catalog'), { recursive: true })
    await mkdir(join(directory, openDrgRoot, 'raw'), { recursive: true })
    await mkdir(join(directory, openDrgRoot, 'groupers'), { recursive: true })
    await writeFile(join(directory, preparedRoot, 'drg/groups.jsonl'), groupsText)
    await writeFile(join(directory, preparedRoot, 'manifest.json'), preparedManifestText)
    await writeFile(join(directory, openDrgRoot, 'catalog/datasets.json'), datasetsText)
    await writeFile(join(directory, openDrgRoot, 'catalog/schemes.json'), schemesText)
    await writeFile(join(directory, openDrgRoot, 'raw/3258.b47bba5f.js'), jsText)
    await writeFile(join(directory, openDrgRoot, 'groupers/chs_drg_30.json'), tablesText)
    await writeFile(join(directory, openDrgRoot, 'manifest.json'), openDrgManifestText)
    await writeFile(join(directory, openDrgRoot, 'checksums.json'), openDrgChecksumsText)

    const compact = await writeDrgCompactFixtureIndex(directory, [
      `${preparedRoot}/manifest.json`,
      `${preparedRoot}/drg/groups.jsonl`,
      `${openDrgRoot}/manifest.json`,
      `${openDrgRoot}/checksums.json`,
      `${openDrgRoot}/catalog/datasets.json`,
      `${openDrgRoot}/catalog/schemes.json`,
      `${openDrgRoot}/raw/3258.b47bba5f.js`,
      `${openDrgRoot}/groupers/chs_drg_30.json`,
    ])
    const offlineLockPath = join(directory, 'offline-full.lock.json')
    await writeFile(offlineLockPath, JSON.stringify({
      schemaVersion: 'clinmesh.offline-inventory.v1',
      inventoryId: 'synthetic-full-drg-inventory-v1',
      createdAt: '2026-10-25T00:00:00.000Z',
      scheme: 'CHS-DRG-3.0',
      storage: compact.storage,
      packages: [
        {
          id: 'prepared-five-catalogues',
          format: 'prepared-catalogues-v1',
          root: preparedRoot,
          version: 'synthetic-prepared-v1',
          manifest: { path: 'manifest.json', sha256: digest(preparedManifestText) },
          sourceUrl: 'https://example.test/synthetic-prepared',
          quarantineReasons: ['usage-terms-unconfirmed'],
        },
        {
          id: 'opendrg-export',
          format: 'opendrg-public-data-v1',
          root: openDrgRoot,
          version: '2026-10-20',
          manifest: { path: 'manifest.json', sha256: digest(openDrgManifestText) },
          checksums: { path: 'checksums.json', sha256: digest(openDrgChecksumsText) },
          sourceUrl: 'https://example.test/opendrg',
          quarantineReasons: ['usage-terms-unconfirmed'],
        },
      ],
    }))
    const sourceLockPath = join(directory, 'drg-rules-source.lock.json')
    await writeFile(sourceLockPath, JSON.stringify({
      schemaVersion: 'clinmesh.drg-rules-source.v1',
      releaseId: 'clinmesh-chs-drg-30-2026-10-25.conditions-v2',
      sourceVersion: 'opendrg-chs-drg-3.0@2026-10-20',
      inputs: {
        groups: { path: `${preparedRoot}/drg/groups.jsonl`, sha256: digest(groupsText) },
        js: { path: `${openDrgRoot}/raw/3258.b47bba5f.js`, sha256: digest(jsText) },
        tables: { path: `${openDrgRoot}/groupers/chs_drg_30.json`, sha256: digest(tablesText) },
      },
    }))

    // First run without review file materializes .data/drg-rules/<releaseId> cleanly with reviewPath: null
    const first = await prepareDevelopmentEnvironment({
      databasePath,
      referenceDatabasePath,
      referenceReleaseId: 'synthetic-clinical-reference',
      repositoryRoot: directory,
      drgReference: { lockPath: offlineLockPath },
      drgRules: { sourceLockPath },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })
    const expectedOutputDir = join(directory, '.data/drg-rules/clinmesh-chs-drg-30-2026-10-25.conditions-v2')
    expect(first).toMatchObject({
      drgRules: {
        status: 'prepared',
        releaseId: 'clinmesh-chs-drg-30-2026-10-25.conditions-v2',
        outputDirectory: expectedOutputDir,
        reviewPath: null,
        runtimeEnabled: false,
      },
    })
    expect((await loadDrgRules(expectedOutputDir)).rulesId).toBe('clinmesh-chs-drg-30-2026-10-25.conditions-v2')

    // Now write deployment/drg/pci-demo-review.json matching manifestSha256 and referenceReleaseId -> validates association
    const manifestSha256 = digest(await readFile(join(expectedOutputDir, 'manifest.json'), 'utf8'))
    const reviewDirectory = join(directory, 'deployment/drg')
    await mkdir(reviewDirectory, { recursive: true })
    const noticeText = '# 分组规则来源与版权声明\n\n© 2023 OpenDRG.cn\n'
    await writeFile(join(reviewDirectory, 'NOTICE.md'), noticeText)
    const reviewPath = join(reviewDirectory, 'pci-demo-review.json')
    const validReview = {
      schemaVersion: 'clinmesh.drg-rules-review.v1',
      scope: 'hospital-simulation',
      releaseId: 'clinmesh-chs-drg-30-2026-10-25.conditions-v2',
      sourceVersion: 'opendrg-chs-drg-3.0@2026-10-20',
      manifestSha256,
      referenceReleaseId: 'synthetic-clinical-reference',
      reviewedBy: 'Synthetic Test Reviewer',
      reviewedAt: '2026-11-12T00:00:00.000Z',
      checks: {
        usageTerms: { status: 'verified', evidence: ['synthetic usage check'] },
        codingCompatibility: { status: 'verified', evidence: ['synthetic coding check'] },
        sourceApplicability: { status: 'verified', evidence: ['synthetic applicability check'] },
        algorithmValidation: { status: 'verified', evidence: ['synthetic algorithm check'] },
      },
    }
    await writeFile(reviewPath, JSON.stringify(validReview))

    const second = await prepareDevelopmentEnvironment({
      databasePath,
      referenceDatabasePath,
      referenceReleaseId: 'synthetic-clinical-reference',
      repositoryRoot: directory,
      drgReference: { lockPath: offlineLockPath },
      drgRules: { sourceLockPath },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })
    expect(second).toMatchObject({
      drgRules: {
        status: 'already-prepared',
        releaseId: 'clinmesh-chs-drg-30-2026-10-25.conditions-v2',
        outputDirectory: expectedOutputDir,
        reviewPath,
        manifestSha256,
        runtimeEnabled: false,
      },
    })
    expect(await readFile(join(expectedOutputDir, 'NOTICE.md'), 'utf8')).toBe(noticeText)

    // Mismatched review referenceReleaseId must fail closed
    await writeFile(reviewPath, JSON.stringify({ ...validReview, referenceReleaseId: 'wrong-clinical-release' }))
    await expect(prepareDevelopmentEnvironment({
      databasePath,
      referenceDatabasePath,
      referenceReleaseId: 'synthetic-clinical-reference',
      repositoryRoot: directory,
      drgReference: { lockPath: offlineLockPath },
      drgRules: { sourceLockPath },
      guidelineDatabasePath: join(directory, 'guidelines.sqlite'),
      guidelineReference: { lockPath: guidelines.lockPath, inputRoot: guidelines.inputRoot },
    })).rejects.toThrow(/DRG review reference release mismatch/)
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
