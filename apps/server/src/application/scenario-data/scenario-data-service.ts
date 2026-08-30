import { randomUUID } from 'node:crypto'
import {
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  scenarioDatasetContentSchema,
  scenarioDatasetSchema,
  type ScenarioDataset,
  type ScenarioGenerationJob,
  type ScenarioGenerationRequest,
  syntheticPatientProfileListSchema,
  syntheticPatientProfileDetailSchema,
  syntheticPatientProfileSchema,
  startSyntheticPatientVisitsRequestSchema,
  type SyntheticPatientIdentity,
  type SyntheticPatientMappingInput,
} from '@clinmesh/contracts/scenario'
import { scenarioStateSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import type { ScenarioDatasetRepository } from '../../infrastructure/sqlite/scenario-dataset-repository.ts'
import type { ScenarioGenerationJobRepository } from '../../infrastructure/sqlite/scenario-generation-job-repository.ts'
import type { SyntheticPatientProfileRepository } from '../../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { SyntheticCaseRepository } from '../../infrastructure/sqlite/synthetic-case-repository.ts'
import type { ActorContext, CommandExecutor, CommandResponse } from '../command-executor.ts'
import {
  ScenarioGenerationProviderError,
  type ScenarioGenerationProvider,
  type SourcePatientCorpus,
} from './provider.ts'
import { validateScenarioDataset } from './scenario-dataset-validator.ts'
import type { ScenarioService } from '../scenario-service.ts'
import type { WorkflowService } from '../workflow-service.ts'
import type { ReferenceDataService } from '../reference-data-service.ts'
import {
  applySyntheticPatientProfileMappings,
  createSyntheticPatientProfiles,
} from './synthetic-patient-profile.ts'
import { canonicalJsonHash } from './canonical-json.ts'
import {
  compileSyntheaR4Bundle,
  pinSyntheaSourceVersions,
} from './synthea-case-truth-compiler.ts'
import {
  compileSyntheaIndexCase,
  SyntheaIndexCaseError,
  type CompiledSyntheaIndexCase,
} from './synthea-index-case.ts'

const scenarioDatasetInstallResultSchema = z.object({
  packageId: z.string().min(1),
  scenario: scenarioStateSchema,
}).strict()

const scenarioDatasetDeleteResultSchema = z.object({
  datasetId: z.string().min(1),
  deleted: z.literal(true),
}).strict()

function mappingCatalogKey(
  resourceType: string,
  catalogItemId: string,
  version: number,
): string {
  return `${resourceType}\u0000${catalogItemId}\u0000${version}`
}

type ScenarioDataErrorCode =
  | 'CASE_NOT_FOUND'
  | 'DATASET_INVALID'
  | 'DATASET_NOT_FOUND'
  | 'DATASET_VERSION_CONFLICT'
  | 'PROFILE_IDENTITY_CONFLICT'
  | 'PROFILE_MAPPING_INVALID'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_VERSION_CONFLICT'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'ROLE_NOT_ALLOWED'

export class ScenarioDataError extends Error {
  readonly code: ScenarioDataErrorCode
  readonly status: 403 | 404 | 409 | 503

  constructor(
    code: ScenarioDataErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ScenarioDataError'
    this.code = code
    if (code === 'ROLE_NOT_ALLOWED') this.status = 403
    else if (code === 'CASE_NOT_FOUND' || code === 'DATASET_NOT_FOUND' || code === 'PROFILE_NOT_FOUND') this.status = 404
    else if (code === 'PROVIDER_NOT_AVAILABLE') this.status = 503
    else this.status = 409
  }
}

export class ScenarioDataService {
  readonly #cases: SyntheticCaseRepository
  readonly #commands: CommandExecutor
  readonly #providers: ReadonlyMap<string, ScenarioGenerationProvider>
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #jobs: ScenarioGenerationJobRepository
  readonly #repository: ScenarioDatasetRepository
  readonly #referenceData: ReferenceDataService
  readonly #scenario: ScenarioService
  readonly #workflow: WorkflowService

  constructor(input: {
    cases: SyntheticCaseRepository
    commands: CommandExecutor
    jobs: ScenarioGenerationJobRepository
    providers: ReadonlyMap<string, ScenarioGenerationProvider>
    profiles: SyntheticPatientProfileRepository
    referenceData: ReferenceDataService
    repository: ScenarioDatasetRepository
    scenario: ScenarioService
    workflow: WorkflowService
  }) {
    this.#cases = input.cases
    this.#commands = input.commands
    this.#jobs = input.jobs
    this.#providers = input.providers
    this.#profiles = input.profiles
    this.#referenceData = input.referenceData
    this.#repository = input.repository
    this.#scenario = input.scenario
    this.#workflow = input.workflow
  }

  async capabilities(context: ActorContext) {
    this.#assertAdministrator(context)
    return {
      items: await Promise.all([...this.#providers.values()].map(provider => provider.capabilities())),
    }
  }

  async generate(input: {
    context: ActorContext
    idempotencyKey: string
    request: ScenarioGenerationRequest
  }): Promise<CommandResponse<ScenarioDataset>> {
    this.#assertAdministrator(input.context)
    if (input.request.providerId !== 'builtin') {
      throw new ScenarioDataError(
        'DATASET_INVALID',
        'External Scenario Providers must use persistent generation jobs',
      )
    }
    const provider = await this.#providerFor(input.request)
    const corpus = await provider.generate(input.request)
    const dataset = this.#dataset(
      input.context.workspaceId,
      input.request,
      this.#withReferenceData(corpus.content),
    )
    const profiles = createSyntheticPatientProfiles({
      dataset,
      sources: corpus.sources,
    })
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: input.request,
      operation: 'scenario-dataset.generate',
    }, () => {
      this.#repository.create(dataset, input.context.actorId)
      this.#profiles.createBatch(profiles, input.context.actorId)
      return {
        data: dataset,
        effects: [{
          kind: 'created',
          reference: `ScenarioDataset/${dataset.datasetId}`,
          versionId: '1',
        }],
      }
    })
  }

  async enqueueGeneration(input: {
    context: ActorContext
    idempotencyKey: string
    request: ScenarioGenerationRequest
  }): Promise<CommandResponse<ScenarioGenerationJob>> {
    this.#assertAdministrator(input.context)
    await this.#providerFor(input.request)
    const now = new Date().toISOString()
    const job: ScenarioGenerationJob = {
      caseIds: [],
      createdAt: now,
      datasetId: null,
      error: null,
      finishedAt: null,
      jobId: `scenario-generation-job-${randomUUID()}`,
      profileIds: [],
      request: input.request,
      startedAt: null,
      status: 'queued',
      updatedAt: now,
      workspaceId: input.context.workspaceId,
    }
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioGenerationJobSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: input.request,
      operation: 'scenario-generation-job.create',
    }, () => {
      this.#jobs.create(job, input.context)
      return {
        data: job,
        effects: [{
          kind: 'created',
          reference: `ScenarioGenerationJob/${job.jobId}`,
          versionId: '1',
        }],
      }
    })
  }

  getGenerationJob(context: ActorContext, jobId: string): ScenarioGenerationJob {
    this.#assertAdministrator(context)
    const job = this.#jobs.get(context.workspaceId, jobId)
    if (job === undefined) {
      throw new ScenarioDataError('DATASET_NOT_FOUND', 'The Scenario generation job was not found')
    }
    return job
  }

  async processNextGenerationJob(signal?: AbortSignal): Promise<ScenarioGenerationJob | undefined> {
    const claimed = this.#jobs.claimNext(new Date().toISOString())
    if (claimed === undefined) return undefined
    try {
      const provider = await this.#providerFor(claimed.request)
      const generated = await this.#generateUsableCorpus(provider, claimed.request, signal)
      const corpus = generated.corpus
      const dataset = this.#dataset(
        claimed.workspaceId,
        claimed.request,
        this.#withReferenceData(corpus.content),
      )
      const profiles = createSyntheticPatientProfiles({
        dataset,
        sources: corpus.sources,
      })
      return this.#commands.execute({
        context: claimed.actorContext,
        contextRequirement: 'known',
        dataSchema: scenarioGenerationJobSchema,
        expectedVersions: {},
        idempotencyKey: `${claimed.jobId}:complete`,
        idempotencyScope: 'workspace',
        input: { contentHash: dataset.contentHash, jobId: claimed.jobId },
        operation: 'scenario-generation-job.complete',
      }, () => {
        this.#profiles.createBatch(profiles, claimed.createdByActorId)
        const cases = profiles.flatMap((profile) => {
          const compiled = generated.casesByPatientId.get(profile.source.patientId)
          if (compiled === undefined) return []
          const existing = this.#cases.getByProfileRevision(
            profile.workspaceId,
            profile.profileId,
            profile.revision,
          )
          return [existing ?? this.#cases.createFromProfile({
            actorId: claimed.createdByActorId,
            compiled,
            profile,
          })]
        })
        const completed = this.#jobs.completeWithDataset(
          claimed,
          dataset,
          {
            caseIds: cases.map(item => item.caseId),
            profileIds: profiles.map(profile => profile.profileId),
          },
          new Date().toISOString(),
        )
        return {
          data: completed,
          effects: [{
            kind: 'created',
            reference: `ScenarioDataset/${dataset.datasetId}`,
            versionId: '1',
          }, ...cases.map(item => ({
            kind: 'created' as const,
            reference: `SyntheticCase/${item.caseId}`,
            versionId: String(item.revision),
          })), {
            kind: 'updated',
            reference: `ScenarioGenerationJob/${claimed.jobId}`,
            versionId: completed.updatedAt,
          }],
        }
      }).data
    } catch (error) {
      const now = new Date().toISOString()
      const transition = signal?.aborted === true ? 'requeue' : 'fail'
      return this.#commands.execute({
        context: claimed.actorContext,
        contextRequirement: 'known',
        dataSchema: scenarioGenerationJobSchema,
        expectedVersions: {},
        idempotencyKey: `${claimed.jobId}:${transition}:${claimed.startedAt ?? now}`,
        idempotencyScope: 'workspace',
        input: { jobId: claimed.jobId, transition },
        operation: `scenario-generation-job.${transition}`,
      }, () => {
        const transitioned = transition === 'requeue'
          ? this.#jobs.requeue(claimed, now)
          : this.#jobs.fail(claimed, {
              code: error instanceof ScenarioGenerationProviderError || error instanceof SyntheaIndexCaseError
                ? error.code
                : 'GENERATION_FAILED',
              message: error instanceof ScenarioGenerationProviderError || error instanceof SyntheaIndexCaseError
                ? error.message
                : 'Scenario generation failed',
            }, now)
        return {
          data: transitioned,
          effects: [{
            kind: 'updated',
            reference: `ScenarioGenerationJob/${claimed.jobId}`,
            versionId: transitioned.updatedAt,
          }],
        }
      }).data
    }
  }

  get(context: ActorContext, datasetId: string): ScenarioDataset {
    this.#assertAdministrator(context)
    return this.#getDataset(context.workspaceId, datasetId)
  }

  delete(input: {
    context: ActorContext
    datasetId: string
    expectedVersion: number
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetDeleteResultSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { datasetId: input.datasetId, expectedVersion: input.expectedVersion },
      operation: 'scenario-dataset.delete',
    }, () => {
      const dataset = this.#getDataset(input.context.workspaceId, input.datasetId)
      this.#assertExpectedVersion(dataset, input.expectedVersion)
      if (!this.#repository.delete(
        input.context.workspaceId,
        input.datasetId,
        input.expectedVersion,
      )) {
        throw new ScenarioDataError('DATASET_VERSION_CONFLICT', 'The Scenario Dataset changed after it was loaded')
      }
      return {
        data: { datasetId: input.datasetId, deleted: true as const },
        effects: [{
          kind: 'updated',
          reference: `ScenarioDataset/${input.datasetId}`,
          versionId: String(input.expectedVersion),
        }],
      }
    })
  }

  list(context: ActorContext, input: { page: number; pageSize: number; search?: string }) {
    this.#assertAdministrator(context)
    return this.#repository.list({ ...input, workspaceId: context.workspaceId })
  }

  listSyntheticPatients(
    context: ActorContext,
    input: { page: number; pageSize: number; search?: string },
  ) {
    this.#assertAdministrator(context)
    return syntheticPatientProfileListSchema.parse(this.#profiles.list({
      epoch: context.epoch,
      ...input,
      workspaceId: context.workspaceId,
    }))
  }

  getSyntheticCase(context: ActorContext, caseId: string) {
    this.#assertCaseReader(context)
    const syntheticCase = this.#cases.get(context.workspaceId, caseId)
    if (syntheticCase === undefined) {
      throw new ScenarioDataError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    return syntheticCase
  }

  listSyntheticCaseHistory(
    context: ActorContext,
    input: { caseId: string; page: number; pageSize: number },
  ) {
    this.getSyntheticCase(context, input.caseId)
    return this.#cases.listVisibleHistory({ ...input, workspaceId: context.workspaceId })
  }

  getSyntheticCaseHistoryDetail(
    context: ActorContext,
    caseId: string,
    sourceReference: string,
  ) {
    this.getSyntheticCase(context, caseId)
    const detail = this.#cases.getVisibleResource(context.workspaceId, caseId, sourceReference)
    if (detail === undefined) {
      throw new ScenarioDataError('CASE_NOT_FOUND', 'The visible Synthetic Case resource was not found')
    }
    return detail
  }

  getSyntheticPatient(context: ActorContext, profileId: string) {
    this.#assertAdministrator(context)
    const profile = this.#profiles.get(context.workspaceId, profileId)
    if (profile === undefined) {
      throw new ScenarioDataError('PROFILE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
    }
    return this.#publicProfile(profile)
  }

  updateSyntheticPatient(input: {
    context: ActorContext
    expectedRevision: number
    idempotencyKey: string
    identity: SyntheticPatientIdentity
    profileId: string
  }) {
    this.#assertAdministrator(input.context)
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: syntheticPatientProfileDetailSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: {
        expectedRevision: input.expectedRevision,
        identity: input.identity,
        profileId: input.profileId,
      },
      operation: 'synthetic-patient-profile.update',
    }, () => {
      const current = this.#profiles.get(input.context.workspaceId, input.profileId)
      if (current === undefined) {
        throw new ScenarioDataError('PROFILE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
      }
      if (current.revision !== input.expectedRevision) {
        throw new ScenarioDataError(
          'PROFILE_VERSION_CONFLICT',
          'The Synthetic Patient Profile changed after it was loaded',
        )
      }
      if (this.#profiles.mrnBelongsToOtherProfile(
        input.context.workspaceId,
        input.identity.mrn,
        input.profileId,
      )) {
        throw new ScenarioDataError(
          'PROFILE_IDENTITY_CONFLICT',
          'The synthetic medical record number is already in use',
        )
      }
      const updated = syntheticPatientProfileSchema.parse({
        ...current,
        identity: input.identity,
        revision: input.expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      })
      if (!this.#profiles.update(updated, input.expectedRevision, input.context.actorId)) {
        throw new ScenarioDataError(
          'PROFILE_VERSION_CONFLICT',
          'The Synthetic Patient Profile changed after it was loaded',
        )
      }
      return {
        data: this.#publicProfile(updated),
        effects: [{
          kind: 'updated',
          reference: `SyntheticPatientProfile/${updated.profileId}`,
          versionId: String(updated.revision),
        }],
      }
    })
  }

  updateSyntheticPatientMappings(input: {
    context: ActorContext
    expectedRevision: number
    idempotencyKey: string
    mappings: SyntheticPatientMappingInput[]
    profileId: string
  }) {
    this.#assertAdministrator(input.context)
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: syntheticPatientProfileDetailSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: {
        expectedRevision: input.expectedRevision,
        mappings: input.mappings,
        profileId: input.profileId,
      },
      operation: 'synthetic-patient-profile.update-mappings',
    }, () => {
      const current = this.#profiles.get(input.context.workspaceId, input.profileId)
      if (current === undefined) {
        throw new ScenarioDataError('PROFILE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
      }
      if (current.revision !== input.expectedRevision) {
        throw new ScenarioDataError(
          'PROFILE_VERSION_CONFLICT',
          'The Synthetic Patient Profile changed after it was loaded',
        )
      }
      const compilation = current.source.compilation
      const recompiledPatient = current.source.format === 'fhir-r4-bundle'
        && current.source.raw !== null
        && compilation !== null
        ? compileSyntheaR4Bundle({
            bundle: pinSyntheaSourceVersions(current.source.raw, current.patient),
            ordinal: compilation.ordinal,
            request: scenarioGenerationRequestSchema.parse({
              modules: compilation.modules,
              name: current.source.batchName,
              population: {
                age: { maximum: 120, minimum: 0 },
                count: 1,
                gender: 'any',
              },
              providerId: 'synthea',
              seeds: compilation.seeds,
              timeRange: compilation.timeRange,
              timeZone: compilation.timeZone,
            }),
          })
        : current.patient
      const eventBySourceId = new Map(recompiledPatient.longitudinalHistory.map(event => (
        [event.sourceResourceId, event] as const
      )))
      const catalog = this.#workflow.syntheticPatientMappingCatalog(input.context)
      const mappingCatalog = new Map<string, (typeof catalog.items)[number]>(
        catalog.items.map(item => (
          [mappingCatalogKey(
            item.sourceResourceType,
            item.catalogItemId,
            item.version,
          ), item] as const
        )),
      )
      const mappingBySourceId = new Map(current.mappings.map(mapping => (
        [mapping.sourceResourceId, mapping] as const
      )))
      for (const mapping of input.mappings) {
        const event = eventBySourceId.get(mapping.sourceResourceId)
        if (event === undefined) {
          throw new ScenarioDataError(
            'PROFILE_MAPPING_INVALID',
            `The source resource ${mapping.sourceResourceId} is not part of this profile`,
          )
        }
        if (mapping.target === null) {
          mappingBySourceId.delete(mapping.sourceResourceId)
          continue
        }
        const target = mappingCatalog.get(mappingCatalogKey(
          event.sourceResourceType,
          mapping.target.catalogItemId,
          mapping.target.version,
        ))
        if (target === undefined) {
          throw new ScenarioDataError(
            'PROFILE_MAPPING_INVALID',
            `The selected catalog item is unavailable for ${event.sourceResourceType}`,
          )
        }
        mappingBySourceId.set(mapping.sourceResourceId, {
          sourceResourceId: mapping.sourceResourceId,
          sourceResourceType: target.sourceResourceType,
          target: {
            catalogItemId: target.catalogItemId,
            code: target.code,
            ...(target.system === undefined ? {} : { system: target.system }),
            version: target.version,
          },
        })
      }
      const mappings = [...mappingBySourceId.values()].toSorted((left, right) => (
        left.sourceResourceType.localeCompare(right.sourceResourceType)
          || left.sourceResourceId.localeCompare(right.sourceResourceId)
      ))
      const revision = input.expectedRevision + 1
      const mappingSource = current.source.mappingProvenance === undefined
        ? {
            mappingVersion: `${current.source.mappingVersion.replace(/\+overlay-r\d+$/, '')}+overlay-r${revision}`,
          }
        : {
            mappingProvenance: {
              ...current.source.mappingProvenance,
              overlayRevision: revision,
            },
            mappingVersion: current.source.mappingVersion,
          }
      const updated = syntheticPatientProfileSchema.parse({
        ...current,
        mappings,
        patient: applySyntheticPatientProfileMappings(recompiledPatient, mappings),
        revision,
        source: {
          ...current.source,
          ...mappingSource,
        },
        updatedAt: new Date().toISOString(),
      })
      if (!this.#profiles.update(updated, input.expectedRevision, input.context.actorId)) {
        throw new ScenarioDataError(
          'PROFILE_VERSION_CONFLICT',
          'The Synthetic Patient Profile changed after it was loaded',
        )
      }
      return {
        data: this.#publicProfile(updated),
        effects: [{
          kind: 'updated',
          reference: `SyntheticPatientProfile/${updated.profileId}`,
          versionId: String(updated.revision),
        }],
      }
    })
  }

  startSyntheticPatientVisits(input: {
    context: ActorContext
    idempotencyKey: string
    request: z.infer<typeof startSyntheticPatientVisitsRequestSchema>
  }) {
    this.#assertAdministrator(input.context)
    const profiles = input.request.patients.map((selected) => {
      const profile = this.#profiles.get(input.context.workspaceId, selected.profileId)
      if (profile === undefined) {
        throw new ScenarioDataError('PROFILE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
      }
      return { expectedRevision: selected.expectedRevision, profile }
    })
    return this.#workflow.startSyntheticPatientVisits({
      context: input.context,
      departmentId: input.request.departmentId,
      idempotencyKey: input.idempotencyKey,
      locationId: input.request.locationId,
      profiles,
      visitDate: input.request.visitDate,
      visitTypeId: input.request.visitTypeId,
    })
  }

  syntheticPatientMappingCatalog(context: ActorContext) {
    this.#assertAdministrator(context)
    return this.#workflow.syntheticPatientMappingCatalog(context)
  }

  install(input: {
    context: ActorContext
    datasetId: string
    expectedVersion: number
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    const dataset = this.#getDataset(input.context.workspaceId, input.datasetId)
    this.#assertExpectedVersion(dataset, input.expectedVersion)
    this.#assertInstallable(dataset)
    const packageId = `scenario-package-${randomUUID()}`
    const createdAt = new Date().toISOString()
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetInstallResultSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { datasetId: input.datasetId, expectedVersion: input.expectedVersion },
      operation: 'scenario-dataset.install',
    }, () => {
      const current = this.#getDataset(input.context.workspaceId, input.datasetId)
      this.#assertExpectedVersion(current, input.expectedVersion)
      this.#assertInstallable(current)
      this.#repository.createPackage({
        actorId: input.context.actorId,
        createdAt,
        dataset: current,
        packageId,
      })
      const installed = this.#scenario.installPackage({
        content: current.content,
        context: input.context,
        packageId,
        version: current.version,
      })
      return {
        data: { packageId, scenario: installed.data },
        effects: [{
          kind: 'created',
          reference: `ScenarioPackage/${packageId}`,
          versionId: '1',
        }, ...installed.effects],
      }
    })
  }

  update(input: {
    content: ScenarioDataset['content']
    context: ActorContext
    datasetId: string
    expectedVersion: number
    idempotencyKey: string
    name: string
  }): CommandResponse<ScenarioDataset> {
    this.#assertAdministrator(input.context)
    const current = this.#getDataset(input.context.workspaceId, input.datasetId)
    const now = new Date().toISOString()
    const content = scenarioDatasetContentSchema.parse({
      ...input.content,
      reproduction: {
        ...input.content.reproduction,
        referenceData: current.content.reproduction.referenceData ?? this.#referenceData.provenance(),
      },
    })
    const updated: ScenarioDataset = {
      ...current,
      content,
      contentHash: canonicalJsonHash(content),
      diagnostics: validateScenarioDataset(content),
      name: input.name,
      updatedAt: now,
      version: input.expectedVersion + 1,
    }
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: {
        content: input.content,
        datasetId: input.datasetId,
        expectedVersion: input.expectedVersion,
        name: input.name,
      },
      operation: 'scenario-dataset.update',
    }, () => {
      if (!this.#repository.update(updated, input.expectedVersion)) {
        throw new ScenarioDataError(
          'DATASET_VERSION_CONFLICT',
          'The Scenario Dataset changed after it was loaded',
        )
      }
      return {
        data: updated,
        effects: [{
          kind: 'updated',
          reference: `ScenarioDataset/${input.datasetId}`,
          versionId: String(updated.version),
        }],
      }
    })
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new ScenarioDataError('ROLE_NOT_ALLOWED', 'Only an administrator can manage Scenario Datasets')
    }
  }

  #assertCaseReader(context: ActorContext): void {
    if (![
      'administrator',
      'outpatient-doctor',
      'registrar',
      'triage-nurse',
    ].includes(context.roleCode)) {
      throw new ScenarioDataError('ROLE_NOT_ALLOWED', 'This role cannot read Synthetic Case history')
    }
  }

  #publicProfile(profile: z.infer<typeof syntheticPatientProfileSchema>) {
    return syntheticPatientProfileDetailSchema.parse({
      birthDate: profile.patient.birthDate,
      case: this.#cases.getByProfile(profile.workspaceId, profile.profileId) ?? null,
      createdAt: profile.createdAt,
      gender: profile.patient.gender,
      identity: profile.identity,
      profileId: profile.profileId,
      revision: profile.revision,
      source: {
        batchId: profile.source.batchId,
        batchName: profile.source.batchName,
        format: profile.source.format,
        hash: profile.source.hash,
        ...(profile.source.localization === undefined
          ? {}
          : { localization: profile.source.localization }),
        mappingVersion: profile.source.mappingVersion,
        patientId: profile.source.patientId,
        providerId: profile.source.providerId,
        ...(profile.source.referenceData === undefined
          ? {}
          : { referenceData: profile.source.referenceData }),
      },
      updatedAt: profile.updatedAt,
      workspaceId: profile.workspaceId,
    })
  }

  #withReferenceData(content: ScenarioDataset['content']): ScenarioDataset['content'] {
    return scenarioDatasetContentSchema.parse({
      ...content,
      reproduction: {
        ...content.reproduction,
        referenceData: this.#referenceData.provenance(),
      },
    })
  }

  #assertExpectedVersion(dataset: ScenarioDataset, expectedVersion: number): void {
    if (dataset.version !== expectedVersion) {
      throw new ScenarioDataError('DATASET_VERSION_CONFLICT', 'The Scenario Dataset changed after it was loaded')
    }
  }

  #assertInstallable(dataset: ScenarioDataset): void {
    if (dataset.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      throw new ScenarioDataError('DATASET_INVALID', 'The Scenario Dataset has errors and cannot be installed')
    }
  }

  #dataset(
    workspaceId: string,
    request: ScenarioGenerationRequest,
    sourceContent: ScenarioDataset['content'],
  ): ScenarioDataset {
    const content = scenarioDatasetContentSchema.parse(sourceContent)
    const now = new Date().toISOString()
    return {
      content,
      contentHash: canonicalJsonHash(content),
      createdAt: now,
      datasetId: `scenario-dataset-${randomUUID()}`,
      diagnostics: validateScenarioDataset(content),
      name: request.name,
      providerId: request.providerId,
      updatedAt: now,
      version: 1,
      workspaceId,
    }
  }

  async #providerFor(request: ScenarioGenerationRequest): Promise<ScenarioGenerationProvider> {
    const provider = this.#providers.get(request.providerId)
    if (provider === undefined) {
      throw new ScenarioDataError('PROVIDER_NOT_AVAILABLE', 'The requested Scenario Provider is not available')
    }
    const capabilities = await provider.capabilities()
    if (!capabilities.available) {
      throw new ScenarioDataError(
        'PROVIDER_NOT_AVAILABLE',
        capabilities.unavailableReason ?? 'The requested Scenario Provider is unavailable',
      )
    }
    if (
      request.population.count > capabilities.maxPopulation
      || (
        request.providerId === 'builtin'
        && request.moduleMode === 'filter'
        && request.modules.some(module => !capabilities.modules.includes(module))
      )
    ) {
      throw new ScenarioDataError(
        'DATASET_INVALID',
        'The generation request exceeds the Scenario Provider capabilities',
      )
    }
    return provider
  }

  async #generateUsableCorpus(
    provider: ScenarioGenerationProvider,
    request: ScenarioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<{
    casesByPatientId: Map<string, CompiledSyntheaIndexCase>
    corpus: SourcePatientCorpus
  }> {
    if (request.providerId !== 'synthea') {
      return { casesByPatientId: new Map(), corpus: await provider.generate(request, signal) }
    }
    let lastError: SyntheaIndexCaseError | undefined
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const attemptRequest = scenarioGenerationRequestSchema.parse({
        ...request,
        seeds: {
          clinical: (request.seeds.clinical + attempt * 104_729) % 2_147_483_648,
          population: (request.seeds.population + attempt * 130_363) % 2_147_483_648,
        },
      })
      const corpus = await provider.generate(attemptRequest, signal)
      try {
        const casesByPatientId = new Map(corpus.sources.map(source => (
          [source.patientId, compileSyntheaIndexCase(source.raw)] as const
        )))
        return { casesByPatientId, corpus }
      } catch (error) {
        if (!(error instanceof SyntheaIndexCaseError)) throw error
        lastError = error
      }
    }
    throw lastError ?? new SyntheaIndexCaseError()
  }

  #getDataset(workspaceId: string, datasetId: string): ScenarioDataset {
    const dataset = this.#repository.get(workspaceId, datasetId)
    if (dataset === undefined) {
      throw new ScenarioDataError('DATASET_NOT_FOUND', 'The Scenario Dataset was not found')
    }
    return dataset
  }
}
