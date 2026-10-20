import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigrations, backupDatabase, expectedSchemaVersion, openClinMeshDatabase, restoreDatabase, verifyMigrations,
  type ClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { allocateRegistrationNumber, readRegistrationNumberState } from '../src/infrastructure/sqlite/registration-numbering.ts'

const directories: string[] = []
const databases: ClinMeshDatabase[] = []

function open(databasePath: string) {
  const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5000 })
  databases.push(database)
  return database
}

function issue(database: ClinMeshDatabase, visitDate = '2026-10-20') {
  database.driver.exec('BEGIN IMMEDIATE')
  try {
    const number = allocateRegistrationNumber(database, visitDate)
    database.driver.exec('COMMIT')
    return number
  } catch (error) {
    database.driver.exec('ROLLBACK')
    throw error
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-number-recovery-'))
  directories.push(directory)
  const activePath = join(directory, 'active.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const destinationPath = join(directory, 'restored.sqlite')
  const database = open(activePath)
  applyMigrations(database)
  issue(database)
  await backupDatabase(database, backupPath)
  return { directory, activePath, backupPath, destinationPath, database }
}

afterEach(async () => {
  for (const database of databases.splice(0)) if (database.driver.open) database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('registration numbering controlled recovery', () => {
  it('preserves the latest issued range when restoring an old backup and disables the previous writer', async () => {
    const { activePath, backupPath, destinationPath, database } = await fixture()
    issue(database)
    issue(database)
    issue(database, '2026-10-21')
    const result = await restoreDatabase({
      authorityDatabasePath: activePath, backupPath, destinationPath, busyTimeoutMs: 5000,
      expectedSchemaVersion: expectedSchemaVersion(),
    })
    expect(result.integrity).toBe('ok')
    expect(readRegistrationNumberState(database, { allowRetired: true }).status).toBe('retired')
    expect(() => issue(database)).toThrow('retired authority')
    expect(() => verifyMigrations(database)).toThrow('retired authority')
    await expect(backupDatabase(database, `${activePath}.retired-backup`)).resolves.toMatchObject({ integrity: 'ok' })

    const restored = open(destinationPath)
    expect(issue(restored)).toBe('CM-OP-20261020-000004')
    expect(issue(restored, '2026-10-21')).toBe('CM-OP-20261021-000002')
    restored.close()
    expect(issue(open(destinationPath))).toBe('CM-OP-20261020-000005')
    await expect(restoreDatabase({
      authorityDatabasePath: activePath, backupPath, destinationPath: `${destinationPath}.clone`, busyTimeoutMs: 5000,
      expectedSchemaVersion: expectedSchemaVersion(),
    })).rejects.toThrow('retired authority')
    expect(existsSync(`${destinationPath}.clone`)).toBe(false)
  })

  it('rejects missing authority evidence and unrelated authorities without enabling a clone', async () => {
    const { directory, activePath, backupPath, destinationPath, database } = await fixture()
    await expect(restoreDatabase({
      backupPath, destinationPath, busyTimeoutMs: 5000, expectedSchemaVersion: expectedSchemaVersion(),
    })).rejects.toThrow('REGISTRATION_NUMBER_RECOVERY_UNVERIFIED')
    const unrelatedPath = join(directory, 'unrelated.sqlite')
    const unrelated = open(unrelatedPath)
    applyMigrations(unrelated)
    await expect(restoreDatabase({
      authorityDatabasePath: unrelatedPath, backupPath, destinationPath, busyTimeoutMs: 5000,
      expectedSchemaVersion: expectedSchemaVersion(),
    })).rejects.toThrow('does not belong to the trusted issuance authority')
    expect(existsSync(destinationPath)).toBe(false)
    expect(readRegistrationNumberState(unrelated).status).toBe('active')
    expect(readRegistrationNumberState(database).status).toBe('active')
    expect(issue(open(activePath))).toBe('CM-OP-20261020-000002')
  })

  it('rejects a backup with lost counter state while keeping the current writer active', async () => {
    const { activePath, backupPath, destinationPath, database } = await fixture()
    const backup = open(backupPath)
    backup.driver.prepare('DELETE FROM registration_number_counter').run()
    backup.close()
    await expect(restoreDatabase({
      authorityDatabasePath: activePath, backupPath, destinationPath, busyTimeoutMs: 5000,
      expectedSchemaVersion: expectedSchemaVersion(),
    })).rejects.toThrow('missing or corrupt')
    expect(existsSync(destinationPath)).toBe(false)
    expect(issue(database)).toBe('CM-OP-20261020-000002')
  })

  it('keeps the source retired after candidate persistence fails and rejects a second transfer', async () => {
    const { activePath, backupPath, destinationPath, database } = await fixture()
    issue(database)
    const backup = open(backupPath)
    backup.driver.exec(`
      CREATE TRIGGER reject_candidate_activation BEFORE UPDATE ON registration_number_authority
      WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'candidate persistence unavailable'); END
    `)
    backup.close()
    const options = {
      authorityDatabasePath: activePath, backupPath, destinationPath, busyTimeoutMs: 5000,
      expectedSchemaVersion: expectedSchemaVersion(),
    }
    await expect(restoreDatabase(options)).rejects.toThrow('previous writer remains retired')
    expect(existsSync(destinationPath)).toBe(false)
    expect(() => issue(database)).toThrow('retired authority')
    await expect(restoreDatabase(options)).rejects.toThrow('retired authority')
  })
})
