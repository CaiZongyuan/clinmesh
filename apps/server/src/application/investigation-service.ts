import { createHash } from 'node:crypto'
import {
  investigationCodeableValueSchema,
  investigationResultContentSchema,
  investigationResultSnapshotSchema,
  type InvestigationResultContent,
  type InvestigationResultSnapshot,
} from '@clinmesh/contracts/scenario'
import { referenceConceptSnapshotSchema } from '@clinmesh/contracts/reference-data'
import {
  laboratoryServiceSnapshotSchema,
  type InvestigationGenerationCapability,
  type LaboratoryServiceSnapshot,
} from '@clinmesh/contracts/his'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { InvestigationResultRepository } from '../infrastructure/sqlite/investigation-result-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import {
  ChatCompletionsError,
  type JsonChatCompletionsProvider,
} from '../infrastructure/ai/openai-chat-completions.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { syntheticInvestigationReferenceRange } from './scenario-data/reference-coding-package.ts'

const promptVersion = 'investigation-result-v1'
const systemPrompt = [
  '你是中国门诊结构化检验结果生成器。',
  '只返回符合 JSON Schema 的 JSON，不要返回 Markdown。',
  '只生成请求中的一个项目，只返回数值、normal/high/low 判读和简短结论。',
  '不得修改项目编码、单位或参考范围，不得添加其他项目。',
].join('\n')
const promptHash = canonicalJsonHash({ promptVersion, systemPrompt })
const servicePromptVersion = 'investigation-result-v2'
const serviceSystemPrompt = [
  '你是中国门诊结构化检验结果生成器。',
  '只返回符合 JSON Schema 的 JSON，不要返回 Markdown。',
  '只生成 requestedResults 中缺失的项目，不得增加、删除或替换编码。',
  '逐项原样返回输入给定的单位和参考范围，并返回值、normal/high/low 判读和总结。',
  '结合正式诊断、已有正式检验、可见病史和私有病例证据生成相互一致的结果。',
].join('\n')
const servicePromptHash = canonicalJsonHash({
  promptVersion: servicePromptVersion,
  systemPrompt: serviceSystemPrompt,
})
const maximumAgentEvidenceItems = 20
const agentEvidenceResourceTypes = new Set(['Condition', 'Observation', 'Procedure'])
const agentOutputSchema = z.object({
  conclusion: z.string().trim().min(1).max(1_000),
  interpretation: z.enum(['normal', 'high', 'low']),
  value: z.number().finite(),
}).strict()

const serviceAgentOutputSchema = z.object({
  conclusion: z.string().trim().min(1).max(1_000),
  results: z.array(z.object({
    code: z.string().min(1).max(256),
    interpretation: z.enum(['normal', 'high', 'low']),
    referenceRange: z.object({
      high: z.number().finite().optional(),
      low: z.number().finite().optional(),
      text: z.string().min(1).max(500),
    }).strict(),
    unit: z.object({
      code: z.string().min(1).max(128),
      display: z.string().min(1).max(128),
      system: z.literal('http://unitsofmeasure.org'),
    }).strict().optional(),
    value: z.union([
      z.boolean(),
      z.number().finite(),
      z.string().min(1).max(1_000),
      investigationCodeableValueSchema,
    ]),
  }).strict()).min(1).max(128),
}).strict()

const requestRowSchema = z.object({
  catalog_item_id: z.string().min(1),
  encounter_id: z.string().min(1),
  patient_id: z.string().min(1),
  profile_id: z.string().min(1),
  profile_revision: z.number().int().positive(),
  reference_json: z.string().min(1),
  result_snapshot_id: z.string().min(1).nullable(),
  service_snapshot_json: z.string().min(1).nullable(),
  synthetic_case_id: z.string().min(1),
  synthetic_case_revision: z.number().int().positive(),
}).strict()

const caseMaterializationRowSchema = z.object({
  synthetic_case_id: z.string().min(1),
}).strict()

const investigationResourceSchema = z.object({
  id: z.string().min(1),
  resourceType: z.string().min(1),
}).loose()

