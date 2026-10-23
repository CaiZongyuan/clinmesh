import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PaymentLedger } from '../src/application/payment-ledger.ts'
import {
  applyMigrations,
  canonicalStateHash,
  openClinMeshDatabase,
  type ClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const migration = '0071_payment-installments.sql'
const context = { workspaceId: 'workspace-payments', epoch: 'epoch-1' }
const createdAt = '2026-10-20T01:00:00.000Z'
const directories: string[] = []
const databases: ClinMeshDatabase[] = []

async function legacyDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-payment-migration-'))
  directories.push(directory)
  const migrations = join(directory, 'legacy-migrations')
  await mkdir(migrations)
  const files = (await readdir('drizzle')).filter(file => file.endsWith('.sql') && file < migration)
  await Promise.all(files.map(file => copyFile(join('drizzle', file), join(migrations, file))))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'legacy.sqlite'), busyTimeoutMs: 5000 })
  databases.push(database)
  applyMigrations(database, migrations)
  new WorkspaceRepository(database).install({
    ...context,
    scenarioId: 'payment-migration',
    scenarioRunId: 'run-payments',
    workspaceName: 'Synthetic payment migration',
  })
  database.driver.prepare(`
    INSERT INTO scenario_definition (scenario_id, version, kind, schema_version)
    VALUES ('payment-migration', '1', 'candidate', '1')
  `).run()
  database.driver.prepare(`
    INSERT INTO scenario_epoch_state (
      workspace_id, epoch, scenario_run_id, scenario_id, deterministic_seed,
      virtual_time, initial_state_hash
    ) VALUES (?, ?, 'run-payments', 'payment-migration', 1, ?, ?)
  `).run(context.workspaceId, context.epoch, createdAt, '0'.repeat(64))
  database.driver.prepare(`
    INSERT INTO outpatient_catalog (
      workspace_id, epoch, item_id, kind, code, name_zh, name_en
    ) VALUES (?, ?, 'department', 'department', 'general', '合成科室', 'Synthetic department')
  `).run(context.workspaceId, context.epoch)
  return database
}

function legacyAttempt(
  database: ClinMeshDatabase,
  name: string,
  outcome: 'ambiguous' | 'declined' | 'success',
  amountFen = 6800,
) {
  const status = outcome === 'success' ? 'paid' : outcome
  database.driver.prepare(`
    INSERT INTO outpatient_case (
      workspace_id, epoch, case_id, scenario_run_id, patient_id, registration_id,
      encounter_id, account_id, department_id, location_id, initial_task_id,
      status, arrived_at, updated_at
    ) VALUES (?, ?, ?, 'run-payments', ?, ?, ?, ?, 'department', 'location', ?,
      'awaiting-lab-payment', ?, ?)
  `).run(
    context.workspaceId, context.epoch, `case-${name}`, `patient-${name}`,
    `registration-${name}`, `encounter-${name}`, `account-${name}`,
    `task-${name}`, createdAt, createdAt,
  )
  database.driver.prepare(`
    INSERT INTO charge_record (
      workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
      category, source_reference, description_zh, description_en, quantity,
      unit_price_fen, total_fen, status, version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'laboratory', ?, '合成检验', 'Synthetic laboratory',
      1, ?, ?, ?, 2, ?)
  `).run(
    context.workspaceId, context.epoch, `charge-${name}`, `case-${name}`,
    `account-${name}`, `item-${name}`, `ServiceRequest/request-${name}`,
    amountFen, amountFen, status, createdAt,
  )
  database.driver.prepare(`
    INSERT INTO payment_preview (
      workspace_id, epoch, preview_id, case_id, category, amount_fen,
      expected_charge_version, simulator_rule, token_hash, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, 'laboratory', ?, 1, ?, 'synthetic-token-hash', ?, ?)
  `).run(
    context.workspaceId, context.epoch, `preview-${name}`, `case-${name}`,
    amountFen, outcome === 'declined' ? 'decline' : outcome, createdAt, createdAt,
  )
  database.driver.prepare(`
    INSERT INTO payment_transaction (
      workspace_id, epoch, payment_id, case_id, category, amount_fen,
      outcome, correlation_id, preview_id, created_at
    ) VALUES (?, ?, ?, ?, 'laboratory', ?, ?, ?, ?, ?)
  `).run(
    context.workspaceId, context.epoch, `payment-${name}`, `case-${name}`,
    amountFen, outcome, `sim-payment-${name}`, `preview-${name}`, createdAt,
  )
}

