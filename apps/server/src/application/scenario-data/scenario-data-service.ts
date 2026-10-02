import { randomUUID } from 'node:crypto'
import {
  administratorCaseTruthSchema,
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  syntheticPatientProfileDetailSchema,
  syntheticPatientProfileListSchema,
  syntheticPatientProfileSchema,
  type ScenarioGenerationJob,
  type ScenarioGenerationRequest,
  type ScenarioGenerationTarget,
  type SyntheaKeepCriteria,
  type SyntheticPatientIdentity,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ScenarioGenerationJobRepository } from '../../infrastructure/sqlite/scenario-generation-job-repository.ts'
import type { SyntheticPatientProfileRepository } from '../../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { SyntheticCaseRepository } from '../../infrastructure/sqlite/synthetic-case-repository.ts'
import type { ActorContext, CommandExecutor } from '../command-executor.ts'
import {
  ScenarioGenerationProviderError,
  type ScenarioGenerationProvider,
  type SourcePatientCorpus,
} from './provider.ts'
import { createSyntheticPatientProfiles } from './synthetic-patient-profile.ts'
import {
  compileSyntheaIndexCase,
  SyntheaIndexCaseError,
  type CompiledSyntheaIndexCase,
} from './synthea-index-case.ts'
import { canonicalJsonHash } from './canonical-json.ts'

type ScenarioDataErrorCode =
  | 'CASE_NOT_FOUND'
  | 'GENERATION_JOB_NOT_FOUND'
  | 'PROFILE_IDENTITY_CONFLICT'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_VERSION_CONFLICT'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'ROLE_NOT_ALLOWED'

export class ScenarioDataError extends Error {
  readonly code: ScenarioDataErrorCode
  readonly status: 403 | 404 | 409 | 503

  constructor(code: ScenarioDataErrorCode, message: string) {
    super(message)
    this.name = 'ScenarioDataError'
    this.code = code
    if (code === 'ROLE_NOT_ALLOWED') this.status = 403
    else if (
      code === 'CASE_NOT_FOUND'
      || code === 'GENERATION_JOB_NOT_FOUND'
      || code === 'PROFILE_NOT_FOUND'
    ) {
      this.status = 404
    }
    else if (code === 'PROVIDER_NOT_AVAILABLE') this.status = 503
    else this.status = 409
  }
}

/** 定向生成依赖的影像适配规则，由影像准备服务实现。 */
export interface ScenarioGenerationTargets {
  generationKeep(target: ScenarioGenerationTarget): Promise<SyntheaKeepCriteria | undefined>
  generationTargetMet(target: ScenarioGenerationTarget, candidate: {
    birthDate: string
    gender: string
    historyResources: Array<{ resource: unknown; sourceReference: string }>
    indexEncounterReference: string
    indexResources: Array<{ resource: unknown; sourceReference: string }>
    sourceHash: string
  }): Promise<boolean>
  /** 为新病例运行目标所属素材包的病例准备。 */
  prepareBatch(target: ScenarioGenerationTarget, input: {
    caseIds: string[]
    context: ActorContext
    idempotencyKey: string
  }): Promise<unknown>
}

const sourceBundleSchema = z.object({
  entry: z.array(z.object({
    fullUrl: z.string().optional(),
    resource: z.object({
      birthDate: z.string().optional(),
      gender: z.string().optional(),
      id: z.string().optional(),
      resourceType: z.string(),
    }).passthrough(),
  }).passthrough()),
}).passthrough()

export class ScenarioDataService {
  readonly #cases: SyntheticCaseRepository
  readonly #commands: CommandExecutor
  readonly #jobs: ScenarioGenerationJobRepository
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #provider: ScenarioGenerationProvider
  readonly #targets: ScenarioGenerationTargets | undefined

  constructor(input: {
    cases: SyntheticCaseRepository
    commands: CommandExecutor
    jobs: ScenarioGenerationJobRepository
    profiles: SyntheticPatientProfileRepository
    provider: ScenarioGenerationProvider
    targets?: ScenarioGenerationTargets
  }) {
    this.#cases = input.cases
    this.#commands = input.commands
    this.#jobs = input.jobs
    this.#profiles = input.profiles
    this.#provider = input.provider
    this.#targets = input.targets
  }