type Resource = z.infer<typeof investigationResourceSchema>
type RequestedConcept = z.infer<typeof referenceConceptSnapshotSchema>
type RequestRow = z.infer<typeof requestRowSchema>
type ServiceResultDefinition = LaboratoryServiceSnapshot['reportDefinition']['results'][number]
type RequestedLaboratory = NonNullable<RequestedConcept['laboratory']>
type AgentLaboratoryMetadata = RequestedLaboratory & {
  referenceRange: NonNullable<RequestedLaboratory['referenceRange']>
  resultType: 'quantity'
  unit: NonNullable<RequestedLaboratory['unit']>
}
type AgentGenerationPlan =
  | { capability: Extract<InvestigationGenerationCapability, { supported: false }> }
  | {
      capability: Extract<InvestigationGenerationCapability, { supported: true }>
      metadata: AgentLaboratoryMetadata
      referenceRange: AgentLaboratoryMetadata['referenceRange']
    }

export class InvestigationGenerationError extends Error {
  readonly code: 'INVESTIGATION_OUTPUT_INVALID' | 'INVESTIGATION_UNSUPPORTED'

  constructor(
    code: 'INVESTIGATION_OUTPUT_INVALID' | 'INVESTIGATION_UNSUPPORTED',
    message: string,
  ) {
    super(message)
    this.name = 'InvestigationGenerationError'
    this.code = code
  }
}

export function investigationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ChatCompletionsError || error instanceof InvestigationGenerationError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return {
      code: 'INVESTIGATION_OUTPUT_INVALID',
      message: 'The Investigation Agent returned an invalid result',
    }
  }
  return {
    code: 'INVESTIGATION_GENERATION_FAILED',
    message: 'Investigation result generation failed',
  }
}

function conceptCodings(resource: Resource) {
  const code = typeof resource.code === 'object' && resource.code !== null
    ? resource.code as Record<string, unknown>
    : {}
  return (Array.isArray(code.coding) ? code.coding : []).flatMap((value) => {
    if (typeof value !== 'object' || value === null) return []
    const coding = value as Record<string, unknown>
    return typeof coding.code === 'string' && typeof coding.system === 'string'
      ? [{
          code: coding.code,
          display: typeof coding.display === 'string' ? coding.display : undefined,
          system: coding.system,
        }]
      : []
  })
}

function clinicalTimestamp(resource: Resource): number {
  for (const key of ['effectiveDateTime', 'issued']) {
    const value = resource[key]
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value)
  }
  return 0
}

function quantity(value: unknown) {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) return undefined
  return {
    code: typeof candidate.code === 'string'
      ? candidate.code
      : typeof candidate.unit === 'string' ? candidate.unit : undefined,
    display: typeof candidate.unit === 'string'
      ? candidate.unit
      : typeof candidate.code === 'string' ? candidate.code : undefined,
    system: typeof candidate.system === 'string' ? candidate.system : undefined,
    value: candidate.value,
  }
}

function scalarValue(
  resource: Resource,
): boolean | string | z.infer<typeof investigationCodeableValueSchema> | undefined {
  if (typeof resource.valueBoolean === 'boolean') return resource.valueBoolean
  if (typeof resource.valueString === 'string') return resource.valueString
  if (typeof resource.valueCodeableConcept !== 'object' || resource.valueCodeableConcept === null) {
    return undefined
  }
  const concept = resource.valueCodeableConcept as Record<string, unknown>
  const coding = Array.isArray(concept.coding)
    ? concept.coding.find(item => typeof item === 'object' && item !== null)
    : undefined
  if (typeof coding === 'object' && coding !== null) {
    const code = (coding as Record<string, unknown>).code
    const display = (coding as Record<string, unknown>).display
    const system = (coding as Record<string, unknown>).system
    if (typeof code === 'string' && typeof display === 'string' && typeof system === 'string') {
      return investigationCodeableValueSchema.parse({ code, display, system })
    }
  }
  return typeof concept.text === 'string' ? concept.text : undefined
}

function sourceReferenceRange(resource: Resource) {
  const values = Array.isArray(resource.referenceRange) ? resource.referenceRange : []
  const first = values.find(value => typeof value === 'object' && value !== null) as
    | Record<string, unknown>
    | undefined
  if (first === undefined) return undefined
  const low = quantity(first.low)
  const high = quantity(first.high)
  return {
    ...(high === undefined ? {} : { high: high.value }),
    ...(low === undefined ? {} : { low: low.value }),
    text: typeof first.text === 'string' ? first.text : '来源 Observation 参考范围',
  }
}

