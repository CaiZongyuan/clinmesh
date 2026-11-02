import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientDiagnosisSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { pciMeasurementSchema, pciSelectionProcedureCodes, type InpatientPciSelectionParameters } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientGuidelineAdviceSchema, inpatientGuidelineAdviceListSchema, inpatientGuidelineAdviceRequestInputSchema,
  inpatientGuidelineAdviceGenerationSchema, inpatientGuidelineAdviceVerificationSchema, inpatientGuidelineAdviceResultSchema,
  inpatientGuidelineAdviceEvidenceSchema, type InpatientGuidelineAdvice as Advice } from '@clinmesh/contracts/inpatient-guideline-advice'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import { WorkspaceContextError } from '../infrastructure/sqlite/workspace-repository.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import { modelTaskOutcomeUnknown, type ModelTaskRecovery } from './model-task-recovery.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import { readPciStentGuidelineTopic, pciStentGuidelineTopicFingerprint } from './pci-stent-guideline-topic.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const contextSchema = z.object({ workspaceId: z.string(), epoch: z.string(), scenarioRunId: z.string(), actorId: z.string(),
  practitionerId: z.string(), practitionerRoleId: z.string(), roleCode: z.literal('inpatient-doctor'), organizationId: z.string(), locationId: z.string(),
  agentGrantId: z.string().optional() }).strict()
  .transform(({ agentGrantId, ...context }) => ({ ...context, ...(agentGrantId === undefined ? {} : { agentGrantId }) }))
const rowSchema = z.object({ workspace_id: z.string(), epoch: z.string(), task_id: z.string(), admission_id: z.string(), request_id: z.string(),
  version: z.number().int().positive(), context_json: z.string(), basis_json: z.string(), basis_fingerprint: z.string(),
  trigger: z.enum(['automatic', 'manual']),
  cancelled: z.union([z.literal(0), z.literal(1)]),
  status: z.enum(['queued', 'running', 'succeeded', 'no-evidence', 'blocked', 'unknown', 'rejected', 'failed', 'stale']),
  error_code: z.string().nullable(), result_json: z.string().nullable(), created_at: z.string() })
type Row = z.infer<typeof rowSchema>
const authorizationOperations = { automatic: 'inpatient.surgery.request', manual: 'inpatient.guideline-advice.request' } as const
const basisSchema = z.object({ topic: z.object({ id: z.literal('pci-stent'), version: z.string(), navigation: z.string(), limitations: z.array(z.string()) }).strict(),
  guidelines: z.array(inpatientGuidelineAdviceEvidenceSchema).max(7), missing: z.array(z.string()),
  sourceStatus: z.enum(['available', 'unavailable', 'read-failed']), dependencyFingerprint: z.string(),
  clinicalFacts: z.object({ request: inpatientSurgeryRequestSchema.pick({ id: true, plannedProcedure: true, plannedFor: true }),
    diagnosis: inpatientDiagnosisSchema, investigations: inpatientInvestigationsSchema,
    measurements: z.array(pciMeasurementSchema).max(3), targetSite: z.string().nullable() }).strict() }).strict()
const messages: Record<Advice['status'], string> = {
  idle: '尚未准备本计划的指南参考意见。', queued: '正在准备指南参考意见。', running: '正在根据原文起草并独立核验指南参考意见。',
  succeeded: '指南参考意见已准备，请结合原文和本次患者资料审阅。', incomplete: '指南参考意见已准备；患者资料仍有缺项，仅供有条件核对。',
  'no-evidence': '本专题暂无可用指南原文，不能提供指南参考意见。', blocked: '模型暂不可用或用量控制未就绪，指南参考意见尚未生成。',
  unknown: '原模型请求结果未知，请先核查原尝试；不会自动重新发送。', rejected: '指南参考意见未通过独立核验，内容不予展示。',
  failed: '指南参考意见准备失败，可核查后显式重新评估。', cancelled: '手术计划已取消，指南参考意见停止准备。',
  stale: '患者资料、计划、目录或指南依据已变化，请显式重新评估。', frozen: '手术已开始、完成或病案已归档，指南参考意见保留历史只读。',
}

