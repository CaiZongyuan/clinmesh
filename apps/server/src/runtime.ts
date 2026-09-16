import { createApp } from './app.ts'
import { IdentityService } from './application/identity-service.ts'
import { CommandExecutor, type ActorContext } from './application/command-executor.ts'
import { ScenarioService } from './application/scenario-service.ts'
import { ReferenceDataService } from './application/reference-data-service.ts'
import { ScenarioDataService } from './application/scenario-data/scenario-data-service.ts'
import { ConsultationDialogueService } from './application/consultation-dialogue-service.ts'
import { PatientPersonaService } from './application/patient-persona-service.ts'
import { LaboratoryServicePublisher } from './application/laboratory-service-publisher.ts'
import { SyntheticCaseVisitService } from './application/synthetic-case-visit-service.ts'
import {
  InvestigationService,
  investigationFailure,
} from './application/investigation-service.ts'
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
import { ScenarioGenerationJobRepository } from './infrastructure/sqlite/scenario-generation-job-repository.ts'
import { SyntheticPatientProfileRepository } from './infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { SyntheticCaseRepository } from './infrastructure/sqlite/synthetic-case-repository.ts'
import { PatientPersonaRepository } from './infrastructure/sqlite/patient-persona-repository.ts'
import { InvestigationResultRepository } from './infrastructure/sqlite/investigation-result-repository.ts'
import {
  LaboratoryServicePublicationRepository,
} from './infrastructure/sqlite/laboratory-service-publication-repository.ts'
import {
  OpenAIChatCompletionsClient,
  type JsonChatCompletionsProvider,
} from './infrastructure/ai/openai-chat-completions.ts'
import { SqliteReferenceDataRepository } from './infrastructure/sqlite/reference-data-repository.ts'
import {
  openReferenceDatabase,
  verifyReferenceDatabase,
  type ReferenceDatabase,
} from './infrastructure/sqlite/reference-database.ts'
import { SyntheaScenarioGenerationProvider } from './infrastructure/scenario-generation/synthea-provider.ts'
import { syntheticNhsaMedicationProductSnapshot } from './application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from './application/scenario-data/medical-service-snapshot.ts'
import type { ScenarioGenerationProvider } from './application/scenario-data/provider.ts'
import type { SqlitePerformanceObserver } from './infrastructure/sqlite/performance-observer.ts'
import { AgentIntegrationService } from './application/agent-integration-service.ts'
import { reportRuntimeError } from './runtime-error-reporting.ts'

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
  activeReferenceReleaseId?: string
  ai?: {
    apiKey: string
    baseUrl: string
    briefModel: string
    catalogEnrichmentModel?: string
    consultationModel?: string | undefined
    investigationModel: string
    maxResponseBytes: number
    timeoutMs: number
  }
  authBaseUrl: string
  authSecret: string
  autoDispatchIntervalMs?: number
  cursorSecret: string
  databasePath: string
  demoPassword: string
  dshBridgeSecret?: string
  migrationMode: 'apply' | 'verify'
  chatCompletionsProvider?: JsonChatCompletionsProvider
  investigationModel?: string
  catalogEnrichmentModel?: string
  consultationModel?: string
  patientPersonaModel?: string
  now?: () => Date
  outboxRetryDelayMs?: number
  performanceObserver?: SqlitePerformanceObserver
  referenceDatabasePath?: string
  referencePerformanceObserver?: SqlitePerformanceObserver
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
        ...(options.referencePerformanceObserver === undefined
          ? {}
          : { performanceObserver: options.referencePerformanceObserver }),
        readonly: true,
      })
      verifyReferenceDatabase(referenceDatabase)
    }
    const referenceData = new ReferenceDataService(
      referenceDatabase === undefined ? undefined : new SqliteReferenceDataRepository(referenceDatabase),
      options.activeReferenceReleaseId,
    )
    const generationJobs = new ScenarioGenerationJobRepository(database)
    const syntheticPatientProfiles = new SyntheticPatientProfileRepository(database)
    const syntheticCases = new SyntheticCaseRepository(database)
    const patientPersonas = new PatientPersonaRepository(database, syntheticCases)
    const investigationResults = new InvestigationResultRepository(database)
    const laboratoryServicePublications = new LaboratoryServicePublicationRepository(database)
    const chatCompletions = options.chatCompletionsProvider
      ?? (options.ai === undefined
        ? undefined
        : new OpenAIChatCompletionsClient({
            apiKey: options.ai.apiKey,
            baseUrl: options.ai.baseUrl,
            maxResponseBytes: options.ai.maxResponseBytes,
            timeoutMs: options.ai.timeoutMs,
          }))
    const patientPersonaModel = options.patientPersonaModel ?? options.ai?.briefModel
    const consultationModel = options.consultationModel ?? options.ai?.consultationModel
    const investigationModel = options.investigationModel ?? options.ai?.investigationModel
    const catalogEnrichmentModel = options.catalogEnrichmentModel
      ?? options.ai?.catalogEnrichmentModel
    const investigation = new InvestigationService({
      cases: syntheticCases,
      database,
      ...(investigationModel === undefined ? {} : { model: investigationModel }),
      profiles: syntheticPatientProfiles,
      ...(chatCompletions === undefined ? {} : { provider: chatCompletions }),
      results: investigationResults,
    })
    const workflow = new WorkflowService(database, fhir, commands, {
      investigation,
      ...clockOptions,
      referenceData,
      tokenSecret: options.cursorSecret,
    })
    const laboratoryServicePublisher = new LaboratoryServicePublisher({
      commands,
      database,
      ...(catalogEnrichmentModel === undefined ? {} : { model: catalogEnrichmentModel }),
      ...(chatCompletions === undefined ? {} : { provider: chatCompletions }),
      publications: laboratoryServicePublications,
      referenceData,
    })
    const scenario = new ScenarioService(
      database,
      fhir,
      commands,
      syntheticNhsaMedicationProductSnapshot,
      syntheticNhcMedicalServiceSnapshot,
      syntheticWstValueSetSnapshot,
      { replaySyntheticCases: input => workflow.replaySyntheticCases(input) },
    )
    const syntheaProvider = options.syntheaProvider
      ?? (options.syntheaProviderUrl === undefined
        ? new UnavailableScenarioGenerationProvider({
            available: false,
            maxPopulation: 10,
            modules: [],
            providerId: 'synthea',
            providerName: 'Synthea',
            unavailableReason: '未配置 Synthea Provider',
          })
        : new SyntheaScenarioGenerationProvider({
            baseUrl: options.syntheaProviderUrl,
          }))
    generationJobs.requeueInterrupted(new Date().toISOString())
    patientPersonas.requeueInterrupted(new Date().toISOString())
    laboratoryServicePublications.requeueInterrupted(new Date().toISOString())
    const scenarioData = new ScenarioDataService({
      cases: syntheticCases,
      commands,
      jobs: generationJobs,
      provider: syntheaProvider,
      profiles: syntheticPatientProfiles,
    })
    const patientPersona = new PatientPersonaService({
      briefs: patientPersonas,
      cases: syntheticCases,
      commands,
      ...(patientPersonaModel === undefined ? {} : { model: patientPersonaModel }),
      profiles: syntheticPatientProfiles,
      ...(chatCompletions === undefined ? {} : { provider: chatCompletions }),
    })
    const caseVisits = new SyntheticCaseVisitService({
      briefs: patientPersonas,
      cases: syntheticCases,
      profiles: syntheticPatientProfiles,
      workflow,
    })
    const consultationDialogue = new ConsultationDialogueService({
      cases: syntheticCases,
      commands,
      ...(consultationModel === undefined ? {} : { model: consultationModel }),
      ...(chatCompletions === undefined ? {} : { provider: chatCompletions }),
      workflow,
    })
    scenario.ensureInitialEpoch({
      epoch: 'epoch-1',
      scenarioRunId: 'scenario-run-1',
      workspaceId: 'workspace-demo',
    })
    laboratoryServicePublisher.ensureDefaultServices()
    const identity = new IdentityService(database, {
      authBaseUrl: options.authBaseUrl,
      authSecret: options.authSecret,
      commands,
      ...clockOptions,
      trustedOrigins: options.trustedOrigins,
    })
    await identity.seedSyntheticAccounts({
      password: options.demoPassword,
      workspaceId: 'workspace-demo',
    })
    const agentIntegration = options.dshBridgeSecret === undefined
      ? undefined
      : new AgentIntegrationService(database, {
          cases: syntheticCases,
          ...clockOptions,
          secret: options.dshBridgeSecret,
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
    const aiTimeoutMs = options.ai?.timeoutMs ?? 60_000
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
          const context = lisActorContext(event)
          try {
            const snapshot = await investigation.resolveForRequest(
              event.workspaceId,
              event.epoch,
              payload.requestId,
              AbortSignal.timeout(aiTimeoutMs),
            )
            workflow.reportLaboratoryRequest({
              context,
              eventId: event.eventId,
              requestId: payload.requestId,
              ...(snapshot === undefined
                ? {}
                : {
                    resultSnapshot: {
                      content: snapshot.content,
                      inputHash: snapshot.inputHash,
                      ...(snapshot.provenance === undefined
                        ? {}
                        : { provenance: snapshot.provenance }),
                      snapshotId: snapshot.snapshotId,
                      source: snapshot.source,
                    },
                  }),
            })
          } catch (error) {
            const failure = investigationFailure(error)
            // 无底账属于确定性失败，重试不会改变结果，直接落为生成失败。
            if (failure.code !== 'INVESTIGATION_UNSUPPORTED' && event.attempt < 3) {
              return { status: 'retryable-failed' }
            }
            workflow.failLaboratoryResultGeneration({
              context,
              error: failure,
              eventId: event.eventId,
              requestId: payload.requestId,
            })
          }
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
      leaseDurationMs: aiTimeoutMs + 5_000,
      leaseOwner: `runtime-${process.pid}`,
      maxAttempts: 3,
      ...clockOptions,
      retryDelayMs: options.outboxRetryDelayMs ?? 250,
    })
    let closed = false
    let dispatchCycle: Promise<void> | undefined
    let generationCycle: Promise<void> | undefined
    let patientPersonaCycle: Promise<void> | undefined
    let laboratoryServicePublicationCycle: Promise<void> | undefined
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
    const dispatchPatientPersonaJobs = (): Promise<void> => {
      if (closed) return Promise.resolve()
      if (patientPersonaCycle !== undefined) return patientPersonaCycle
      patientPersonaCycle = patientPersona.processNext(generationAbort.signal)
        .then(() => undefined)
        .finally(() => {
          patientPersonaCycle = undefined
        })
      return patientPersonaCycle
    }
    const dispatchLaboratoryServicePublicationJobs = (): Promise<void> => {
      if (closed) return Promise.resolve()
      if (laboratoryServicePublicationCycle !== undefined) {
        return laboratoryServicePublicationCycle
      }
      laboratoryServicePublicationCycle = laboratoryServicePublisher.processNext(
        generationAbort.signal,
      ).then(() => undefined).finally(() => {
        laboratoryServicePublicationCycle = undefined
      })
      return laboratoryServicePublicationCycle
    }
    const dispatchTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchPending().catch(error => {
            reportRuntimeError({ error, scope: 'outbox-dispatch' })
          })
        }, options.autoDispatchIntervalMs)
    const generationTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchScenarioGenerationJobs().catch(error => {
            reportRuntimeError({ error, scope: 'scenario-generation-dispatch' })
          })
        }, options.autoDispatchIntervalMs)
    const patientPersonaTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchPatientPersonaJobs().catch(error => {
            reportRuntimeError({ error, scope: 'patient-brief-dispatch' })
          })
        }, options.autoDispatchIntervalMs)
    const laboratoryServicePublicationTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchLaboratoryServicePublicationJobs().catch(error => {
            reportRuntimeError({ error, scope: 'laboratory-service-publication-dispatch' })
          })
        }, options.autoDispatchIntervalMs)
    const app = createApp({
      ...(agentIntegration === undefined ? {} : { agentIntegration }),
      fhir: {
        repository: fhir,
        resolveContext: request => identity.resolveRequestActor(
          request.headers,
          request.method,
          new URL(request.url).pathname,
        ),
      },
      identity,
      investigation,
      caseVisits,
      patientPersona,
      consultationDialogue,
      laboratoryServicePublisher,
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
        if (patientPersonaTimer !== undefined) clearInterval(patientPersonaTimer)
        if (laboratoryServicePublicationTimer !== undefined) {
          clearInterval(laboratoryServicePublicationTimer)
        }
        generationAbort.abort()
        closePromise = (async () => {
          await Promise.all([
            dispatchCycle,
            generationCycle,
            laboratoryServicePublicationCycle,
            patientPersonaCycle,
          ])
          referenceDatabase?.close()
          referenceDatabase = undefined
          database.close()
        })()
        return closePromise
      },
      database,
      dispatchPending,
      dispatchScenarioGenerationJobs,
      dispatchPatientPersonaJobs,
      dispatchLaboratoryServicePublicationJobs,
      dispatcher,
      fhir,
      identity,
      caseVisits,
      investigation,
      laboratoryServicePublisher,
      patientPersona,
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
