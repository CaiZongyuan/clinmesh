import { ModelTaskRecovery, modelControlWaitingCount } from './application/model-task-recovery.ts'
import { InpatientService } from './application/inpatient-service.ts'
import { InpatientInsuranceSource } from './application/inpatient-insurance-source.ts'
import { loadDrgRules, loadReviewedDrgRules } from './infrastructure/reference-data/drg-rules-package.ts'
import { createApp } from './app.ts'
import { ModelUsageService } from './application/model-usage-service.ts'
import type { ModelUsagePolicyConfig } from '@clinmesh/contracts/model-usage'
import type { ModelPricingConfig } from '@clinmesh/contracts/model-pricing'
import { IdentityService } from './application/identity-service.ts'
import { CommandExecutor, type ActorContext } from './application/command-executor.ts'
import { ScenarioService } from './application/scenario-service.ts'
import { ReferenceDataService } from './application/reference-data-service.ts'
import { ScenarioDataService } from './application/scenario-data/scenario-data-service.ts'
import { ConsultationDialogueService } from './application/consultation-dialogue-service.ts'
import type { DevReflectionConfig } from './application/agent-dev-reflection.ts'
import { AgentSessionService } from './application/agent-session-service.ts'
import { createVisibleCaseReader } from './application/agent-clinical-reader.ts'
import { ClinMeshProviderRegistry, type CustomMockResponder } from './infrastructure/agents/byok-provider-resolver.ts'
import type { LocalCliProviderDiscoveryOptions } from './infrastructure/agents/local-cli-providers.ts'
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
import { existsSync } from 'node:fs'
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
import { syntheticNhsaMedicationProductSnapshot } from './application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from './application/scenario-data/medical-service-snapshot.ts'
import type { ScenarioGenerationProvider } from './application/scenario-data/provider.ts'
import type { SqlitePerformanceObserver } from './infrastructure/sqlite/performance-observer.ts'
import { reportRuntimeError } from './runtime-error-reporting.ts'
import { GenerationModelBinding } from './application/generation-model-binding.ts'
import { DoctorRecommendationsService } from './application/doctor-recommendations-service.ts'
import { GuidelineCorpus } from './infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineDeploymentPolicy } from './application/guideline-corpus.ts'
import { ImagingPreparationService } from './application/imaging-preparation-service.ts'
import { ExaminationResultResolver } from './application/examination-result-resolver.ts'
import { ImagingStudyReader } from './application/imaging-study-reader.ts'
import { PathologyPreparationService } from './application/pathology-preparation-service.ts'
import {
  PathologyResultResolver,
  PathologyResultUnavailableError,
} from './application/pathology-result-resolver.ts'
import { PathologySlideReader } from './application/pathology-slide-reader.ts'
import {
  ImagingResultResolver,
  ImagingResultUnavailableError,
} from './application/imaging-result-resolver.ts'
import { ImagingAssetLibrary } from './infrastructure/imaging-assets/imaging-asset-library.ts'
import { PathologyAssetLibrary } from './infrastructure/imaging-assets/pathology-asset-library.ts'
import { ImagingPreparationRepository } from './infrastructure/sqlite/imaging-preparation-repository.ts'
import { PathologyPreparationRepository } from './infrastructure/sqlite/pathology-preparation-repository.ts'

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

function risActorContext(event: {
  epoch: string
  scenarioRunId: string
  workspaceId: string
}): ActorContext {
  return {
    actorId: 'actor-ris-system',
    epoch: event.epoch,
    organizationId: 'organization-clinmesh',
    roleCode: 'ris-system',
    scenarioRunId: event.scenarioRunId,
    workspaceId: event.workspaceId,
  }
}

function pathologyActorContext(event: {
  epoch: string
  scenarioRunId: string
  workspaceId: string
}): ActorContext {
  return {
    actorId: 'actor-pathology-system',
    epoch: event.epoch,
    organizationId: 'organization-clinmesh',
    roleCode: 'pathology-system',
    scenarioRunId: event.scenarioRunId,
    workspaceId: event.workspaceId,
  }
}

