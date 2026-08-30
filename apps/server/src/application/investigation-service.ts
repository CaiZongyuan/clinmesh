import { createHash } from 'node:crypto'
import {
  investigationResultContentSchema,
  investigationResultSnapshotSchema,
  type InvestigationResultContent,
  type InvestigationResultSnapshot,
} from '@clinmesh/contracts/scenario'
import { referenceConceptSnapshotSchema } from '@clinmesh/contracts/reference-data'
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

const promptVersion = 'investigation-result-v1'
const systemPrompt = [
  '你是中国门诊结构化检验结果生成器。',
  '只返回符合 JSON Schema 的 JSON，不要返回 Markdown。',
  '只生成请求中的一个项目，只返回数值、normal/high/low 判读和简短结论。',
  '不得修改项目编码、单位或参考范围，不得添加其他项目。',
].join('\n')
const promptHash = canonicalJsonHash({ promptVersion, systemPrompt })
const agentOutputSchema = z.object({
  conclusion: z.string().trim().min(1).max(1_000),
  interpretation: z.enum(['normal', 'high', 'low']),
  value: z.number().finite(),
}).strict()

const requestRowSchema = z.object({
  catalog_item_id: z.string().min(1),
  profile_id: z.string().min(1),
  profile_revision: z.number().int().positive(),
  reference_json: z.string().min(1),
  synthetic_case_id: z.string().min(1),
  synthetic_case_revision: z.number().int().positive(),
}).strict()

type Resource = { id: string; resourceType: string; [key: string]: unknown }

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
  return resources.slice(0, 100).map((resource) => {
    const valueQuantity = quantity(resource.valueQuantity)
    const scalarValue = typeof resource.valueString === 'string'
      || typeof resource.valueBoolean === 'boolean'
      ? resource.valueString ?? resource.valueBoolean
      : undefined
    return {
      codings: conceptCodings(resource).slice(0, 5),
      resourceType: resource.resourceType,
      ...(clinicalTimestamp(resource) === 0
        ? {}
        : { clinicalTime: new Date(clinicalTimestamp(resource)).toISOString() }),
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

  async resolveForRequest(
    workspaceId: string,
    epoch: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<InvestigationResultSnapshot | undefined> {
    const row = requestRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT request.catalog_item_id, request.reference_json,
        materialization.case_id AS synthetic_case_id,
        materialization.case_revision AS synthetic_case_revision,
        materialization.profile_id, materialization.profile_revision
      FROM laboratory_request AS request
      JOIN synthetic_case_materialization AS materialization
        ON materialization.workspace_id = request.workspace_id
       AND materialization.epoch = request.epoch
       AND materialization.outpatient_case_id = request.case_id
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.request_id = ?
    `).get(workspaceId, epoch, requestId))
    if (row === undefined) return undefined
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
    const hiddenResources = truth.hiddenResources.map(item => item.resource as Resource)
    const exact = hiddenResources
      .filter(resource => resource.resourceType === 'Observation')
      .filter(resource => conceptCodings(resource).some(coding => (
        coding.system === requestedConcept.system && coding.code === requestedConcept.code
      )))
      .toSorted((left, right) => (
        clinicalTimestamp(right) - clinicalTimestamp(left) || left.id.localeCompare(right.id)
      ))[0]
    const baseInput = {
      caseRevision: row.synthetic_case_revision,
      demographics: {
        birthDate: profile.patient.birthDate,
        gender: profile.patient.gender,
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
    const metadata = requestedConcept.laboratory
    if (
      metadata?.resultType !== 'quantity'
      || metadata.unit === undefined
      || this.#provider === undefined
      || this.#model === undefined
    ) {
      throw new InvestigationGenerationError(
        'INVESTIGATION_UNSUPPORTED',
        'The requested investigation cannot be generated by the structured Investigation Agent',
      )
    }
    const referenceRange = metadata.referenceRange ?? { text: '未配置参考范围' }
    const payload = {
      ...baseInput,
      privateCaseEvidence: evidence(hiddenResources),
      referenceRange,
      resultType: metadata.resultType,
      unit: metadata.unit,
      visibleHistory: this.#cases.listVisibleHistory({
        caseId: row.synthetic_case_id,
        page: 1,
        pageSize: 100,
        workspaceId,
      }).items,
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
