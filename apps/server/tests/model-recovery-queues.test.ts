import { afterEach, expect, it, vi } from 'vitest'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { ConsultationDialogueService } from '../src/application/consultation-dialogue-service.ts'
import { ModelTaskRecovery } from '../src/application/model-task-recovery.ts'
import { ModelUsageControlError } from '../src/application/model-usage-control.ts'
import { WorkflowService } from '../src/application/workflow-service.ts'
import { openClinMeshDatabase, type ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { SyntheticCaseRepository } from '../src/infrastructure/sqlite/synthetic-case-repository.ts'

const databases: ClinMeshDatabase[] = []
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close() })

function queueDatabase() {
  const database = openClinMeshDatabase({ databasePath: ':memory:', busyTimeoutMs: 5_000 })
  databases.push(database)
  // Scheduling collaborators own business validity; this fixture keeps only their private queue projection.
  database.driver.exec(`
    CREATE TABLE model_task_step (status TEXT);
    CREATE TABLE model_task_wait (workspace_id TEXT, epoch TEXT, event_id TEXT, reason TEXT,
      PRIMARY KEY (workspace_id, epoch, event_id));
    CREATE TABLE outbox_event (workspace_id TEXT, epoch TEXT, event_id TEXT, status TEXT, next_attempt_at TEXT);
    CREATE TABLE model_reply_wait (workspace_id TEXT, epoch TEXT, attempt_id TEXT, deadline_at TEXT, input_json TEXT);
    CREATE TABLE consultation_reply_attempt (workspace_id TEXT, epoch TEXT, attempt_id TEXT, doctor_turn_id TEXT,
      encounter_id TEXT, status TEXT, started_at TEXT, deadline_at TEXT, error_code TEXT);
    CREATE TABLE consultation_turn (workspace_id TEXT, epoch TEXT, turn_id TEXT, case_id TEXT,
      sequence INTEGER, speaker TEXT, kind TEXT);
  `)
  return database
}

