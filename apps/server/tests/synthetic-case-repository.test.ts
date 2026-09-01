import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scenarioGenerationRequestSchema,
  syntheticPatientProfileSchema,
} from '@clinmesh/contracts/scenario'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { compileSyntheaIndexCase } from '../src/application/scenario-data/synthea-index-case.ts'
import { createSyntheticPatientProfiles } from '../src/application/scenario-data/synthetic-patient-profile.ts'
import {
  applyMigrations,
  openClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import {
  SyntheticCaseRepository,
  SyntheticCaseRepositoryError,
} from '../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

function sourceBundle() {
  return {
    entry: [{
      fullUrl: 'urn:uuid:patient',
      resource: {
        birthDate: '1970-01-01',
        gender: 'female',
        id: 'patient',
        name: [{ text: '张琴' }],
        resourceType: 'Patient',
      },
    }, {
      fullUrl: 'urn:uuid:prior-encounter',
      resource: {
        id: 'prior-encounter',
        period: { end: '2025-01-10T09:30:00+08:00', start: '2025-01-10T09:00:00+08:00' },
        resourceType: 'Encounter',
        status: 'finished',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:prior-condition',
      resource: {
        code: {
          coding: [{
            code: '59621000',
            display: '高血压（疾病）',
            system: 'http://snomed.info/sct',
          }],
        },
        encounter: { reference: 'urn:uuid:prior-encounter' },
        id: 'prior-condition',
        recordedDate: '2025-01-10T09:05:00+08:00',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-encounter',
      resource: {
        id: 'index-encounter',
        period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' },
        reasonCode: [{ text: '血压控制不佳' }],
        resourceType: 'Encounter',
        status: 'finished',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-condition',
      resource: {
        code: {
          coding: [{
            code: '59621000',
            display: '高血压（疾病）',
            system: 'http://snomed.info/sct',
          }],
        },
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-condition',
        recordedDate: '2026-06-01T10:05:00+08:00',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-observation',
      resource: {
        code: {
          coding: [{ code: '8480-6', display: '收缩压', system: 'http://loinc.org' }],
        },
        effectiveDateTime: '2026-06-01T10:10:00+08:00',
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-observation',
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: 'urn:uuid:patient' },
        valueQuantity: {
          code: 'mm[Hg]',
          system: 'http://unitsofmeasure.org',
          unit: 'mmHg',
          value: 162,
        },
      },
    }],
    resourceType: 'Bundle',
    type: 'collection',
  }
}

describe('Synthetic Case SQLite boundary', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('persists visible source history separately from private Case Truth', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthetic-case-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    new WorkspaceRepository(database).install({
      epoch: 'epoch-synthetic-case',
      scenarioId: 'scenario-synthetic-case',
      scenarioRunId: 'run-synthetic-case',
      workspaceId: 'workspace-synthetic-case',
      workspaceName: 'Synthetic Case',
    })

    const request = scenarioGenerationRequestSchema.parse({
      moduleMode: 'filter',
      modules: ['hypertension'],
      name: 'Synthetic Case',
      population: { age: { maximum: 60, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'synthea',
      seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2016-08-01' },
      timeZone: 'Asia/Shanghai',
    })
    const bundle = sourceBundle()
    const profile = syntheticPatientProfileSchema.parse(createSyntheticPatientProfiles({
      batchId: 'batch-synthetic-case',
      batchName: request.name,
      createdAt: '2026-08-30T08:00:00+08:00',
      request,
      sources: [{
        format: 'fhir-r4-bundle',
        hash: canonicalJsonHash(bundle),
        patientId: 'patient',
        raw: bundle,
      }],
      workspaceId: 'workspace-synthetic-case',
    })[0])
    new SyntheticPatientProfileRepository(database).createBatch([profile], 'actor-administrator')

    const repository = new SyntheticCaseRepository(database)
    const created = repository.createFromProfile({
      actorId: 'actor-administrator',
      compiled: compileSyntheaIndexCase(bundle),
      profile,
    })

    expect(repository.get(profile.workspaceId, created.caseId)).toEqual(created)
    expect(JSON.stringify(created)).not.toMatch(/index-encounter|index-condition|index-observation/)
    expect(repository.listVisibleHistory({
      caseId: created.caseId,
      page: 1,
      pageSize: 1,
      workspaceId: profile.workspaceId,
    })).toEqual({
      items: [{
        clinicalDate: '2025-01-10T09:00:00+08:00',
        resourceType: 'Encounter',
        sourceReference: 'urn:uuid:prior-encounter',
        title: '就诊',
      }],
      page: 1,
      pageSize: 1,
      total: 2,
    })
    expect(repository.getVisibleResource(
      profile.workspaceId,
      created.caseId,
      'urn:uuid:prior-condition',
    )).toMatchObject({
      resource: {
        code: { coding: [{ display: '高血压（疾病）' }] },
        resourceType: 'Condition',
      },
      sourceKind: 'synthea-r4-external',
      sourceReference: 'urn:uuid:prior-condition',
    })
    expect(repository.getVisibleResource(
      profile.workspaceId,
      created.caseId,
      'urn:uuid:index-condition',
    )).toBeUndefined()
    expect(repository.getVisibleResource(
      profile.workspaceId,
      created.caseId,
      'Condition/index-condition',
    )).toBeUndefined()

    expect(repository.getTruthForSimulator(profile.workspaceId, created.caseId)).toMatchObject({
      hiddenResourceReferences: [
        'urn:uuid:index-condition',
        'urn:uuid:index-encounter',
        'urn:uuid:index-observation',
      ],
      indexEncounterReference: 'urn:uuid:index-encounter',
    })
    expect(() => repository.createFromProfile({
      actorId: 'actor-administrator',
      compiled: compileSyntheaIndexCase(bundle),
      profile,
    })).toThrowError(SyntheticCaseRepositoryError)

    database.close()
  })
})