  async capabilities(context: ActorContext) {
    this.#assertAdministrator(context)
    return { items: [await this.#provider.capabilities()] }
  }

  async enqueueGeneration(input: {
    context: ActorContext
    idempotencyKey: string
    request: ScenarioGenerationRequest
  }) {
    this.#assertAdministrator(input.context)
    await this.#assertProviderAvailable(input.request)
    if (input.request.target !== undefined && !(await this.#provider.capabilities()).targetedGeneration) {
      throw new ScenarioDataError('PROVIDER_NOT_AVAILABLE', 'The Synthea Provider does not support targeted generation')
    }
    const now = new Date().toISOString()
    const job = scenarioGenerationJobSchema.parse({
      caseIds: [],
      createdAt: now,
      error: null,
      finishedAt: null,
      jobId: `scenario-generation-job-${randomUUID()}`,
      profileIds: [],
      request: input.request,
      startedAt: null,
      status: 'queued',
      updatedAt: now,
      workspaceId: input.context.workspaceId,
    })
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
          kind: 'created' as const,
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
      throw new ScenarioDataError('GENERATION_JOB_NOT_FOUND', 'The generation job was not found')
    }
    return job
  }

  async processNextGenerationJob(signal?: AbortSignal): Promise<ScenarioGenerationJob | undefined> {
    const claimed = this.#jobs.claimNext(new Date().toISOString())
    if (claimed === undefined) return undefined
    const { target } = claimed.request
    let completedJob: ScenarioGenerationJob
    try {
      await this.#assertProviderAvailable(claimed.request)
      const keep = target === undefined ? undefined : await this.#targetKeep(target)
      const generated = await this.#generateUsableCorpus(claimed.request, signal, keep)
      const createdAt = new Date().toISOString()
      const profiles = createSyntheticPatientProfiles({
        batchId: `synthea-batch-${claimed.jobId}`,
        batchName: claimed.request.name,
        createdAt,
        request: generated.request,
        sources: generated.corpus.sources,
        workspaceId: claimed.workspaceId,
      })
      const sourceHash = canonicalJsonHash(
        generated.corpus.sources.map(source => source.hash),
      )
      completedJob = this.#commands.execute({
        context: claimed.actorContext,
        contextRequirement: 'known',
        dataSchema: scenarioGenerationJobSchema,
        expectedVersions: {},
        idempotencyKey: `${claimed.jobId}:complete`,
        idempotencyScope: 'workspace',
        input: { jobId: claimed.jobId, sourceHash },
        operation: 'scenario-generation-job.complete',
      }, () => {
        const restoredProfiles = new Set(this.#profiles.createBatch(profiles, claimed.createdByActorId))
        const cases = profiles.map((profile) => {
          const compiled = generated.casesByPatientId.get(profile.source.patientId)
          if (compiled === undefined) throw new Error('Generated Profile has no compiled Case')
          const existing = this.#cases.getByProfileRevision(profile.workspaceId, profile.profileId, profile.revision)
          if (existing?.status === 'retired' && restoredProfiles.has(profile.profileId)) {
            return this.#cases.restoreRetired(profile.workspaceId, existing.caseId, new Date().toISOString())
          }
          return existing ?? this.#cases.createFromProfile({
            actorId: claimed.createdByActorId,
            compiled,
            profile,
          })
        })
        const completed = this.#jobs.complete(claimed, {
          caseIds: cases.map(item => item.caseId),
          profileIds: profiles.map(profile => profile.profileId),
        }, new Date().toISOString())
        return {
          data: completed,
          effects: [
            ...profiles.map(profile => {
              const stored = restoredProfiles.has(profile.profileId)
                ? this.#profiles.get(profile.workspaceId, profile.profileId)
                : profile
              if (stored === undefined) throw new Error('The restored Synthetic Patient Profile was not found')
              return {
                kind: restoredProfiles.has(profile.profileId) ? 'updated' as const : 'created' as const,
                reference: `SyntheticPatientProfile/${profile.profileId}`,
                versionId: String(stored.revision),
              }
            }),
            ...cases.map(item => ({
              kind: restoredProfiles.has(item.profileId) ? 'updated' as const : 'created' as const,
              reference: `SyntheticCase/${item.caseId}`,
              versionId: String(item.revision),
            })),
            {
              kind: 'updated' as const,
              reference: `ScenarioGenerationJob/${claimed.jobId}`,
              versionId: completed.updatedAt,
            },
          ],
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
                : 'Synthea patient generation failed',
            }, now)
        return {
          data: transitioned,
          effects: [{
            kind: 'updated' as const,
            reference: `ScenarioGenerationJob/${claimed.jobId}`,
            versionId: transitioned.updatedAt,
          }],
        }
      }).data
    }
    if (target !== undefined && this.#targets !== undefined) {
      // 定向生成的病例随即运行目标所属素材包的病例准备；准备失败不回滚已生成的患者，在任务上记录警告，管理员可在对应的准备入口重试。
      const pathology = target.kind === 'pathology-profile'
      try {
        await this.#targets.prepareBatch(target, {
          caseIds: completedJob.caseIds,
          context: claimed.actorContext,
          idempotencyKey: `${claimed.jobId}:${pathology ? 'pathology' : 'imaging'}-preparation`,
        })
      } catch {
        const code = pathology ? 'PATHOLOGY_PREPARATION_FAILED' : 'IMAGING_PREPARATION_FAILED'
        return this.#commands.execute({
          context: claimed.actorContext,
          contextRequirement: 'known',
          dataSchema: scenarioGenerationJobSchema,
          expectedVersions: {},
          idempotencyKey: `${claimed.jobId}:warn`,
          idempotencyScope: 'workspace',
          input: { jobId: claimed.jobId, warning: code },
          operation: 'scenario-generation-job.warn',
        }, () => {
          const warned = this.#jobs.recordWarning(claimed.workspaceId, claimed.jobId, {
            code,
            message: `The patients were generated, but ${pathology ? 'pathology' : 'imaging'} preparation did not complete`,
          }, new Date().toISOString())
          return {
            data: warned,
            effects: [{
              kind: 'updated' as const,
              reference: `ScenarioGenerationJob/${claimed.jobId}`,
              versionId: warned.updatedAt,
            }],
          }
        }).data
      }
    }
    return completedJob
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
          kind: 'updated' as const,
          reference: `SyntheticPatientProfile/${updated.profileId}`,
          versionId: String(updated.revision),
        }],
      }
    })
  }

  getSyntheticCase(context: ActorContext, caseId: string) {
    this.#assertCaseReader(context)
    if (
      context.roleCode !== 'administrator'
      && !this.#cases.hasMaterialization(context.workspaceId, context.epoch, caseId)
    ) {
      throw new ScenarioDataError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
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
    return this.#cases.listVisibleHistoryGroups({ ...input, workspaceId: context.workspaceId })
  }

  getAdministratorCaseTruth(context: ActorContext, caseId: string) {
    this.#assertAdministrator(context)
    this.getSyntheticCase(context, caseId)
    const truth = this.#cases.getTruthForSimulator(context.workspaceId, caseId)
    if (truth === undefined) {
      throw new ScenarioDataError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    return administratorCaseTruthSchema.parse({
      caseId,
      indexEncounterReference: truth.indexEncounterReference,
      items: truth.hiddenResources,
    })
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

  async #assertProviderAvailable(request: ScenarioGenerationRequest): Promise<void> {
    if (request.providerId !== 'synthea') {
      throw new ScenarioDataError('PROVIDER_NOT_AVAILABLE', 'Only the Synthea Provider is supported')
    }
    const capabilities = await this.#provider.capabilities()
    if (!capabilities.available) {
      throw new ScenarioDataError(
        'PROVIDER_NOT_AVAILABLE',
        capabilities.unavailableReason ?? 'The Synthea Provider is unavailable',
      )
    }
    if (request.population.count > capabilities.maxPopulation) {
      throw new ScenarioDataError('PROVIDER_NOT_AVAILABLE', 'The generation request exceeds Provider limits')
    }
  }

  async #targetKeep(target: ScenarioGenerationTarget): Promise<SyntheaKeepCriteria> {
    if (!(await this.#provider.capabilities()).targetedGeneration) {
      throw new ScenarioGenerationProviderError(
        'PROVIDER_TARGET_UNSUPPORTED',
        'The Synthea Provider does not support targeted generation',
      )
    }
    const keep = await this.#targets?.generationKeep(target)
    if (keep === undefined) {
      throw new ScenarioGenerationProviderError('IMAGING_TARGET_UNAVAILABLE', 'The selected matching profile is not available')
    }
    return keep
  }

  /**
   * 有界重试直到每位患者都有合格的 Index Encounter；定向生成还要求每位患者按当前影像规则满足目标条目。
   * 保留条件只提高 Provider 的命中率，是否满足由影像准备的匹配规则判定。
   */
  async #generateUsableCorpus(
    request: ScenarioGenerationRequest,
    signal?: AbortSignal,
    keep?: SyntheaKeepCriteria,
  ): Promise<{
    casesByPatientId: Map<string, CompiledSyntheaIndexCase>
    corpus: SourcePatientCorpus
    request: ScenarioGenerationRequest
  }> {
    let lastError: ScenarioGenerationProviderError | SyntheaIndexCaseError | undefined
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const attemptRequest = scenarioGenerationRequestSchema.parse({
        ...request,
        seeds: {
          clinical: (request.seeds.clinical + attempt * 104_729) % 2_147_483_648,
          population: (request.seeds.population + attempt * 130_363) % 2_147_483_648,
        },
      })
      let corpus: SourcePatientCorpus
      try {
        corpus = await this.#provider.generate(attemptRequest, signal, keep)
      } catch (error) {
        // Synthea 在一次运行中固定患者年龄等人口属性，抽到无法满足保留条件的人口时整次运行未命中，换 seed 重试。
        if (!(error instanceof ScenarioGenerationProviderError) || error.code !== 'KEEP_NOT_SATISFIED') throw error
        lastError = new ScenarioGenerationProviderError(
          'IMAGING_TARGET_NOT_MET',
          'No generated patient satisfied the selected matching profile after repeated attempts',
        )
        continue
      }
      let casesByPatientId: Map<string, CompiledSyntheaIndexCase>
      try {
        casesByPatientId = new Map(corpus.sources.map(source => (
          [source.patientId, compileSyntheaIndexCase(source.raw)] as const
        )))
      } catch (error) {
        if (!(error instanceof SyntheaIndexCaseError)) throw error
        lastError = error
        continue
      }
      const { target } = request
      if (target !== undefined && this.#targets !== undefined) {
        let met = true
        for (const source of corpus.sources) {
          const compiled = casesByPatientId.get(source.patientId)!
          const entries = new Map(sourceBundleSchema.parse(source.raw).entry.map(entry => (
            [entry.fullUrl ?? `${entry.resource.resourceType}/${entry.resource.id}`, entry.resource] as const
          )))
          const resources = (references: string[]) => references.map(reference => ({
            resource: entries.get(reference),
            sourceReference: reference,
          }))
          const patient = [...entries.values()].find(resource => resource.resourceType === 'Patient')
          met = patient?.birthDate !== undefined && patient.gender !== undefined
            && await this.#targets.generationTargetMet(target, {
              birthDate: patient.birthDate,
              gender: patient.gender,
              historyResources: resources(compiled.visibleResourceReferences),
              indexEncounterReference: compiled.indexEncounterReference,
              indexResources: resources(compiled.hiddenResourceReferences),
              sourceHash: source.hash,
            })
          if (!met) break
        }
        if (!met) {
          lastError = new ScenarioGenerationProviderError(
            'IMAGING_TARGET_NOT_MET',
            'No generated patient satisfied the selected matching profile after repeated attempts',
          )
          continue
        }
      }
      return { casesByPatientId, corpus, request: attemptRequest }
    }
    throw lastError ?? new SyntheaIndexCaseError()
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new ScenarioDataError('ROLE_NOT_ALLOWED', 'Only an administrator can manage synthetic patients')
    }
  }

  #assertCaseReader(context: ActorContext): void {
    if (!['administrator', 'outpatient-doctor', 'registrar', 'triage-nurse'].includes(context.roleCode)) {
      throw new ScenarioDataError('ROLE_NOT_ALLOWED', 'This role cannot read Synthetic Case history')
    }
  }

  #publicProfile(profile: z.infer<typeof syntheticPatientProfileSchema>) {
    return syntheticPatientProfileDetailSchema.parse({
      birthDate: profile.demographics.birthDate,
      case: this.#cases.getByProfile(profile.workspaceId, profile.profileId) ?? null,
      createdAt: profile.createdAt,
      gender: profile.demographics.gender,
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
        ...(profile.source.translationWarning === undefined
          ? {}
          : { translationWarning: profile.source.translationWarning }),
        patientId: profile.source.patientId,
        providerId: profile.source.providerId,
      },
      updatedAt: profile.updatedAt,
      workspaceId: profile.workspaceId,
    })
  }
}
