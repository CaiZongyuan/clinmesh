import { createApp } from './app.ts'
import { IdentityService } from './application/identity-service.ts'
import { CommandExecutor, type ActorContext } from './application/command-executor.ts'
import { ScenarioService } from './application/scenario-service.ts'
import { ScenarioDataService } from './application/scenario-data/scenario-data-service.ts'
import { UnavailableScenarioGenerationProvider } from './application/scenario-data/provider.ts'
import { WorkflowService } from './application/workflow-service.ts'
import { OutboxDispatcher } from './application/outbox-dispatcher.ts'
import { z } from 'zod'
import {
  applyMigrations,
  openClinMeshDatabase,
  verifyMigrations,
} from './infrastructure/sqlite/database.ts'
import { FhirRepository } from './infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from './infrastructure/sqlite/workspace-repository.ts'
import { ScenarioDatasetRepository } from './infrastructure/sqlite/scenario-dataset-repository.ts'
import { BuiltInScenarioGenerationProvider } from './infrastructure/scenario-generation/builtin-provider.ts'

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
  trustedOrigins: string[]
  webRoot?: string
}

export async function createClinMeshRuntime(options: CreateClinMeshRuntimeOptions) {
  const database = openClinMeshDatabase({
    busyTimeoutMs: 5_000,
    databasePath: options.databasePath,
  })
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
    const scenario = new ScenarioService(database, fhir, commands)
    const scenarioData = new ScenarioDataService({
      commands,
      providers: new Map([
        ['builtin', new BuiltInScenarioGenerationProvider()],
        ['synthea', new UnavailableScenarioGenerationProvider({
          available: false,
          maxPopulation: 500,
          modules: ['fever', 'type-2-diabetes'],
          providerId: 'synthea',
          providerName: 'Synthea',
          unavailableReason: '未配置 Synthea Provider',
        })],
      ]),
      repository: new ScenarioDatasetRepository(database),
      scenario,
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
    const workflow = new WorkflowService(database, fhir, commands, {
      ...clockOptions,
      tokenSecret: options.cursorSecret,
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
    let closePromise: Promise<void> | undefined
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
    const dispatchTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchPending().catch(() => {
            console.error('ClinMesh outbox dispatch cycle failed')
          })
        }, options.autoDispatchIntervalMs)
    const app = createApp({
      fhir: {
        repository: fhir,
        resolveContext: async request => (await identity.resolveSessionContext(request.headers)).actor,
      },
      identity,
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
        closePromise = (async () => {
          await dispatchCycle
          database.close()
        })()
        return closePromise
      },
      database,
      dispatchPending,
      dispatcher,
      fhir,
      identity,
      scenario,
      scenarioData,
      workflow,
    }
  } catch (error) {
    database.close()
    throw error
  }
}
