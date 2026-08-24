import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getResourceCapability, getResourceOwnership } from '../src/fhir/capabilities.ts'
import {
  applyMigrations,
  openClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const examplesSchema = z.object({
  resources: z.array(fhirResourceSchema).min(1),
  title: z.string().min(1),
}).strict()

describe('FHIR R5 release profile examples', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('keeps example instances aligned with registered references and searches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-fhir-examples-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
    })
    applyMigrations(database)
    const repository = new FhirRepository(database, {
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      now: () => new Date('2026-08-24T02:00:00.000Z'),
    })
    const context = { epoch: 'epoch-release-examples', workspaceId: 'workspace-release-examples' }
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'fhir-release-examples',
      scenarioRunId: 'run-release-examples',
      workspaceName: 'FHIR 首期示例工作区',
    })
    const fixtureUrl = new URL('./fixtures/fhir-r5-release-profile-examples.json', import.meta.url)
    const examples = examplesSchema.parse(JSON.parse(await readFile(fixtureUrl, 'utf8')))

    for (const resource of examples.resources) {
      expect(getResourceCapability(resource.resourceType)).toBeDefined()
      if (getResourceOwnership(resource.resourceType) === 'fhir-native-immutable') {
        repository.createImmutable(context, resource)
      } else {
        repository.create(context, resource)
      }
    }

    const searches = [
      ['Condition', 'patient', 'Patient/patient-example', 'condition-example'],
      ['Encounter', 'patient', 'Patient/patient-example', 'encounter-example'],
      ['Task', 'focus', 'Encounter/encounter-example', 'task-example'],
      ['ChargeItem', 'encounter', 'Encounter/encounter-example', 'charge-item-example'],
      ['Observation', 'patient', 'Patient/patient-example', 'observation-example'],
      ['ServiceRequest', 'encounter', 'Encounter/encounter-example', 'service-request-example'],
      ['DiagnosticReport', 'patient', 'Patient/patient-example', 'diagnostic-report-example'],
      ['MedicationRequest', 'encounter', 'Encounter/encounter-example', 'medication-request-example'],
      ['MedicationDispense', 'prescription', 'MedicationRequest/medication-request-example', 'medication-dispense-example'],
      ['Composition', 'patient', 'Patient/patient-example', 'composition-example'],
      ['Provenance', 'target', 'Composition/composition-example', 'provenance-example'],
    ] as const

    for (const [resourceType, parameter, reference, expectedId] of searches) {
      const result = repository.search(
        context,
        resourceType,
        new URLSearchParams({ [parameter]: reference, _total: 'accurate' }),
      )
      expect(result.total).toBe(1)
      expect(result.resources.map(resource => resource.id)).toEqual([expectedId])
    }

    database.close()
  })
})