export interface CreateClinMeshRuntimeOptions {
  modelUsageControl?: ModelUsagePolicyConfig
  modelPricing?: ModelPricingConfig
  devReflection?: DevReflectionConfig
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
  /** DRG 规则数据包目录（含 manifest.json）；缺省时住院 DRG 预分组返回未配置错误。 */
  drgRulesDirectory?: string
  /** 部署启用审核；正常服务入口必须提供。省略仅供受控规则注入测试使用。 */
  drgRulesReviewPath?: string
  guidelineDatabasePath?: string
  guidelineNonCommercialUse?: boolean
  guidelineDeploymentPolicy?: GuidelineDeploymentPolicy
  guidelineLocalEvaluation?: boolean
  demoPassword: string
  imagingAssetDirectory?: string
  imagingCatalogDirectory?: string
  pathologyAssetDirectory?: string
  pathologyCatalogDirectory?: string
  migrationMode: 'apply' | 'verify'
  chatCompletionsProvider?: JsonChatCompletionsProvider
  mockResponder?: CustomMockResponder
  mockTokensPerSecond?: number
  localProviders?: LocalCliProviderDiscoveryOptions
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
  let guidelineCorpus: GuidelineCorpus | undefined
  let agentSessions: AgentSessionService | undefined
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
    if (options.guidelineDatabasePath !== undefined && existsSync(options.guidelineDatabasePath)) {
      guidelineCorpus = new GuidelineCorpus({ databasePath: options.guidelineDatabasePath, readOnly: true,
        allowNonCommercial: options.guidelineNonCommercialUse === true,
        deploymentPolicy: options.guidelineDeploymentPolicy ?? 'default',
        allowLocalEvaluation: options.guidelineLocalEvaluation === true })
    }
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
      (context, outcome, inventoryIds) => commands.auditRead(context, 'reference.offline-inventories.read', { inventoryIds }, outcome),
    )
    const generationJobs = new ScenarioGenerationJobRepository(database)
    const syntheticPatientProfiles = new SyntheticPatientProfileRepository(database)
    const syntheticCases = new SyntheticCaseRepository(database)
    const patientPersonas = new PatientPersonaRepository(database, syntheticCases)
    const investigationResults = new InvestigationResultRepository(database)
    const laboratoryServicePublications = new LaboratoryServicePublicationRepository(database)
    const modelUsage = new ModelUsageService(database, commands, options.modelUsageControl, options.modelPricing)
    const unaccountedChatCompletions: JsonChatCompletionsProvider | undefined = options.chatCompletionsProvider
      ?? (options.ai === undefined
        ? undefined
        : new OpenAIChatCompletionsClient({
            apiKey: options.ai.apiKey,
            baseUrl: options.ai.baseUrl,
            maxResponseBytes: options.ai.maxResponseBytes,
            timeoutMs: options.ai.timeoutMs,
          }))
    const chatCompletions: JsonChatCompletionsProvider | undefined = unaccountedChatCompletions === undefined ? undefined : {
      ...(unaccountedChatCompletions.supportsUsageAccounting === undefined ? {} : { supportsUsageAccounting: unaccountedChatCompletions.supportsUsageAccounting }),
      ...(unaccountedChatCompletions.supportsRequestControl === undefined ? {} : { supportsRequestControl: unaccountedChatCompletions.supportsRequestControl }),
      ...(unaccountedChatCompletions.resolveModel === undefined ? {} : { resolveModel: (model, signal) => unaccountedChatCompletions.resolveModel!(model, signal) }),
      completeJson: input => modelUsage.run(input.usageContext?.workspaceId ?? 'workspace-demo', input.signal,
        signal => unaccountedChatCompletions.completeJson({ ...input, signal, usageRecorder: modelUsage })),
    }
    const modelTasks = new ModelTaskRecovery(database, modelUsage)
    const recoverableChatCompletions = chatCompletions === undefined ? undefined : modelTasks.provider(chatCompletions)
    const models = new GenerationModelBinding(database, chatCompletions)
    const patientPersonaModel = options.patientPersonaModel ?? options.ai?.briefModel
    const consultationModel = options.consultationModel ?? options.ai?.consultationModel
    const investigationModel = options.investigationModel ?? options.ai?.investigationModel
    const catalogEnrichmentModel = options.catalogEnrichmentModel
      ?? options.ai?.catalogEnrichmentModel
    const investigation = new InvestigationService({
      models,
      cases: syntheticCases,
      database,
      ...(investigationModel === undefined ? {} : { model: investigationModel }),
      profiles: syntheticPatientProfiles,
      ...(recoverableChatCompletions === undefined ? {} : { provider: recoverableChatCompletions }),
      results: investigationResults,
    })
    const workflow: WorkflowService = new WorkflowService(database, fhir, commands, {
      readInpatientInsuranceSource: (context, target) => {
        if (target.kind !== 'inpatient') throw new Error('Expected an inpatient insurance source')
        return inpatientInsurance.read(context, { kind: 'inpatient', id: target.id })
      },
      assertInpatientInsuranceChangeAllowed: (context, source) => inpatientInsurance.assertFirstSettlementWritable(context, source.target.id),
      ...(guidelineCorpus === undefined ? {} : { guidelines: guidelineCorpus }),
      investigation,
      ...clockOptions,
      referenceData,
      tokenSecret: options.cursorSecret,
    })
    const drgRules = options.drgRulesDirectory === undefined ? null
      : options.drgRulesReviewPath === undefined ? await loadDrgRules(options.drgRulesDirectory)
        : await loadReviewedDrgRules({ directory: options.drgRulesDirectory, reviewPath: options.drgRulesReviewPath,
            referenceReleaseId: options.activeReferenceReleaseId })
    const inpatient = new InpatientService(database, fhir, commands, referenceData, workflow, drgRules,
      context => identity.modelTaskContextStatus(context, ['inpatient.drg.followup.start']),
      (context, operations) => identity.modelTaskContextStatus(context, operations), guidelineCorpus)
    const inpatientInsurance = new InpatientInsuranceSource(inpatient)
    const laboratoryServicePublisher = new LaboratoryServicePublisher({
      canResume: (workspaceId, taskId) => modelTasks.claimable(workspaceId, taskId),
      contextStatus: context => identity.modelTaskContextStatus(context, ['admin.laboratory-services.publish']),
      models,
      commands,
      database,
      ...(catalogEnrichmentModel === undefined ? {} : { model: catalogEnrichmentModel }),
      ...(recoverableChatCompletions === undefined ? {} : { provider: recoverableChatCompletions }),
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
      { replaySyntheticCases: input => { workflow.replaySyntheticCases(input); caseVisits.replayInpatientCases(input) } },
    )
    const syntheaProvider = options.syntheaProvider
      ?? new UnavailableScenarioGenerationProvider({
        available: false,
        maxPopulation: 10,
        modules: [],
        providerId: 'synthea',
        providerName: 'Synthea',
        unavailableReason: 'Synthea dynamic generation is disabled; use Authored Case Pack.',
      })
    generationJobs.requeueInterrupted(new Date().toISOString())
    patientPersonas.requeueInterrupted(new Date().toISOString())
    laboratoryServicePublications.requeueInterrupted(new Date().toISOString())
    const patientPersona = new PatientPersonaService({
      canResume: (workspaceId, taskId) => modelTasks.claimable(workspaceId, taskId),
      contextStatus: context => identity.modelTaskContextStatus(context),
      models,
      briefs: patientPersonas,
      cases: syntheticCases,
      commands,
      ...(patientPersonaModel === undefined ? {} : { model: patientPersonaModel }),
      profiles: syntheticPatientProfiles,
      ...(recoverableChatCompletions === undefined ? {} : { provider: recoverableChatCompletions }),
    })
    const imagingLibrary = new ImagingAssetLibrary({
      assetDirectory: options.imagingAssetDirectory,
      catalogDirectory: options.imagingCatalogDirectory,
    })
    const imagingPreparations = new ImagingPreparationRepository(database)
    const imagingResults = new ImagingResultResolver({
      database,
      library: imagingLibrary,
      preparations: imagingPreparations,
    })
    const imagingPreparation = new ImagingPreparationService({
      cases: syntheticCases,
      commands,
      library: imagingLibrary,
      preparations: imagingPreparations,
      profiles: syntheticPatientProfiles,
    })
    // 病理素材包与放射素材包各自独立：任一目录缺失或损坏只影响自己的会诊与准备。
    const pathologyLibrary = new PathologyAssetLibrary({
      assetDirectory: options.pathologyAssetDirectory,
      catalogDirectory: options.pathologyCatalogDirectory,
    })
    const pathologyPreparations = new PathologyPreparationRepository(database)
    const pathologyResults = new PathologyResultResolver({
      database,
      library: pathologyLibrary,
      preparations: pathologyPreparations,
    })
    const pathologyPreparation = new PathologyPreparationService({
      cases: syntheticCases,
      commands,
      library: pathologyLibrary,
      preparations: pathologyPreparations,
      profiles: syntheticPatientProfiles,
    })
    const scenarioData = new ScenarioDataService({
      personas: patientPersonas,
      cases: syntheticCases,
      commands,
      jobs: generationJobs,
      provider: syntheaProvider,
      profiles: syntheticPatientProfiles,
      // 定向目标按类别交给拥有对应素材包的病例准备。
      targets: {
        generationHistoryYears: async target => target.kind === 'pathology-profile'
          ? await pathologyPreparation.generationHistoryYears(target)
          : undefined,
        generationKeep: target => target.kind === 'pathology-profile'
          ? pathologyPreparation.generationKeep(target)
          : imagingPreparation.generationKeep(target),
        generationTargetMet: (target, candidate) => target.kind === 'pathology-profile'
          ? pathologyPreparation.generationTargetMet(target, candidate)
          : imagingPreparation.generationTargetMet(target, candidate),
        prepareBatch: (target, input) => target.kind === 'pathology-profile'
          ? pathologyPreparation.prepareBatch(input)
          : imagingPreparation.prepareBatch(input),
      },
    })
    const caseVisits = new SyntheticCaseVisitService({
      inpatient,
      briefs: patientPersonas,
      cases: syntheticCases,
      profiles: syntheticPatientProfiles,
      workflow,
    })
    const providerRegistry = new ClinMeshProviderRegistry({
      ...(options.ai === undefined
        ? {}
        : {
            serverDefault: {
              provider: 'openai-compatible',
              baseUrl: options.ai.baseUrl,
              apiKey: options.ai.apiKey,
              defaultModel: options.ai.consultationModel ?? options.ai.briefModel,
              patientModel: options.ai.consultationModel,
              timeoutMs: options.ai.timeoutMs,
            },
          }),
      ...(recoverableChatCompletions === undefined ? {} : { injectedChatCompletions: recoverableChatCompletions }),
      ...(options.mockResponder === undefined ? {} : { mockResponder: options.mockResponder }),
      ...(options.mockTokensPerSecond === undefined ? {} : { mockTokensPerSecond: options.mockTokensPerSecond }),
      ...(options.localProviders === undefined ? {} : { localProviders: options.localProviders }),
    })
    agentSessions = await AgentSessionService.open({
      database,
      providers: providerRegistry,
      visibleCaseReader: createVisibleCaseReader((actor, caseId) => workflow.doctorCaseDetail(actor, caseId)),
      ...(options.devReflection === undefined ? {} : { devReflection: options.devReflection }),
      onReport: (_scope, error) => reportRuntimeError({ error, scope: 'agent-runtime' }),
    })
    const consultationDialogue = new ConsultationDialogueService({
      canResume: (workspaceId, taskId) => modelTasks.ready(workspaceId, taskId),
      contextStatus: context => identity.modelTaskContextStatus(context, ['consultation.ask-question', 'consultation.reply.retry']),
      database,
      models,
      cases: syntheticCases,
      commands,
      fhir,
      agentSessions,
      ...(consultationModel === undefined ? {} : { model: consultationModel }),
      ...(recoverableChatCompletions === undefined ? {} : { provider: recoverableChatCompletions }),
      workflow,
    })
    scenario.ensureInitialEpoch({
      epoch: 'epoch-1',
      scenarioRunId: 'scenario-run-1',
      workspaceId: 'workspace-demo',
    })
    laboratoryServicePublisher.ensureDefaultServices()
    laboratoryServicePublisher.ensureInpatientPrices()
    workflow.examination.ensureServices()
    const examinationResults = new ExaminationResultResolver(database)
    workflow.imaging.ensureServices()
    workflow.pathology.ensureServices()
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
    modelUsage.setWaitingCount(workspaceId => modelControlWaitingCount(database, workspaceId))
    const lisPayloadSchema = z.object({
      caseId: z.string().min(1),
      encounterId: z.string().min(1),
      patientId: z.string().min(1),
      serviceRequestId: z.string().min(1),
    })
    const laboratoryRequestPayloadSchema = z.object({
      generationAttempt: z.number().int().positive().optional(),
      requestId: z.string().min(1),
    })
    const pharmacyPayloadSchema = z.object({
      caseId: z.string().min(1),
      prescriptionId: z.string().min(1),
    })
    const aiTimeoutMs = options.ai?.timeoutMs ?? 60_000
    const recommendationTimeoutMs = 2 * aiTimeoutMs
    const recommendationModel = consultationModel ?? investigationModel ?? patientPersonaModel
    const doctorRecommendations = new DoctorRecommendationsService({
      database,
      workflow,
      commands,
      referenceData,
      contextStatus: context => identity.doctorTaskContextStatus(context),
      investigationCatalogs: async (context, caseId, kind) => {
        if (kind === 'imaging') return { imaging: workflow.imaging.serviceCatalog(context, await imagingLibrary.readyExamCodes()) }
        const offering = await pathologyPreparation.offering(context, { outpatientCaseId: caseId })
        return { pathology: workflow.pathology.serviceCatalog(context, offering.readyExamCodes, offering.sourceProcedures) }
      },
    })
    const dispatcher = new OutboxDispatcher(database, {
      handlers: {
        'inpatient.angiography.report': event => inpatient.angiography.process(event, lisActorContext(event)),
        'inpatient.drg.agent.analyze': event => inpatient.drgAgent.process(event, {
          models, recovery: modelTasks, signal: AbortSignal.any([generationAbort.signal, AbortSignal.timeout(recommendationTimeoutMs)]),
          ...(recommendationModel === undefined ? {} : { model: recommendationModel }),
          ...(recoverableChatCompletions === undefined ? {} : { provider: recoverableChatCompletions }),
        }),
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
          const current = () => database.driver.prepare(`SELECT 1 FROM laboratory_request r
            JOIN workspace w ON w.workspace_id = r.workspace_id AND w.active_epoch = r.epoch
            JOIN workspace_epoch e ON e.workspace_id = w.workspace_id AND e.epoch = w.active_epoch AND e.state = 'active'
            WHERE r.workspace_id = ? AND r.epoch = ? AND r.request_id = ? AND r.status = 'in-progress'`)
            .get(event.workspaceId, event.epoch, payload.requestId) !== undefined
          if (!current()) return { status: 'completed' }
          try {
            const snapshot = await investigation.resolveForRequest(
              event.workspaceId,
              event.epoch,
              payload.requestId,
              AbortSignal.any([generationAbort.signal, AbortSignal.timeout(aiTimeoutMs)]),
              payload.generationAttempt,
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
            if (!current()) return { status: 'completed' }
            const deferred = modelTasks.defer(event, error)
            if (deferred?.status === 'ambiguous') workflow.failLaboratoryResultGeneration({
              context, eventId: event.eventId, requestId: payload.requestId,
              error: { code: 'MODEL_OUTCOME_UNKNOWN', message: '模型请求结果未知，已停止自动重发。' },
            })
            if (deferred !== undefined) return deferred
            const failure = investigationFailure(error)
            // 无底账或精确真值不兼容均无法通过自动重试恢复。
            if (failure.code !== 'INVESTIGATION_UNSUPPORTED'
              && failure.code !== 'INVESTIGATION_TRUTH_INCOMPATIBLE' && event.attempt < 3
              && modelUsage.automaticRetries(event.workspaceId)) {
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
        'examination.accept-request': async event => {
          workflow.examination.accept({ context: risActorContext(event), eventId: event.eventId, requestId: laboratoryRequestPayloadSchema.parse(event.payload).requestId })
          return { status: 'completed' }
        },
        'examination.start-request': async event => {
          workflow.examination.start({ context: risActorContext(event), eventId: event.eventId, requestId: laboratoryRequestPayloadSchema.parse(event.payload).requestId })
          return { status: 'completed' }
        },
        'examination.report-request': async event => {
          const context = risActorContext(event), requestId = laboratoryRequestPayloadSchema.parse(event.payload).requestId
          try { workflow.examination.report({ context, eventId: event.eventId, requestId, result: examinationResults.resolve(event.workspaceId,event.epoch,requestId) }) }
          catch (error) {
            const failure = investigationFailure(error)
            if (!['INVESTIGATION_UNSUPPORTED','INVESTIGATION_TRUTH_INCOMPATIBLE','INVESTIGATION_OUTPUT_INVALID'].includes(failure.code) && event.attempt < 3) return { status: 'retryable-failed' }
            workflow.examination.fail({ context, eventId: event.eventId, requestId, error: failure })
          }
          return { status: 'completed' }
        },
        'imaging.accept-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.imaging.accept({
            context: risActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'imaging.start-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.imaging.start({
            context: risActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'imaging.report-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          const context = risActorContext(event)
          try {
            const result = await imagingResults.resolveForRequest(event.workspaceId, event.epoch, payload.requestId)
            workflow.imaging.report({ context, eventId: event.eventId, requestId: payload.requestId, result })
          } catch (error) {
            // 未准备、未覆盖或素材不可用属于确定性失败，直接落为未取得结果；其他故障最多自动尝试三次，
            // 之后同样落为未取得结果，医生可以重试或取消，申请不会停在检查中。
            const unavailable = error instanceof ImagingResultUnavailableError
            if (!unavailable && event.attempt < 3) return { status: 'retryable-failed' }
            workflow.imaging.fail({
              context,
              error: unavailable
                ? { code: 'IMAGING_RESULT_UNAVAILABLE', message: 'The imaging result is not available for this examination' }
                : { code: 'IMAGING_RESULT_FAILED', message: 'The imaging result could not be produced' },
              eventId: event.eventId,
              requestId: payload.requestId,
            })
          }
          return { status: 'completed' }
        },
        'pathology.accept-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.pathology.accept({
            context: pathologyActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'pathology.start-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          workflow.pathology.start({
            context: pathologyActorContext(event),
            eventId: event.eventId,
            requestId: payload.requestId,
          })
          return { status: 'completed' }
        },
        'pathology.report-request': async event => {
          const payload = laboratoryRequestPayloadSchema.parse(event.payload)
          const context = pathologyActorContext(event)
          try {
            const result = await pathologyResults.resolveForRequest(event.workspaceId, event.epoch, payload.requestId)
            workflow.pathology.report({ context, eventId: event.eventId, requestId: payload.requestId, result })
          } catch (error) {
            // 与放射相同：未准备、未覆盖或切片不可用直接落为未取得结果；其他故障最多自动尝试三次。
            const unavailable = error instanceof PathologyResultUnavailableError
            if (!unavailable && event.attempt < 3) return { status: 'retryable-failed' }
            workflow.pathology.fail({
              context,
              error: unavailable
                ? { code: 'PATHOLOGY_RESULT_UNAVAILABLE', message: 'The pathology result is not available for this consultation' }
                : { code: 'PATHOLOGY_RESULT_FAILED', message: 'The pathology result could not be produced' },
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
      leaseDurationMs: recommendationTimeoutMs + 5_000,
      leaseOwner: `runtime-${process.pid}`,
      maxAttempts: 3,
      ...clockOptions,
      retryDelayMs: options.outboxRetryDelayMs ?? 250,
    })
    let closed = false
    const dispatchCycles = new Map<string, Promise<number>>()
    let generationCycle: Promise<void> | undefined
    let patientPersonaCycle: Promise<void> | undefined
    let laboratoryServicePublicationCycle: Promise<void> | undefined
    let closePromise: Promise<void> | undefined
    const generationAbort = new AbortController()
    const lanes = [
      { id: 'business', concurrency: 2, filter: {} },
    ]
    const pumpSlot = (lane: typeof lanes[number], slot: number): Promise<number> => {
      const key = `${lane.id}:${slot}`
      const running = dispatchCycles.get(key)
      if (running !== undefined) return running
      const cycle = (async () => {
        let handled = 0
        while (!closed && handled < 100 && await dispatcher.dispatchOnce(lane.filter) !== undefined) handled += 1
        return handled
      })().finally(() => dispatchCycles.delete(key))
      dispatchCycles.set(key, cycle)
      return cycle
    }
    const dispatchPending = async (): Promise<void> => {
      inpatient.drgReview.refreshPending()
      inpatient.materialEstimates.refreshPending()
      modelTasks.wake()
      const dialogueRecovery = consultationDialogue.resumePending()
      for (let round = 0; !closed && round < 100; round += 1) {
        const counts = await Promise.all(lanes.map(lane => Promise.all(Array.from(
          { length: lane.concurrency }, (_, slot) => pumpSlot(lane, slot)))))
        if (counts.every(lane => lane.every(count => count === 0))) break
      }
      await dialogueRecovery
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
    const unsubscribeModelRecovery = modelUsage.subscribe(() => {
      modelTasks.wake()
      void dispatchPending().catch(error => reportRuntimeError({ error, scope: 'outbox-dispatch' }))
      void dispatchPatientPersonaJobs().catch(error => reportRuntimeError({ error, scope: 'patient-brief-dispatch' }))
      void dispatchLaboratoryServicePublicationJobs().catch(error => reportRuntimeError({ error, scope: 'laboratory-service-publication-dispatch' }))
    })
    const dispatchTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          modelTasks.wake()
          try { inpatient.drgReview.refreshPending(); inpatient.materialEstimates.refreshPending() } catch (error) { reportRuntimeError({ error, scope: 'outbox-dispatch' }) }
          void consultationDialogue.resumePending().catch(error => reportRuntimeError({ error, scope: 'outbox-dispatch' }))
          for (const lane of lanes) for (let slot = 0; slot < lane.concurrency; slot++) {
            if (dispatchCycles.has(`${lane.id}:${slot}`)) continue
            void pumpSlot(lane, slot).catch(error => {
              reportRuntimeError({ error, scope: 'outbox-dispatch' })
            })
          }
        }, options.autoDispatchIntervalMs)
    const laboratoryServicePublicationTimer = options.autoDispatchIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void dispatchLaboratoryServicePublicationJobs().catch(error => {
            reportRuntimeError({ error, scope: 'laboratory-service-publication-dispatch' })
          })
        }, options.autoDispatchIntervalMs)
    const app = createApp({
      modelUsage,
      inpatient,
      doctorRecommendations,
      fhir: {
        repository: fhir,
        resolveContext: request => identity.resolveRequestActor(
          request.headers,
          request.method,
          new URL(request.url).pathname,
        ),
      },
      identity,
      imaging: {
        library: imagingLibrary,
        reader: new ImagingStudyReader({
          library: imagingLibrary,
          studyAccess: (context, studyId) => workflow.imaging.studyAccess(context, studyId),
        }),
        results: imagingResults,
      },
      imagingPreparation,
      pathology: {
        preparation: pathologyPreparation,
        reader: new PathologySlideReader({
          library: pathologyLibrary,
          studyAccess: (context, studyId) => workflow.pathology.studyAccess(context, studyId),
        }),
        results: pathologyResults,
      },
      investigation,
      caseVisits,
      patientPersona,
      consultationDialogue,
      agentSessions,
      laboratoryServicePublisher,
      referenceData,
      scenario,
      scenarioData,
      workflow,
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    })
    agentSessions.attachHttpDispatcher({
      dispatch: request => Promise.resolve(app.fetch(request)),
    })
    const modelUsageRetentionTimer = setInterval(() => {
      try { modelUsage.compactUsage() } catch (error) { reportRuntimeError({ error, scope: 'model-usage-retention' }) }
    }, 60 * 60 * 1000)
    modelUsageRetentionTimer.unref()
    return {
      agentSessions,
      app,
      close: (): Promise<void> => {
        if (closePromise !== undefined) return closePromise
        closed = true
        clearInterval(modelUsageRetentionTimer)
        if (dispatchTimer !== undefined) clearInterval(dispatchTimer)
        if (laboratoryServicePublicationTimer !== undefined) {
          clearInterval(laboratoryServicePublicationTimer)
        }
        generationAbort.abort()
        unsubscribeModelRecovery()
        inpatient.followup.close()
        inpatient.drgAgent.close()
        inpatient.materialEstimates.close()
        inpatient.drgReview.close()
        closePromise = (async () => {
          await Promise.all([
            consultationDialogue.close(),
            ...dispatchCycles.values(),
            generationCycle,
            laboratoryServicePublicationCycle,
            patientPersonaCycle,
          ])
          await agentSessions?.close()
          referenceDatabase?.close()
          referenceDatabase = undefined
          guidelineCorpus?.close()
          guidelineCorpus = undefined
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
      doctorRecommendations,
      fhir,
      identity,
      imagingResults,
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
    await agentSessions?.close().catch(() => undefined)
    referenceDatabase?.close()
    guidelineCorpus?.close()
    database.close()
    throw error
  }
}
