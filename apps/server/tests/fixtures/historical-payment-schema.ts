import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ClinMeshDatabase } from '../../src/infrastructure/sqlite/database.ts'

const cutoverMigration = '0103_payment-collection-cutover.sql'
const retiredPaymentTables = new Set([
  'payment_transaction', 'payment_allocation', 'payment_tender', 'payment_resolution',
  'refund_preview', 'inpatient_payment_attempt', 'inpatient_payment_resolution',
  'inpatient_settlement_supplement_refund',
])

/** Historical migrations keep their original preservation contract before the explicit cutover. */
export function prePaymentCutoverMigrations(database: ClinMeshDatabase): string {
  const directory = join(dirname(database.driver.name), 'pre-payment-cutover-migrations')
  mkdirSync(directory, { recursive: true })
  for (const file of readdirSync('drizzle').filter(name => /^\d{4}_.+\.sql$/u.test(name) && name < cutoverMigration)) {
    copyFileSync(join('drizzle', file), join(directory, file))
  }
  return directory
}

/** Current HTTP fixtures have no old money tables to project into historical schemas. */
export function isRetiredCapturedPaymentTable(database: ClinMeshDatabase, table: string): boolean {
  return retiredPaymentTables.has(table)
    && database.driver.prepare("SELECT 1 FROM captured.sqlite_schema WHERE type='table' AND name=?").get(table) === undefined
}
