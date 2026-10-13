import { z } from 'zod'
import {
  doctorCaseEvidenceSchema, doctorRecommendationGenerationSchema, doctorRecommendationKindSchema,
  doctorRecommendationStateSchema, type DoctorCaseEvidence, type DoctorRecommendationKind, type DoctorRecommendationState,
  type GenerateDoctorRecommendationsRequest,
} from '@clinmesh/contracts/doctor-recommendations'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { doctorCaseDetailSchema, type ClinicalCatalog } from '@clinmesh/contracts/his'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { WorkflowService } from './workflow-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { WorkflowError } from './workflow-error.ts'
import { ChatCompletionsError, type JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import type { ReferenceDataService } from './reference-data-service.ts'
import type { ReferenceConcept } from '@clinmesh/contracts/reference-data'
import { doctorGuidelineGroups, doctorGuidelineRevision } from './doctor-guideline-evidence.ts'
import { normalizeDoctorDiagnosisRecommendation } from './doctor-diagnosis-recommendations.ts'
import { normalizeInvestigationRecommendation, type DoctorInvestigationRecommendationCatalogs } from './doctor-investigation-recommendations.ts'
import { normalizePrescriptionRecommendation } from './doctor-prescription-recommendations.ts'

const stateRowSchema = z.object({
  generation: z.number().int().positive(), input_fingerprint: z.string(),
  state_json: z.string(), status: z.string(),
})
const actorContextSchema = z.object({
  workspaceId: z.string(), epoch: z.string(), actorId: z.string(), scenarioRunId: z.string(), roleCode: z.string(),
  agentGrantId: z.string().optional(), locationId: z.string(), organizationId: z.string(),
  practitionerId: z.string(), practitionerRoleId: z.string(),
}).strict().transform(({ agentGrantId, ...context }) => ({
  ...context, ...(agentGrantId === undefined ? {} : { agentGrantId }),
}))
const verificationSchema = z.object({ items: z.array(z.object({
  id: z.string().min(1), guidelineSupported: z.boolean(), caseSupported: z.boolean(),
  applicable: z.boolean(), qualifiersPreserved: z.boolean(),
  prescriptionFields: z.object({ doseText: z.boolean(), frequencyCode: z.boolean(),
    courseDays: z.boolean(), quantity: z.boolean() }).strict().optional(),
}).strict()).max(8) }).strict()
type Catalogs = DoctorInvestigationRecommendationCatalogs & {
  diagnoses?: { local: ClinicalCatalog['diagnoses']; reference: ReferenceConcept[] }
  medications?: ReturnType<WorkflowService['doctorRecommendationMedications']>
}

const generationPrompt = `你是医生的诊疗建议助手。仅依据给出的指南条款、当前医生可见病例和本院目录生成当前kind的候选，最多8条。
每条必须引用实际guidelines与caseEvidence的id，说明支持、不符合和待核实信息，保留来源中的否定、条件、时间与不确定性。
目录仅定义可选项目与允许值，default和allowed字段不是临床依据。不能用模型记忆补齐指南、事实或处方字段；无依据的处方字段必须为null。
处方需要核对具体药品规格、单位和包装，疗程与数量分别需要依据，不得根据默认值或剂量自行猜测换算。
只给建议，不确诊、不正式开立；没有适用依据时返回空items并明确missingInformation。`
const verificationPrompt = `独立核对每条候选与实际提供的指南和病例。逐项判断指南支持、病例支持、适用性、否定和限定语是否保留。
引用存在不等于临床语义成立，未证实、条件缺失或冲突时返回false。必须恰好覆盖全部候选id。
处方还必须分别核对doseText、frequencyCode、courseDays、quantity：仅使用指南、病例及medicationPresentations的真实品名、规格、剂型和包装；目录允许值与默认值不能证明临床依据，无法证实时返回false。`

export class DoctorRecommendationsService {
  constructor(private readonly options: {
    database: ClinMeshDatabase; workflow: WorkflowService; commands: CommandExecutor; referenceData: ReferenceDataService
    models: GenerationModelBinding; model?: string; provider?: JsonChatCompletionsProvider
    contextStatus: (context: ActorContext) => 'active' | 'inactive' | 'superseded'
    investigationCatalogs: (context: ActorContext, caseId: string, kind: DoctorRecommendationKind) => Promise<DoctorInvestigationRecommendationCatalogs>
  }) {}

  #authorize(context: ActorContext, caseId: string) {
    if (this.options.contextStatus(context) !== 'active') {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The original doctor authorization is no longer active')
    }
    return this.options.workflow.doctorRecommendationCase(context, caseId)
  }

  async #input(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    const detail = doctorCaseDetailSchema.parse(this.#authorize(context, caseId))
    const caseEvidence: DoctorCaseEvidence[] = []
    const add = (id: string, sourceKind: DoctorCaseEvidence['kind'], label: string, content: unknown, reference?: string) => {
      if (content === undefined || content === null) return
      caseEvidence.push(doctorCaseEvidenceSchema.parse({ id, kind: sourceKind, label,
        text: typeof content === 'string' ? content : JSON.stringify(content), ...(reference === undefined ? {} : { reference }) }))
    }
    add('demographics', 'demographics', '患者基本资料', detail.patient, `Patient/${detail.patient.id}`)
    add('presentation', 'presentation', '当前主诉与体征', { presentation: detail.presentation, triage: detail.triage })
    add('allergies', 'history', '已记录过敏信息', detail.allergies)
    for (const turn of detail.consultation?.turns ?? []) {
      add(`turn:${turn.id}`, 'consultation', `${turn.speaker === 'patient' ? '患者' : '医生'}问诊记录`,
        { speaker: turn.speaker, text: turn.messageText, kind: turn.kind, recordedAt: turn.recordedAt, reportReference: turn.reportReference })
    }
    add('clinical-document', 'draft', '当前病历草稿与已签病历', detail.clinicalDocument)
    add('legacy-drafts', 'draft', '当前诊疗草稿', detail.drafts)
    add('diagnoses', 'diagnosis', '当前诊断草稿与已确认诊断', detail.diagnosis)
    add('medication-conclusion', 'draft', '当前处方草稿与用药结论', detail.medicationConclusion)
    add('prior-facts', 'history', '已发布既往诊断', detail.priorFacts)
    add('report', 'report', '当前检验报告', detail.report)
    for (const request of [...detail.laboratoryRequests?.requests ?? [], ...detail.imagingRequests?.requests ?? [], ...detail.pathologyRequests?.requests ?? []]) {
      add(`report:${request.id}`, 'report', '已发布检查检验报告', request.report)
    }
    for (const source of ['visible-source', 'local-completed'] as const) {
      const history = this.options.workflow.doctorCaseHistory(context, caseId, { source, page: 1, pageSize: 20 })
      for (const item of history.items) add(`history:${source}:${item.entryId}`, 'history', item.title,
        this.options.workflow.doctorCaseHistoryDetail(context, caseId, { source, entryId: item.entryId }))
    }
    const text = JSON.stringify(caseEvidence).toLowerCase()
    const groups = doctorGuidelineGroups.filter(group => group.terms.some(term => text.includes(term.toLowerCase())))
    const guidelines = groups.flatMap(group => group.evidence)
    let catalogs: Catalogs
    if (kind === 'diagnosis') {
      const reference = groups.flatMap(group => this.options.referenceData.searchDiagnoses(context, { page: 1, pageSize: 50, query: group.terms[0]! }).items)
      catalogs = { diagnoses: { local: this.options.workflow.clinicalCatalog(context).diagnoses,
        reference: [...new Map(reference.map(item => [item.id, item])).values()] } }
    } else if (kind === 'prescription') catalogs = { medications: this.options.workflow.doctorRecommendationMedications(context) }
    else catalogs = await this.options.investigationCatalogs(context, caseId, kind)
    this.#authorize(context, caseId)
    const snapshot = { context, encounter: detail.encounter, kind, caseEvidence, catalogs, guidelines,
      guidelineRevision: doctorGuidelineRevision,
      ...(kind === 'diagnosis' ? { referenceRevision: this.options.referenceData.provenance() } : {}),
      prescriptionConcluded: detail.medicationConclusion?.prescription !== undefined || detail.medicationConclusion?.noMedication !== undefined }
    return { snapshot, inputFingerprint: canonicalJsonHash(snapshot) }
  }

  #key(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    return [context.workspaceId, context.epoch, context.actorId, canonicalJsonHash(context), caseId, kind] as const
  }

  #row(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    return stateRowSchema.optional().parse(this.options.database.driver.prepare(`
      SELECT generation, input_fingerprint, state_json, status FROM doctor_recommendation_state
      WHERE workspace_id = ? AND epoch = ? AND actor_id = ? AND context_key = ? AND case_id = ? AND kind = ?
    `).get(...this.#key(context, caseId, kind)))
  }

  async read(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    const { snapshot, inputFingerprint } = await this.#input(context, caseId, kind)
    const row = this.#row(context, caseId, kind)
    if (row !== undefined) {
      const state = doctorRecommendationStateSchema.parse(JSON.parse(row.state_json))
      return { ...state, inputFingerprint, encounterVersion: snapshot.encounter.versionId,
        stale: row.input_fingerprint !== inputFingerprint }
    }
    return doctorRecommendationStateSchema.parse({
      caseId, kind, encounterId: snapshot.encounter.id, encounterVersion: snapshot.encounter.versionId,
      inputFingerprint, status: 'idle', generation: 0, stale: false, items: [],
      guidelines: [], caseEvidence: [], missingInformation: [],
    })
  }

  async generate(context: ActorContext, caseId: string, kind: DoctorRecommendationKind,
    request: GenerateDoctorRecommendationsRequest, idempotencyKey: string) {
    const { snapshot, inputFingerprint } = await this.#input(context, caseId, kind)
    const encounterReference = `Encounter/${snapshot.encounter.id}`
    if (Object.keys(request.expectedVersions).length !== 1 || request.expectedVersions[encounterReference] === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The current Encounter expected version is required')
    }
    return this.options.commands.execute({ context, operation: 'doctor.recommendations.generate',
      contextRequirement: 'current', expectedVersions: request.expectedVersions, idempotencyKey,
      input: { caseId, kind, ...request.input }, dataSchema: doctorRecommendationStateSchema,
      authorize: () => { this.#authorize(context, caseId) },
    }, transaction => {
      if (request.input.expectedInputFingerprint !== inputFingerprint) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The recommendation input changed; read the current state')
      }
      const previous = this.#row(context, caseId, kind)
      if (!request.input.refresh && previous?.input_fingerprint === inputFingerprint && previous.status !== 'failed') {
        return { data: doctorRecommendationStateSchema.parse(JSON.parse(previous.state_json)), effects: [] }
      }
      const generation = (previous?.generation ?? 0) + 1
      const state: DoctorRecommendationState = {
        caseId, kind, encounterId: snapshot.encounter.id, encounterVersion: snapshot.encounter.versionId,
        inputFingerprint, generation, status: 'pending', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [],
      }
      const key = this.#key(context, caseId, kind)
      this.options.database.driver.prepare(`INSERT INTO doctor_recommendation_state
        (workspace_id, epoch, actor_id, context_key, case_id, kind, generation, input_fingerprint,
          actor_context_json, input_json, state_json, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT (workspace_id, epoch, actor_id, context_key, case_id, kind) DO UPDATE SET
          generation = excluded.generation, input_fingerprint = excluded.input_fingerprint,
          actor_context_json = excluded.actor_context_json, input_json = excluded.input_json,
          state_json = excluded.state_json, status = excluded.status, updated_at = excluded.updated_at
      `).run(...key, generation, inputFingerprint, JSON.stringify(context), JSON.stringify(snapshot), JSON.stringify(state), new Date().toISOString())
      transaction.enqueue({ kind: 'doctor.generate-recommendations',
        dedupKey: `doctor-recommendations:${key[3]}:${caseId}:${kind}:${generation}`,
        payload: { actorId: context.actorId, contextKey: key[3], caseId, kind, generation },
      })
      return { data: state, effects: [{ kind: 'updated', reference: `DoctorRecommendations/${caseId}:${kind}`, versionId: String(generation) }] }
    })
  }

  async process(event: OutboxHandlerInput, signal: AbortSignal, shutdownSignal: AbortSignal): Promise<OutboxHandlerResult> {
    const payload = z.object({ actorId: z.string(), contextKey: z.string(), caseId: z.string(),
      kind: doctorRecommendationKindSchema, generation: z.number().int().positive() }).strict().parse(event.payload)
    const row = stateRowSchema.extend({ actor_context_json: z.string() }).optional().parse(
      this.options.database.driver.prepare(`SELECT generation, input_fingerprint, state_json, status, actor_context_json
        FROM doctor_recommendation_state WHERE workspace_id = ? AND epoch = ? AND actor_id = ?
        AND context_key = ? AND case_id = ? AND kind = ?
      `).get(event.workspaceId, event.epoch, payload.actorId, payload.contextKey, payload.caseId, payload.kind),
    )
    if (row === undefined || row.generation !== payload.generation || row.status !== 'pending') return { status: 'completed' }
    const context = actorContextSchema.parse(JSON.parse(row.actor_context_json))
    if (context.workspaceId !== event.workspaceId || context.epoch !== event.epoch || context.actorId !== payload.actorId
      || context.scenarioRunId !== event.scenarioRunId || canonicalJsonHash(context) !== payload.contextKey) {
      throw new Error('Recommendation context does not match the durable event')
    }
    const pending = doctorRecommendationStateSchema.parse(JSON.parse(row.state_json))
    const current = () => this.#row(context, payload.caseId, payload.kind)?.generation === payload.generation
    const finish = (state: DoctorRecommendationState) => {
      if (!current() || this.options.contextStatus(context) === 'superseded') return
      this.options.commands.execute({ context, operation: 'doctor.recommendations.complete', contextRequirement: 'known',
        expectedVersions: {}, idempotencyKey: `recommendations:${event.eventId}:${event.attempt}`, input: state,
        dataSchema: doctorRecommendationStateSchema,
      }, () => {
        if (!current()) return { data: state, effects: [] }
        this.options.database.driver.prepare(`UPDATE doctor_recommendation_state SET state_json = ?, status = ?, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND actor_id = ? AND context_key = ? AND case_id = ? AND kind = ? AND generation = ?
        `).run(JSON.stringify(state), state.status, new Date().toISOString(), ...this.#key(context, payload.caseId, payload.kind), payload.generation)
        return { data: state, effects: [{ kind: 'updated', reference: `DoctorRecommendations/${payload.caseId}:${payload.kind}`, versionId: String(payload.generation) }] }
      })
    }
    try {
      const { snapshot, inputFingerprint } = await this.#input(context, payload.caseId, payload.kind)
      if (row.input_fingerprint !== inputFingerprint) throw new WorkflowError('WORKFLOW_CONFLICT', 'The recommendation input changed')
      const base = { ...pending, guidelines: snapshot.guidelines, caseEvidence: snapshot.caseEvidence }
      if (snapshot.guidelines.length === 0 || (payload.kind === 'prescription' && snapshot.prescriptionConcluded)) {
        finish({ ...base, status: 'missing-evidence', missingInformation: [snapshot.prescriptionConcluded
          ? '本次就诊已有正式用药结论。' : '当前病例没有已取得的适用指南条款。'] })
        return { status: 'completed' }
      }
      if (this.options.provider === undefined || this.options.model === undefined) {
        finish({ ...base, status: 'failed', errorCode: 'MODEL_UNAVAILABLE' })
        return { status: 'completed' }
      }
      const model = await this.options.models.bind(context.workspaceId,
        `recommendations:${context.epoch}:${payload.contextKey}:${payload.caseId}:${payload.kind}:${payload.generation}`, this.options.model, signal)
      const parseGeneration = (value: unknown) => {
        const output = doctorRecommendationGenerationSchema.parse(value)
        doctorRecommendationStateSchema.parse({ ...base, ...output, status: 'ready' })
        return output
      }
      const result = await this.options.provider.completeJson({ model, signal, schemaName: 'doctor_recommendations',
        systemPrompt: generationPrompt, jsonSchema: z.toJSONSchema(doctorRecommendationGenerationSchema) as Record<string, unknown>,
        userPayload: { kind: payload.kind, guidelines: snapshot.guidelines, caseEvidence: snapshot.caseEvidence, catalogs: snapshot.catalogs },
        validate: value => { parseGeneration(value); return true },
      })
      signal.throwIfAborted()
      const output = parseGeneration(JSON.parse(result.content))
      const parseVerification = (value: unknown) => {
        const verification = verificationSchema.parse(value)
        const ids = new Set(verification.items.map(item => item.id))
        if (ids.size !== output.items.length || verification.items.length !== output.items.length
          || output.items.some(item => !ids.has(item.id))
          || (payload.kind === 'prescription' && verification.items.some(item => item.prescriptionFields === undefined))) {
          throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'Independent verification must cover every candidate and prescription field')
        }
        return verification
      }
      const verified = output.items.length === 0 ? { items: [] } : parseVerification(JSON.parse((await this.options.provider.completeJson({
        model, signal, schemaName: 'doctor_recommendation_verification', systemPrompt: verificationPrompt,
        jsonSchema: z.toJSONSchema(verificationSchema) as Record<string, unknown>,
        userPayload: { kind: payload.kind, items: output.items, guidelines: snapshot.guidelines, caseEvidence: snapshot.caseEvidence,
          ...(payload.kind === 'prescription' ? { medicationPresentations: snapshot.catalogs.medications?.map(({ id, nameZh, version, product, drugConcept, availableScopes, regulatoryVerification }) =>
            ({ id, nameZh, version, product, drugConcept, availableScopes, regulatoryVerification })) } : {}) },
        validate: value => { parseVerification(value); return true },
      })).content))
      signal.throwIfAborted()
      const items = output.items.flatMap(item => {
        const check = verified.items.find(candidate => candidate.id === item.id)!
        if (!check.guidelineSupported || !check.caseSupported || !check.applicable || !check.qualifiersPreserved) return []
        if (item.kind === 'diagnosis') {
          const normalized = normalizeDoctorDiagnosisRecommendation(item, snapshot.catalogs.diagnoses!)
          return normalized === undefined ? [] : [normalized]
        }
        if (item.kind === 'prescription') {
          const missingInformation = [...item.missingInformation]
          const fields = { doseText: item.doseText, frequencyCode: item.frequencyCode, courseDays: item.courseDays, quantity: item.quantity }
          for (const field of ['doseText', 'frequencyCode', 'courseDays', 'quantity'] as const) {
            if (!check.prescriptionFields![field]) {
              fields[field] = null
              missingInformation.push(`处方${{ doseText: '剂量', frequencyCode: '频次', courseDays: '疗程', quantity: '数量' }[field]}缺少指南、病例或药品规格依据。`)
            }
          }
          const normalized = normalizePrescriptionRecommendation({ ...item, ...fields, missingInformation: [...new Set(missingInformation)].slice(0, 12) }, snapshot.catalogs.medications!)
          return normalized === undefined ? [] : [normalized]
        }
        const normalized = normalizeInvestigationRecommendation(item, snapshot.catalogs)
        return normalized === undefined ? [] : [normalized]
      })
      const latest = await this.#input(context, payload.caseId, payload.kind)
      if (row.input_fingerprint !== latest.inputFingerprint) throw new WorkflowError('WORKFLOW_CONFLICT', 'The recommendation input changed during generation')
      finish({ ...base, items, status: items.length === 0 ? 'missing-evidence' : 'ready',
        missingInformation: [...output.missingInformation, ...(items.length < output.items.length ? ['部分候选未通过当前目录、指南与病例的独立核验。'] : [])].slice(0, 12) })
      return { status: 'completed' }
    } catch (error) {
      if (!current() || this.options.contextStatus(context) === 'superseded') return { status: 'completed' }
      if (shutdownSignal.aborted && event.attempt < 3) return { status: 'retryable-failed' }
      const retrying = error instanceof ChatCompletionsError && error.code === 'AI_REQUEST_FAILED'
        && event.attempt < 3 && this.options.contextStatus(context) === 'active'
      if (!retrying) finish({ ...pending, status: 'failed', errorCode:
        error instanceof WorkflowError ? 'WORKFLOW_CONFLICT' : signal.aborted || (error instanceof ChatCompletionsError && error.code === 'AI_TIMEOUT') ? 'MODEL_TIMEOUT'
        : error instanceof ChatCompletionsError && error.code === 'AI_AUTH_FAILED' ? 'MODEL_AUTH_FAILED'
        : error instanceof z.ZodError || error instanceof SyntaxError || (error instanceof ChatCompletionsError && error.code === 'AI_RESPONSE_INVALID') ? 'AI_RESPONSE_INVALID' : 'MODEL_UNAVAILABLE' })
      return { status: retrying ? 'retryable-failed' : 'completed' }
    }
  }
}
