import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  openClinMeshDatabase,
  verifyMigrations,
} from '../src/infrastructure/sqlite/database.ts'
import {
  applyReferenceMigrations,
  verifyReferenceMigrations,
} from '../src/infrastructure/sqlite/reference-database.ts'

const migrationId = '0000_line-endings.sql'
const migrationSql = [
  'CREATE TABLE migration_fixture (value TEXT NOT NULL) STRICT;',
  "INSERT INTO migration_fixture (value) VALUES ('preserved');",
  '',
].join('\n')
const rawChecksum = (sql: string) => createHash('sha256').update(sql).digest('hex')

describe.each([
  { name: 'operational', apply: applyMigrations, verify: verifyMigrations },
  { name: 'reference', apply: applyReferenceMigrations, verify: verifyReferenceMigrations },
])('$name migration line endings', ({ apply, verify }) => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  async function fixture(sql: string) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-migration-eol-'))
    temporaryDirectories.push(directory)
    const migrationDirectory = join(directory, 'migrations')
    await mkdir(migrationDirectory)
    const migrationPath = join(migrationDirectory, migrationId)
    await writeFile(migrationPath, sql)
    const databasePath = join(directory, 'fixture.sqlite')
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      apply(database, migrationDirectory)
    } finally {
      database.close()
    }
    return { databasePath, migrationDirectory, migrationPath }
  }

  it.each(['LF', 'CRLF'])('preserves a legacy %s checksum across checkout and restart', async (style) => {
    const originalSql = style === 'LF' ? migrationSql : migrationSql.replaceAll('\n', '\r\n')
    const changedSql = style === 'LF' ? migrationSql.replaceAll('\n', '\r\n') : migrationSql
    const { databasePath, migrationDirectory, migrationPath } = await fixture(originalSql)
    const legacy = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    const receipt = {
      migration_id: migrationId,
      checksum: rawChecksum(originalSql),
      applied_at: '2026-10-14T00:00:00.000Z',
    }
    try {
      // Reproduce the raw-byte checksum written before newline normalization existed.
      legacy.driver.prepare('UPDATE schema_migration SET checksum = ?, applied_at = ? WHERE migration_id = ?')
        .run(receipt.checksum, receipt.applied_at, migrationId)
    } finally {
      legacy.close()
    }
    await writeFile(migrationPath, changedSql)
    const reopened = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      expect(apply(reopened, migrationDirectory)).toEqual({ applied: [], schemaVersion: 1 })
      expect(verify(reopened, migrationDirectory)).toEqual({ applied: [], schemaVersion: 1 })
      expect(reopened.driver.prepare('SELECT * FROM schema_migration').all()).toEqual([receipt])
      expect(reopened.driver.prepare('SELECT * FROM migration_fixture').all()).toEqual([{ value: 'preserved' }])

      await writeFile(join(migrationDirectory, '0001_pending.sql'), 'ALTER TABLE migration_fixture ADD COLUMN extra TEXT;\n')
      expect(() => verify(reopened, migrationDirectory)).toThrow(/Pending.*migration/i)
      expect(apply(reopened, migrationDirectory)).toEqual({ applied: ['0001_pending.sql'], schemaVersion: 2 })
      expect(verify(reopened, migrationDirectory).schemaVersion).toBe(2)

      await writeFile(migrationPath, changedSql.replace('preserved', 'modified'))
      expect(() => apply(reopened, migrationDirectory)).toThrow(/checksum changed/)
      expect(() => verify(reopened, migrationDirectory)).toThrow(/checksum changed/)
      expect(reopened.driver.prepare('SELECT value FROM migration_fixture').all()).toEqual([{ value: 'preserved' }])
    } finally {
      reopened.close()
    }
  })

  it.each(['LF', 'CRLF'])('writes the canonical LF checksum for a new %s migration', async (style) => {
    const sql = style === 'LF' ? migrationSql : migrationSql.replaceAll('\n', '\r\n')
    const { databasePath } = await fixture(sql)
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      expect(database.driver.prepare('SELECT checksum FROM schema_migration').get())
        .toEqual({ checksum: rawChecksum(migrationSql) })
    } finally {
      database.close()
    }
  })
})