function interpretationFor(
  value: number,
  range: { high?: number | undefined; low?: number | undefined },
): 'high' | 'low' | 'normal' {
  if (range.high !== undefined && value > range.high) return 'high'
  if (range.low !== undefined && value < range.low) return 'low'
  return 'normal'
}

function sourceInterpretation(
  resource: Resource,
  value: number,
  range: { high?: number | undefined; low?: number | undefined },
) {
  const interpretations = Array.isArray(resource.interpretation) ? resource.interpretation : []
  for (const interpretation of interpretations) {
    if (typeof interpretation !== 'object' || interpretation === null) continue
    const coding = (interpretation as Record<string, unknown>).coding
    if (!Array.isArray(coding)) continue
    for (const item of coding) {
      if (typeof item !== 'object' || item === null) continue
      const code = (item as Record<string, unknown>).code
      if (code === 'H') return 'high' as const
      if (code === 'L') return 'low' as const
      if (code === 'N') return 'normal' as const
    }
  }
  return interpretationFor(value, range)
}

function evidence(resources: Resource[]) {
  return resources
    .filter(resource => agentEvidenceResourceTypes.has(resource.resourceType))
    .toSorted((left, right) => (
      clinicalTimestamp(right) - clinicalTimestamp(left) || left.id.localeCompare(right.id)
    ))
    .slice(0, maximumAgentEvidenceItems)
    .map((resource) => {
      const valueQuantity = quantity(resource.valueQuantity)
      const scalarValue = typeof resource.valueString === 'string'
        || typeof resource.valueBoolean === 'boolean'
        ? resource.valueString ?? resource.valueBoolean
        : undefined
      const timestamp = clinicalTimestamp(resource)
      return {
        codings: conceptCodings(resource).slice(0, 5),
        resourceType: resource.resourceType,
        ...(timestamp === 0
          ? {}
          : { clinicalTime: new Date(timestamp).toISOString() }),
        ...(valueQuantity === undefined
          ? scalarValue === undefined ? {} : { value: scalarValue }
          : {
              value: {
                code: valueQuantity.code,
                display: valueQuantity.display,
                system: valueQuantity.system,
                value: valueQuantity.value,
              },
            }),
      }
    })
}

function exactObservation(
  hiddenResources: Resource[],
  requestedConcept: RequestedConcept,
): Resource | undefined {
  return hiddenResources
    .filter(resource => resource.resourceType === 'Observation')
    .filter(resource => conceptCodings(resource).some(coding => (
      coding.system === requestedConcept.system && coding.code === requestedConcept.code
    )))
    .toSorted((left, right) => (
      clinicalTimestamp(right) - clinicalTimestamp(left) || left.id.localeCompare(right.id)
    ))[0]
}

function agentLaboratoryMetadata(
  concept: RequestedConcept,
): AgentLaboratoryMetadata | undefined {
  const metadata = concept.laboratory
  const referenceRange = metadata?.referenceRange ?? (
    metadata?.unit === undefined
      ? undefined
      : syntheticInvestigationReferenceRange({
          code: concept.code,
          system: concept.system,
          unitCode: metadata.unit.code,
          unitDisplay: metadata.unit.display,
          version: concept.version,
        })
  )
  if (
    metadata?.resultType !== 'quantity'
    || metadata.unit === undefined
    || referenceRange === undefined
    || (referenceRange.low === undefined && referenceRange.high === undefined)
  ) return undefined
  return { ...metadata, referenceRange, resultType: 'quantity', unit: metadata.unit }
}

export class InvestigationService {
  readonly #cases: SyntheticCaseRepository
  readonly #database: ClinMeshDatabase
  readonly #model: string | undefined
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #provider: JsonChatCompletionsProvider | undefined
  readonly #results: InvestigationResultRepository

  constructor(input: {
    cases: SyntheticCaseRepository
    database: ClinMeshDatabase
    model?: string
    profiles: SyntheticPatientProfileRepository
    provider?: JsonChatCompletionsProvider
    results: InvestigationResultRepository
  }) {
    this.#cases = input.cases
    this.#database = input.database
    this.#model = input.model
    this.#profiles = input.profiles
    this.#provider = input.provider
    this.#results = input.results
  }

