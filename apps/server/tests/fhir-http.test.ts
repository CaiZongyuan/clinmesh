import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fhirBundleSchema,
  operationOutcomeSchema,
} from '@clinmesh/contracts/fhir'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import {
  applyMigrations,
  openClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

describe('FHIR R5 HTTP contract', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('returns strict, isolated Patient search with signed keyset pagination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-fhir-http-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    let timestamp = Date.parse('2026-08-24T01:00:00.000Z')
    const repository = new FhirRepository(database, {
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      now: () => new Date(timestamp += 1_000),
    })
    const workspaceA = { epoch: 'epoch-a1', workspaceId: 'workspace-a' }
    const workspaceB = { epoch: 'epoch-b1', workspaceId: 'workspace-b' }
    const workspaces = new WorkspaceRepository(database)
    workspaces.install({
      ...workspaceA,
      scenarioId: 'fhir-http-contract',
      scenarioRunId: 'run-a1',
      workspaceName: '合成工作区 A',
    })
    workspaces.install({
      ...workspaceB,
      scenarioId: 'fhir-http-contract',
      scenarioRunId: 'run-b1',
      workspaceName: '合成工作区 B',
    })

    repository.create(workspaceA, {
      resourceType: 'Patient',
      id: 'patient-a1',
      identifier: [{ system: 'https://example.test/mrn', value: 'A-001' }],
      name: [{ text: '合成患者甲' }],
    })
    repository.create(workspaceA, {
      resourceType: 'Patient',
      id: 'patient-a2',
      identifier: [{ system: 'https://example.test/mrn', value: 'A-002' }],
      name: [{ text: '合成患者乙' }],
    })
    repository.create(workspaceB, {
      resourceType: 'Patient',
      id: 'patient-b1',
      name: [{ text: '合成患者丙' }],
    })

    const appA = createApp({
      fhir: { repository, resolveContext: () => workspaceA },
    })
    const firstResponse = await appA.request(
      '/fhir/R5/Patient?name=%E5%90%88%E6%88%90&_count=1&_total=accurate',
    )
    expect(firstResponse.status).toBe(200)
    expect(firstResponse.headers.get('content-type')).toContain('application/fhir+json')
    const firstPage = fhirBundleSchema.parse(await firstResponse.json())
    expect(firstPage.total).toBe(2)
    expect(firstPage.entry).toHaveLength(1)
    expect(firstPage.entry?.[0]?.resource.id).toBe('patient-a2')
    const nextLink = firstPage.link?.find(link => link.relation === 'next')?.url
    expect(nextLink).toBeDefined()

    const secondResponse = await appA.request(nextLink ?? '')
    const secondPage = fhirBundleSchema.parse(await secondResponse.json())
    expect(secondPage.entry?.map(entry => entry.resource.id)).toEqual(['patient-a1'])
    expect(secondPage.link?.some(link => link.relation === 'next')).toBe(false)

    const unknownResponse = await appA.request('/fhir/R5/Patient?unknown=value')
    expect(unknownResponse.status).toBe(400)
    expect(operationOutcomeSchema.parse(await unknownResponse.json()).issue[0]?.code).toBe('not-supported')

    const appB = createApp({
      fhir: { repository, resolveContext: () => workspaceB },
    })
    const replayResponse = await appB.request(nextLink ?? '')
    expect(replayResponse.status).toBe(400)
    expect(operationOutcomeSchema.parse(await replayResponse.json()).issue[0]?.code).toBe('invalid')
    database.close()
  })
})
