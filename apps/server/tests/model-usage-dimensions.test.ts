import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelUsagePolicyConfig } from '@clinmesh/contracts/model-usage'
import { afterEach, expect, it } from 'vitest'
import { ModelUsageControl, ModelUsageControlError } from '../src/application/model-usage-control.ts'
import { ModelTaskRecovery } from '../src/application/model-task-recovery.ts'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const closes: Array<() => void> = []
afterEach(() => { for (const close of closes.splice(0)) close() })

function setup(deployment?: ModelUsagePolicyConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'clinmesh-model-dimensions-'))
  const databasePath = join(directory, 'synthetic.sqlite')
  let database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
  closes.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  applyMigrations(database)
  const context: ActorContext = { workspaceId: 'synthetic-dimensions', epoch: 'epoch-1', scenarioRunId: 'run-1',
    actorId: 'synthetic-admin', roleCode: 'administrator' }
  new WorkspaceRepository(database).install({ ...context, workspaceName: '合成计价工作区', scenarioId: 'synthetic' })
  let commands = new CommandExecutor(database, new FhirRepository(database))
  let control = new ModelUsageControl(database, commands, deployment)
  function attempt() {
    const id = randomUUID()
    database.driver.prepare(`INSERT INTO model_usage_attempt(attempt_id, workspace_id, epoch, feature, provider,
      requested_model, status, started_at, record_json) VALUES (?, ?, ?, 'patient_persona', 'synthetic', 'example', 'in-flight', ?, '{}')`)
      .run(id, context.workspaceId, context.epoch, new Date().toISOString())
    return id
  }
  function update(input: { requests?: number | null; tokens?: number | null; cny?: number | null }) {
    const current = control.read(context.workspaceId).workspace
    return control.update(context, { enabled: current.enabled, requests: current.requests,
      automaticRetries: current.automaticRetries, expectedVersion: current.version, ...input }, randomUUID())
  }
  return { get database() { return database }, get control() { return control }, context, attempt, update,
    restart() {
      database.close()
      database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
      commands = new CommandExecutor(database, new FhirRepository(database))
      control = new ModelUsageControl(database, commands, deployment)
    } }
}

it('reserves both dimensions together and releases unused bounds on settlement', () => {
  const fixture = setup()
  fixture.update({ tokens: 100, cny: 1 })
  const first = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, first, 'initial', { tokens: 60, cny: 600_000 })
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({
    tokens: 100, tokensUsed: 0, tokensReserved: 60, tokensRemaining: 40,
    cny: 1, cnyUsed: 0, cnyReserved: 0.6, cnyRemaining: 0.4,
  })
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 41, cny: 100_000 }))
    .toThrow(expect.objectContaining({ code: 'MODEL_TOKEN_LIMIT', dimension: 'tokens', remaining: 40, required: 41 }))
  fixture.control.settleDimensions(first, { tokens: 30, cny: 200_000 }, false)
  fixture.control.settleDimensions(first, { tokens: 30, cny: 200_000 }, false)
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({
    tokensUsed: 30, tokensReserved: 0, tokensRemaining: 70, cnyUsed: 0.2, cnyReserved: 0, cnyRemaining: 0.8,
  })
})

it.each([false, true])('结算释放预占后恢复有界任务，即使拒绝尚未传回（%s）', async releaseBeforePropagation => {
  const fixture = setup()
  fixture.update({ tokens: 100, cny: 0 })
  const first = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, first, 'initial', { tokens: 70, cny: 0 })
  const next = fixture.attempt()
  const recovery = new ModelTaskRecovery(fixture.database, fixture.control)
  const provider = recovery.provider({ supportsRequestControl: true, completeJson: async input => {
    try { fixture.control.reserve(fixture.context.workspaceId, next, 'initial', { tokens: 50, cny: 0 }) }
    finally { if (releaseBeforePropagation) fixture.control.settleDimensions(first, { tokens: 10, cny: 0 }, false) }
    input.onBeforeRequest?.()
    input.onRequestComplete?.()
    return { content: '{}', model: 'synthetic' }
  } })
  const input = { model: 'synthetic', schemaName: 'patient_persona', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {},
    usageContext: { workspaceId: fixture.context.workspaceId, epoch: fixture.context.epoch, taskId: 'bounded-task',
      stage: 'synthetic', trigger: 'automatic' as const, sources: [] } }
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'MODEL_TOKEN_LIMIT' })
  expect(recovery.ready(fixture.context.workspaceId, 'bounded-task')).toBe(releaseBeforePropagation)
  if (!releaseBeforePropagation) fixture.control.settleDimensions(first, { tokens: 10, cny: 0 }, false)
  expect(recovery.ready(fixture.context.workspaceId, 'bounded-task')).toBe(true)
  await expect(provider.completeJson(input)).resolves.toEqual({ content: '{}', model: 'synthetic' })
})