/** Read-only clinical advice shares the model execution and accounting boundary, never the material confirmation. */
export class InpatientGuidelineAdvice {
  constructor(readonly owner: InpatientService, readonly options: { guidelines?: GuidelineCorpus;
    contextStatus: (context: ActorContext, operations: readonly string[]) => 'active' | 'inactive' | 'superseded' }) {}
  #row(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string, requestId: string) {
    return rowSchema.optional().parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_guideline_advice
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? ORDER BY version DESC LIMIT 1`)
      .get(context.workspaceId, context.epoch, admissionId, requestId))
  }
  #authorize(context: ActorContext, admissionId: string, trigger: Row['trigger']) {
    this.owner.assertRole(context, ['inpatient-doctor'])
    this.owner.assertNotArchived(context, admissionId)
    this.owner.orders.assertAdmitted(context, admissionId)
    if (this.options.contextStatus(context, [authorizationOperations[trigger]]) !== 'active')
      throw new InpatientError('INPATIENT_GUIDELINE_FORBIDDEN', '原准备岗位授权已失效，请由当前主管医生重新评估', 403)
  }
  #basis(context: ActorContext, admissionId: string, requestId: string) {
    const surgery = this.owner.surgery.read(context, admissionId), request = surgery.requests.find(item => item.id === requestId)
    if (!request || !pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code))
      throw new InpatientError('INPATIENT_GUIDELINE_PLAN_REQUIRED', '未找到本次住院有效的PCI计划', 404)
    const selection: ReturnType<InpatientService['pciSelection']['read']> & { drafts?: Array<{ requestId: string;
      parameters: Omit<InpatientPciSelectionParameters, 'targetSite'> & { targetSite: string | null } }> } = this.owner.pciSelection.read(context, admissionId)
    const parameters = selection.drafts?.find(item => item.requestId === requestId)?.parameters
      ?? (selection.confirmation?.parameters.requestId === requestId ? selection.confirmation.parameters : undefined)
    const measurements = parameters?.measurements ?? [], missing: string[] = []
    if (!measurements.some(item => item.source.reference.startsWith('DiagnosticReport/'))) missing.push('尚无本次正式造影报告；仅给出一般类别、测量要求与具体缺项。')
    for (const [kind, label] of [['lesion-length', '病变长度'], ['proximal-reference-diameter', '近端参考管径'],
      ['distal-reference-diameter', '远端参考管径']] as const) {
      const measurement = measurements.find(item => item.kind === kind)
      if (measurement?.value === null || measurement === undefined) missing.push(`缺少${label}。`)
      if (measurement && measurement.unit === null) missing.push(`${label}缺少单位。`)
      if (measurement?.object === 'unknown') missing.push(`${label}的测量对象尚未核实。`)
    }
    if (!parameters?.targetSite) missing.push('缺少靶血管具体部位。')
    if (!selection.candidates.some(item => item.eligibility === 'valid')) missing.push('缺少本计划适用的具体耗材候选，类别意见不能代替具体产品。')
    if (!parameters?.plannedQuantities.length || parameters.plannedQuantities.some(item => item.quantity === null)) missing.push('缺少完整的预计数量依据，指南类别意见不提供默认件数。')
    const topic = readPciStentGuidelineTopic(this.options.guidelines)
    const input = basisSchema.parse({ ...topic, missing: [...new Set([...missing, ...topic.missing])],
      dependencyFingerprint: canonicalJsonHash({ candidates: selection.candidates, parameters, topic: pciStentGuidelineTopicFingerprint }),
      clinicalFacts: { request: { id: request.id, plannedProcedure: request.plannedProcedure, plannedFor: request.plannedFor },
        diagnosis: this.owner.orders.diagnosis(context, admissionId), investigations: this.owner.investigations.read(context, admissionId),
        measurements, targetSite: parameters?.targetSite ?? null } })
    return { input, fingerprint: canonicalJsonHash(input), request,
      frozen: surgery.inProgress.some(item => item.requestId === requestId) || surgery.executions.some(item => item.requestId === requestId) }
  }
  #state(context: ActorContext, admissionId: string, requestId: string): Advice {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    const binding = this.owner.readAdmissionBinding(context, admissionId), basis = this.#basis(context, admissionId, requestId)
    const row = this.#row(context, admissionId, requestId)
    let authorized = true
    if (row) try {
      const original = contextSchema.parse(JSON.parse(row.context_json))
      this.owner.assertReadRole(original, ['inpatient-doctor'])
      this.owner.readAdmissionBinding(original, admissionId)
      authorized = this.options.contextStatus(original, [authorizationOperations[row.trigger]]) === 'active'
    }
    catch (error) { if (error instanceof InpatientError || error instanceof WorkspaceContextError) authorized = false; else throw error }
    const unchanged = row?.basis_fingerprint === basis.fingerprint
    let status: Advice['status'] = row?.status ?? 'idle'
    if (row && (!unchanged || !authorized)) status = 'stale'
    if (basis.input.sourceStatus !== 'available') status = 'no-evidence'
    if (basis.frozen || binding.row.record_status === 'archived') status = 'frozen'
    if (row?.cancelled === 1) status = row.status === 'succeeded' ? 'frozen' : 'cancelled'
    if (basis.request.status === 'cancelled') status = 'cancelled'
    if (row?.status === 'unknown') status = 'unknown'
    const result = authorized && unchanged && basis.input.sourceStatus === 'available' && row?.status === 'succeeded' && row.result_json
      && status !== 'cancelled' ? inpatientGuidelineAdviceResultSchema.parse(JSON.parse(row.result_json)) : null
    if (status === 'succeeded' && basis.input.missing.length > 0) status = 'incomplete'
    return inpatientGuidelineAdviceSchema.parse({ admissionId, requestId, taskId: row?.task_id ?? null, version: row?.version ?? 0,
      fingerprint: basis.fingerprint, status, message: row?.cancelled === 1 && status !== 'unknown'
        ? row.status === 'succeeded' ? '本次单次准备已取消，已发布的指南意见保留历史只读；可显式重新评估。' : '本次单次准备已取消，指南意见停止准备；可显式重新评估。'
        : basis.input.sourceStatus === 'read-failed' ? '指南原文读取失败，请核查指南库后显式重新评估。' : messages[status],
      missing: basis.input.missing, failureCode: row?.error_code ?? null, result })
  }
  read(context: ActorContext, admissionId: string, requestId: string) {
    try {
      const state = this.#state(context, admissionId, requestId)
      this.owner.commands.auditRead(context, 'inpatient.guideline-advice.read', { admissionId, requestId }, 'success')
      return state
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.guideline-advice.read', { admissionId, requestId }, 'failed') } catch { /* Preserve the original error. */ }
      throw error
    }
  }
  list(context: ActorContext, admissionId: string) {
    try {
      this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const requests = this.owner.surgery.read(context, admissionId).requests.filter(item => pciSelectionProcedureCodes.includes(item.plannedProcedure.coding.code))
      const result = inpatientGuidelineAdviceListSchema.parse({ admissionId, advice: requests.map(item => this.#state(context, admissionId, item.id)) })
      this.owner.commands.auditRead(context, 'inpatient.guideline-advice.list', { admissionId }, 'success')
      return result
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.guideline-advice.list', { admissionId }, 'failed') } catch { /* Preserve the original error. */ }
      throw error
    }
  }
  #create(context: ActorContext, admissionId: string, requestId: string, version: number, trigger: Row['trigger'], transaction: CommandTransaction) {
    const basis = this.#basis(context, admissionId, requestId), previous = this.#row(context, admissionId, requestId)
    const taskId = previous?.task_id ?? uuidv7(), available = basis.input.sourceStatus === 'available'
    this.owner.database.driver.prepare(`INSERT INTO inpatient_guideline_advice
      (workspace_id,epoch,task_id,admission_id,request_id,version,context_json,basis_json,basis_fingerprint,trigger,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, taskId, admissionId, requestId, version,
        JSON.stringify(contextSchema.parse(context)), JSON.stringify(basis.input), basis.fingerprint, trigger, available ? 'queued' : 'no-evidence', this.owner.virtualTime(context))
    if (available) transaction.enqueue({ kind: 'inpatient.guideline-advice.prepare', dedupKey: `${taskId}:${version}:${basis.fingerprint}`,
      payload: { taskId, version } })
    return this.#state(context, admissionId, requestId)
  }
  automatic(context: ActorContext, admissionId: string, requestId: string, transaction: CommandTransaction) {
    const request = this.owner.surgery.read(context, admissionId).requests.find(item => item.id === requestId)
    if (!request || !pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code) || this.#row(context, admissionId, requestId)) return
    this.#create(context, admissionId, requestId, 1, 'automatic', transaction)
  }
  /** The caller owns the already-authorized material-estimate cancellation transaction. */
  cancel(context: ActorContext, admissionId: string, requestId: string) {
    this.owner.database.driver.prepare(`UPDATE inpatient_guideline_advice SET cancelled=1
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?`).run(context.workspaceId, context.epoch, admissionId, requestId)
  }
  request(context: ActorContext, raw: unknown, key: string) {
    const input = inpatientGuidelineAdviceRequestInputSchema.parse(raw)
    const receipt = this.owner.commands.execute({ context, input, idempotencyKey: key, operation: 'inpatient.guideline-advice.request',
      expectedVersions: {}, dataSchema: inpatientGuidelineAdviceSchema, authorize: () => this.#authorize(context, input.admissionId, 'manual'),
      storedResponse: response => ({ ...response, data: { ...response.data, result: null } }) }, transaction => {
      const state = this.#state(context, input.admissionId, input.requestId)
      if (state.version !== input.expectedVersion || state.fingerprint !== input.expectedFingerprint)
        throw new InpatientError('INPATIENT_GUIDELINE_CONFLICT', '计划、正式资料或指南依据已变化，请刷新后核实')
      if (state.status === 'unknown' || state.taskId && this.owner.database.driver.prepare(`SELECT 1 FROM model_task_step
        WHERE workspace_id=? AND epoch=? AND task_id=? AND status IN ('unknown','dispatching') LIMIT 1`).get(context.workspaceId, context.epoch, state.taskId))
        throw new InpatientError('MODEL_OUTCOME_UNKNOWN', '原模型请求结果未知，请先核查原尝试；不会重新派发')
      const basis = this.#basis(context, input.admissionId, input.requestId)
      if (basis.request.status === 'cancelled' || basis.frozen) throw new InpatientError('INPATIENT_GUIDELINE_STALE', messages[state.status])
      if (['queued', 'running', 'succeeded', 'incomplete', 'blocked'].includes(state.status)) return { data: state, effects: [] }
      const data = this.#create(context, input.admissionId, input.requestId, state.version + 1, 'manual', transaction)
      return { data, effects: [{ kind: 'updated' as const, reference: `InpatientGuidelineAdvice/${data.taskId}`, versionId: String(data.version) }] }
    })
    // Replayed receipts must not return original text after a source restriction or withdrawal.
    return { ...receipt, data: this.#state(context, input.admissionId, input.requestId) }
  }
  async process(event: OutboxHandlerInput, options: { models: GenerationModelBinding; recovery: ModelTaskRecovery;
    provider?: JsonChatCompletionsProvider; model?: string; signal: AbortSignal }): Promise<OutboxHandlerResult> {
    const payload = z.object({ taskId: z.string(), version: z.number().int().positive() }).strict().parse(event.payload)
    const row = rowSchema.optional().parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_guideline_advice
      WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?`).get(event.workspaceId, event.epoch, payload.taskId, payload.version))
    if (!row || ['succeeded', 'unknown', 'stale', 'no-evidence', 'rejected', 'failed'].includes(row.status)) return { status: 'completed' }
    const update = (status: Row['status'], code: string | null, result: string | null = null) => this.owner.database.driver.prepare(`UPDATE inpatient_guideline_advice
      SET status=?,error_code=?,result_json=? WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?`)
      .run(status, code, result, row.workspace_id, row.epoch, row.task_id, row.version)
    const assertCurrent = () => {
      if (options.signal.aborted) throw options.signal.reason
      const context = contextSchema.parse(JSON.parse(row.context_json))
      this.#authorize(context, row.admission_id, row.trigger)
      const latest = this.#row(context, row.admission_id, row.request_id), basis = this.#basis(context, row.admission_id, row.request_id)
      if (latest?.version !== row.version || latest.cancelled === 1 || basis.fingerprint !== row.basis_fingerprint || basis.input.sourceStatus !== 'available'
        || basis.request.status === 'cancelled' || basis.frozen) throw new InpatientError('INPATIENT_GUIDELINE_STALE', '计划、正式资料或指南依据已变化')
      return context
    }
    let waitUntil: 'runtime-restart' | undefined
    try {
      const context = assertCurrent()
      if (!options.provider || !options.model || options.provider.supportsUsageAccounting !== true) {
        waitUntil = 'runtime-restart'
        throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
      }
      update('running', null)
      const input = basisSchema.parse(JSON.parse(row.basis_json)), model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const usageContext = { workspaceId: event.workspaceId, epoch: event.epoch, taskId: row.task_id, actorId: context.actorId,
        practitionerRoleId: context.practitionerRoleId!, caseId: row.admission_id, encounterId: row.admission_id, trigger: row.trigger,
        sources: [{ kind: 'job' as const, id: event.eventId, relationship: 'trigger' as const },
          ...input.guidelines.map(item => ({ kind: 'document' as const, id: item.id, relationship: 'evidence' as const }))] }
      const normalize = (raw: unknown) => {
        const generated = inpatientGuidelineAdviceGenerationSchema.parse(raw)
        if (generated.conclusions.some(item => input.missing.length > 0 && item.applicability !== 'conditional'
          || item.citations.some(citation => !input.guidelines.some(evidence => evidence.id === citation.evidenceId && evidence.text.includes(citation.quote)))))
          throw new InpatientError('INPATIENT_GUIDELINE_INVALID', '结论没有引用实际读取的原句，或把资料缺项当作已确认适用')
        return generated
      }
      const generated = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_recommendation',
        jsonSchema: z.toJSONSchema(inpatientGuidelineAdviceGenerationSchema),
        systemPrompt: '仅依据guidelines完整原文与clinicalFacts起草三类只读指南参考意见：支架类别、IVUS/OCT指导条件、测量要求。topic仅是操作性导航不是证据。逐条给实际evidenceId和未经改写的原句。保留人群、条件、例外与推荐强度，不把可考虑写成必须；不能把所有PCI写为必须IVUS，OCT需保留左主干开口限制。缺测量或单位仍给conditional类别意见和缺项，不补造患者事实，不从目录倒推测量，不推荐固定产品、规格或数量；3.0mm、5–16mm及每类一件只是合成方案，不是指南要求。不产生清单、诊断、手术、预留或收费。',
        userPayload: input, usageContext: { ...usageContext, stage: `guideline-${row.version}-generation` }, signal: options.signal,
        maxAttempts: 2, onBeforeRequest: assertCurrent, validate: raw => { normalize(raw); return true } })
      const proposed = normalize(JSON.parse(generated.content))
      assertCurrent()
      const verified = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_verification',
        jsonSchema: z.toJSONSchema(inpatientGuidelineAdviceVerificationSchema),
        systemPrompt: '独立核验proposed三类结论是否由同组guidelines实际原文与clinicalFacts支持。topic是导航不能作证据。分别核验人群、条件、例外、推荐强度、未知测量及无固定产品和数量；把选择性IVUS写成所有PCI必须检查、漏掉OCT左主干开口例外、从目录推管径、从类别推固定产品或数量均拒绝。资料不足只能发布conditional意见，原句必须实际存在。逐项返回原kind及所有核验标志与理由，未知不得判支持。',
        userPayload: { ...input, proposed }, usageContext: { ...usageContext, stage: `guideline-${row.version}-verification` }, signal: options.signal,
        maxAttempts: 2, onBeforeRequest: assertCurrent, validate: raw => inpatientGuidelineAdviceVerificationSchema.safeParse(raw).success })
      const verification = inpatientGuidelineAdviceVerificationSchema.parse(JSON.parse(verified.content))
      if (verification.conclusions.some(item => !item.supported || !item.populationPreserved || !item.conditionsPreserved || !item.strengthPreserved
        || !item.noInventedMeasurements || !item.noProductOrQuantity)) throw new InpatientError('INPATIENT_GUIDELINE_REJECTED', '指南意见未通过独立核验')
      this.owner.database.driver.transaction(() => {
        assertCurrent()
        update('succeeded', null, JSON.stringify(inpatientGuidelineAdviceResultSchema.parse({ id: uuidv7(), fingerprint: row.basis_fingerprint,
          model, createdAt: this.owner.virtualTime(context), topic: { id: input.topic.id, version: input.topic.version, fingerprint: pciStentGuidelineTopicFingerprint },
          guidelines: input.guidelines, conclusions: proposed.conclusions, limitations: input.topic.limitations })))
      })()
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof InpatientError || error instanceof WorkspaceContextError) {
        if (error instanceof InpatientError && error.code === 'INPATIENT_GUIDELINE_REJECTED') { update('rejected', error.code); return { status: 'completed' } }
        if (!(error instanceof InpatientError) || error.code !== 'INPATIENT_GUIDELINE_INVALID') { update('stale', 'INPATIENT_GUIDELINE_STALE'); return { status: 'completed' } }
      }
      const unknown = modelTaskOutcomeUnknown(error), failure = modelUsageControlFailure(error)
      update(unknown ? 'unknown' : failure ? 'blocked' : 'failed', unknown ? 'MODEL_OUTCOME_UNKNOWN' : failure?.code ?? 'INPATIENT_GUIDELINE_FAILED')
      return options.recovery.defer(event, error, waitUntil) ?? { status: 'completed' }
    }
  }
}
