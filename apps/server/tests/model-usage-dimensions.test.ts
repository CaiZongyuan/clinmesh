import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ModelUsageControl } from '../src/application/model-usage-control.ts'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const closes: Array<() => void> = []
afterEach(() => { for (const close of closes.splice(0)) close() })

function setup() {
  const database = openClinMeshDatabase({ databasePath: ':memory:', busyTimeoutMs: 5_000 })
  closes.push(() => database.close())
  applyMigrations(database)
  const context: ActorContext = { workspaceId: 'synthetic-dimensions', epoch: 'epoch-1', scenarioRunId: 'run-1',
    actorId: 'synthetic-admin', roleCode: 'administrator' }
  new WorkspaceRepository(database).install({ ...context, workspaceName: '合成计价工作区', scenarioId: 'synthetic' })
  const commands = new CommandExecutor(database, new FhirRepository(database))
  const control = new ModelUsageControl(database, commands)
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
  return { database, control, commands, context, attempt, update }
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
