import type Database from 'better-sqlite3'
import { migrationChecksum } from './migration-checksum.ts'

// 0064 ran locally before its Actor column and completed-job backfill were added.
// Pin both sides of the exception so subsequent SQL edits still fail verification.
export function matchesEarlyIncrementalRecordingMigration(file: string, sql: string, checksum: string): boolean {
  return file === '0064_incremental-recording.sql'
    && migrationChecksum(sql) === 'f89c94cdf1cbb15edc103a0efa308d5aabc9112124a72da413affc3314f54c89'
    && (checksum === '4a39fb88c40b97efa45559731aefe9df25559c8165d75ac776504eae935407be'
      || checksum === '56d20fc40e229e4331ddeb2e44762ef6081bc801d51bef2a94e173c9fdeb25fe')
}

export function prepareIncrementalRecordingContextMigration(driver: Database.Database, file: string): void {
  if (file !== '0065_incremental-recording-context.sql') return
  // SQLite has no ADD COLUMN IF NOT EXISTS. Stage a nullable column inside the
  // migration transaction; 0065 recovers its values and restores NOT NULL.
  const column = driver.prepare("SELECT 1 FROM pragma_table_info('consultation_recording_verification') WHERE name = 'actor_context_json'").get()
  if (column === undefined) driver.exec('ALTER TABLE consultation_recording_verification ADD COLUMN actor_context_json TEXT')
}
