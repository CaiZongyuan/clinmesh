import { createApp } from './app.ts'
import { IdentityService } from './application/identity-service.ts'
import { CommandExecutor, type ActorContext } from './application/command-executor.ts'
import { ScenarioService } from './application/scenario-service.ts'
import { ReferenceDataService } from './application/reference-data-service.ts'
import { ScenarioDataService } from './application/scenario-data/scenario-data-service.ts'
import { UnavailableScenarioGenerationProvider } from './application/scenario-data/provider.ts'
import { WorkflowService } from './application/workflow-service.ts'
import { OutboxDispatcher } from './application/outbox-dispatcher.ts'
import { z } from 'zod'
import { scenarioModules } from '@clinmesh/contracts/scenario'
import {
  applyMigrations,
  openClinMeshDatabase,
  verifyMigrations,
} from './infrastructure/sqlite/database.ts'
import { FhirRepository } from './infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from './infrastructure/sqlite/workspace-repository.ts'
import { ScenarioDatasetRepository } from './infrastructure/sqlite/scenario-dataset-repository.ts'
import { ScenarioGenerationJobRepository } from './infrastructure/sqlite/scenario-generation-job-repository.ts'
import { SyntheticPatientProfileRepository } from './infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { SqliteReferenceDataRepository } from './infrastructure/sqlite/reference-data-repository.ts'
import {
  openReferenceDatabase,
  verifyReferenceDatabase,
  type ReferenceDatabase,
} from './infrastructure/sqlite/reference-database.ts'
import { BuiltInScenarioGenerationProvider } from './infrastructure/scenario-generation/builtin-provider.ts'
import { SyntheaScenarioGenerationProvider } from './infrastructure/scenario-generation/synthea-provider.ts'
import type { ScenarioGenerationProvider } from './application/scenario-data/provider.ts'
import type { SqlitePerformanceObserver } from './infrastructure/sqlite/performance-observer.ts'

function lisActorContext(event: {
  epoch: string
  scenarioRunId: string
  workspaceId: string
}): ActorContext {
  return {
    actorId: 'actor-lis-system',
    epoch: event.epoch,
    organizationId: 'organization-clinmesh',
    roleCode: 'lis-system',
    scenarioRunId: event.scenarioRunId,
    workspaceId: event.workspaceId,
  }
}

export interface CreateClinMeshRuntimeOptions {
  authBaseUrl: string
  authSecret: string
  autoDispatchIntervalMs?: number
  cursorSecret: string
  databasePath: string
  demoPassword: string
  migrationMode: 'apply' | 'verify'
  now?: () => Date
  performanceObserver?: SqlitePerformanceObserver
  referenceDatabasePath?: string
  syntheaProvider?: ScenarioGenerationProvider
  syntheaProviderUrl?: string
  trustedOrigins: string[]
  webRoot?: string
}

