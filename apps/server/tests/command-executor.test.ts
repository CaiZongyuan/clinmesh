import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandConflictError,
  CommandExecutor,
} from '../src/application/command-executor.ts'
import { AuditQuery } from '../src/application/audit-query.ts'
import { OutboxRepository } from '../src/infrastructure/sqlite/outbox-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { WorkspaceContextError } from '../src/infrastructure/sqlite/workspace-repository.ts'
import {
  applyMigrations,
  openClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'

describe('CommandExecutor', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('returns the first result for an identical idempotent command and rejects payload reuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-command-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    const repositoryContext = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    const workspaceRepository = new WorkspaceRepository(database)
    workspaceRepository.install({
      ...repositoryContext,
      scenarioId: 'outpatient-fever-001',
      scenarioRunId: 'run-001',
      workspaceName: '合成医院工作区',
    })
    const fhirRepository = new FhirRepository(database, {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    const executor = new CommandExecutor(database, fhirRepository, {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    const context = {
      actorId: 'actor-registrar',
      organizationId: 'org-clinmesh',
      practitionerId: 'practitioner-registrar',
      practitionerRoleId: 'role-registrar',
      roleCode: 'registrar',
      scenarioRunId: 'run-001',
      ...repositoryContext,
    }
    const execute = (patientName: string) => executor.execute({
      context,
      expectedVersions: {},
      idempotencyKey: 'register-001',
      input: { patientName },
      operation: 'registration.register',
    }, transaction => {
      const patient = transaction.fhir.create(repositoryContext, {
        resourceType: 'Patient',
        id: 'patient-001',
        name: [{ text: patientName }],
      })
      transaction.enqueue({
        dedupKey: 'patient-created-001',
        kind: 'patient-created',
        payload: { patientId: patient.id },
      })
      return {
        data: { patientId: patient.id },
        effects: [{
          kind: 'created' as const,
          reference: `Patient/${patient.id}`,
          versionId: patient.meta?.versionId ?? '1',
        }],
      }
    })

    const startedAt = performance.now()
    const first = execute('合成患者甲')
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    const replay = execute('合成患者甲')

    expect(replay).toEqual(first)
    expect(fhirRepository.history(repositoryContext, 'Patient', 'patient-001')).toHaveLength(1)
    expect(new OutboxRepository(database).list(repositoryContext)).toHaveLength(1)
    expect(new AuditQuery(database).list(repositoryContext)).toHaveLength(1)
    expect(fhirRepository.search(
      repositoryContext,
      'AuditEvent',
      new URLSearchParams('_total=accurate'),
    )).toMatchObject({
      resources: [{ outcome: { code: { code: '0' } } }],
      total: 1,
    })
    expect(() => execute('合成患者乙')).toThrowError(CommandConflictError)
    database.close()
  })

  it('rolls back every business effect while retaining a failed audit attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-command-rollback-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    const repositoryContext = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(database).install({
      ...repositoryContext,
      scenarioId: 'outpatient-fever-001',
      scenarioRunId: 'run-001',
      workspaceName: '合成医院工作区',
    })
    const fhirRepository = new FhirRepository(database)
    const executor = new CommandExecutor(database, fhirRepository)
    const context = {
      actorId: 'actor-registrar',
      roleCode: 'registrar',
      scenarioRunId: 'run-001',
      ...repositoryContext,
    }

    expect(() => executor.execute({
      context,
      expectedVersions: {},
      idempotencyKey: 'rollback-001',
      input: { patientName: '合成患者回滚' },
      operation: 'registration.register',
    }, transaction => {
      transaction.fhir.create(repositoryContext, {
        resourceType: 'Patient',
        id: 'patient-rollback',
        name: [{ text: '合成患者回滚' }],
      })
      transaction.enqueue({
        dedupKey: 'rollback-outbox',
        kind: 'patient-created',
        payload: { patientId: 'patient-rollback' },
      })
      throw new Error('injected command failure')
    })).toThrow('injected command failure')

    expect(() => fhirRepository.read(repositoryContext, 'Patient', 'patient-rollback')).toThrow()
    expect(new OutboxRepository(database).list(repositoryContext)).toEqual([])
    expect(new AuditQuery(database).list(repositoryContext)).toMatchObject([{
      operation: 'registration.register',
      outcome: 'failed',
      sequence: 1,
    }])
    expect(fhirRepository.search(
      repositoryContext,
      'AuditEvent',
      new URLSearchParams('_total=accurate'),
    )).toMatchObject({
      resources: [{ outcome: { code: { code: '8' } } }],
      total: 1,
    })
    database.close()
  })

  it('isolates idempotent command results and audit projections by Workspace and Epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-command-isolation-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    const contexts = [
      { epoch: 'epoch-a1', workspaceId: 'workspace-a' },
      { epoch: 'epoch-b1', workspaceId: 'workspace-b' },
    ] as const
    const workspaces = new WorkspaceRepository(database)
    for (const [index, context] of contexts.entries()) {
      workspaces.install({
        ...context,
        scenarioId: 'command-isolation',
        scenarioRunId: `run-${index + 1}`,
        workspaceName: `合成隔离工作区 ${index + 1}`,
      })
    }
    const fhir = new FhirRepository(database)
    const executor = new CommandExecutor(database, fhir)
    const execute = (context: typeof contexts[number], label: string, scenarioRunId: string) => (
      executor.execute({
        context: {
          ...context,
          actorId: 'actor-shared',
          roleCode: 'registrar',
          scenarioRunId,
        },
        expectedVersions: {},
        idempotencyKey: 'shared-idempotency-key',
        input: { label },
        operation: 'patient.create-synthetic',
      }, transaction => {
        const patient = transaction.fhir.create(context, {
          resourceType: 'Patient',
          id: 'patient-shared-id',
          name: [{ text: label }],
        })
        return {
          data: { label },
          effects: [{
            kind: 'created' as const,
            reference: `Patient/${patient.id}`,
            versionId: patient.meta?.versionId ?? '1',
          }],
        }
      })
    )

    const resultA = execute(contexts[0], '工作区甲', 'run-1')
    const resultB = execute(contexts[1], '工作区乙', 'run-2')
    expect(execute(contexts[0], '工作区甲', 'run-1')).toEqual(resultA)
    expect(execute(contexts[1], '工作区乙', 'run-2')).toEqual(resultB)
    expect(resultA.data).toEqual({ label: '工作区甲' })
    expect(resultB.data).toEqual({ label: '工作区乙' })
    for (const context of contexts) {
      expect(new AuditQuery(database).list(context)).toHaveLength(1)
      expect(fhir.search(
        context,
        'AuditEvent',
        new URLSearchParams('_total=accurate'),
      )).toMatchObject({ total: 1 })
    }
    database.close()
  })

  it('preserves the inactive-context error and records a late command against a known closed Epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-command-old-epoch-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    const repositoryContext = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(database).install({
      ...repositoryContext,
      scenarioId: 'outpatient-fever-001',
      scenarioRunId: 'run-001',
      workspaceName: '合成医院工作区',
    })
    database.driver.prepare(`
      UPDATE scenario_run SET status = 'closed', completed_at = ?
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).run('2026-08-24T01:01:00.000Z', 'workspace-001', 'epoch-001', 'run-001')
    database.driver.prepare(`
      UPDATE workspace_epoch SET state = 'closed', closed_at = ?
      WHERE workspace_id = ? AND epoch = ?
    `).run('2026-08-24T01:01:00.000Z', 'workspace-001', 'epoch-001')
    const fhirRepository = new FhirRepository(database)
    const executor = new CommandExecutor(database, fhirRepository, {
      now: () => new Date('2026-08-24T01:02:00.000Z'),
    })

    expect(() => executor.execute({
      context: {
        ...repositoryContext,
        actorId: 'actor-lis-system',
        roleCode: 'lis-system',
        scenarioRunId: 'run-001',
      },
      expectedVersions: {},
      idempotencyKey: 'late-lis-result-001',
      input: { serviceRequestId: 'service-request-001' },
      operation: 'lis.process-order',
    }, () => ({ data: { accepted: true }, effects: [] }))).toThrowError(WorkspaceContextError)
    expect(new AuditQuery(database).list(repositoryContext)).toMatchObject([{
      operation: 'lis.process-order',
      outcome: 'failed',
      sequence: 1,
    }])
    expect(fhirRepository.search(
      repositoryContext,
      'AuditEvent',
      new URLSearchParams('_total=accurate'),
    )).toMatchObject({ total: 1 })
    database.close()
  })
})