  generationCapabilityForCase(
    workspaceId: string,
    epoch: string,
    outpatientCaseId: string,
    concept: RequestedConcept,
  ): InvestigationGenerationCapability {
    const materialization = caseMaterializationRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT case_id AS synthetic_case_id
        FROM synthetic_case_materialization
        WHERE workspace_id = ? AND epoch = ? AND outpatient_case_id = ?
      `).get(workspaceId, epoch, outpatientCaseId),
    )
    if (materialization === undefined) {
      return { reason: 'no-case-source', supported: false }
    }
    const truth = this.#cases.getTruthForSimulator(workspaceId, materialization.synthetic_case_id)
    if (truth === undefined) return { reason: 'no-case-source', supported: false }
    const exact = exactObservation(
      truth.hiddenResources.map(item => investigationResourceSchema.parse(item.resource)),
      concept,
    )
    if (exact !== undefined) {
      try {
        this.#contentFromExactObservation(concept, exact)
        return { source: 'synthea-exact', supported: true }
      } catch (error) {
        if (error instanceof InvestigationGenerationError) {
          return { reason: 'exact-incompatible', supported: false }
        }
        throw error
      }
    }
    return this.#agentGenerationPlan(concept).capability
  }

  async resolveForRequest(
    workspaceId: string,
    epoch: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<InvestigationResultSnapshot | undefined> {
    const row = requestRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT request.catalog_item_id, request.reference_json,
        request.result_snapshot_id, request.service_snapshot_json,
        outpatient_case.encounter_id, outpatient_case.patient_id,
        materialization.case_id AS synthetic_case_id,
        materialization.case_revision AS synthetic_case_revision,
        materialization.profile_id, materialization.profile_revision
      FROM laboratory_request AS request
      JOIN synthetic_case_materialization AS materialization
        ON materialization.workspace_id = request.workspace_id
       AND materialization.epoch = request.epoch
       AND materialization.outpatient_case_id = request.case_id
      JOIN outpatient_case
        ON outpatient_case.workspace_id = request.workspace_id
       AND outpatient_case.epoch = request.epoch
       AND outpatient_case.case_id = request.case_id
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.request_id = ?
    `).get(workspaceId, epoch, requestId))
    if (row === undefined) return undefined
    if (row.result_snapshot_id !== null) {
      return this.#results.getById(workspaceId, row.result_snapshot_id)
    }
    if (row.service_snapshot_json !== null) {
      return this.#resolvePublishedService(
        workspaceId,
        epoch,
        row,
        laboratoryServiceSnapshotSchema.parse(JSON.parse(row.service_snapshot_json)),
        signal,
      )
    }
    const existing = this.#results.getByCaseItem(
      workspaceId,
      row.synthetic_case_id,
      row.catalog_item_id,
    )
    if (existing !== undefined) return existing
    const requestedConcept = referenceConceptSnapshotSchema.parse(JSON.parse(row.reference_json))
    const syntheticCase = this.#cases.get(workspaceId, row.synthetic_case_id)
    const truth = this.#cases.getTruthForSimulator(workspaceId, row.synthetic_case_id)
    const profile = this.#profiles.getRevision(workspaceId, row.profile_id, row.profile_revision)
    if (syntheticCase === undefined || truth === undefined || profile === undefined) {
      throw new InvestigationGenerationError('INVESTIGATION_OUTPUT_INVALID', 'The Synthetic Case context is incomplete')
    }
    const hiddenResources = truth.hiddenResources.map(item => (
      investigationResourceSchema.parse(item.resource)
    ))
    const exact = exactObservation(hiddenResources, requestedConcept)
    const baseInput = {
      caseRevision: row.synthetic_case_revision,
      demographics: {
        birthDate: profile.demographics.birthDate,
        gender: profile.demographics.gender,
      },
      requestedConcept,
      sourceHash: syntheticCase.sourceHash,
    }
    if (exact !== undefined) {
      const content = this.#contentFromExactObservation(requestedConcept, exact)
      return this.#freeze({
        caseId: row.synthetic_case_id,
        catalogItemId: row.catalog_item_id,
        content,
        inputHash: canonicalJsonHash(baseInput),
        model: null,
        promptHash: null,
        promptVersion: null,
        requestedConcept,
        source: 'synthea-exact',
        workspaceId,
      })
    }
    const agentPlan = this.#agentGenerationPlan(requestedConcept)
    if (!('metadata' in agentPlan) || this.#provider === undefined || this.#model === undefined) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_UNSUPPORTED',
        'The requested investigation cannot be generated by the structured Investigation Agent',
      )
    }
    const { metadata, referenceRange } = agentPlan
    const payload = {
      ...baseInput,
      privateCaseEvidence: evidence(hiddenResources),
      referenceRange,
      resultType: metadata.resultType,
      unit: metadata.unit,
      visibleHistory: this.#cases.listRecentVisibleHistory({
        caseId: row.synthetic_case_id,
        limit: maximumAgentEvidenceItems,
        workspaceId,
      }),
    }
    const inputHash = canonicalJsonHash(payload)
    const completion = await this.#provider.completeJson({
      jsonSchema: z.toJSONSchema(agentOutputSchema) as Record<string, unknown>,
      model: this.#model,
      schemaName: 'investigation_result',
      ...(signal === undefined ? {} : { signal }),
      systemPrompt,
      userPayload: payload,
    })
    const output = agentOutputSchema.parse(JSON.parse(completion.content))
    if (output.interpretation !== interpretationFor(output.value, referenceRange)) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The Investigation Agent interpretation conflicts with the reference range',
      )
    }
    const content = investigationResultContentSchema.parse({
      conclusion: output.conclusion,
      results: [{
        code: requestedConcept.code,
        display: requestedConcept.display,
        interpretation: output.interpretation,
        referenceRange,
        unit: metadata.unit,
        value: output.value,
      }],
    })
    return this.#freeze({
      caseId: row.synthetic_case_id,
      catalogItemId: row.catalog_item_id,
      content,
      inputHash,
      model: completion.model,
      promptHash,
      promptVersion,
      requestedConcept,
      source: 'investigation-agent',
      workspaceId,
    })
  }

  async #resolvePublishedService(
    workspaceId: string,
    epoch: string,
    row: RequestRow,
    service: LaboratoryServiceSnapshot,
    signal?: AbortSignal,
  ): Promise<InvestigationResultSnapshot> {
    const syntheticCase = this.#cases.get(workspaceId, row.synthetic_case_id)
    const truth = this.#cases.getTruthForSimulator(workspaceId, row.synthetic_case_id)
    const profile = this.#profiles.getRevision(workspaceId, row.profile_id, row.profile_revision)
    if (syntheticCase === undefined || truth === undefined || profile === undefined) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The Synthetic Case context is incomplete',
      )
    }
    const hiddenResources = truth.hiddenResources.map(item => (
      investigationResourceSchema.parse(item.resource)
    ))
    const exactResults = new Map<string, InvestigationResultContent['results'][number]>()
    for (const definition of service.reportDefinition.results) {
      const exact = exactObservation(hiddenResources, definition.referenceConcept)
      if (exact === undefined) continue
      exactResults.set(definition.referenceConcept.code, this.#contentFromServiceObservation(
        definition,
        exact,
      ))
    }
    const formalEvidence = this.#formalEvidence(
      workspaceId,
      epoch,
      row.patient_id,
      row.encounter_id,
    )
    const missing = service.reportDefinition.results.filter(
      definition => !exactResults.has(definition.referenceConcept.code),
    )
    const basePayload = {
      caseRevision: row.synthetic_case_revision,
      demographics: {
        birthDate: profile.demographics.birthDate,
        gender: profile.demographics.gender,
      },
      exactResults: [...exactResults.values()],
      formalEvidence,
      requestedService: service,
      sourceHash: syntheticCase.sourceHash,
    }
    if (missing.length === 0) {
      const inputHash = canonicalJsonHash(basePayload)
      const existing = this.#results.getByEvidence(
        workspaceId,
        row.synthetic_case_id,
        row.catalog_item_id,
        inputHash,
      )
      if (existing !== undefined) return existing
      return this.#freeze({
        caseId: row.synthetic_case_id,
        catalogItemId: row.catalog_item_id,
        content: investigationResultContentSchema.parse({
          conclusion: service.reportDefinition.conclusionTemplate,
          results: service.reportDefinition.results.map(definition => (
            exactResults.get(definition.referenceConcept.code)!
          )),
        }),
        inputHash,
        model: null,
        promptHash: null,
        promptVersion: null,
        requestedConcept: service.referenceConcept,
        source: 'synthea-exact',
        workspaceId,
      })
    }
    if (this.#provider === undefined || this.#model === undefined) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_UNSUPPORTED',
        'The structured Investigation Agent is not configured',
      )
    }
    const payload = {
      ...basePayload,
      privateCaseEvidence: evidence(hiddenResources),
      requestedResults: missing,
      visibleHistory: this.#cases.listRecentVisibleHistory({
        caseId: row.synthetic_case_id,
        limit: maximumAgentEvidenceItems,
        workspaceId,
      }),
    }
    const inputHash = canonicalJsonHash(payload)
    const existing = this.#results.getByEvidence(
      workspaceId,
      row.synthetic_case_id,
      row.catalog_item_id,
      inputHash,
    )
    if (existing !== undefined) return existing
    const completion = await this.#provider.completeJson({
      jsonSchema: z.toJSONSchema(serviceAgentOutputSchema) as Record<string, unknown>,
      model: this.#model,
      schemaName: 'investigation_service_result',
      ...(signal === undefined ? {} : { signal }),
      systemPrompt: serviceSystemPrompt,
      userPayload: payload,
    })
    const output = serviceAgentOutputSchema.parse(JSON.parse(completion.content))
    const outputByCode = new Map(output.results.map(result => [result.code, result]))
    if (outputByCode.size !== output.results.length
      || output.results.length !== missing.length
      || missing.some(definition => !outputByCode.has(definition.referenceConcept.code))) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The Investigation Agent changed the requested report closure',
      )
    }
    const generatedResults = new Map(missing.map((definition) => {
      const generated = outputByCode.get(definition.referenceConcept.code)!
      return [definition.referenceConcept.code, this.#validatedServiceAgentResult(
        definition,
        generated,
      )] as const
    }))
    const content = investigationResultContentSchema.parse({
      conclusion: output.conclusion,
      results: service.reportDefinition.results.map(definition => (
        exactResults.get(definition.referenceConcept.code)
        ?? generatedResults.get(definition.referenceConcept.code)
      )),
    })
    return this.#freeze({
      caseId: row.synthetic_case_id,
      catalogItemId: row.catalog_item_id,
      content,
      inputHash,
      model: completion.model,
      promptHash: servicePromptHash,
      promptVersion: servicePromptVersion,
      requestedConcept: service.referenceConcept,
      source: 'investigation-agent',
      workspaceId,
    })
  }

  #contentFromServiceObservation(
    definition: ServiceResultDefinition,
    observation: Resource,
  ): InvestigationResultContent['results'][number] {
    if (definition.valueType === 'quantity') {
      const result = quantity(observation.valueQuantity)
      if (result === undefined || definition.unit === undefined
        || result.code !== definition.unit.code
        || result.system !== definition.unit.system) {
        throw new InvestigationGenerationError(
          'INVESTIGATION_OUTPUT_INVALID',
          'The exact Case Truth Observation conflicts with the Laboratory Service unit',
        )
      }
      return {
        code: definition.referenceConcept.code,
        display: definition.referenceConcept.display,
        interpretation: interpretationFor(result.value, definition.referenceRange),
        referenceRange: definition.referenceRange,
        unit: definition.unit,
        value: result.value,
      }
    }
    const value = scalarValue(observation)
    if (value === undefined || definition.allowedValues?.some(
      item => canonicalJsonHash(item) === canonicalJsonHash(value),
    ) !== true) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The exact Case Truth Observation conflicts with the Laboratory Service value definition',
      )
    }
    return {
      code: definition.referenceConcept.code,
      display: definition.referenceConcept.display,
      interpretation: 'normal',
      referenceRange: definition.referenceRange,
      value,
    }
  }

  #validatedServiceAgentResult(
    definition: ServiceResultDefinition,
    generated: z.infer<typeof serviceAgentOutputSchema>['results'][number],
  ): InvestigationResultContent['results'][number] {
    if (canonicalJsonHash(generated.referenceRange)
      !== canonicalJsonHash(definition.referenceRange)
      || canonicalJsonHash(generated.unit ?? null) !== canonicalJsonHash(definition.unit ?? null)) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The Investigation Agent changed the Laboratory Service unit or reference range',
      )
    }
    if (definition.valueType === 'quantity') {
      if (typeof generated.value !== 'number'
        || generated.interpretation !== interpretationFor(
          generated.value,
          definition.referenceRange,
        )) {
        throw new InvestigationGenerationError(
          'INVESTIGATION_OUTPUT_INVALID',
          'The Investigation Agent value conflicts with the quantitative report definition',
        )
      }
    } else {
      const valueMatchesType = definition.valueType === 'boolean'
        ? typeof generated.value === 'boolean'
        : definition.valueType === 'string'
          ? typeof generated.value === 'string'
          : typeof generated.value === 'object'
      const allowed = definition.allowedValues?.some(
        value => canonicalJsonHash(value) === canonicalJsonHash(generated.value),
      ) === true
      if (!valueMatchesType || !allowed) {
        throw new InvestigationGenerationError(
          'INVESTIGATION_OUTPUT_INVALID',
          'The Investigation Agent value conflicts with the qualitative report definition',
        )
      }
    }
    return investigationResultContentSchema.shape.results.element.parse({
      code: definition.referenceConcept.code,
      display: definition.referenceConcept.display,
      interpretation: generated.interpretation,
      referenceRange: generated.referenceRange,
      ...(generated.unit === undefined ? {} : { unit: generated.unit }),
      value: generated.value,
    })
  }

  #formalEvidence(
    workspaceId: string,
    epoch: string,
    patientId: string,
    encounterId: string,
  ) {
    const rows = z.array(z.object({ content_json: z.string() }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT content_json
        FROM fhir_resource
        WHERE workspace_id = ? AND epoch = ? AND deleted = 0
          AND resource_type IN ('Condition', 'Observation')
          AND (
            json_extract(content_json, '$.encounter.reference') = ?
            OR (
              resource_type = 'Condition'
              AND json_extract(content_json, '$.subject.reference') = ?
            )
          )
        ORDER BY last_updated DESC, resource_type, resource_id
        LIMIT ?
      `).all(
        workspaceId,
        epoch,
        `Encounter/${encounterId}`,
        `Patient/${patientId}`,
        maximumAgentEvidenceItems,
      ),
    )
    return evidence(rows.map(row => investigationResourceSchema.parse(
      JSON.parse(row.content_json),
    )))
  }

  #contentFromExactObservation(
    requestedConcept: z.infer<typeof referenceConceptSnapshotSchema>,
    observation: Resource,
  ): InvestigationResultContent {
    const result = quantity(observation.valueQuantity)
    if (result === undefined) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The exact Synthea Observation has an unsupported value type',
      )
    }
    const expectedUnit = requestedConcept.laboratory?.unit
    if (
      expectedUnit !== undefined
      && (result.code !== expectedUnit.code || result.system !== expectedUnit.system)
    ) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_OUTPUT_INVALID',
        'The exact Synthea Observation unit conflicts with the requested item',
      )
    }
    const unit = expectedUnit ?? (
      result.code === undefined || result.display === undefined
        ? undefined
        : {
            code: result.code,
            display: result.display,
            system: 'http://unitsofmeasure.org' as const,
          }
    )
    const referenceRange = sourceReferenceRange(observation)
      ?? requestedConcept.laboratory?.referenceRange
      ?? { text: '来源 Observation 未提供参考范围' }
    return investigationResultContentSchema.parse({
      conclusion: `${requestedConcept.display} ${result.value}${unit === undefined ? '' : ` ${unit.display}`}`,
      results: [{
        code: requestedConcept.code,
        display: requestedConcept.display,
        interpretation: sourceInterpretation(observation, result.value, referenceRange),
        referenceRange,
        ...(unit === undefined ? {} : { unit }),
        value: result.value,
      }],
    })
  }

  #agentGenerationPlan(concept: RequestedConcept): AgentGenerationPlan {
    const metadata = agentLaboratoryMetadata(concept)
    if (metadata === undefined) {
      return { capability: { reason: 'metadata-incomplete', supported: false } }
    }
    if (this.#provider === undefined || this.#model === undefined) {
      return { capability: { reason: 'agent-unavailable', supported: false } }
    }
    return {
      capability: { source: 'investigation-agent', supported: true },
      metadata,
      referenceRange: metadata.referenceRange,
    }
  }

  #freeze(input: Omit<InvestigationResultSnapshot, 'createdAt' | 'outputHash' | 'snapshotId'>) {
    const outputHash = canonicalJsonHash(input.content)
    const snapshotId = `investigation-result-${createHash('sha256')
      .update(`${input.workspaceId}:${input.caseId}:${input.catalogItemId}:${input.inputHash}`)
      .digest('hex')
      .slice(0, 32)}`
    return this.#results.createOrGet(investigationResultSnapshotSchema.parse({
      ...input,
      createdAt: new Date().toISOString(),
      outputHash,
      snapshotId,
    }))
  }
}
