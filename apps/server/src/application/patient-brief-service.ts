import { randomUUID } from 'node:crypto'
import {
  patientBriefContentSchema,
  patientBriefJobSchema,
  syntheticCaseInstanceSchema,
  type PatientBriefContent,
  type PatientBriefJob,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type {
  ClaimedPatientBriefJob,
  PatientBriefRepository,
} from '../infrastructure/sqlite/patient-brief-repository.ts'
import {
  ChatCompletionsError,
  type JsonChatCompletionsProvider,
} from '../infrastructure/ai/openai-chat-completions.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const promptVersion = 'patient-brief-v1'
const systemPrompt = [
  '你是中国门诊标准化患者病例梗概生成器。',
  '只返回符合 JSON Schema 的 JSON，不要返回 Markdown。',
  '根据合成患者的既往可见病史和本次私有证据生成主诉、患者开场陈述、已知史摘要和问诊主题。',
  '不得把尚未在既往病史出现的本次诊断名称、诊断编码或同义表达写入输出。',
  '问诊主题 ID 使用稳定的小写英文短横线格式，answerPoints 使用患者自然口语。',
].join('\n')
const promptHash = canonicalJsonHash({ promptVersion, systemPrompt })

type Resource = { id: string; resourceType: string; [key: string]: unknown }

export class PatientBriefLeakError extends Error {
  readonly code = 'BRIEF_DIAGNOSIS_LEAK'

  constructor() {
    super('The generated Patient Brief reveals a hidden diagnosis')
    this.name = 'PatientBriefLeakError'
  }
}

type PatientBriefErrorCode =
  | 'BRIEF_JOB_NOT_FOUND'
  | 'BRIEF_REVISION_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'CASE_VERSION_CONFLICT'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'ROLE_NOT_ALLOWED'

export class PatientBriefError extends Error {
  readonly code: PatientBriefErrorCode
  readonly status: 403 | 404 | 409 | 503

  constructor(code: PatientBriefErrorCode, message: string) {
    super(message)
    this.name = 'PatientBriefError'
    this.code = code
    if (code === 'ROLE_NOT_ALLOWED') this.status = 403
    else if (code === 'CASE_VERSION_CONFLICT') this.status = 409
    else if (code === 'PROVIDER_NOT_AVAILABLE') this.status = 503
    else this.status = 404
  }
}

function conceptValues(resource: Resource): { codes: string[]; terms: string[] } {
  const concept = typeof resource.code === 'object' && resource.code !== null
    ? resource.code as Record<string, unknown>
    : {}
  const codings = Array.isArray(concept.coding) ? concept.coding : []
  const codes: string[] = []
  const terms: string[] = []
  if (typeof concept.text === 'string') terms.push(concept.text)
  for (const value of codings) {
    if (typeof value !== 'object' || value === null) continue
    const coding = value as Record<string, unknown>
    if (typeof coding.code === 'string') codes.push(coding.code)
    if (typeof coding.display === 'string') terms.push(coding.display)
  }
  return { codes, terms }
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replaceAll(/[^\p{L}\p{N}]+/gu, '')
}

function summarizedResource(resource: Resource) {
  const concept = conceptValues(resource)
  const valueQuantity = typeof resource.valueQuantity === 'object' && resource.valueQuantity !== null
    ? resource.valueQuantity as Record<string, unknown>
    : undefined
  return {
    codes: concept.codes.slice(0, 5),
    resourceType: resource.resourceType,
    terms: concept.terms.slice(0, 5),
    ...(valueQuantity === undefined ? {} : {
      value: {
        unit: typeof valueQuantity.unit === 'string' ? valueQuantity.unit : undefined,
        value: typeof valueQuantity.value === 'number' ? valueQuantity.value : undefined,
      },
    }),
  }
}

function hiddenDiagnosisTokens(
  hiddenResources: Resource[],
  visibleResources: Resource[],
): string[] {
  const visibleConditions = visibleResources.filter(resource => resource.resourceType === 'Condition')
  const visibleCodes = new Set(visibleConditions.flatMap(resource => conceptValues(resource).codes))
  const visibleTerms = new Set(visibleConditions.flatMap(resource => (
    conceptValues(resource).terms.map(normalized)
  )))
  return hiddenResources
    .filter(resource => resource.resourceType === 'Condition')
    .flatMap((resource) => {
      const values = conceptValues(resource)
      const alreadyVisible = values.codes.some(code => visibleCodes.has(code))
        || values.terms.some(term => visibleTerms.has(normalized(term)))
      return alreadyVisible ? [] : [...values.codes, ...values.terms]
    })
    .map(normalized)
    .filter(value => value.length >= 2)
}

function assertNoDiagnosisLeak(
  content: PatientBriefContent,
  hiddenResources: Resource[],
  visibleResources: Resource[],
): void {
  const output = normalized(JSON.stringify(content))
  if (hiddenDiagnosisTokens(hiddenResources, visibleResources).some(token => output.includes(token))) {
    throw new PatientBriefLeakError()
  }
}

export async function generatePatientBrief(input: {
  hiddenResources: Resource[]
  model: string
  payload: unknown
  provider: JsonChatCompletionsProvider
  signal?: AbortSignal
  visibleResources: Resource[]
}) {
  const completion = await input.provider.completeJson({
    jsonSchema: z.toJSONSchema(patientBriefContentSchema) as Record<string, unknown>,
    model: input.model,
    schemaName: 'patient_brief',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    systemPrompt,
    userPayload: input.payload,
  })
  const content = patientBriefContentSchema.parse(JSON.parse(completion.content))
  assertNoDiagnosisLeak(content, input.hiddenResources, input.visibleResources)
  return {
    content,
    inputHash: canonicalJsonHash(input.payload),
    model: completion.model,
    outputHash: canonicalJsonHash(content),
    promptHash,
    promptVersion,
  }
}

export class PatientBriefService {
  readonly #briefs: PatientBriefRepository
  readonly #cases: SyntheticCaseRepository
  readonly #commands: CommandExecutor
  readonly #model: string | undefined
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #provider: JsonChatCompletionsProvider | undefined

  constructor(input: {
    briefs: PatientBriefRepository
    cases: SyntheticCaseRepository
    commands: CommandExecutor
    model?: string
    profiles: SyntheticPatientProfileRepository
    provider?: JsonChatCompletionsProvider
  }) {
    this.#briefs = input.briefs
    this.#cases = input.cases
    this.#commands = input.commands
    this.#model = input.model
    this.#profiles = input.profiles
    this.#provider = input.provider
  }

  enqueue(input: { caseId: string; context: ActorContext; idempotencyKey: string }) {
    this.#assertAdministrator(input.context)
    if (this.#provider === undefined || this.#model === undefined) {
      throw new PatientBriefError('PROVIDER_NOT_AVAILABLE', 'Patient Brief generation is not configured')
    }
    if (this.#cases.get(input.context.workspaceId, input.caseId) === undefined) {
      throw new PatientBriefError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    const now = new Date().toISOString()
    const job = patientBriefJobSchema.parse({
      caseId: input.caseId,
      createdAt: now,
      error: null,
      finishedAt: null,
      jobId: `patient-brief-job-${randomUUID()}`,
      resultRevision: null,
      startedAt: null,
      status: 'queued',
      updatedAt: now,
      workspaceId: input.context.workspaceId,
    })
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: patientBriefJobSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { caseId: input.caseId },
      operation: 'patient-brief-job.create',
    }, () => {
      this.#briefs.create(job, input.context, this.#model!)
      return {
        data: job,
        effects: [{ kind: 'created' as const, reference: `PatientBriefJob/${job.jobId}`, versionId: '1' }],
      }
    })
  }

  getJob(context: ActorContext, jobId: string): PatientBriefJob {
    this.#assertAdministrator(context)
    const job = this.#briefs.get(context.workspaceId, jobId)
    if (job === undefined) {
      throw new PatientBriefError('BRIEF_JOB_NOT_FOUND', 'The Patient Brief job was not found')
    }
    return job
  }

  listRevisions(context: ActorContext, caseId: string) {
    this.#assertAdministrator(context)
    const revisions = this.#briefs.listRevisions(context.workspaceId, caseId)
    if (revisions === undefined) {
      throw new PatientBriefError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    return revisions
  }

  selectRevision(input: {
    briefRevision: number
    caseId: string
    context: ActorContext
    expectedCaseRevision: number
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: syntheticCaseInstanceSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: {
        briefRevision: input.briefRevision,
        caseId: input.caseId,
        expectedCaseRevision: input.expectedCaseRevision,
      },
      operation: 'patient-brief-revision.select',
    }, () => {
      const selected = this.#briefs.selectRevision({
        briefRevision: input.briefRevision,
        caseId: input.caseId,
        expectedCaseRevision: input.expectedCaseRevision,
        now: new Date().toISOString(),
        workspaceId: input.context.workspaceId,
      })
      if (selected === undefined) {
        const revisions = this.#briefs.listRevisions(input.context.workspaceId, input.caseId)
        if (revisions === undefined) {
          throw new PatientBriefError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
        }
        if (!revisions.items.some(item => item.revision === input.briefRevision)) {
          throw new PatientBriefError('BRIEF_REVISION_NOT_FOUND', 'The Patient Brief revision was not found')
        }
        throw new PatientBriefError('CASE_VERSION_CONFLICT', 'The Synthetic Case changed after it was loaded')
      }
      return {
        data: selected,
        effects: [{
          kind: 'updated' as const,
          reference: `SyntheticCase/${selected.caseId}`,
          versionId: String(selected.revision),
        }],
      }
    })
  }

  async processNext(signal?: AbortSignal): Promise<PatientBriefJob | undefined> {
    const claimed = this.#briefs.claimNext(new Date().toISOString())
    if (claimed === undefined) return undefined
    if (this.#provider === undefined) return this.#fail(claimed, {
      code: 'PROVIDER_NOT_AVAILABLE',
      message: 'Patient Brief generation is not configured',
    })
    try {
      const generation = this.#generationInput(claimed)
      const generated = await generatePatientBrief({
        hiddenResources: generation.hiddenResources,
        model: claimed.model,
        payload: generation.payload,
        provider: this.#provider,
        ...(signal === undefined ? {} : { signal }),
        visibleResources: generation.visibleResources,
      })
      return this.#commands.execute({
        context: claimed.actorContext,
        contextRequirement: 'known',
        dataSchema: patientBriefJobSchema,
        expectedVersions: {},
        idempotencyKey: `${claimed.jobId}:complete:${generated.outputHash}`,
        idempotencyScope: 'workspace',
        input: { jobId: claimed.jobId, outputHash: generated.outputHash },
        operation: 'patient-brief-job.complete',
      }, () => {
        const result = this.#briefs.succeed(claimed, {
          ...generated,
        }, new Date().toISOString())
        return {
          data: result.job,
          effects: [{
            kind: 'created' as const,
            reference: `PatientBrief/${claimed.caseId}/${result.revision.revision}`,
            versionId: String(result.revision.revision),
          }, {
            kind: 'updated' as const,
            reference: `SyntheticCase/${claimed.caseId}`,
            versionId: String(result.syntheticCase.revision),
          }],
        }
      }).data
    } catch (error) {
      if (signal?.aborted === true) {
        return this.#commands.execute({
          context: claimed.actorContext,
          contextRequirement: 'known',
          dataSchema: patientBriefJobSchema,
          expectedVersions: {},
          idempotencyKey: `${claimed.jobId}:requeue:${claimed.startedAt}`,
          idempotencyScope: 'workspace',
          input: { jobId: claimed.jobId },
          operation: 'patient-brief-job.requeue',
        }, () => ({
          data: this.#briefs.requeue(claimed, new Date().toISOString()),
          effects: [],
        })).data
      }
      return this.#fail(claimed, this.#publicFailure(error))
    }
  }

  #generationInput(job: ClaimedPatientBriefJob) {
    const syntheticCase = this.#cases.get(job.workspaceId, job.caseId)
    const truth = this.#cases.getTruthForSimulator(job.workspaceId, job.caseId)
    const visible = this.#cases.getVisibleResourcesForSimulator(job.workspaceId, job.caseId)
    if (syntheticCase === undefined || truth === undefined) {
      throw new PatientBriefError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    const profile = this.#profiles.get(job.workspaceId, syntheticCase.profileId)
    if (profile === undefined) {
      throw new PatientBriefError('CASE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
    }
    const hiddenResources = truth.hiddenResources.map(item => item.resource as Resource)
    const visibleResources = visible.map(item => item.resource as Resource)
    const history = this.#cases.listVisibleHistory({
      caseId: job.caseId,
      page: 1,
      pageSize: 100,
      workspaceId: job.workspaceId,
    }).items
    const payload = {
      caseType: syntheticCase.caseType,
      demographics: {
        birthDate: profile.demographics.birthDate,
        gender: profile.demographics.gender,
      },
      privateEpisodeEvidence: hiddenResources.slice(0, 100).map(summarizedResource),
      visibleHistory: history,
    }
    return {
      hiddenResources,
      payload,
      visibleResources,
    }
  }

  #fail(job: ClaimedPatientBriefJob, error: { code: string; message: string }) {
    return this.#commands.execute({
      context: job.actorContext,
      contextRequirement: 'known',
      dataSchema: patientBriefJobSchema,
      expectedVersions: {},
      idempotencyKey: `${job.jobId}:fail:${error.code}`,
      idempotencyScope: 'workspace',
      input: { errorCode: error.code, jobId: job.jobId },
      operation: 'patient-brief-job.fail',
    }, () => ({
      data: this.#briefs.fail(job, error, new Date().toISOString()),
      effects: [{
        kind: 'updated' as const,
        reference: `PatientBriefJob/${job.jobId}`,
        versionId: 'failed',
      }],
    })).data
  }

  #publicFailure(error: unknown): { code: string; message: string } {
    if (error instanceof ChatCompletionsError || error instanceof PatientBriefLeakError) {
      return { code: error.code, message: error.message }
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return { code: 'BRIEF_RESPONSE_INVALID', message: 'The generated Patient Brief is invalid' }
    }
    return { code: 'BRIEF_GENERATION_FAILED', message: 'Patient Brief generation failed' }
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new PatientBriefError('ROLE_NOT_ALLOWED', 'Only an administrator can manage Patient Briefs')
    }
  }
}