export async function createClinMeshRuntime(options: CreateClinMeshRuntimeOptions) {
  const database = openClinMeshDatabase({
    busyTimeoutMs: 5_000,
    databasePath: options.databasePath,
    ...(options.performanceObserver === undefined
      ? {}
      : { performanceObserver: options.performanceObserver }),
  })
  let referenceDatabase: ReferenceDatabase | undefined
  try {
    if (options.migrationMode === 'apply') applyMigrations(database)
    else verifyMigrations(database)
    const workspace = database.driver.prepare(
      'SELECT workspace_id FROM workspace WHERE workspace_id = ?',
    ).get('workspace-demo')
    if (workspace === undefined) {
      new WorkspaceRepository(database).install({
        epoch: 'epoch-1',
        scenarioId: 'candidate-fever-outpatient-v3',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
        workspaceName: '合成市立医院演示空间',
      })
    }
    const clockOptions = options.now === undefined ? {} : { now: options.now }
    const fhir = new FhirRepository(database, {
      cursorSecret: options.cursorSecret,
      ...clockOptions,
    })
    const commands = new CommandExecutor(database, fhir, clockOptions)
    if (options.referenceDatabasePath !== undefined) {
      referenceDatabase = openReferenceDatabase({
        busyTimeoutMs: 5_000,
        databasePath: options.referenceDatabasePath,
        readonly: true,
      })
      verifyReferenceDatabase(referenceDatabase)
    }
    const referenceData = new ReferenceDataService(
      referenceDatabase === undefined ? undefined : new SqliteReferenceDataRepository(referenceDatabase),
    )
    const hospitalReference = referenceData.hospitalReferenceSelection()
    const scenario = new ScenarioService(
      database,
      fhir,
      commands,
      hospitalReference.products,
      hospitalReference.services,
      hospitalReference.valueSetEntries,
    )
    const workflow = new WorkflowService(database, fhir, commands, {
      ...clockOptions,
      tokenSecret: options.cursorSecret,
    })
    const syntheaProvider = options.syntheaProvider
      ?? (options.syntheaProviderUrl === undefined
        ? new UnavailableScenarioGenerationProvider({
            available: false,
            maxPopulation: 10,
            modules: [...scenarioModules],
            providerId: 'synthea',
            providerName: 'Synthea',
            unavailableReason: '未配置 Synthea Provider',
          })
        : new SyntheaScenarioGenerationProvider({
            baseUrl: options.syntheaProviderUrl,
            medicalServices: hospitalReference.services,
            medicationProducts: hospitalReference.products,
            valueSetEntries: hospitalReference.valueSetEntries,
          }))
    const generationJobs = new ScenarioGenerationJobRepository(database)
    const syntheticPatientProfiles = new SyntheticPatientProfileRepository(database)
    generationJobs.requeueInterrupted(new Date().toISOString())
    const scenarioData = new ScenarioDataService({
      commands,
      jobs: generationJobs,
      providers: new Map([
        ['builtin', new BuiltInScenarioGenerationProvider(
          hospitalReference.products,
          hospitalReference.services,
          hospitalReference.valueSetEntries,
        )],
        ['synthea', syntheaProvider],
      ]),
      profiles: syntheticPatientProfiles,
      referenceData,
      repository: new ScenarioDatasetRepository(database),
      scenario,
      workflow,
    })
    scenario.ensureInitialEpoch({
      epoch: 'epoch-1',
      scenarioRunId: 'scenario-run-1',
      workspaceId: 'workspace-demo',
    })
    const identity = new IdentityService(database, {
      authBaseUrl: options.authBaseUrl,
      authSecret: options.authSecret,
      trustedOrigins: options.trustedOrigins,
    })
    await identity.seedSyntheticAccounts({
      password: options.demoPassword,
      workspaceId: 'workspace-demo',
    })
    const lisPayloadSchema = z.object({
      caseId: z.string().min(1),
      encounterId: z.string().min(1),
      patientId: z.string().min(1),
      serviceRequestId: z.string().min(1),
    })
    const laboratoryRequestPayloadSchema = z.object({
      requestId: z.string().min(1),
    })
    const pharmacyPayloadSchema = z.object({
      caseId: z.string().min(1),
      prescriptionId: z.string().min(1),
    })
    const dispatcher = new OutboxDispatcher(database, {
      handlers: {
        'laboratory.accept-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.acceptLaboratoryRequest({
            context: lisActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'laboratory.start-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.startLaboratoryRequest({
            context: lisActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'laboratory.report-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.reportLaboratoryRequest({
            context: lisActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'lis.process-order': async event => {
          workflow.processLisOrder({
            context: lisActorContext(event),
            eventId: event.eventId,
            payload: lisPayloadSchema.parse(event.payload),
          })
          return { status: 'completed' }
        },
        'pharmacy.ready': async event => {
          pharmacyPayloadSchema.parse(event.payload)
          return { status: 'completed' }
        },
      },
      leaseDurationMs: 30_000,
      leaseOwner: `runtime-${process.pid}`,
      maxAttempts: 3,
      ...clockOptions,
      retryDelayMs: 250,
    })
    let closed = false
    let dispatchCycle: Promise<void> | undefined
    let generationCycle: Promise<void> | undefined
    let closePromise: Promise<void> | undefined
    const generationAbort = new AbortController()
    const dispatchPending = (): Promise<void> => {
      if (closed) return Promise.resolve()
      if (dispatchCycle !== undefined) return dispatchCycle
      dispatchCycle = (async () => {
        for (let handled = 0; handled < 100; handled += 1) {
          if (closed || await dispatcher.dispatchOnce() === undefined) break
        }
      })().finally(() => {
        dispatchCycle = undefined
      })
      return dispatchCycle
    }
    const dispatchScenarioGenerationJobs = (): Promise<void> => {
      if (closed) return Promise.resolve()
      if (generationCycle !== undefined) return generationCycle
      generationCycle = scenarioData.processNextGenerationJob(generationAbort.signal)
        .then(() => undefined)
        .finally(() => {
          generationCycle = undefined
        })
      return generationCycle
    }
    const dispatchTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchPending().catch(() => {
            console.error('ClinMesh outbox dispatch cycle failed')
          })
        }, options.autoDispatchIntervalMs)
    const generationTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchScenarioGenerationJobs().catch(() => {
            console.error('ClinMesh Scenario generation dispatch cycle failed')
          })
        }, options.autoDispatchIntervalMs)
    const app = createApp({
      fhir: {
        repository: fhir,
        resolveContext: async request => (await identity.resolveSessionContext(request.headers)).actor,
      },
      identity,
      referenceData,
      scenario,
      scenarioData,
      workflow,
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    })
    return {
      app,
      close: (): Promise<void> => {
        if (closePromise !== undefined) return closePromise
        closed = true
        if (dispatchTimer !== undefined) clearInterval(dispatchTimer)
        if (generationTimer !== undefined) clearInterval(generationTimer)
        generationAbort.abort()
        closePromise = (async () => {
          await Promise.all([dispatchCycle, generationCycle])
          referenceDatabase?.close()
          referenceDatabase = undefined
          database.close()
        })()
        return closePromise
      },
      database,
      dispatchPending,
      dispatchScenarioGenerationJobs,
      dispatcher,
      fhir,
      identity,
      referenceData,
      scenario,
      scenarioData,
      workflow,
    }
  } catch (error) {
    referenceDatabase?.close()
    database.close()
    throw error
  }
}
