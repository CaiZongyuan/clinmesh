import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  openClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

describe('FHIR Resource Store', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('keeps current and history isolated by Workspace and Epoch across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-fhir-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const firstDatabase = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    applyMigrations(firstDatabase)
    const firstRepository = new FhirRepository(firstDatabase, {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    const workspaceA = { epoch: 'epoch-a1', workspaceId: 'workspace-a' }
    const workspaceB = { epoch: 'epoch-b1', workspaceId: 'workspace-b' }
    const workspaces = new WorkspaceRepository(firstDatabase)
    workspaces.install({
      ...workspaceA,
      scenarioId: 'repository-contract',
      scenarioRunId: 'run-a1',
      workspaceName: '合成工作区 A',
    })
    workspaces.install({
      ...workspaceB,
      scenarioId: 'repository-contract',
      scenarioRunId: 'run-b1',
      workspaceName: '合成工作区 B',
    })

    firstRepository.create(workspaceA, {
      resourceType: 'Patient',
      id: 'patient-shared-id',
      active: true,
      name: [{ text: '合成患者甲' }],
    })
    firstRepository.update(
      workspaceA,
      {
        resourceType: 'Patient',
        id: 'patient-shared-id',
        active: true,
        name: [{ text: '合成患者甲（已核验）' }],
      },
      '1',
    )
    firstRepository.create(workspaceB, {
      resourceType: 'Patient',
      id: 'patient-shared-id',
      active: true,
      name: [{ text: '合成患者乙' }],
    })
    for (const [context, id, name] of [
      [workspaceA, 'patient-a-002', '合成患者甲二'],
      [workspaceA, 'patient-a-003', '合成患者甲三'],
      [workspaceB, 'patient-b-002', '合成患者乙二'],
    ] as const) {
      firstRepository.create(context, {
        resourceType: 'Patient',
        id,
        active: true,
        name: [{ text: name }],
      })
    }
    firstDatabase.close()

    const reopenedDatabase = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    applyMigrations(reopenedDatabase)
    const repository = new FhirRepository(reopenedDatabase, {
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      now: () => new Date('2026-08-24T01:01:00.000Z'),
    })

    expect(repository.read(workspaceA, 'Patient', 'patient-shared-id')).toMatchObject({
      meta: { versionId: '2' },
      name: [{ text: '合成患者甲（已核验）' }],
    })
    expect(repository.vread(workspaceA, 'Patient', 'patient-shared-id', '1')).toMatchObject({
      meta: { versionId: '1' },
      name: [{ text: '合成患者甲' }],
    })
    expect(repository.history(workspaceA, 'Patient', 'patient-shared-id').map(resource => resource.meta?.versionId)).toEqual([
      '2',
      '1',
    ])
    expect(repository.read(workspaceB, 'Patient', 'patient-shared-id')).toMatchObject({
      meta: { versionId: '1' },
      name: [{ text: '合成患者乙' }],
    })
    const firstPage = repository.search(
      workspaceA,
      'Patient',
      new URLSearchParams('_count=2&_total=accurate'),
    )
    expect(firstPage).toMatchObject({ resources: expect.any(Array), total: 3 })
    expect(firstPage.resources).toHaveLength(2)
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    const secondPage = repository.search(
      workspaceA,
      'Patient',
      new URLSearchParams(`_count=2&_total=accurate&_cursor=${firstPage.nextCursor}`),
    )
    expect(secondPage).toMatchObject({ total: 3 })
    expect(secondPage.resources).toHaveLength(1)
    expect(repository.search(
      workspaceB,
      'Patient',
      new URLSearchParams('_count=2&_total=accurate'),
    )).toMatchObject({ resources: expect.any(Array), total: 2 })
    expect(() => repository.search(
      workspaceB,
      'Patient',
      new URLSearchParams(`_count=2&_total=accurate&_cursor=${firstPage.nextCursor}`),
    )).toThrow('Search cursor does not match the active context')
    reopenedDatabase.close()
  })

  it('keeps immutable resources and domain projections on distinct write paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-fhir-ownership-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      databasePath: join(directory, 'clinmesh.sqlite'),
      busyTimeoutMs: 5_000,
    })
    applyMigrations(database)
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'repository-ownership',
      scenarioRunId: 'run-001',
      workspaceName: '合成资源所有权工作区',
    })
    const repository = new FhirRepository(database, {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    const composition = repository.createImmutable(context, {
      resourceType: 'Composition',
      id: 'composition-001',
      status: 'final',
      type: { text: 'Synthetic note' },
      date: '2026-08-24T09:00:00+08:00',
      author: [{ reference: 'Practitioner/practitioner-001' }],
      title: '合成病历',
    })
    expect(() => repository.update(context, {
      ...composition,
      title: '被覆盖的病历',
    }, '1')).toThrow('owned by fhir-native-immutable')
    expect(() => repository.create(context, {
      resourceType: 'InventoryItem',
      id: 'lot-001',
      status: 'active',
    })).toThrow('cannot be created through the fhir-native write path')

    repository.createProjection(context, {
      resourceType: 'InventoryItem',
      id: 'lot-001',
      status: 'active',
      netContent: { value: 10 },
    })
    const owners = database.driver.prepare(`
      SELECT resource_type, owner_kind FROM fhir_resource
      WHERE workspace_id = ? AND epoch = ?
      ORDER BY resource_type
    `).all(context.workspaceId, context.epoch)
    expect(owners).toEqual([
      { owner_kind: 'fhir-native-immutable', resource_type: 'Composition' },
      { owner_kind: 'domain-projection', resource_type: 'InventoryItem' },
    ])
    database.close()
  })

  it('rolls back current, history, and search when an index constraint fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-fhir-atomicity-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      databasePath: join(directory, 'clinmesh.sqlite'),
      busyTimeoutMs: 5_000,
    })
    applyMigrations(database)
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'repository-atomicity',
      scenarioRunId: 'run-001',
      workspaceName: '合成资源原子性工作区',
    })
    const repository = new FhirRepository(database)
    database.driver.exec(`
      CREATE TRIGGER reject_patient_search
      BEFORE INSERT ON fhir_sp_string
      WHEN NEW.resource_type = 'Patient'
      BEGIN
        SELECT RAISE(ABORT, 'injected search index failure');
      END
    `)
    const patient = {
      resourceType: 'Patient' as const,
      id: 'patient-atomicity',
      identifier: [{ value: 'CM-SYN-ATOMICITY' }],
      name: [{ text: '合成原子性患者' }],
    }

    expect(() => repository.create(context, patient)).toThrow('injected search index failure')
    expect(() => repository.read(context, 'Patient', patient.id)).toThrow('was not found')
    expect(repository.history(context, 'Patient', patient.id)).toEqual([])
    expect(repository.search(
      context,
      'Patient',
      new URLSearchParams('identifier=CM-SYN-ATOMICITY&_total=accurate'),
    )).toMatchObject({ resources: [], total: 0 })

    database.driver.exec('DROP TRIGGER reject_patient_search')
    expect(repository.create(context, patient)).toMatchObject({ meta: { versionId: '1' } })
    database.close()
  })
})
