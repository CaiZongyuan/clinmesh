import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  openClinMeshDatabase,
  verifyMigrations,
} from '../src/infrastructure/sqlite/database.ts'

const incrementalId = '0064_incremental-recording.sql'
const repairId = '0065_incremental-recording-context.sql'
const earlyChecksum = '4a39fb88c40b97efa45559731aefe9df25559c8165d75ac776504eae935407be'
const actor = JSON.stringify({ actorId: 'original-doctor', workspaceId: 'workspace', epoch: 'epoch' })
const publishedActor = JSON.stringify({ actorId: 'published-verifier', workspaceId: 'workspace', epoch: 'epoch' })

describe('incremental recording migration compatibility', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
  })

  async function fixture(version: 'early' | 'published', crlf = false) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-incremental-migration-'))
    directories.push(directory)
    const migrationDirectory = join(directory, 'migrations')
    await mkdir(migrationDirectory)
    let sql = (await readFile(join(process.cwd(), 'drizzle', incrementalId), 'utf8')).replaceAll('\r\n', '\n')
    if (version === 'early') {
      sql = sql.replace('  actor_context_json TEXT NOT NULL CHECK (json_valid(actor_context_json)),\n', '')
        .replace(/UPDATE consultation_recording_job AS j SET result = CASE WHEN EXISTS \([\s\S]*?END WHERE status = 'completed';\n\n/u, '')
      expect(createHash('sha256').update(sql).digest('hex')).toBe(earlyChecksum)
    }
    await writeFile(join(migrationDirectory, incrementalId), crlf ? sql.replaceAll('\n', '\r\n') : sql)
    const databasePath = join(directory, 'fixture.sqlite')
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      database.driver.exec(`
        CREATE TABLE consultation_recording (
          workspace_id TEXT, epoch TEXT, case_id TEXT,
          PRIMARY KEY (workspace_id, epoch, case_id)
        ) STRICT;
        CREATE TABLE consultation_recording_job (
          workspace_id TEXT, epoch TEXT, case_id TEXT, turn_id TEXT, status TEXT, actor_context_json TEXT
        ) STRICT;
        CREATE TABLE consultation_recording_source (source_id TEXT) STRICT;
        CREATE TABLE consultation_history_addition (
          workspace_id TEXT, epoch TEXT, case_id TEXT, addition_id TEXT, source_turn_id TEXT, facts_json TEXT,
          PRIMARY KEY (workspace_id, epoch, case_id, addition_id)
        ) STRICT;
        CREATE TABLE outbox_event (
          workspace_id TEXT, epoch TEXT, kind TEXT, status TEXT, next_attempt_at TEXT, payload_json TEXT
        ) STRICT;
        INSERT INTO consultation_recording VALUES ('workspace', 'epoch', 'case');
        INSERT INTO consultation_history_addition VALUES ('workspace', 'epoch', 'case', 'addition', 'direct',
          '[{"sources":[{"sourceTurnId":"fact"}]}]');
      `)
      for (const [id, status] of [['direct', 'completed'], ['fact', 'completed'], ['empty', 'completed'], ['failed', 'failed'], ['no-facts', 'completed']]) {
        database.driver.prepare('INSERT INTO consultation_recording_job VALUES (?, ?, ?, ?, ?, ?)')
          .run('workspace', 'epoch', 'case', id, status, actor)
      }
      applyMigrations(database, migrationDirectory)
      // Historical raw CRLF receipts must remain unchanged as well.
      if (crlf) database.driver.prepare('UPDATE schema_migration SET checksum = ? WHERE migration_id = ?')
        .run(createHash('sha256').update(sql.replaceAll('\n', '\r\n')).digest('hex'), incrementalId)
      database.driver.exec(`INSERT INTO consultation_recording_batch
        (workspace_id, epoch, case_id, batch_id, snapshot_json, created_at)
        VALUES ('workspace', 'epoch', 'case', 'batch', '{}', '2026-10-16T00:00:00Z')`)
      const columns = 'workspace_id, epoch, case_id, addition_id, batch_id, content_hash, status'
      const values = ['workspace', 'epoch', 'case', 'addition', 'batch', 'content-hash', 'pending']
      database.driver.prepare(`INSERT INTO consultation_recording_verification (${columns}${version === 'published' ? ', actor_context_json' : ''})
        VALUES (${values.map(() => '?').join(', ')}${version === 'published' ? ', ?' : ''})`)
        .run(...values, ...(version === 'published' ? [publishedActor] : []))
      database.driver.prepare('INSERT INTO outbox_event VALUES (?, ?, ?, ?, ?, ?)')
        .run('workspace', 'epoch', 'consultation.verify-history', 'pending', '2026-10-16T00:00:00Z',
          JSON.stringify({ batchId: 'batch', additionId: 'addition', turnId: 'direct' }))
      // Results produced after 0064 must not be replaced by the historical backfill.
      database.driver.exec("UPDATE consultation_recording_job SET result = 'needs-verification' WHERE turn_id = 'empty'")
    } finally {
      database.close()
    }
    await writeFile(join(migrationDirectory, incrementalId), await readFile(join(process.cwd(), 'drizzle', incrementalId)))
    return { databasePath, migrationDirectory }
  }

  it.each([
    { version: 'early' as const, crlf: false },
    { version: 'early' as const, crlf: true },
    { version: 'published' as const, crlf: false },
  ])('upgrades $version (CRLF=$crlf) without rewriting its receipt or pending verification', async ({ version, crlf }) => {
    const { databasePath, migrationDirectory } = await fixture(version, crlf)
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      const receipt = database.driver.prepare('SELECT * FROM schema_migration WHERE migration_id = ?').get(incrementalId)
      await writeFile(join(migrationDirectory, repairId), await readFile(join(process.cwd(), 'drizzle', repairId)))
      expect(() => verifyMigrations(database, migrationDirectory)).toThrow(/Pending database migrations/)
      expect(applyMigrations(database, migrationDirectory)).toEqual({ applied: [repairId], schemaVersion: 2 })
      expect(database.driver.prepare('SELECT * FROM schema_migration WHERE migration_id = ?').get(incrementalId)).toEqual(receipt)
      expect(database.driver.prepare('SELECT actor_context_json, status, content_hash FROM consultation_recording_verification').get())
        .toEqual({ actor_context_json: version === 'published' ? publishedActor : actor, status: 'pending', content_hash: 'content-hash' })
      expect(database.driver.prepare('SELECT turn_id, result FROM consultation_recording_job ORDER BY turn_id').all()).toEqual([
        { turn_id: 'direct', result: 'recorded' },
        { turn_id: 'empty', result: 'needs-verification' },
        { turn_id: 'fact', result: 'recorded' },
        { turn_id: 'failed', result: null },
        { turn_id: 'no-facts', result: 'no-new-facts' },
      ])
      expect(database.driver.pragma('foreign_key_check')).toEqual([])
      expect(verifyMigrations(database, migrationDirectory)).toEqual({ applied: [], schemaVersion: 2 })
      expect(applyMigrations(database, migrationDirectory)).toEqual({ applied: [], schemaVersion: 2 })
    } finally {
      database.close()
    }
  })

  it('rolls back an early upgrade when the original verification actor cannot be recovered', async () => {
    const { databasePath, migrationDirectory } = await fixture('early')
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      database.driver.exec('DELETE FROM outbox_event')
      await writeFile(join(migrationDirectory, repairId), await readFile(join(process.cwd(), 'drizzle', repairId)))
      expect(() => applyMigrations(database, migrationDirectory)).toThrow(/NOT NULL/)
      expect(database.driver.prepare('SELECT migration_id FROM schema_migration').all()).toEqual([{ migration_id: incrementalId }])
      expect(database.driver.prepare('SELECT name FROM pragma_table_info(?)').all('consultation_recording_verification'))
        .not.toContainEqual({ name: 'actor_context_json' })
    } finally {
      database.close()
    }
  })

  it('still rejects changes to the published SQL even with an allowlisted early receipt', async () => {
    const { databasePath, migrationDirectory } = await fixture('early')
    await writeFile(join(migrationDirectory, incrementalId), `${await readFile(join(migrationDirectory, incrementalId), 'utf8')}-- changed\n`)
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      expect(() => applyMigrations(database, migrationDirectory)).toThrow(`Applied migration checksum changed: ${incrementalId}`)
      expect(() => verifyMigrations(database, migrationDirectory)).toThrow(`Applied migration checksum changed: ${incrementalId}`)
    } finally {
      database.close()
    }
  })
})
