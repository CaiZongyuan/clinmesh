import { randomUUID } from 'node:crypto'
import {
  patientPersonaContentSchema,
  patientPersonaJobSchema,
  patientPersonaRevisionSchema,
  syntheticCaseInstanceSchema,
  type PatientPersonaContent,
  type PatientPersonaJob,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type {
  ClaimedPatientPersonaJob,
  PatientPersonaRepository,
} from '../infrastructure/sqlite/patient-persona-repository.ts'
import {
  ChatCompletionsError,
  type JsonChatCompletionsProvider,
} from '../infrastructure/ai/openai-chat-completions.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const promptVersion = 'patient-persona-v2'
const systemPrompt = [
  '你是中国门诊标准化患者人设生成器。',
  '只返回符合 JSON Schema 的 JSON，不要返回 Markdown。',
  '根据合成患者的人口学与生活背景、既往可见病史和本次私有证据生成患者档案：',
  '主诉、患者开场陈述、已知史摘要、性格与说话方式、健康素养、就医态度、体验式症状叙述、用药记忆。',
  '性格、表达方式和健康素养必须与年龄、职业、文化程度协调，像一位真实的中国门诊患者。',
  '症状叙述使用患者第一人称体验（感受、时间线、加重缓解、自行处理过什么）。',
  '患者不知道自己本次得了什么病，只知道自己的感受。',
  '不得把尚未在既往病史出现的本次诊断名称、诊断编码或同义表达写入任何字段。',
].join('\n')
const promptHash = canonicalJsonHash({ promptVersion, systemPrompt })

export type PersonaResource = { id: string; resourceType: string; [key: string]: unknown }

export class PatientPersonaLeakError extends Error {
  readonly code = 'PERSONA_DIAGNOSIS_LEAK'

  constructor() {
    super('The generated Patient Persona reveals a hidden diagnosis')
    this.name = 'PatientPersonaLeakError'
  }
}

type PatientPersonaErrorCode =
  | 'PERSONA_JOB_NOT_FOUND'
  | 'PERSONA_REVISION_NOT_FOUND'
  | 'PERSONA_DIAGNOSIS_LEAK_WARNING'
  | 'CASE_NOT_FOUND'
  | 'CASE_VERSION_CONFLICT'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'ROLE_NOT_ALLOWED'

export class PatientPersonaError extends Error {
  readonly code: PatientPersonaErrorCode
  readonly status: 403 | 404 | 409 | 503

  constructor(code: PatientPersonaErrorCode, message: string) {
    super(message)
    this.name = 'PatientPersonaError'
    this.code = code
    if (code === 'ROLE_NOT_ALLOWED') this.status = 403
    else if (code === 'CASE_VERSION_CONFLICT' || code === 'PERSONA_DIAGNOSIS_LEAK_WARNING') this.status = 409
    else if (code === 'PROVIDER_NOT_AVAILABLE') this.status = 503
    else this.status = 404
  }
}

function conceptValues(resource: PersonaResource): { codes: string[]; terms: string[] } {
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

export function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replaceAll(/[^\p{L}\p{N}]+/gu, '').replaceAll('二型', '2型').replaceAll('一型', '1型')
}

function summarizedResource(resource: PersonaResource) {
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

function diagnosisTerms(term: string): string[] {
  const name = normalized(term.replace(/[(（](?:疾病|疾患|障碍|disorder|disease|finding)[)）]/gi, ''))
  return name.endsWith('糖尿病') && /^[12]型/.test(name) ? [name, '糖尿病'] : [name]
}

export function hiddenDiagnosisTokens(
  hiddenResources: PersonaResource[],
  visibleResources: PersonaResource[],
): string[] {
  const visibleConditions = visibleResources.filter(resource => resource.resourceType === 'Condition')
  const visibleCodes = new Set(visibleConditions.flatMap(resource => conceptValues(resource).codes))
  const visibleTerms = new Set(visibleConditions.flatMap(resource => conceptValues(resource).terms.flatMap(diagnosisTerms)))
  return [...new Set(hiddenResources
    .filter(resource => resource.resourceType === 'Condition')
    .flatMap(resource => {
      const values = conceptValues(resource)
      if (values.codes.some(code => visibleCodes.has(code))) return []
      return [...values.codes.map(normalized), ...values.terms.flatMap(diagnosisTerms)]
        .filter(token => !visibleTerms.has(token))
    })
    .filter(value => value.length >= 2))]
}

function assertNoDiagnosisLeak(
  content: PatientPersonaContent,
  hiddenResources: PersonaResource[],
  visibleResources: PersonaResource[],
): void {
  const output = normalized(JSON.stringify(content))
  if (hiddenDiagnosisTokens(hiddenResources, visibleResources).some(token => output.includes(token))) {
    throw new PatientPersonaLeakError()
  }
}

export async function generatePatientPersona(input: {
  hiddenResources: PersonaResource[]
  model: string
  payload: unknown
  provider: JsonChatCompletionsProvider
  signal?: AbortSignal
  visibleResources: PersonaResource[]
}) {
  const completion = await input.provider.completeJson({
    jsonSchema: z.toJSONSchema(patientPersonaContentSchema) as Record<string, unknown>,
    model: input.model,
    schemaName: 'patient_persona',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    systemPrompt,
    userPayload: input.payload,
    validate: value => patientPersonaContentSchema.safeParse(value).success,
  })
  const content = patientPersonaContentSchema.parse(JSON.parse(completion.content))
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

const manualPromptVersion = 'patient-persona-manual-edit-v1'
const manualPromptHash = canonicalJsonHash({ promptVersion: manualPromptVersion })

export class PatientPersonaService {
  readonly #briefs: PatientPersonaRepository
  readonly #cases: SyntheticCaseRepository
  readonly #commands: CommandExecutor
  readonly #model: string | undefined
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #provider: JsonChatCompletionsProvider | undefined

  constructor(input: {
    briefs: PatientPersonaRepository
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
      throw new PatientPersonaError('PROVIDER_NOT_AVAILABLE', 'Patient Persona generation is not configured')
    }
    if (this.#cases.get(input.context.workspaceId, input.caseId) === undefined) {
      throw new PatientPersonaError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    const now = new Date().toISOString()
    const job = patientPersonaJobSchema.parse({
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
      dataSchema: patientPersonaJobSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { caseId: input.caseId },
      operation: 'patient-persona-job.create',
    }, () => {
      this.#briefs.create(job, input.context, this.#model!)
      return {
        data: job,
        effects: [{ kind: 'created' as const, reference: `PatientPersonaJob/${job.jobId}`, versionId: '1' }],
      }
    })
  }

  getJob(context: ActorContext, jobId: string): PatientPersonaJob {
    this.#assertAdministrator(context)
    const job = this.#briefs.get(context.workspaceId, jobId)
    if (job === undefined) {
      throw new PatientPersonaError('PERSONA_JOB_NOT_FOUND', 'The Patient Persona job was not found')
    }
    return job
  }

  listRevisions(context: ActorContext, caseId: string) {
    this.#assertAdministrator(context)
    const revisions = this.#briefs.listRevisions(context.workspaceId, caseId)
    if (revisions === undefined) {
      throw new PatientPersonaError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    return revisions
  }

  selectRevision(input: {
    personaRevision: number
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
        personaRevision: input.personaRevision,
        caseId: input.caseId,
        expectedCaseRevision: input.expectedCaseRevision,
      },
      operation: 'patient-persona-revision.select',
    }, () => {
      const selected = this.#briefs.selectRevision({
        personaRevision: input.personaRevision,
        caseId: input.caseId,
        expectedCaseRevision: input.expectedCaseRevision,
        now: new Date().toISOString(),
        workspaceId: input.context.workspaceId,
      })
      if (selected === undefined) {
        const revisions = this.#briefs.listRevisions(input.context.workspaceId, input.caseId)
        if (revisions === undefined) {
          throw new PatientPersonaError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
        }
        if (!revisions.items.some(item => item.revision === input.personaRevision)) {
          throw new PatientPersonaError('PERSONA_REVISION_NOT_FOUND', 'The Patient Persona revision was not found')
        }
        throw new PatientPersonaError('CASE_VERSION_CONFLICT', 'The Synthetic Case changed after it was loaded')
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

  createRevisionFromEdit(input: {
    caseId: string
    content: PatientPersonaContent
    context: ActorContext
    forceDiagnosisLeakOverride: boolean
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    if (this.#cases.get(input.context.workspaceId, input.caseId) === undefined) {
      throw new PatientPersonaError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    const content = patientPersonaContentSchema.parse(input.content)
    const generation = this.#generationInput({
      caseId: input.caseId,
      workspaceId: input.context.workspaceId,
    })
    if (
      hiddenDiagnosisTokens(generation.hiddenResources, generation.visibleResources)
        .some(token => normalized(JSON.stringify(content)).includes(token))
      && !input.forceDiagnosisLeakOverride
    ) {
      throw new PatientPersonaError(
        'PERSONA_DIAGNOSIS_LEAK_WARNING',
        'The edited Patient Persona mentions the hidden diagnosis of this encounter',
      )
    }
    const contentHash = canonicalJsonHash(content)
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: patientPersonaRevisionSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { caseId: input.caseId, outputHash: contentHash },
      operation: 'patient-persona-revision.create-from-edit',
    }, () => {
      const revision = this.#briefs.createRevision({
        caseId: input.caseId,
        content,
        createdAt: new Date().toISOString(),
        inputHash: contentHash,
        model: 'administrator-manual',
        outputHash: contentHash,
        promptHash: manualPromptHash,
        promptVersion: manualPromptVersion,
        workspaceId: input.context.workspaceId,
      })
      return {
        data: revision,
        effects: [{
          kind: 'created' as const,
          reference: `PatientPersona/${input.caseId}/${revision.revision}`,
          versionId: String(revision.revision),
        }],
      }
    })
  }

  async processNext(signal?: AbortSignal): Promise<PatientPersonaJob | undefined> {
    const claimed = this.#briefs.claimNext(new Date().toISOString())
    if (claimed === undefined) return undefined
    if (this.#provider === undefined) return this.#fail(claimed, {
      code: 'PROVIDER_NOT_AVAILABLE',
      message: 'Patient Persona generation is not configured',
    })
    try {
      const generation = this.#generationInput({
        caseId: claimed.caseId,
        workspaceId: claimed.workspaceId,
      })
      const generated = await generatePatientPersona({
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
        dataSchema: patientPersonaJobSchema,
        expectedVersions: {},
        idempotencyKey: `${claimed.jobId}:complete:${generated.outputHash}`,
        idempotencyScope: 'workspace',
        input: { jobId: claimed.jobId, outputHash: generated.outputHash },
        operation: 'patient-persona-job.complete',
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
          dataSchema: patientPersonaJobSchema,
          expectedVersions: {},
          idempotencyKey: `${claimed.jobId}:requeue:${claimed.startedAt}`,
          idempotencyScope: 'workspace',
          input: { jobId: claimed.jobId },
          operation: 'patient-persona-job.requeue',
        }, () => ({
          data: this.#briefs.requeue(claimed, new Date().toISOString()),
          effects: [],
        })).data
      }
      return this.#fail(claimed, this.#publicFailure(error))
    }
  }

  #generationInput(input: { caseId: string; workspaceId: string }) {
    const syntheticCase = this.#cases.get(input.workspaceId, input.caseId)
    const truth = this.#cases.getTruthForSimulator(input.workspaceId, input.caseId)
    const visible = this.#cases.getVisibleResourcesForSimulator(input.workspaceId, input.caseId)
    if (syntheticCase === undefined || truth === undefined) {
      throw new PatientPersonaError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    const profile = this.#profiles.get(input.workspaceId, syntheticCase.profileId)
    if (profile === undefined) {
      throw new PatientPersonaError('CASE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
    }
    const hiddenResources = truth.hiddenResources.map(item => item.resource as PersonaResource)
    const visibleResources = visible.map(item => item.resource as PersonaResource)
    const history = this.#cases.listVisibleHistory({
      caseId: input.caseId,
      page: 1,
      pageSize: 100,
      workspaceId: input.workspaceId,
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

  #fail(job: ClaimedPatientPersonaJob, error: { code: string; message: string }) {
    return this.#commands.execute({
      context: job.actorContext,
      contextRequirement: 'known',
      dataSchema: patientPersonaJobSchema,
      expectedVersions: {},
      idempotencyKey: `${job.jobId}:fail:${error.code}`,
      idempotencyScope: 'workspace',
      input: { errorCode: error.code, jobId: job.jobId },
      operation: 'patient-persona-job.fail',
    }, () => ({
      data: this.#briefs.fail(job, error, new Date().toISOString()),
      effects: [{
        kind: 'updated' as const,
        reference: `PatientPersonaJob/${job.jobId}`,
        versionId: 'failed',
      }],
    })).data
  }

  #publicFailure(error: unknown): { code: string; message: string } {
    if (error instanceof ChatCompletionsError || error instanceof PatientPersonaLeakError) {
      return { code: error.code, message: error.message }
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return { code: 'PERSONA_RESPONSE_INVALID', message: 'The generated Patient Persona is invalid' }
    }
    return { code: 'PERSONA_GENERATION_FAILED', message: 'Patient Persona generation failed' }
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new PatientPersonaError('ROLE_NOT_ALLOWED', 'Only an administrator can manage Patient Personas')
    }
  }
}