it('starts each dimension independently and preserves consumption during unlimited periods and restart', () => {
  const fixture = setup()
  const before = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, before, 'initial', { tokens: 100, cny: 100_000 })
  fixture.control.settleDimensions(before, { tokens: 100, cny: 100_000 }, false)
  fixture.update({ tokens: 50 })
  const firstStart = fixture.control.read(fixture.context.workspaceId).workspace
  expect(firstStart).toMatchObject({ tokensUsed: 0, cnyStartedAt: null, cnyUsed: 0, cny: null })
  expect(firstStart.tokensStartedAt).not.toBeNull()
  const counted = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, counted, 'initial', { tokens: 20, cny: 200_000 })
  fixture.control.settleDimensions(counted, { tokens: 10, cny: 100_000 }, false)
  fixture.update({ tokens: null, cny: 1 })
  const unlimited = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, unlimited, 'initial', { tokens: 30, cny: 300_000 })
  fixture.control.settleDimensions(unlimited, { tokens: 20, cny: 200_000 }, false)
  fixture.update({ tokens: 40 })
  fixture.restart()
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({
    tokens: 40, tokensUsed: 30, tokensRemaining: 10, tokensStartedAt: firstStart.tokensStartedAt,
    cny: 1, cnyUsed: 0.2, cnyRemaining: 0.8, requestsStartedAt: null, used: 0,
  })
})

it('retains unbounded unknown reservations across restart and blocks finite budgets until verified', () => {
  const fixture = setup()
  fixture.update({ tokens: 100, cny: 1 })
  fixture.update({ tokens: null, cny: null })
  const unknown = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, unknown, 'initial', { tokens: null, cny: null })
  fixture.control.settleDimensions(unknown, { tokens: 30, cny: null }, false)
  fixture.restart()
  fixture.update({ tokens: 100, cny: 1 })
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({
    tokensUsed: 30, tokensUnknownReservations: 0, tokensRemaining: 70,
    cnyUsed: 0, cnyUnknownReservations: 1, cnyRemaining: null,
  })
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 10, cny: 100_000 }))
    .toThrow(expect.objectContaining({ code: 'MODEL_METERING_UNAVAILABLE', dimension: 'cny' }))
  fixture.control.settleDimensions(unknown, { tokens: null, cny: 200_000 }, false)
  const notDispatched = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, notDispatched, 'initial', { tokens: 60, cny: 700_000 })
  fixture.control.settleDimensions(notDispatched, { tokens: null, cny: null }, true)
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({
    tokensUsed: 30, tokensReserved: 0, tokensRemaining: 70,
    cnyUsed: 0.2, cnyReserved: 0, cnyRemaining: 0.8, cnyUnknownReservations: 0,
  })
})

it('checks deployment and Workspace bounds atomically and persists rejection amounts in CNY', () => {
  const fixture = setup({ enabled: true, requests: 2, automaticRetries: true, tokens: 100, cny: 1 })
  fixture.update({ requests: 3, tokens: 200, cny: 2 })
  const first = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, first, 'initial', { tokens: 60, cny: 600_000 })
  let rejection: unknown
  try { fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 30, cny: 500_000 }) }
  catch (error) { rejection = error }
  expect(rejection).toMatchObject({ code: 'MODEL_CNY_LIMIT', scope: 'deployment', dimension: 'cny', remaining: 0.4, required: 0.5 })
  if (!(rejection instanceof ModelUsageControlError)) throw new Error('Expected a structured policy rejection')
  fixture.control.reject(fixture.context.workspaceId, rejection)
  const state = fixture.control.read(fixture.context.workspaceId)
  expect(state).toMatchObject({ workspace: { reserved: 1, tokensReserved: 60, cnyReserved: 0.6 },
    deployment: { reserved: 1, tokensReserved: 60, cnyReserved: 0.6 },
    lastRejection: { code: 'MODEL_CNY_LIMIT', scope: 'deployment', dimension: 'cny', remaining: 0.4, required: 0.5 } })
  fixture.control.settle(first, 'not-dispatched')
  fixture.control.settleDimensions(first, { tokens: null, cny: null }, true)
  expect(fixture.control.read(fixture.context.workspaceId)).toMatchObject({
    workspace: { used: 0, reserved: 0, tokensReserved: 0, cnyReserved: 0 },
    deployment: { used: 0, reserved: 0, tokensReserved: 0, cnyReserved: 0 },
  })
})

