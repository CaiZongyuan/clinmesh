import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import {
  applyReferenceMigrations,
  listReferenceDataReleases,
  openReferenceDatabase,
  verifyReferenceDatabase,
} from '../src/infrastructure/sqlite/reference-database.ts'

describe('Reference Data database CLI', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('publishes an immutable release and leaves it unchanged when a later artifact fails checksum validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-data-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'reference.sqlite')
    const artifactPath = join(directory, 'concepts.json')
    const manifestPath = join(directory, 'release.json')
    const artifact = {
      concepts: [{
        code: 'R50.9',
        display: '发热，未特指',
        domain: 'diagnosis',
        id: 'diagnosis:fever',
        sourceLocator: 'concepts[0]',
        status: 'active',
        system: 'http://hl7.org/fhir/sid/icd-10',
        version: 'synthetic-2026',
      }],
      schemaVersion: '1',
    }
    const artifactJson = `${JSON.stringify(artifact)}\n`
    const checksum = createHash('sha256').update(artifactJson).digest('hex')
    const source = {
      acquisitionMethod: 'bundled-fixture',
      artifactPath: 'concepts.json',
      checksum,
      licenseId: 'CC0-1.0',
      publishedAt: '2026-08-28',
      retrievedAt: '2026-08-28T00:00:00.000Z',
      sourceId: 'synthetic-diagnosis',
      sourceUrl: 'https://example.test/reference/synthetic-diagnosis',
      upstreamVersion: 'synthetic-2026',
    }
    const manifest = {
      createdAt: '2026-08-28T00:00:00.000Z',
      releaseId: 'reference-synthetic-2026-08-28',
      schemaVersion: '1',
      sources: [source],
    }
    await writeFile(artifactPath, artifactJson)
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)

    await expect(runReferenceDatabaseCli([
      'migrate', '--database', databasePath,
    ])).resolves.toEqual({
      applied: [
        '0001_reference-data.sql',
        '0002_reference-source-format.sql',
        '0003_reference-diagnosis-format.sql',
        '0004_reference-medication-products.sql',
        '0005_reference-services.sql',
      ],
      schemaVersion: 5,
    })
    const imported = await runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])
    expect(imported).toMatchObject({
      conceptCount: 1,
      created: true,
      releaseId: 'reference-synthetic-2026-08-28',
      sourceCount: 1,
    })
    expect(imported).toHaveProperty('contentHash', expect.stringMatching(/^[a-f0-9]{64}$/))
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).resolves.toMatchObject({ integrity: 'ok', releaseCount: 1, schemaVersion: 5 })
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toEqual({ items: [expect.objectContaining({
      conceptCount: 1,
      releaseId: 'reference-synthetic-2026-08-28',
      sourceCount: 1,
      sources: [expect.objectContaining({
        importDiagnostics: {
          acceptedCount: 1,
          rejectedCount: 0,
          warnings: [],
        },
      })],
    })] })

    const changedArtifactJson = `${JSON.stringify({ ...artifact, concepts: [] })}\n`
    const changedChecksum = createHash('sha256').update(changedArtifactJson).digest('hex')
    await writeFile(artifactPath, changedArtifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      sources: [{ ...source, checksum: changedChecksum }],
    })}\n`)
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).rejects.toThrow('immutable')

    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      releaseId: 'reference-failed-2026-08-28',
    })}\n`)
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).rejects.toThrow('checksum')
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toEqual({ items: [expect.objectContaining({
      conceptCount: 1,
      releaseId: 'reference-synthetic-2026-08-28',
      sourceCount: 1,
    })] })

    const tampered = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    tampered.driver.prepare(`
      UPDATE reference_concept SET display = ? WHERE concept_id = ?
    `).run('被篡改的显示名', 'diagnosis:fever')
    tampered.close()
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).rejects.toThrow('content hash')
  })

  it('imports the synthetic LOINC 2.83 and UCUM 2.2 parser fixture into one release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-loinc-ucum-reference-data-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'reference.sqlite')
    const manifestPath = fileURLToPath(new URL(
      './fixtures/reference-data/loinc-ucum-release.json',
      import.meta.url,
    ))

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 6,
      created: true,
      releaseId: 'clinmesh-loinc-ucum-parser-fixture-2026-08-28',
      sourceCount: 2,
    })
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toEqual({
      items: [expect.objectContaining({
        conceptCount: 6,
        sources: [
          expect.objectContaining({ artifactFormat: 'loinc-csv', recordCount: 3 }),
          expect.objectContaining({ artifactFormat: 'ucum-xml', recordCount: 3 }),
        ],
      })],
    })
  })

  it('imports the complete NHSA diagnosis CSV selected by a fixed manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-nhsa-diagnosis-reference-data-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'reference.sqlite')
    const manifestPath = fileURLToPath(new URL(
      './fixtures/reference-data/nhsa-diagnosis-release.json',
      import.meta.url,
    ))

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 2,
      created: true,
      releaseId: 'clinmesh-nhsa-diagnosis-parser-fixture-2026-08-28',
      sourceCount: 1,
    })
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).resolves.toMatchObject({ integrity: 'ok', releaseCount: 1 })
  })

  it('imports NHSA medication products as products rather than reference concepts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-nhsa-medication-products-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'reference.sqlite')
    const manifestPath = fileURLToPath(new URL(
      './fixtures/reference-data/nhsa-medication-products-release.json',
      import.meta.url,
    ))

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 0,
      medicationProductCount: 3,
      releaseId: 'clinmesh-nhsa-medication-products-parser-fixture-2026-08-28',
    })
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toMatchObject({
      items: [{ conceptCount: 0, medicationProductCount: 3 }],
    })
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).resolves.toMatchObject({ integrity: 'ok', releaseCount: 1 })

    const tampered = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    tampered.driver.prepare(`
      UPDATE reference_medication_product SET manufacturer = ? WHERE code = ?
    `).run('Tampered manufacturer', 'CM-NHSA-PRODUCT-ACETAMINOPHEN')
    tampered.close()
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).rejects.toThrow('content hash')
  })

  it('imports NHC services and WS/T values into independent reference tables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-nhc-services-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'reference.sqlite')
    const manifestPath = fileURLToPath(new URL(
      './fixtures/reference-data/nhc-services-release.json',
      import.meta.url,
    ))

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 0,
      releaseId: 'clinmesh-nhc-services-parser-fixture-2026-08-28',
      serviceCount: 9,
      sourceCount: 2,
      valueSetEntryCount: 6,
    })
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toMatchObject({
      items: [{ serviceCount: 9, valueSetEntryCount: 6 }],
    })
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).resolves.toMatchObject({ integrity: 'ok', releaseCount: 1, schemaVersion: 5 })

    const tampered = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    tampered.driver.prepare(`
      UPDATE reference_medical_service SET billing_unit_code = ? WHERE code = ?
    `).run('SESSION', 'CM-NHC-SERVICE-CBC')
    tampered.close()
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).rejects.toThrow('content hash')
  })

  it('preserves a published release hash when the source format migration is applied', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-data-legacy-release-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'reference.sqlite')
    const migrationDirectory = join(directory, 'migrations')
    const sourceMigrationDirectory = fileURLToPath(new URL('../reference-drizzle/', import.meta.url))
    await mkdir(migrationDirectory)
    await copyFile(
      join(sourceMigrationDirectory, '0001_reference-data.sql'),
      join(migrationDirectory, '0001_reference-data.sql'),
    )
    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    expect(applyReferenceMigrations(database, migrationDirectory)).toEqual({
      applied: ['0001_reference-data.sql'],
      schemaVersion: 1,
    })

    const releaseId = 'reference-synthetic-2026-08-28'
    const sourceId = 'synthetic-diagnosis'
    const oldContentHash = '34805f47f23bc8e705006949b8fe446726eaa8f00516f150f4211b99f3855c90'
    database.driver.prepare(`
      INSERT INTO reference_release (
        release_id, schema_version, status, created_at, content_hash, source_count, concept_count
      ) VALUES (?, '1', 'published', ?, ?, 1, 1)
    `).run(releaseId, '2026-08-28T00:00:00.000Z', oldContentHash)
    database.driver.prepare(`
      INSERT INTO reference_source_manifest (
        release_id, source_id, upstream_version, published_at, retrieved_at,
        source_url, checksum, license_id, acquisition_method, record_count,
        import_diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      releaseId,
      sourceId,
      'synthetic-2026',
      '2026-08-28',
      '2026-08-28T00:00:00.000Z',
      'https://example.test/reference/synthetic-diagnosis',
      'b1d09a8c7259bb3b882b18da7bbaeebc51ea06599ea9b19c32f830fac10e8db7',
      'CC0-1.0',
      'bundled-fixture',
      JSON.stringify({ acceptedCount: 1, rejectedCount: 0, warnings: [] }),
    )
    database.driver.prepare(`
      INSERT INTO reference_concept (
        release_id, concept_id, domain, system, system_version, code, display,
        status, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      releaseId,
      'diagnosis:fever',
      'diagnosis',
      'http://hl7.org/fhir/sid/icd-10',
      'synthetic-2026',
      'R50.9',
      '发热，未特指',
      'active',
      sourceId,
      'concepts[0]',
    )

    await copyFile(
      join(sourceMigrationDirectory, '0002_reference-source-format.sql'),
      join(migrationDirectory, '0002_reference-source-format.sql'),
    )
    expect(applyReferenceMigrations(database, migrationDirectory)).toEqual({
      applied: ['0002_reference-source-format.sql'],
      schemaVersion: 2,
    })
    await copyFile(
      join(sourceMigrationDirectory, '0003_reference-diagnosis-format.sql'),
      join(migrationDirectory, '0003_reference-diagnosis-format.sql'),
    )
    expect(applyReferenceMigrations(database, migrationDirectory)).toEqual({
      applied: ['0003_reference-diagnosis-format.sql'],
      schemaVersion: 3,
    })
    await copyFile(
      join(sourceMigrationDirectory, '0004_reference-medication-products.sql'),
      join(migrationDirectory, '0004_reference-medication-products.sql'),
    )
    expect(applyReferenceMigrations(database, migrationDirectory)).toEqual({
      applied: ['0004_reference-medication-products.sql'],
      schemaVersion: 4,
    })
    await copyFile(
      join(sourceMigrationDirectory, '0005_reference-services.sql'),
      join(migrationDirectory, '0005_reference-services.sql'),
    )
    expect(applyReferenceMigrations(database, migrationDirectory)).toEqual({
      applied: ['0005_reference-services.sql'],
      schemaVersion: 5,
    })
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
    for (const table of [
      'reference_concept',
      'reference_medication_product',
      'reference_medical_service',
      'reference_value_set_entry',
    ]) {
      const foreignKeys = database.driver.pragma(`foreign_key_list(${table})`) as Array<{
        table: string
      }>
      expect(foreignKeys.map(foreignKey => foreignKey.table)).toContain(
        'reference_source_manifest',
      )
    }
    expect(verifyReferenceDatabase(database)).toEqual({
      integrity: 'ok',
      releaseCount: 1,
      schemaVersion: 5,
    })
    expect(listReferenceDataReleases(database).items[0]).toMatchObject({
      contentHash: oldContentHash,
      sources: [{ artifactFormat: 'clinmesh-reference-v1' }],
    })
    database.driver.pragma('foreign_keys = OFF')
    database.driver.prepare(`
      DELETE FROM reference_source_manifest WHERE release_id = ? AND source_id = ?
    `).run(releaseId, sourceId)
    database.driver.pragma('foreign_keys = ON')
    expect(() => verifyReferenceDatabase(database)).toThrow('foreign key check failed')
    database.close()
  })
})
