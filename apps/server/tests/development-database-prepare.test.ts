import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentDatabases } from '../src/development-database-prepare.ts'
import {
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
      operational: { schemaVersion: 47 },
      reference: { schemaVersion: 10 },
    })

    const operational = openClinMeshDatabase({ busyTimeoutMs: 5_000, databasePath })
    expect(verifyMigrations(operational)).toMatchObject({ schemaVersion: 47 })
    operational.close()
    const reference = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath: referenceDatabasePath,
      readonly: true,
    })
    expect(verifyReferenceDatabase(reference)).toMatchObject({ schemaVersion: 10 })
    reference.close()

    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts.dev).toContain('pnpm db:prepare')
  })
})
