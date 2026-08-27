import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'

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
    ])).resolves.toEqual({ applied: ['0001_reference-data.sql'], schemaVersion: 1 })
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
    ])).resolves.toMatchObject({ integrity: 'ok', releaseCount: 1, schemaVersion: 1 })
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
})
