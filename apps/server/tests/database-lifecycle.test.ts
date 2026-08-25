import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runDatabaseCli } from '../src/database-cli.ts'
import {
  applyMigrations,
  backupDatabase,
  canonicalStateHash,
  openClinMeshDatabase,
  rebuildDatabaseIndexes,
  restoreDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

describe('SQLite lifecycle', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('opens a configured file with the required safety settings and stable migrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-sqlite-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')

    const first = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    const firstMigration = applyMigrations(first)

    expect(first.diagnostics()).toEqual({
      busyTimeoutMs: 5_000,
      foreignKeys: true,
      integrity: 'ok',
      journalMode: 'wal',
      schemaVersion: 19,
    })
    expect(firstMigration).toEqual({
      applied: [
        '0000_foundation.sql',
        '0001_identity.sql',
        '0002_scenario.sql',
        '0003_outpatient-workflow.sql',
        '0004_clinical-signing.sql',
        '0005_partial-dispensing.sql',
        '0006_queue-pagination.sql',
        '0007_prescription-review.sql',
        '0008_virtual-patient-intake.sql',
        '0009_consultation-record.sql',
        '0010_consultation-question-backfill.sql',
        '0011_structured-clinical-document.sql',
        '0012_structured-clinical-document-preview-binding.sql',
        '0013_laboratory-request-lifecycle.sql',
        '0014_laboratory-report.sql',
        '0015_laboratory-report-acknowledgement.sql',
        '0016_laboratory-report-revision.sql',
        '0017_diagnosis-draft.sql',
        '0018_prescription-conclusion.sql',
      ],
      schemaVersion: 19,
    })
    first.close()

    const reopened = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    expect(applyMigrations(reopened)).toEqual({ applied: [], schemaVersion: 19 })
    expect(reopened.diagnostics().schemaVersion).toBe(19)
    reopened.close()
  })

  it('preserves existing outpatient cases while adding Virtual Patient consultation state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-virtual-patient-migration-'))
    temporaryDirectories.push(directory)
    const legacyMigrationDirectory = join(directory, 'legacy-migrations')
    await mkdir(legacyMigrationDirectory)
    for (const migration of [
      '0000_foundation.sql',
      '0001_identity.sql',
      '0002_scenario.sql',
      '0003_outpatient-workflow.sql',
      '0004_clinical-signing.sql',
      '0005_partial-dispensing.sql',
      '0006_queue-pagination.sql',
      '0007_prescription-review.sql',
    ]) {
      await copyFile(join(process.cwd(), 'drizzle', migration), join(legacyMigrationDirectory, migration))
    }
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    expect(applyMigrations(database, legacyMigrationDirectory).schemaVersion).toBe(8)
    const context = { epoch: 'epoch-legacy', workspaceId: 'workspace-legacy' }
    database.driver.prepare(`
      INSERT INTO scenario_definition (
        scenario_id, version, kind, schema_version, clinical_review_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run('candidate-fever-outpatient-v1', '1.0.0', 'candidate', '1', null)
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'candidate-fever-outpatient-v1',
      scenarioRunId: 'run-legacy',
      workspaceName: '合成升级工作区',
    })
    database.driver.prepare(`
      INSERT INTO scenario_epoch_state (
        workspace_id, epoch, scenario_run_id, scenario_id,
        deterministic_seed, virtual_time, initial_state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'run-legacy',
      'candidate-fever-outpatient-v1',
      20260824,
      '2026-08-24T09:00:00+08:00',
      'legacy-state',
    )
    database.driver.prepare(`
      INSERT INTO scenario_hidden_fact (
        workspace_id, epoch, fact_code, value_json
      ) VALUES (?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'respiratory-pathogen',
      JSON.stringify({ code: 'influenza-a', detected: true }),
    )
    database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en,
        price_fen, version, active, config_json
      ) VALUES (?, ?, ?, 'department', ?, ?, ?, 0, 1, 1, '{}')
    `).run(
      context.workspaceId,
      context.epoch,
      'department-legacy',
      'LEGACY',
      '合成升级科室',
      'Synthetic upgrade department',
    )
    database.driver.prepare(`
      INSERT INTO outpatient_case (
        workspace_id, epoch, case_id, scenario_run_id, patient_id,
        registration_id, encounter_id, account_id, department_id, location_id,
        triage_task_id, status, arrived_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-triage', ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'case-legacy',
      'run-legacy',
      'patient-legacy',
      'registration-legacy',
      'encounter-legacy',
      'account-legacy',
      'department-legacy',
      'location-legacy',
      'task-triage-legacy',
      '2026-08-24T09:00:00+08:00',
      '2026-08-24T09:00:00+08:00',
    )

    await copyFile(
      join(process.cwd(), 'drizzle', '0008_virtual-patient-intake.sql'),
      join(legacyMigrationDirectory, '0008_virtual-patient-intake.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0008_virtual-patient-intake.sql'],
      schemaVersion: 9,
    })
    const caseColumns = database.driver.prepare('PRAGMA table_info(outpatient_case)').all() as Array<{
      name: string
    }>
    expect(caseColumns.map(column => column.name)).toContain('initial_task_id')
    expect(caseColumns.map(column => column.name)).not.toContain('triage_task_id')
    const virtualPatientColumns = database.driver.prepare('PRAGMA table_info(virtual_patient)').all() as Array<{
      name: string
    }>
    expect(virtualPatientColumns.map(column => column.name)).toEqual([
      'workspace_id',
      'epoch',
      'virtual_patient_id',
      'version',
      'patient_id',
      'clinical_summary_json',
      'available',
    ])
    expect(database.driver.prepare(`
      SELECT case_id, initial_task_id, status FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ?
    `).get(context.workspaceId, context.epoch)).toEqual({
      case_id: 'case-legacy',
      initial_task_id: 'task-triage-legacy',
      status: 'awaiting-triage',
    })
    database.driver.prepare(`
      INSERT INTO virtual_patient (
        workspace_id, epoch, virtual_patient_id, version, patient_id,
        clinical_summary_json, available
      ) VALUES (?, ?, ?, 1, ?, ?, 1)
    `).run(
      context.workspaceId,
      context.epoch,
      'virtual-patient-fever-001',
      'patient-legacy',
      JSON.stringify({
        chiefComplaint: '发热 1 天。',
        summary: '合成升级摘要。',
        vitalSigns: {
          bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
          oxygenSaturationPct: 98,
          pulseBpm: 96,
          respirationBpm: 20,
          temperatureC: 38.6,
        },
      }),
    )
    database.driver.prepare(`
      INSERT INTO virtual_patient_case (
        workspace_id, epoch, virtual_patient_id, case_id
      ) VALUES (?, ?, ?, ?)
    `).run(context.workspaceId, context.epoch, 'virtual-patient-fever-001', 'case-legacy')
    database.driver.prepare(`
      INSERT INTO virtual_patient (
        workspace_id, epoch, virtual_patient_id, version, patient_id,
        clinical_summary_json, available
      ) SELECT workspace_id, epoch, ?, version, ?, clinical_summary_json, available
      FROM virtual_patient
      WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
    `).run(
      'virtual-patient-second',
      'patient-second',
      context.workspaceId,
      context.epoch,
      'virtual-patient-fever-001',
    )
    expect(() => database.driver.prepare(`
      INSERT INTO virtual_patient_case (
        workspace_id, epoch, virtual_patient_id, case_id
      ) VALUES (?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'virtual-patient-second',
      'case-legacy',
    )).toThrow(/UNIQUE constraint failed/)
    expect(() => database.driver.prepare(`
      INSERT INTO virtual_patient_case (
        workspace_id, epoch, virtual_patient_id, case_id
      ) VALUES (?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'virtual-patient-second',
      'case-missing',
    )).toThrow(/FOREIGN KEY constraint failed/)

    await copyFile(
      join(process.cwd(), 'drizzle', '0009_consultation-record.sql'),
      join(legacyMigrationDirectory, '0009_consultation-record.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0009_consultation-record.sql'],
      schemaVersion: 10,
    })
    expect(database.driver.prepare(`
      SELECT case_id, version FROM consultation
      WHERE workspace_id = ? AND epoch = ?
    `).all(context.workspaceId, context.epoch)).toEqual([{
      case_id: 'case-legacy',
      version: 1,
    }])
    const expectedQuestionRules = [{
      answer_text: '昨天傍晚开始发热，最高量到 38.7 °C。',
      fact_code: null,
      ordinal: 1,
      question_code: 'symptom-onset',
      question_text: '什么时候开始发热？',
      revealed_answer_text: null,
      rule_version: 1,
    }, {
      answer_text: '咽痛，吞咽时更明显，没有气促。',
      fact_code: null,
      ordinal: 2,
      question_code: 'associated-symptoms',
      question_text: '除了发热，还有哪里不舒服？',
      revealed_answer_text: null,
      rule_version: 1,
    }, {
      answer_text: '目前还不知道，需要等检查结果。',
      fact_code: 'respiratory-pathogen',
      ordinal: 3,
      question_code: 'infection-cause',
      question_text: '知道是什么感染引起的吗？',
      revealed_answer_text: '检验结果显示是甲型流感病毒感染。',
      rule_version: 1,
    }]
    const readQuestionRules = (ruleContext: typeof context) => database.driver.prepare(`
      SELECT question_code, ordinal, question_text, answer_text,
        fact_code, revealed_answer_text, rule_version
      FROM virtual_patient_question_rule
      WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
      ORDER BY ordinal
    `).all(
      ruleContext.workspaceId,
      ruleContext.epoch,
      'virtual-patient-fever-001',
    )
    expect(readQuestionRules(context)).toEqual([])

    const seededContext = { epoch: 'epoch-checkpoint', workspaceId: 'workspace-checkpoint' }
    new WorkspaceRepository(database).install({
      ...seededContext,
      scenarioId: 'candidate-fever-outpatient-v1',
      scenarioRunId: 'run-checkpoint',
      workspaceName: '合成 Checkpoint 工作区',
    })
    database.driver.prepare(`
      INSERT INTO scenario_epoch_state (
        workspace_id, epoch, scenario_run_id, scenario_id,
        deterministic_seed, virtual_time, initial_state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      seededContext.workspaceId,
      seededContext.epoch,
      'run-checkpoint',
      'candidate-fever-outpatient-v1',
      20260824,
      '2026-08-24T09:00:00+08:00',
      'checkpoint-state',
    )
    database.driver.prepare(`
      INSERT INTO scenario_hidden_fact (
        workspace_id, epoch, fact_code, value_json
      ) VALUES (?, ?, ?, ?)
    `).run(
      seededContext.workspaceId,
      seededContext.epoch,
      'respiratory-pathogen',
      JSON.stringify({ code: 'influenza-a', detected: true }),
    )
    database.driver.prepare(`
      INSERT INTO virtual_patient (
        workspace_id, epoch, virtual_patient_id, version, patient_id,
        clinical_summary_json, available
      ) SELECT ?, ?, virtual_patient_id, version, ?, clinical_summary_json, available
      FROM virtual_patient
      WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
    `).run(
      seededContext.workspaceId,
      seededContext.epoch,
      'patient-checkpoint',
      context.workspaceId,
      context.epoch,
      'virtual-patient-fever-001',
    )
    const insertQuestionRule = database.driver.prepare(`
      INSERT INTO virtual_patient_question_rule (
        workspace_id, epoch, virtual_patient_id, question_code,
        rule_version, ordinal, question_text, answer_text,
        fact_code, revealed_answer_text
      ) VALUES (?, ?, 'virtual-patient-fever-001', ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const question of expectedQuestionRules) {
      insertQuestionRule.run(
        seededContext.workspaceId,
        seededContext.epoch,
        question.question_code,
        question.rule_version,
        question.ordinal,
        question.question_text,
        question.answer_text,
        question.fact_code,
        question.revealed_answer_text,
      )
    }
    expect(readQuestionRules(seededContext)).toEqual(expectedQuestionRules)

    await copyFile(
      join(process.cwd(), 'drizzle', '0010_consultation-question-backfill.sql'),
      join(legacyMigrationDirectory, '0010_consultation-question-backfill.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0010_consultation-question-backfill.sql'],
      schemaVersion: 11,
    })
    expect(readQuestionRules(context)).toEqual(expectedQuestionRules)
    expect(readQuestionRules(seededContext)).toEqual(expectedQuestionRules)
    database.driver.prepare(`
      INSERT INTO signed_clinical_document (
        workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
        provenance_id, signed_by, signed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'document-legacy-root',
      'case-legacy',
      'composition-legacy-root',
      'bundle-legacy-root',
      'provenance-legacy-root',
      'actor-legacy-doctor',
      '2026-08-24T09:00:00+08:00',
    )
    await copyFile(
      join(process.cwd(), 'drizzle', '0011_structured-clinical-document.sql'),
      join(legacyMigrationDirectory, '0011_structured-clinical-document.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0011_structured-clinical-document.sql'],
      schemaVersion: 12,
    })
    expect(database.driver.prepare('PRAGMA table_info(clinical_document_draft)').all()).toHaveLength(7)
    expect(database.driver.prepare('PRAGMA table_info(clinical_document_sign_preview)').all()).toHaveLength(9)
    database.driver.prepare(`
      INSERT INTO clinical_document_sign_preview (
        workspace_id, epoch, preview_id, case_id, draft_version,
        summary_json, token_hash, expires_at
      ) VALUES (?, ?, ?, ?, 1, '{}', ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'preview-before-context-binding',
      'case-legacy',
      'legacy-token-hash',
      '2026-08-24T09:05:00+08:00',
    )
    await copyFile(
      join(process.cwd(), 'drizzle', '0012_structured-clinical-document-preview-binding.sql'),
      join(legacyMigrationDirectory, '0012_structured-clinical-document-preview-binding.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0012_structured-clinical-document-preview-binding.sql'],
      schemaVersion: 13,
    })
    expect(database.driver.prepare('PRAGMA table_info(clinical_document_sign_preview)').all()).toHaveLength(11)
    expect(database.driver.prepare(`
      SELECT actor_context_hash, encounter_version
      FROM clinical_document_sign_preview
      WHERE workspace_id = ? AND epoch = ? AND preview_id = ?
    `).get(
      context.workspaceId,
      context.epoch,
      'preview-before-context-binding',
    )).toEqual({ actor_context_hash: '', encounter_version: '' })
    await copyFile(
      join(process.cwd(), 'drizzle', '0013_laboratory-request-lifecycle.sql'),
      join(legacyMigrationDirectory, '0013_laboratory-request-lifecycle.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0013_laboratory-request-lifecycle.sql'],
      schemaVersion: 14,
    })
    expect(database.driver.prepare(`
      SELECT item_id FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND item_id IN ('lab-cbc', 'lab-crp')
      ORDER BY item_id
    `).all(context.workspaceId, context.epoch)).toEqual([
      { item_id: 'lab-cbc' },
      { item_id: 'lab-crp' },
    ])
    expect(database.driver.prepare('PRAGMA table_info(laboratory_request_state)').all()).toHaveLength(8)
    expect(database.driver.prepare('PRAGMA table_info(laboratory_request)').all()).toHaveLength(17)
    expect(() => database.driver.prepare(`
      INSERT INTO laboratory_request_state (
        workspace_id, epoch, case_id, version, draft_catalog_item_id,
        updated_by, updated_at
      ) VALUES (?, ?, ?, 1, 'lab-cbc', ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'case-legacy',
      'actor-legacy-doctor',
      '2026-08-24T09:00:00+08:00',
    )).toThrow(/CHECK constraint failed/)
    expect(() => database.driver.prepare(`
      INSERT INTO signed_clinical_document (
        workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
        provenance_id, signed_by, signed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'document-second-root',
      'case-legacy',
      'composition-second-root',
      'bundle-second-root',
      'provenance-second-root',
      'actor-legacy-doctor',
      '2026-08-24T09:01:00+08:00',
    )).toThrow(/UNIQUE constraint failed/)
    expect(database.driver.prepare(`
      INSERT INTO signed_clinical_document (
        workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
        provenance_id, revision_of_document_id, signed_by, signed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'document-legacy-revision',
      'case-legacy',
      'composition-legacy-revision',
      'bundle-legacy-revision',
      'provenance-legacy-revision',
      'document-legacy-root',
      'actor-legacy-doctor',
      '2026-08-24T09:02:00+08:00',
    ).changes).toBe(1)
    const consultationRecordColumns = database.driver.prepare(
      'PRAGMA table_info(consultation_record)',
    ).all() as Array<{ name: string }>
    expect(consultationRecordColumns.map(column => column.name)).toEqual([
      'workspace_id',
      'epoch',
      'record_id',
      'case_id',
      'sequence',
      'question_code',
      'question_text',
      'answer_text',
      'rule_version',
      'asked_by_actor_id',
      'asked_by_practitioner_id',
      'recorded_at',
    ])
    await copyFile(
      join(process.cwd(), 'drizzle', '0014_laboratory-report.sql'),
      join(legacyMigrationDirectory, '0014_laboratory-report.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0014_laboratory-report.sql'],
      schemaVersion: 15,
    })
    expect((database.driver.prepare(
      'PRAGMA table_info(laboratory_request)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toContain(
      'diagnostic_report_id',
    )
    for (const migration of [
      '0015_laboratory-report-acknowledgement.sql',
      '0016_laboratory-report-revision.sql',
      '0017_diagnosis-draft.sql',
    ]) {
      await copyFile(
        join(process.cwd(), 'drizzle', migration),
        join(legacyMigrationDirectory, migration),
      )
    }
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: [
        '0015_laboratory-report-acknowledgement.sql',
        '0016_laboratory-report-revision.sql',
        '0017_diagnosis-draft.sql',
      ],
      schemaVersion: 18,
    })
    expect((database.driver.prepare(
      'PRAGMA table_info(laboratory_report_acknowledgement)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toContain(
      'request_version',
    )
    expect((database.driver.prepare(
      'PRAGMA table_info(laboratory_report_revision)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toContain(
      'revision_of_diagnostic_report_id',
    )
    expect((database.driver.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'diagnosis_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)).toEqual([
      'diagnosis_catalog',
      'diagnosis_confirmation',
      'diagnosis_entry',
      'diagnosis_state',
    ])
    expect(database.driver.prepare(`
      SELECT item_id, code FROM diagnosis_catalog
      WHERE workspace_id = ? AND epoch = ?
      ORDER BY item_id
    `).all(context.workspaceId, context.epoch)).toEqual([
      { code: 'J06.9', item_id: 'diagnosis-acute-upper-respiratory-infection' },
      { code: 'R50.9', item_id: 'diagnosis-fever' },
      { code: 'J10.1', item_id: 'diagnosis-influenza' },
    ])
    expect(() => database.driver.prepare(`
      INSERT INTO diagnosis_state (
        workspace_id, epoch, case_id, version, status, draft_json,
        updated_by, updated_at
      ) VALUES (?, ?, ?, 1, 'confirmed', ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'case-legacy',
      JSON.stringify({ entries: [] }),
      'actor-legacy-doctor',
      '2026-08-24T09:03:00+08:00',
    )).toThrow(/CHECK constraint failed/)
    database.driver.prepare(`
      INSERT INTO diagnosis_state (
        workspace_id, epoch, case_id, version, status, draft_json,
        updated_by, updated_at
      ) VALUES (?, ?, ?, 2, 'confirmed', NULL, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'case-legacy',
      'actor-legacy-doctor',
      '2026-08-24T09:03:00+08:00',
    )
    const insertDiagnosisConfirmation = database.driver.prepare(`
      INSERT INTO diagnosis_confirmation (
        workspace_id, epoch, confirmation_id, case_id, provenance_id,
        confirmed_by_actor_id, confirmed_by_practitioner_role_id, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    expect(() => insertDiagnosisConfirmation.run(
      context.workspaceId,
      context.epoch,
      'confirmation-missing-provenance',
      'case-legacy',
      'provenance-missing',
      'actor-legacy-doctor',
      'role-legacy-doctor',
      '2026-08-24T09:03:00+08:00',
    )).toThrow(/FOREIGN KEY constraint failed/)
    const insertFhirResource = database.driver.prepare(`
      INSERT INTO fhir_resource (
        workspace_id, epoch, resource_type, resource_id, version_id,
        last_updated, owner_kind, content_json, content_hash
      ) VALUES (?, ?, ?, ?, 1, ?, 'his-command', ?, ?)
    `)
    for (const [resourceType, resourceId] of [
      ['Provenance', 'provenance-diagnosis-legacy'],
      ['Condition', 'condition-legacy-primary'],
      ['Condition', 'condition-legacy-second-primary'],
    ]) {
      insertFhirResource.run(
        context.workspaceId,
        context.epoch,
        resourceType,
        resourceId,
        '2026-08-24T09:03:00+08:00',
        JSON.stringify({ id: resourceId, resourceType }),
        `hash-${resourceId}`,
      )
    }
    insertDiagnosisConfirmation.run(
      context.workspaceId,
      context.epoch,
      'confirmation-legacy',
      'case-legacy',
      'provenance-diagnosis-legacy',
      'actor-legacy-doctor',
      'role-legacy-doctor',
      '2026-08-24T09:03:00+08:00',
    )
    const insertDiagnosisEntry = database.driver.prepare(`
      INSERT INTO diagnosis_entry (
        workspace_id, epoch, confirmation_id, ordinal,
        condition_id, catalog_item_id, role
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    expect(() => insertDiagnosisEntry.run(
      context.workspaceId,
      context.epoch,
      'confirmation-legacy',
      1,
      'condition-missing',
      'diagnosis-influenza',
      'primary',
    )).toThrow(/FOREIGN KEY constraint failed/)
    insertDiagnosisEntry.run(
      context.workspaceId,
      context.epoch,
      'confirmation-legacy',
      1,
      'condition-legacy-primary',
      'diagnosis-influenza',
      'primary',
    )
    expect(() => insertDiagnosisEntry.run(
      context.workspaceId,
      context.epoch,
      'confirmation-legacy',
      2,
      'condition-legacy-second-primary',
      'diagnosis-fever',
      'primary',
    )).toThrow(/UNIQUE constraint failed/)
    expect(database.driver.prepare(`
      SELECT value_json FROM scenario_hidden_fact
      WHERE workspace_id = ? AND epoch = ? AND fact_code = 'laboratory-results'
    `).get(context.workspaceId, context.epoch)).toBeUndefined()
    const insertMedicationCatalog = database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en,
        price_fen, version, active, config_json
      ) VALUES (?, ?, ?, 'medication', ?, ?, ?, ?, 1, 1, ?)
    `)
    const legacyOseltamivirConfig = '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"]}'
    const legacyAcetaminophenConfig = '{"dose":"0.5 g","frequency":"PRN","allowedDoseTexts":["0.5 g"],"allowedFrequencyCodes":["PRN"],"allowedCombinationIds":["medication-oseltamivir"]}'
    insertMedicationCatalog.run(
      context.workspaceId,
      context.epoch,
      'medication-oseltamivir',
      'OSELTAMIVIR',
      '磷酸奥司他韦胶囊',
      'Oseltamivir phosphate capsules',
      760,
      legacyOseltamivirConfig,
    )
    insertMedicationCatalog.run(
      context.workspaceId,
      context.epoch,
      'medication-acetaminophen',
      'ACETAMINOPHEN',
      '对乙酰氨基酚片',
      'Acetaminophen tablets',
      120,
      legacyAcetaminophenConfig,
    )
    database.driver.prepare(`
      INSERT INTO user (
        id, name, email, email_verified, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
    `).run(
      'user-legacy-doctor',
      '合成升级医生',
      'legacy-doctor@example.invalid',
      1,
      1,
    )
    database.driver.prepare(`
      INSERT INTO workspace_membership (
        membership_id, workspace_id, user_id, actor_id, status, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).run(
      'membership-legacy-doctor',
      context.workspaceId,
      'user-legacy-doctor',
      'actor-legacy-doctor',
      '2026-08-24T09:00:00+08:00',
    )
    database.driver.prepare(`
      INSERT INTO practitioner_role_binding (
        workspace_id, practitioner_role_id, practitioner_id, role_code,
        organization_id, location_id, active
      ) VALUES (?, ?, ?, 'outpatient-doctor', ?, ?, 1)
    `).run(
      context.workspaceId,
      'role-legacy-doctor',
      'practitioner-legacy-doctor',
      'organization-legacy',
      'location-legacy',
    )
    await copyFile(
      join(process.cwd(), 'drizzle', '0018_prescription-conclusion.sql'),
      join(legacyMigrationDirectory, '0018_prescription-conclusion.sql'),
    )
    expect(applyMigrations(database, legacyMigrationDirectory)).toEqual({
      applied: ['0018_prescription-conclusion.sql'],
      schemaVersion: 19,
    })
    expect((database.driver.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'no_medication_conclusion',
        'prescription_authorship',
        'prescription_draft_state',
        'prescription_withdrawal'
      )
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)).toEqual([
      'no_medication_conclusion',
      'prescription_authorship',
      'prescription_draft_state',
      'prescription_withdrawal',
    ])
    expect((database.driver.prepare(
      'PRAGMA table_info(prescription)',
    ).all() as Array<{ name: string }>).map(column => column.name)).not.toContain(
      'authored_by_practitioner_role_id',
    )
    expect((database.driver.prepare(
      'PRAGMA table_info(prescription_item)',
    ).all() as Array<{ name: string }>).map(column => column.name)).toContain(
      'course_days',
    )
    database.driver.prepare(`
      INSERT INTO prescription (
        workspace_id, epoch, prescription_id, case_id, prescription_number,
        status, version, authored_by, authored_at, signed_at
      ) VALUES (?, ?, ?, ?, ?, 'signed', 1, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'prescription-v19-identity-check',
      'case-legacy',
      'CM-RX-IDENTITY-CHECK',
      'actor-legacy-doctor',
      '2026-08-24T09:04:00+08:00',
      '2026-08-24T09:04:00+08:00',
    )
    expect(() => database.driver.prepare(`
      INSERT INTO prescription_draft_state (
        workspace_id, epoch, case_id, version, draft_json, updated_by, updated_at
      ) VALUES (?, ?, ?, 1, NULL, 'actor-missing', ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'case-legacy',
      '2026-08-24T09:04:00+08:00',
    )).toThrow(/FOREIGN KEY constraint failed/)
    const insertPrescriptionAuthorship = database.driver.prepare(`
      INSERT INTO prescription_authorship (
        workspace_id, epoch, prescription_id,
        authored_by_actor_id, authored_by_practitioner_role_id
      ) VALUES (?, ?, ?, ?, ?)
    `)
    expect(() => insertPrescriptionAuthorship.run(
      context.workspaceId,
      context.epoch,
      'prescription-v19-identity-check',
      'actor-missing',
      'role-legacy-doctor',
    )).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => insertPrescriptionAuthorship.run(
      context.workspaceId,
      context.epoch,
      'prescription-v19-identity-check',
      'actor-legacy-doctor',
      'role-missing',
    )).toThrow(/FOREIGN KEY constraint failed/)
    const insertNoMedicationConclusion = database.driver.prepare(`
      INSERT INTO no_medication_conclusion (
        workspace_id, epoch, conclusion_id, case_id, version,
        authored_by_actor_id, authored_by_practitioner_role_id, authored_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `)
    expect(() => insertNoMedicationConclusion.run(
      context.workspaceId,
      context.epoch,
      'no-medication-v19-invalid-actor',
      'case-legacy',
      'actor-missing',
      'role-legacy-doctor',
      '2026-08-24T09:04:00+08:00',
    )).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => insertNoMedicationConclusion.run(
      context.workspaceId,
      context.epoch,
      'no-medication-v19-invalid-role',
      'case-legacy',
      'actor-legacy-doctor',
      'role-missing',
      '2026-08-24T09:04:00+08:00',
    )).toThrow(/FOREIGN KEY constraint failed/)
    const insertPrescriptionWithdrawal = database.driver.prepare(`
      INSERT INTO prescription_withdrawal (
        workspace_id, epoch, withdrawal_id, prescription_id, version,
        withdrawn_by_actor_id, withdrawn_by_practitioner_role_id, withdrawn_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `)
    expect(() => insertPrescriptionWithdrawal.run(
      context.workspaceId,
      context.epoch,
      'withdrawal-v19-invalid-actor',
      'prescription-v19-identity-check',
      'actor-missing',
      'role-legacy-doctor',
      '2026-08-24T09:04:00+08:00',
    )).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => insertPrescriptionWithdrawal.run(
      context.workspaceId,
      context.epoch,
      'withdrawal-v19-invalid-role',
      'prescription-v19-identity-check',
      'actor-legacy-doctor',
      'role-missing',
      '2026-08-24T09:04:00+08:00',
    )).toThrow(/FOREIGN KEY constraint failed/)
    expect(database.driver.prepare(`
      SELECT item_id, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND kind = 'medication'
      ORDER BY item_id
    `).all(context.workspaceId, context.epoch)).toEqual([
      {
        config_json: legacyAcetaminophenConfig,
        item_id: 'medication-acetaminophen',
      },
      {
        config_json: legacyOseltamivirConfig,
        item_id: 'medication-oseltamivir',
      },
    ])
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
    expect(database.driver.pragma('integrity_check', { simple: true })).toBe('ok')
    database.close()
  })

  it('requires migrations to be applied explicitly before verified runtime startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-explicit-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const options = {
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath,
      demoPassword: `Test-${crypto.randomUUID()}-Aa1!`,
      migrationMode: 'verify' as const,
      trustedOrigins: ['http://localhost'],
    }

    await expect(createClinMeshRuntime(options)).rejects.toThrow('Pending database migrations')
    const unmigrated = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    expect(unmigrated.diagnostics().schemaVersion).toBe(0)
    applyMigrations(unmigrated)
    unmigrated.close()

    const runtime = await createClinMeshRuntime(options)
    expect(runtime.database.diagnostics().schemaVersion).toBe(19)
    await runtime.close()
  })

  it('restores a consistent backup to a new path without changing the active database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-backup-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'active.sqlite')
    const backupPath = join(directory, 'backup.sqlite')
    const restoredPath = join(directory, 'restored.sqlite')
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    applyMigrations(database)
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'backup-contract',
      scenarioRunId: 'run-001',
      workspaceName: '合成备份工作区',
    })
    const hashBeforeDomainFacts = canonicalStateHash(database)
    database.driver.prepare(`
      INSERT INTO scenario_definition (
        scenario_id, version, kind, schema_version, clinical_review_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run('backup-contract', '1.0.0', 'candidate', '1', null)
    database.driver.prepare(`
      INSERT INTO scenario_epoch_state (
        workspace_id, epoch, scenario_run_id, scenario_id,
        deterministic_seed, virtual_time, initial_state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'run-001',
      'backup-contract',
      20260824,
      '2026-08-24T09:00:00+08:00',
      'synthetic-initial-state',
    )
    database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en,
        price_fen, version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'synthetic-service',
      'laboratory',
      'SYN-LAB',
      '合成检验服务',
      'Synthetic laboratory service',
      2500,
      1,
      1,
      '{}',
    )
    expect(canonicalStateHash(database)).not.toBe(hashBeforeDomainFacts)
    const repository = new FhirRepository(database, {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    repository.create(context, {
      resourceType: 'Patient',
      id: 'patient-backup',
      name: [{ text: '备份版本' }],
    })
    const expectedHash = canonicalStateHash(database)

    expect(await backupDatabase(database, backupPath)).toMatchObject({
      canonicalStateHash: expectedHash,
      schemaVersion: 19,
    })
    repository.update(context, {
      resourceType: 'Patient',
      id: 'patient-backup',
      name: [{ text: '活动库后续版本' }],
    }, '1')

    expect(await restoreDatabase({
      backupPath,
      busyTimeoutMs: 5_000,
      destinationPath: restoredPath,
      expectedSchemaVersion: 19,
    })).toMatchObject({
      canonicalStateHash: expectedHash,
      integrity: 'ok',
      schemaVersion: 19,
    })

    const restored = openClinMeshDatabase({ databasePath: restoredPath, busyTimeoutMs: 5_000 })
    expect(new FhirRepository(restored).read(context, 'Patient', 'patient-backup')).toMatchObject({
      meta: { versionId: '1' },
      name: [{ text: '备份版本' }],
    })
    expect(repository.read(context, 'Patient', 'patient-backup')).toMatchObject({
      meta: { versionId: '2' },
      name: [{ text: '活动库后续版本' }],
    })
    restored.close()
    database.close()
  })

  it('rejects a corrupt restore candidate without creating the destination or changing the active database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-corrupt-restore-'))
    temporaryDirectories.push(directory)
    const activePath = join(directory, 'active.sqlite')
    const corruptPath = join(directory, 'corrupt.sqlite')
    const destinationPath = join(directory, 'restored.sqlite')
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    const database = openClinMeshDatabase({ databasePath: activePath, busyTimeoutMs: 5_000 })
    applyMigrations(database)
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'restore-failure-contract',
      scenarioRunId: 'run-001',
      workspaceName: '合成恢复失败工作区',
    })
    const repository = new FhirRepository(database)
    repository.create(context, {
      resourceType: 'Patient',
      id: 'patient-active',
      name: [{ text: '活动库合成患者' }],
    })
    await writeFile(corruptPath, 'this is not a SQLite database')

    await expect(restoreDatabase({
      backupPath: corruptPath,
      busyTimeoutMs: 5_000,
      destinationPath,
      expectedSchemaVersion: 9,
    })).rejects.toThrow()
    expect(existsSync(destinationPath)).toBe(false)
    expect(repository.read(context, 'Patient', 'patient-active')).toMatchObject({
      name: [{ text: '活动库合成患者' }],
    })
    database.close()
  })

  it('enforces foreign keys and bounds competing WAL writers by the configured busy timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-sqlite-contention-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const writerA = openClinMeshDatabase({ databasePath, busyTimeoutMs: 25 })
    applyMigrations(writerA)
    const writerB = openClinMeshDatabase({ databasePath, busyTimeoutMs: 25 })
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(writerA).install({
      ...context,
      scenarioId: 'sqlite-contention-contract',
      scenarioRunId: 'run-001',
      workspaceName: '合成并发工作区',
    })

    expect(() => writerA.driver.prepare(`
      INSERT INTO workspace_epoch (
        workspace_id, epoch, state, scenario_id, created_at
      ) VALUES ('missing-workspace', 'epoch-invalid', 'active', 'invalid', ?)
    `).run(new Date().toISOString())).toThrow(/FOREIGN KEY constraint failed/)

    writerA.driver.exec('BEGIN IMMEDIATE')
    writerA.driver.prepare(`
      UPDATE workspace SET name = '写入者甲' WHERE workspace_id = ?
    `).run(context.workspaceId)
    const startedAt = performance.now()
    expect(() => writerB.driver.prepare(`
      UPDATE workspace SET name = '写入者乙' WHERE workspace_id = ?
    `).run(context.workspaceId)).toThrow(/database is locked/)
    expect(performance.now() - startedAt).toBeLessThan(500)
    writerA.driver.exec('ROLLBACK')
    expect(writerB.driver.prepare(`
      UPDATE workspace SET name = '写入者乙' WHERE workspace_id = ?
    `).run(context.workspaceId).changes).toBe(1)
    expect(writerB.diagnostics()).toMatchObject({
      busyTimeoutMs: 25,
      foreignKeys: true,
      journalMode: 'wal',
    })
    writerB.close()
    writerA.close()
  })

  it('rebuilds the role queue indexes and preserves indexed query plans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-index-rebuild-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      databasePath: join(directory, 'clinmesh.sqlite'),
      busyTimeoutMs: 5_000,
    })
    applyMigrations(database)

    const result = rebuildDatabaseIndexes(database)
    expect(result).toMatchObject({ integrity: 'ok' })
    expect(result.indexes).toEqual(expect.arrayContaining([
      'fhir_sp_string_search_idx',
      'outpatient_case_arrival_idx',
      'outpatient_case_status_arrival_idx',
      'outpatient_case_status_updated_idx',
      'charge_record_queue_idx',
    ]))
    const plans = [
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT resource_id FROM fhir_sp_string
        WHERE workspace_id = ? AND epoch = ? AND resource_type = 'Patient'
          AND param = 'name' AND normalized LIKE ?
      `).all('workspace-demo', 'epoch-1', '合成密度%'),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT case_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ?
        ORDER BY arrived_at DESC, case_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 20, 0),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT case_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND status = ?
        ORDER BY arrived_at, case_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 'awaiting-triage', 20, 0),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT case_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND status = ?
        ORDER BY updated_at, case_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 'awaiting-dispense', 20, 0),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT charge_id FROM charge_record
        WHERE workspace_id = ? AND epoch = ? AND category = ? AND status = ?
        ORDER BY created_at, charge_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 'laboratory', 'billable', 20, 0),
    ].flat() as Array<{ detail: string }>
    const details = plans.map(plan => plan.detail).join('\n')
    expect(details).toContain('fhir_sp_string_search_idx')
    expect(details).toContain('outpatient_case_arrival_idx')
    expect(details).toContain('outpatient_case_status_arrival_idx')
    expect(details).toContain('outpatient_case_status_updated_idx')
    expect(details).toContain('charge_record_queue_idx')
    database.close()
  })

  it('runs explicit migrate, verify, backup, and restore operations through the CLI contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-database-cli-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'active.sqlite')
    const backupPath = join(directory, 'backup.sqlite')
    const restoredPath = join(directory, 'restored.sqlite')
    const legacyMigrationDirectory = join(directory, 'legacy-migrations')
    await mkdir(legacyMigrationDirectory)
    for (const migration of [
      '0000_foundation.sql',
      '0001_identity.sql',
      '0002_scenario.sql',
      '0003_outpatient-workflow.sql',
      '0004_clinical-signing.sql',
      '0005_partial-dispensing.sql',
      '0006_queue-pagination.sql',
    ]) {
      await copyFile(join(process.cwd(), 'drizzle', migration), join(legacyMigrationDirectory, migration))
    }
    const legacyDatabase = openClinMeshDatabase({ busyTimeoutMs: 5_000, databasePath })
    applyMigrations(legacyDatabase, legacyMigrationDirectory)
    legacyDatabase.close()

    const migrationResult = z.object({
      applied: z.array(z.string()),
      preMigrationBackup: z.object({
        canonicalStateHash: z.string().regex(/^[a-f0-9]{64}$/),
        path: z.string().min(1),
        schemaVersion: z.literal(7),
      }),
      schemaVersion: z.literal(19),
    }).parse(await runDatabaseCli([
      'migrate',
      '--database',
      databasePath,
    ], {}))
    expect(migrationResult.applied).toEqual([
      '0007_prescription-review.sql',
      '0008_virtual-patient-intake.sql',
      '0009_consultation-record.sql',
      '0010_consultation-question-backfill.sql',
      '0011_structured-clinical-document.sql',
      '0012_structured-clinical-document-preview-binding.sql',
      '0013_laboratory-request-lifecycle.sql',
      '0014_laboratory-report.sql',
      '0015_laboratory-report-acknowledgement.sql',
      '0016_laboratory-report-revision.sql',
      '0017_diagnosis-draft.sql',
      '0018_prescription-conclusion.sql',
    ])
    expect(existsSync(migrationResult.preMigrationBackup.path)).toBe(true)
    await expect(runDatabaseCli([
      'verify',
      '--database',
      databasePath,
    ], {})).resolves.toMatchObject({ integrity: 'ok', schemaVersion: 19 })
    await expect(runDatabaseCli([
      'backup',
      '--database',
      databasePath,
      '--output',
      backupPath,
    ], {})).resolves.toMatchObject({ integrity: 'ok', schemaVersion: 19 })
    await expect(runDatabaseCli([
      'restore',
      '--backup',
      backupPath,
      '--destination',
      restoredPath,
    ], {})).resolves.toMatchObject({ integrity: 'ok', schemaVersion: 19 })
  })
})