function originalAttempts(database: ClinMeshDatabase) {
  return database.driver.prepare(`
    SELECT workspace_id, epoch, payment_id, case_id, category, amount_fen,
      outcome, correlation_id, preview_id, created_at
    FROM payment_transaction ORDER BY payment_id
  `).all()
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('payment ledger migration', () => {
  it('preserves legacy success, decline and unknown attempts with their original charge and cash allocations', async () => {
    const database = await legacyDatabase()
    legacyAttempt(database, 'success', 'success')
    legacyAttempt(database, 'declined', 'declined')
    legacyAttempt(database, 'unknown', 'ambiguous')
    const original = originalAttempts(database)
    const originalCharges = database.driver.prepare('SELECT * FROM charge_record ORDER BY charge_id').all()

    expect(applyMigrations(database).applied).toEqual([
      migration,
      '0072_inpatient-surgery.sql',
      '0072_model-usage-control.sql',
      '0072_payment-history-pagination.sql',
      '0073_inpatient-discharge.sql',
      '0073_model-task-recovery.sql',
      '0074_host-model-waiting.sql',
      '0074_inpatient-record.sql',
      '0075_model-usage-dimensions.sql',
      '0076_model-usage-retention.sql',
      '0077_model-usage-token-breakdown.sql',
      '0078_inpatient-material-reservation.sql',
      '0078_model-task-invalid-code.sql',
      '0079_doctor-consideration-disposition.sql',
      '0080_inpatient-record-archive-drg.sql',
      '0081_inpatient-drg-payer-review.sql',
      '0082_practitioner-role-medical-insurance.sql',
    ])

    expect(originalAttempts(database)).toEqual(original)
    expect(database.driver.prepare('SELECT * FROM charge_record ORDER BY charge_id').all()).toEqual(originalCharges)
    const ledger = new PaymentLedger(database)
    for (const [name, outcome] of [
      ['success', 'success'], ['declined', 'declined'], ['unknown', 'ambiguous'],
    ] as const) {
      expect(ledger.attempts(context, `case-${name}`).items).toEqual([{
        amountFen: 6800,
        chargeItemId: `item-${name}`,
        correlationId: `sim-payment-${name}`,
        createdAt,
        initialOutcome: outcome,
        outcome,
        paymentId: `payment-${name}`,
        previewId: `preview-${name}`,
        resolvedAt: null,
        tenders: [{ amountFen: 6800, method: 'cash' }],
        version: 1,
      }])
    }
    expect(ledger.balance(context, 'item-success')).toEqual({ paidFen: 6800, unresolved: 0 })
    expect(ledger.balance(context, 'item-declined')).toEqual({ paidFen: 0, unresolved: 0 })
    expect(ledger.balance(context, 'item-unknown')).toEqual({ paidFen: 0, unresolved: 1 })
    expect(database.driver.prepare('SELECT * FROM payment_resolution').all()).toEqual([])
    expect(database.driver.prepare(`
      SELECT DISTINCT recovery_outcome FROM payment_transaction
    `).all()).toEqual([{ recovery_outcome: 'ambiguous' }])

    const migratedHash = canonicalStateHash(database)
    expect(applyMigrations(database).applied).toEqual([])
    expect(canonicalStateHash(database)).toBe(migratedHash)
  })

  it('keeps a historical zero amount attempt readable without inventing a positive cash payment', async () => {
    const database = await legacyDatabase()
    legacyAttempt(database, 'zero', 'success', 0)

    applyMigrations(database)

    const ledger = new PaymentLedger(database)
    expect(ledger.attempts(context, 'case-zero').items).toEqual([{
      amountFen: 0,
      chargeItemId: 'item-zero',
      correlationId: 'sim-payment-zero',
      createdAt,
      initialOutcome: 'success',
      outcome: 'success',
      paymentId: 'payment-zero',
      previewId: 'preview-zero',
      resolvedAt: null,
      tenders: [{ amountFen: 0, method: 'cash' }],
      version: 1,
    }])
    expect(ledger.balance(context, 'item-zero')).toEqual({ paidFen: 0, unresolved: 0 })
    expect(database.driver.prepare('SELECT * FROM payment_resolution').all()).toEqual([])
  })

  it.each(['missing', 'multiple'] as const)(
    'rolls back the complete migration when a legacy attempt has %s charge matches',
    async (matching) => {
      const database = await legacyDatabase()
      legacyAttempt(database, 'valid', 'success')
      legacyAttempt(database, 'invalid', 'ambiguous')
      if (matching === 'missing') {
        database.driver.prepare("DELETE FROM charge_record WHERE charge_item_id = 'item-invalid'").run()
      } else {
        database.driver.prepare(`
          INSERT INTO charge_record (
            workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
            category, source_reference, description_zh, description_en, quantity,
            unit_price_fen, total_fen, status, created_at
          ) VALUES (?, ?, 'duplicate-charge', 'case-invalid', 'account-invalid',
            'duplicate-item', 'laboratory', 'ServiceRequest/duplicate',
            '合成检验', 'Synthetic laboratory', 1, 6800, 6800, 'billable', ?)
        `).run(context.workspaceId, context.epoch, createdAt)
      }
      const originalHash = canonicalStateHash(database)
      const original = originalAttempts(database)
      const previousSchemaVersion = database.diagnostics().schemaVersion

      expect(() => applyMigrations(database)).toThrow()

      expect(database.diagnostics().schemaVersion).toBe(previousSchemaVersion)
      expect(canonicalStateHash(database)).toBe(originalHash)
      expect(originalAttempts(database)).toEqual(original)
      expect(database.driver.prepare(`
        SELECT name FROM sqlite_schema WHERE name IN (
          'payment_allocation', 'payment_tender', 'payment_resolution', 'payment_migration_guard'
        )
      `).all()).toEqual([])
      expect(database.driver.prepare('PRAGMA table_info(payment_transaction)').all()).not.toContainEqual(
        expect.objectContaining({ name: 'recovery_outcome' }),
      )
      expect(database.driver.prepare('PRAGMA table_info(payment_preview)').all()).not.toContainEqual(
        expect.objectContaining({ name: 'tenders_json' }),
      )
      expect(database.driver.prepare('SELECT 1 FROM schema_migration WHERE migration_id = ?').get(migration)).toBeUndefined()
    },
  )
})