it('distinguishes zero limits from unlimited and requires trustworthy bounds for each finite dimension', () => {
  const fixture = setup()
  fixture.update({ tokens: 0, cny: 0 })
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: null, cny: 0 }))
    .toThrow(expect.objectContaining({ code: 'MODEL_METERING_UNAVAILABLE', dimension: 'tokens' }))
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 0, cny: 1 }))
    .toThrow(expect.objectContaining({ code: 'MODEL_CNY_LIMIT', dimension: 'cny', remaining: 0, required: 0.000001 }))
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 0, cny: 0 })).not.toThrow()
  fixture.update({ tokens: null, cny: null })
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: null, cny: null })).not.toThrow()
})

it('keeps unknown terminal dimensions reserved and rejects changes to known settlement', () => {
  const fixture = setup()
  fixture.update({ tokens: 100, cny: 1 })
  const attempt = fixture.attempt()
  fixture.control.reserve(fixture.context.workspaceId, attempt, 'initial', { tokens: 60, cny: 600_000 })
  fixture.control.settleDimensions(attempt, { tokens: 30, cny: null }, false)
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({ tokensUsed: 30, tokensReserved: 0, cnyReserved: 0.6 })
  expect(() => fixture.control.settleDimensions(attempt, { tokens: 31, cny: 200_000 }, false))
    .toThrow(expect.objectContaining({ code: 'MODEL_USAGE_CORRECTION_INVALID' }))
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({ tokensUsed: 30, cnyUsed: 0, cnyReserved: 0.6 })
  fixture.control.settleDimensions(attempt, { tokens: null, cny: 200_000 }, false)
  expect(fixture.control.read(fixture.context.workspaceId).workspace).toMatchObject({ tokensUsed: 30, cnyUsed: 0.2, cnyReserved: 0 })
})

it('fails closed when persisted dimension totals are outside safe integer bounds', () => {
  const fixture = setup()
  fixture.update({ tokens: 100 })
  fixture.database.driver.pragma('ignore_check_constraints = ON')
  fixture.database.driver.prepare("UPDATE model_usage_dimension SET used = 9007199254740992 WHERE scope_id = ? AND dimension = 'tokens'")
    .run(`workspace:${fixture.context.workspaceId}`)
  expect(() => fixture.control.read(fixture.context.workspaceId)).toThrow(expect.objectContaining({ code: 'MODEL_LEDGER_UNAVAILABLE' }))
  expect(() => fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 0, cny: 0 }))
    .toThrow(expect.objectContaining({ code: 'MODEL_LEDGER_UNAVAILABLE' }))
})

it('shares the deployment budget across separate Workspace reservations', () => {
  const fixture = setup({ enabled: true, requests: null, automaticRetries: true, tokens: 100, cny: null })
  const other = { ...fixture.context, workspaceId: 'synthetic-dimensions-other', epoch: 'epoch-2', scenarioRunId: 'run-2' }
  new WorkspaceRepository(fixture.database).install({ ...other, workspaceName: '第二合成工作区', scenarioId: 'synthetic' })
  const attempt = randomUUID()
  fixture.database.driver.prepare(`INSERT INTO model_usage_attempt(attempt_id, workspace_id, epoch, feature, provider,
    requested_model, status, started_at, record_json) VALUES (?, ?, ?, 'patient_persona', 'synthetic', 'example', 'in-flight', ?, '{}')`)
    .run(attempt, other.workspaceId, other.epoch, new Date().toISOString())
  fixture.control.reserve(fixture.context.workspaceId, fixture.attempt(), 'initial', { tokens: 60, cny: null })
  expect(() => fixture.control.reserve(other.workspaceId, attempt, 'initial', { tokens: 41, cny: null }))
    .toThrow(expect.objectContaining({ code: 'MODEL_TOKEN_LIMIT', scope: 'deployment', remaining: 40, required: 41 }))
  fixture.control.reserve(other.workspaceId, attempt, 'initial', { tokens: 40, cny: null })
  expect(fixture.control.read(other.workspaceId)).toMatchObject({ deployment: { tokensReserved: 100, tokensRemaining: 0 },
    workspace: { tokensStartedAt: null, tokensReserved: 0, tokensUsed: 0 } })
})