it('wakes an eligible outbox task behind a page of disabled-workspace waits', () => {
  const database = queueDatabase()
  const recovery = new ModelTaskRecovery(database, {
    canDispatch: workspaceId => workspaceId === 'enabled', automaticRetries: () => true,
    recoveryState: () => 'synthetic-policy',
  })
  const future = '9999-12-31T23:59:59.999Z'
  for (let index = 0; index <= 100; index++) {
    const workspaceId = index === 100 ? 'enabled' : 'disabled'
    database.driver.prepare('INSERT INTO outbox_event VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, 'epoch', `task-${index}`, 'failed', future)
    database.driver.prepare('INSERT INTO model_task_wait VALUES (?, ?, ?, ?)')
      .run(workspaceId, 'epoch', `task-${index}`, 'MODEL_CALLS_DISABLED')
  }
  recovery.wake()
  expect(database.driver.prepare("SELECT next_attempt_at FROM outbox_event WHERE workspace_id = 'enabled'").get())
    .toEqual({ next_attempt_at: expect.not.stringMatching(/^9999-/u) })
  expect(database.driver.prepare('SELECT count(*) AS count FROM model_task_wait').get()).toEqual({ count: 100 })
})

it.each(['MODEL_TOKEN_LIMIT', 'MODEL_CNY_LIMIT', 'MODEL_METERING_UNAVAILABLE'] as const)('keeps %s outbox work deferred until its quota state changes', reason => {
  const database = queueDatabase()
  let state = 'synthetic-blocked-quota'
  const recovery = new ModelTaskRecovery(database, {
    canDispatch: () => true, automaticRetries: () => true, recoveryState: () => state,
  })
  const future = '9999-12-31T23:59:59.999Z'
  database.driver.prepare('INSERT INTO outbox_event VALUES (?, ?, ?, ?, ?)').run('workspace', 'epoch', 'event', 'failed', future)
  expect(recovery.defer({ workspaceId: 'workspace', epoch: 'epoch', eventId: 'event', attempt: 1,
    correlationId: 'synthetic', scenarioRunId: 'synthetic', payload: {} }, new ModelUsageControlError(reason, 'workspace', null, null, null, state)))
    .toEqual({ status: 'model-blocked' })
  recovery.wake()
  recovery.wake()
  expect(database.driver.prepare('SELECT next_attempt_at FROM outbox_event').get()).toEqual({ next_attempt_at: future })
  state = 'synthetic-released-reservation'
  recovery.wake()
  expect(database.driver.prepare('SELECT next_attempt_at FROM outbox_event').get())
    .toEqual({ next_attempt_at: expect.not.stringMatching(/^9999-/u) })
})

it('keeps an unreadable quota wait deferred without stopping another workspace, then recovers after repair', () => {
  const database = queueDatabase()
  let unreadable = true
  const recovery = new ModelTaskRecovery(database, {
    canDispatch: () => true, automaticRetries: () => true, recoveryState: workspaceId => {
      if (workspaceId === 'damaged' && unreadable) throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', 'workspace')
      return 'released'
    },
  })
  const future = '9999-12-31T23:59:59.999Z'
  for (const workspaceId of ['damaged', 'healthy']) {
    database.driver.prepare('INSERT INTO outbox_event VALUES (?, ?, ?, ?, ?)').run(workspaceId, 'epoch', 'event', 'failed', future)
    recovery.defer({ workspaceId, epoch: 'epoch', eventId: 'event', attempt: 1,
      correlationId: 'synthetic', scenarioRunId: 'synthetic', payload: {} },
    new ModelUsageControlError('MODEL_TOKEN_LIMIT', 'workspace', null, null, null, 'blocked'))
  }
  recovery.wake()
  expect(database.driver.prepare('SELECT workspace_id FROM model_task_wait').all()).toEqual([{ workspace_id: 'damaged' }])
  unreadable = false
  recovery.wake()
  expect(database.driver.prepare('SELECT COUNT(*) AS count FROM model_task_wait').get()).toEqual({ count: 0 })
})

it('completes an answered reply behind a page of disabled-workspace waits without changing its deadline', async () => {
  const database = queueDatabase()
  const fhir = new FhirRepository(database)
  const commands = new CommandExecutor(database, fhir)
  const workflow = new WorkflowService(database, fhir, commands, { tokenSecret: 'synthetic-queue-token-secret' })
  vi.spyOn(workflow, 'authorizeConsultation').mockReturnValue('synthetic-case')
  vi.spyOn(workflow, 'patientTurnAfter').mockImplementation(context => context.workspaceId === 'disabled' ? undefined : {
    consultationVersion: 4, turn: { id: 'synthetic-answer', sequence: 4, speaker: 'patient', kind: 'text',
      source: 'patient-agent', messageText: '站起来更晕。', recordedAt: '2026-10-21T00:00:00.000Z',
      actorId: null, practitionerId: null, personaRevision: 1, reportReference: null },
  })
  const startedAt = new Date().toISOString()
  const deadline = new Date(Date.now() + 30_000).toISOString()
  for (let index = 0; index <= 100; index++) {
    const context = { workspaceId: index === 100 ? 'enabled' : 'disabled', epoch: 'epoch',
      actorId: 'synthetic-doctor', roleCode: 'outpatient-doctor', scenarioRunId: 'synthetic-run' }
    const attemptId = `reply-${index}`
    const input = { context, encounterId: `encounter-${index}`, doctorSequence: 3, doctorTurnId: `question-${index}`,
      intentKey: `intent-${index}`, operation: 'ask', previouslyAccepted: false, idempotencyKey: `key-${index}` }
    database.driver.prepare('INSERT INTO consultation_reply_attempt VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(context.workspaceId, context.epoch, attemptId, input.doctorTurnId, input.encounterId,
        'executing', startedAt, deadline, 'MODEL_CONTROL_BLOCKED')
    database.driver.prepare('INSERT INTO model_reply_wait VALUES (?, ?, ?, ?, ?)')
      .run(context.workspaceId, context.epoch, attemptId, deadline, JSON.stringify(input))
  }
  const dialogue = new ConsultationDialogueService({ database, fhir, commands, workflow,
    cases: new SyntheticCaseRepository(database), canResume: workspaceId => workspaceId === 'enabled' })
  await dialogue.resumePending()
  expect(database.driver.prepare("SELECT status, started_at, deadline_at FROM consultation_reply_attempt WHERE workspace_id = 'enabled'").get())
    .toEqual({ status: 'succeeded', started_at: startedAt, deadline_at: deadline })
  expect(database.driver.prepare('SELECT count(*) AS count FROM model_reply_wait').get()).toEqual({ count: 100 })
  await dialogue.close()
})
