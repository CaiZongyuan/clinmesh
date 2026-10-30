import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientDrgReviewBasisSchema, inpatientDrgReviewIssueSchema, inpatientDrgReviewSchema, inpatientDrgReviewTodoSchema, inpatientDrgReviewTodoActionInputSchema, inpatientDrgReviewHandoffInputSchema,
  inpatientDrgRecordChecksSchema, type InpatientDrgRecordChecks, type InpatientDrgReviewBasis } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientRecordSnapshotSchema } from '@clinmesh/contracts/inpatient-record'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const stateSchema = z.object({ task_id: z.string(), version: z.number(), task_version: z.number(), snapshot_json: z.string().nullable(), handoff_json: z.string().nullable() })
const todoRowSchema = z.object({ todo_id: z.string(), issue_key: z.string(), evidence_fingerprint: z.string(), issue_json: z.string(),
  status: inpatientDrgReviewTodoSchema.shape.status, version: z.number(), reason: z.string().nullable() })

/** 术后核查保存依据与岗位处置；正式临床、收费及分组仍由原 owner 拥有。 */
export class InpatientDrgReview {
  readonly #unsubscribe: () => void
  constructor(readonly owner: InpatientService) {
    this.#unsubscribe = owner.commands.subscribe((context, effects) => { if (effects.length > 0) this.refreshPending(context.workspaceId, context.epoch) })
  }
  close() { this.#unsubscribe() }
  #state(context: ActorContext, admissionId: string) {
    return stateSchema.optional().parse(this.owner.database.driver.prepare(`SELECT s.*,r.snapshot_json FROM inpatient_drg_review s
      LEFT JOIN inpatient_drg_review_revision r ON r.workspace_id=s.workspace_id AND r.epoch=s.epoch AND r.revision_id=s.revision_id
      WHERE s.workspace_id=? AND s.epoch=? AND s.admission_id=?`).get(context.workspaceId, context.epoch, admissionId))
  }
  #todos(context: ActorContext, admissionId: string) {
    return z.array(todoRowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_review_todo
      WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY issue_key`).all(context.workspaceId, context.epoch, admissionId))
      .map(row => ({ ...row, issue: inpatientDrgReviewIssueSchema.parse(JSON.parse(row.issue_json)) }))
  }
  /** 直接读取当前正式事实；跟进任务、待办和模型均不是查询前置。 */
  recordChecks(context: ActorContext, admissionId: string): InpatientDrgRecordChecks {
    return this.owner.database.driver.transaction(() => this.#recordChecks(context, admissionId))()
  }
  #recordChecks(context: ActorContext, admissionId: string): InpatientDrgRecordChecks {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'medical-records'])
    const admission = this.owner.readAdmissionBinding(context, admissionId)
    const surgery = this.owner.surgery.read(context, admissionId)
    const diagnosis = this.owner.orders.diagnosis(context, admissionId)
    const revision = z.object({ revision: z.number(), snapshot_json: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT revision,snapshot_json FROM inpatient_record_revision WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY revision DESC LIMIT 1')
      .get(context.workspaceId, context.epoch, admissionId))
    const primaryId = revision ? inpatientRecordSnapshotSchema.parse(JSON.parse(revision.snapshot_json)).clinical.mainProcedureExecutionId : null
    const primary = surgery.executions.find(item => item.id === primaryId)
    const frozen = admission.row.record_status === 'archived'
    const sources: InpatientDrgRecordChecks['sources'] = [
      { reference: `InpatientRecord/${admissionId}/revision/${revision?.revision ?? 0}`, target: 'record',
        display: `首页主操作：${primary ? `${primary.actualProcedure.coding.display}（${primary.actualProcedure.coding.code}）` : '尚未选择'}` },
      ...diagnosis.entries.map(item => ({ reference: `Condition/${item.conditionId}`, target: 'orders' as const,
        display: `${item.role === 'primary' ? '主诊断' : '其他诊断'}：${item.coding.display}（${item.coding.code}）` })),
      ...surgery.executions.map(item => ({ reference: `Procedure/${item.id}`, target: 'surgery' as const,
        display: `实际操作：${item.actualProcedure.coding.display}（${item.actualProcedure.coding.code}）` })),
      ...surgery.requests.filter(item => item.status === 'requested' || item.status === 'ready').map(item => ({
        reference: `ServiceRequest/${item.id}/version/${item.version}`, target: 'surgery' as const,
        display: `计划操作：${item.plannedProcedure.coding.display}（${item.plannedProcedure.coding.code}），${item.reason.slice(0, 1000)}` })),
    ]
    const issues: InpatientDrgRecordChecks['issues'] = [], missing: string[] = []
    let simulation: InpatientDrgRecordChecks['simulation'] = null
    if (!frozen) {
      try { simulation = this.owner.drg.simulate(context, admissionId, undefined) }
      catch (error) {
        if (!(error instanceof InpatientError) || error.code !== 'DRG_RULES_NOT_CONFIGURED') throw error
        missing.push(error.message)
      }
      const pci = surgery.executions.filter(item => pciSelectionProcedureCodes.includes(item.actualProcedure.coding.code))
      if (pci.length > 0 && (!primary || !pciSelectionProcedureCodes.includes(primary.actualProcedure.coding.code))) {
        issues.push({ key: 'primary-procedure-difference', kind: 'primary-procedure-difference', ownerRole: 'medical-records',
          materialId: null, display: '实际 PCI 与首页主操作选择需核对', plannedQuantity: null, actualQuantity: null,
          explanation: `已记录实际 PCI；${sources[0]!.display}。请根据原记录核实主操作选择，系统不判定选择错误，也不自动改写首页。`,
          evidence: [sources[0]!.reference, ...pci.map(item => `Procedure/${item.id}`)] })
      }
      if (!simulation || simulation.grouping.formal.status !== 'grouped' || (simulation.grouping.projected !== null && simulation.grouping.projected.status !== 'grouped')) {
        const reason = [simulation?.grouping.formal.reason, simulation?.grouping.projected?.reason, ...missing].filter(Boolean).join('；')
        issues.push({ key: 'grouping-incomplete', kind: 'grouping-incomplete', ownerRole: 'medical-records', materialId: null,
          display: '分组记录缺项或编码不兼容', plannedQuantity: null, actualQuantity: null,
          explanation: reason.slice(0, 2000) || '正式诊断、实际主操作或计划分组依据不完整，请在原记录核对。',
          evidence: sources.map(item => item.reference).slice(0, 99) })
      }
      const formal = simulation?.grouping.formal, projected = simulation?.grouping.projected
      if (formal?.status === 'grouped' && projected?.status === 'grouped' && formal.drgCode !== projected.drgCode) {
        issues.push({ key: 'grouping-difference', kind: 'grouping-difference', ownerRole: 'medical-records', materialId: null,
          display: '正式分组与计划推演不同', plannedQuantity: null, actualQuantity: null,
          explanation: `正式事实分组 ${formal.drgCode}；若当前计划实施的推演分组 ${projected.drgCode}。计划与预留不改变正式病组，请分别核对诊断、实际主操作和计划依据。`,
          evidence: sources.map(item => item.reference).slice(0, 99) })
      }
    }
    if (simulation) sources.push({ reference: `DrgRules/${canonicalJsonHash({ id: simulation.rulesId, version: simulation.rulesVersion })}`, target: 'drg',
      display: `分组规则：${simulation.rulesId} / ${simulation.rulesVersion}` })
    // 每项说明只引用已公开的来源；分组说明同时保留规则身份。
    for (const issue of issues) if (simulation && (issue.kind === 'grouping-difference' || issue.kind === 'grouping-incomplete'))
      issue.evidence.push(sources.at(-1)!.reference)
    const paymentStatus = simulation?.grouping.formal.status !== 'grouped' ? 'grouping-incomplete'
      : simulation.paymentReference === null ? 'missing' : 'available'
    const paymentMessage = frozen ? '病案已归档，请从原分组页面查看冻结结果。'
      : paymentStatus === 'missing' ? '分组成功，金额暂不可估：缺少适用的医院支付参数。'
        : paymentStatus === 'available' ? '医院支付参考可估，与患者医保待遇及正式费用分别核对。' : '分组尚未完成，暂不估算医院支付参考。'
    const basis = { admissionId, encounterVersion: surgery.encounterVersion,
      status: frozen ? 'frozen' as const : issues.some(item => item.kind === 'grouping-incomplete') ? 'incomplete' as const : 'complete' as const,
      simulation, issues, sources, paymentStatus, paymentMessage, missing }
    return inpatientDrgRecordChecksSchema.parse({ ...basis, fingerprint: canonicalJsonHash({ workspaceId: context.workspaceId,
      epoch: context.epoch, ...basis, simulation: simulation ? { ...simulation, evaluatedAt: undefined } : null }) })
  }
  readRecordChecks(context: ActorContext, admissionId: string) {
    try {
      const result = this.recordChecks(context, admissionId)
      this.owner.commands.auditRead(context, 'inpatient.drg.record-checks.read', { admissionId }, 'success')
      return result
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.drg.record-checks.read', { admissionId }, 'failed') } catch { /* Preserve the original rejection. */ }
      throw error
    }
  }
  #compute(current: ReturnType<InpatientService['followup']['current']>): InpatientDrgReviewBasis | undefined {
    const { context, task, simulation } = current, surgery = this.owner.surgery.read(context, task.admissionId)
    if (surgery.executions.length === 0) return undefined
    const executions = surgery.executions
    const scoped = executions.map(execution => ({ execution, plan: this.owner.drgAgent.prePlanForRequest(context, task.admissionId, execution.requestId) }))
      .filter(({ execution, plan }) => pciSelectionProcedureCodes.includes(execution.actualProcedure.coding.code) || plan !== undefined)
    const clinicalExecutions = new Set(scoped.map(item => item.execution.id))
    const charges = this.owner.orders.chargeFacts(context, task.admissionId).charges
    const issues: z.infer<typeof inpatientDrgReviewIssueSchema>[] = [], comparisons: InpatientDrgReviewBasis['comparisons'] = []
    for (const { execution, plan } of scoped) {
      const scope = { requestId: execution.requestId, executionId: execution.id, procedureDisplay: execution.actualProcedure.coding.display }
      const planRef = plan ? `InpatientDrgPlan/${task.admissionId}/version/${plan.revision}` : `ServiceRequest/${execution.requestId}`
      if (!plan) issues.push({ ...scope, key: `missing-plan:${execution.id}`, kind: 'missing-plan', ownerRole: 'inpatient-doctor', materialId: null,
        display: '缺少术前人工计划', plannedQuantity: null, actualQuantity: null, explanation: '该手术尚无可按选型确认身份和版本核对的人工术前计划，不能把其他手术或模型建议作为原计划。',
        evidence: [planRef, `Procedure/${execution.id}`] })
      const products = new Map<string, { materialId: string; version: number; display: string; planned: number; actual: number; uses: string[] }>()
      for (const item of plan?.items ?? []) products.set(`${item.materialId}@${item.catalogVersion}`, { materialId: item.materialId,
        version: item.catalogVersion, display: item.display, planned: item.quantity, actual: 0, uses: [] })
      for (const use of execution.materials) {
        const key = `${use.item.id}@${use.item.version}`, value = products.get(key) ?? { materialId: use.item.id, version: use.item.version,
          display: use.item.display, planned: 0, actual: 0, uses: [] }
        value.actual += use.quantity; value.uses.push(`InpatientSurgeryMaterial/${use.id}`); products.set(key, value)
      }
      for (const [key, item] of products) {
        comparisons.push({ ...scope, materialId: item.materialId, catalogVersion: item.version, display: item.display,
          plannedQuantity: plan ? item.planned : null, actualQuantity: item.actual })
        if (!plan || item.actual === item.planned) continue
        const kind = item.planned === 0 ? 'unplanned-product' : item.actual > item.planned ? 'extra-use' : 'unused-plan'
        issues.push({ ...scope, key: `${kind}:${execution.id}:${key}`, kind, ownerRole: 'inpatient-doctor', materialId: item.materialId, display: item.display,
          plannedQuantity: item.planned, actualQuantity: item.actual, explanation: kind === 'unused-plan' ? '术前计划与实际使用存在未使用差异，需核实原因。'
            : kind === 'extra-use' ? '实际使用数量超过术前人工计划，需术者核实额外用途。' : '实际使用了术前人工计划之外的具体产品，需核实选型及原因。',
          evidence: [planRef, ...item.uses, `Procedure/${execution.id}`] })
      }
    }
    for (const execution of executions) {
      for (const use of execution.materialHistory.length > 0 ? execution.materialHistory : execution.materials.map(item => ({ ...item, correction: null }))) {
        const expected = use.correction === null ? use.amountFen : 0
        const original = charges.filter(charge => charge.kind === 'material' && charge.sourceId === use.id)
        const originalIds = new Set(original.map(item => item.id))
        const related = charges.filter(charge => originalIds.has(charge.id) || (charge.reversalOf !== undefined && originalIds.has(charge.reversalOf)))
        const net = related.reduce((sum, charge) => sum + charge.amountFen, 0)
        if (original.length !== 1 || net !== expected) issues.push({ requestId: execution.requestId, executionId: execution.id, procedureDisplay: execution.actualProcedure.coding.display, key: `billing-mismatch:${execution.id}:${use.id}`, kind: 'billing-mismatch', ownerRole: 'cashier',
          materialId: use.item.id, display: use.item.display, plannedQuantity: null, actualQuantity: use.quantity,
          explanation: '耗材有效使用与正式收费净额不一致，须在正式记录和账务入口核实更正。',
          evidence: [`InpatientSurgeryMaterial/${use.id}`, ...related.map(charge => `ChargeItem/${charge.id}/version/${charge.version}`)] })
        if (clinicalExecutions.has(execution.id) && use.correction?.replacementMaterialUseId) issues.push({ requestId: execution.requestId, executionId: execution.id, procedureDisplay: execution.actualProcedure.coding.display, key: `replacement:${execution.id}:${use.id}`, kind: 'replacement', ownerRole: 'inpatient-doctor', materialId: use.item.id,
          display: use.item.display, plannedQuantity: null, actualQuantity: use.quantity, explanation: use.correction.note,
          evidence: [`InpatientSurgeryMaterial/${use.id}`, `InpatientSurgeryMaterial/${use.correction.replacementMaterialUseId}`,
            `ChargeItem/${use.correction.originalChargeId}`, `ChargeItem/${use.correction.reversalChargeId}`] })
      }
    }
    for (const execution of executions) {
      const original = charges.filter(charge => charge.kind === 'surgery' && charge.sourceId === execution.id), ids = new Set(original.map(item => item.id))
      const related = charges.filter(charge => ids.has(charge.id) || (charge.reversalOf !== undefined && ids.has(charge.reversalOf)))
      if (original.length !== 1 || related.reduce((sum, item) => sum + item.amountFen, 0) !== execution.actualProcedure.chargeDefinition.priceFen)
        issues.push({ requestId: execution.requestId, executionId: execution.id, procedureDisplay: execution.actualProcedure.coding.display, key: `billing-mismatch:Procedure/${execution.id}`, kind: 'billing-mismatch', ownerRole: 'cashier', materialId: null,
          display: execution.actualProcedure.coding.display, plannedQuantity: null, actualQuantity: 1, explanation: '已完成手术与正式术式收费净额不一致，须核实原收费及关联更正。',
          evidence: [`Procedure/${execution.id}`, ...related.map(charge => `ChargeItem/${charge.id}/version/${charge.version}`)] })
    }
    const missing = current.errorCode === null ? [] : [current.errorCode]
    issues.push(...this.recordChecks(context, task.admissionId).issues)
    const basis = { summary: { formalDrgCode: simulation?.grouping.formal.drgCode ?? null, formalChargesFen: simulation?.formal.chargesFen ?? null,
      projectedTotalFen: simulation?.coverage.estimatedTotalFen ?? null }, simulation, issues, comparisons, missing }
    return inpatientDrgReviewBasisSchema.parse({ ...basis, fingerprint: canonicalJsonHash({ ...basis,
      simulation: simulation === null ? null : { ...simulation, evaluatedAt: undefined }, plans: scoped.map(item => item.plan), executions }) })
  }
  #refresh(taskId: string) {
    const current = this.owner.followup.current(taskId), { context, task } = current
    const previous = this.#state(context, task.admissionId)
    if (previous && previous.task_version !== task.version) this.owner.database.driver.prepare(`UPDATE inpatient_drg_review
      SET task_version=?,handoff_json=NULL,version=version+1 WHERE workspace_id=? AND epoch=? AND admission_id=?`)
      .run(task.version, context.workspaceId, context.epoch, task.admissionId)
    const basis = this.#compute(current)
    if (!basis) return
    if (previous?.snapshot_json && inpatientDrgReviewBasisSchema.parse(JSON.parse(previous.snapshot_json)).fingerprint === basis.fingerprint) return
    this.owner.database.driver.transaction(() => {
      const stored = z.object({ revision_id: z.string() }).optional().parse(this.owner.database.driver.prepare(
        'SELECT revision_id FROM inpatient_drg_review_revision WHERE workspace_id=? AND epoch=? AND task_id=? AND fingerprint=?')
        .get(context.workspaceId, context.epoch, taskId, basis.fingerprint))
      const revisionId = stored?.revision_id ?? uuidv7(), now = new Date().toISOString()
      if (!stored) this.owner.database.driver.prepare('INSERT INTO inpatient_drg_review_revision VALUES(?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, revisionId, taskId, task.admissionId, basis.fingerprint, JSON.stringify(basis), now)
      this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_review(workspace_id,epoch,admission_id,task_id,version,task_version,revision_id)
        VALUES(?,?,?,?,1,?,?) ON CONFLICT(workspace_id,epoch,admission_id) DO UPDATE SET version=version+1,task_version=excluded.task_version,revision_id=excluded.revision_id`)
        .run(context.workspaceId, context.epoch, task.admissionId, taskId, task.version, revisionId)
      const existing = this.#todos(context, task.admissionId), retained = new Set<string>()
      for (const issue of basis.issues) {
        const fingerprint = canonicalJsonHash(issue)
        const old = existing.find(item => item.issue_key === issue.key) ?? existing.find(item => {
          if (retained.has(item.todo_id)) return false
          const previous = item.issue
          return previous.executionId === undefined && issue.executionId !== undefined && previous.kind === issue.kind && previous.materialId === issue.materialId
            && (previous.evidence.includes(`Procedure/${issue.executionId}`) || previous.evidence.some(source => source.startsWith('InpatientSurgeryMaterial/') && issue.evidence.includes(source)))
        })
        if (old) retained.add(old.todo_id)
        if (old && old.issue_key !== issue.key) {
          const unchanged = old.issue.plannedQuantity === issue.plannedQuantity && old.issue.actualQuantity === issue.actualQuantity
            && canonicalJsonHash(old.issue.evidence) === canonicalJsonHash(issue.evidence)
          this.owner.database.driver.prepare(`UPDATE inpatient_drg_review_todo SET issue_key=?,evidence_fingerprint=?,issue_json=?,version=version+1,
            status=CASE WHEN status='resolved' OR ?=0 THEN 'pending' ELSE status END,reason=CASE WHEN ? THEN reason ELSE NULL END
            WHERE workspace_id=? AND epoch=? AND todo_id=?`)
            .run(issue.key, fingerprint, JSON.stringify(issue), unchanged ? 1 : 0, unchanged ? 1 : 0, context.workspaceId, context.epoch, old.todo_id)
          continue
        }
        if (old?.evidence_fingerprint === fingerprint && old.status !== 'resolved') continue
        this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_review_todo VALUES(?,?,?,?,?,?,?,?,'pending',1,NULL)
          ON CONFLICT(workspace_id,epoch,task_id,issue_key) DO UPDATE SET evidence_fingerprint=excluded.evidence_fingerprint,
          issue_json=excluded.issue_json,status='pending',version=version+1,reason=NULL`)
          .run(context.workspaceId, context.epoch, old?.todo_id ?? uuidv7(), taskId, task.admissionId, issue.key, fingerprint, JSON.stringify(issue))
      }
      for (const old of existing) if (!retained.has(old.todo_id) && !basis.issues.some(issue => issue.key === old.issue_key) && old.status !== 'resolved')
        this.owner.database.driver.prepare("UPDATE inpatient_drg_review_todo SET status='resolved',version=version+1,reason=? WHERE workspace_id=? AND epoch=? AND todo_id=?")
          .run('已按最新业务事实复查，原问题已消除。', context.workspaceId, context.epoch, old.todo_id)
    })()
  }
  refreshPending(workspaceId?: string, epoch?: string) {
    const tasks = z.array(z.object({ task_id: z.string() })).parse(this.owner.database.driver.prepare(`SELECT task_id FROM inpatient_drg_followup WHERE status='active'
      ${workspaceId === undefined ? '' : 'AND workspace_id=? AND epoch=?'}`).all(...(workspaceId === undefined ? [] : [workspaceId, epoch ?? ''])))
    for (const task of tasks) try { this.#refresh(task.task_id) } catch (error) { if (!(error instanceof InpatientError)) throw error }
  }
  modelBasis(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    this.refreshPending(context.workspaceId, context.epoch)
    const state = this.#state(context, admissionId)
    return state?.snapshot_json ? inpatientDrgReviewBasisSchema.parse(JSON.parse(state.snapshot_json)) : undefined
  }
  act(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDrgReviewTodoActionInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.drg.review.todo.act',
      expectedVersions: {}, dataSchema: inpatientDrgReviewSchema,
      authorize: () => { this.owner.assertReadRole(context, ['inpatient-doctor', 'medical-records', 'cashier']); this.owner.readAdmissionBinding(context, input.admissionId) },
    }, () => {
      this.refreshPending(context.workspaceId, context.epoch)
      const state = this.#state(context, input.admissionId), row = this.#todos(context, input.admissionId).find(item => item.todo_id === input.todoId)
      if (!state?.snapshot_json || !row) throw new InpatientError('INPATIENT_DRG_TODO_NOT_FOUND', '未找到本次住院待办', 404)
      const issue = row.issue
      if (context.roleCode !== issue.ownerRole) throw new InpatientError('INPATIENT_DRG_TODO_FORBIDDEN', '当前岗位不能处理该待办', 403)
      const basis = inpatientDrgReviewBasisSchema.parse(JSON.parse(state.snapshot_json))
      if (input.expectedFingerprint !== basis.fingerprint || input.expectedTodoVersion !== row.version)
        throw new InpatientError('INPATIENT_DRG_REVIEW_STALE', '待办或依据已变化，请刷新后核实')
      const exists = basis.issues.some(item => item.key === row.issue_key)
      if (input.action === 'resolve' && exists) throw new InpatientError('INPATIENT_DRG_TODO_UNRESOLVED', '最新业务事实仍有此问题，不能只关闭提示作为解决证据')
      if (!exists && (input.action === 'dismiss' || input.action === 'in-progress')) throw new InpatientError('INPATIENT_DRG_TODO_RESOLVED', '问题已由最新事实消除，不能以人工状态重新打开')
      const status = input.action === 'dismiss' ? 'dismissed' : input.action === 'in-progress' ? 'in-progress' : input.action === 'resolve' ? 'resolved' : row.status
      const reason = input.action === 'resolve' ? '已按最新业务事实复查，原问题已消除。' : input.action === 'recheck' ? row.reason : input.note
      this.owner.database.driver.prepare('UPDATE inpatient_drg_review_todo SET status=?,reason=?,version=version+1 WHERE workspace_id=? AND epoch=? AND todo_id=? AND version=?')
        .run(status, reason, context.workspaceId, context.epoch, row.todo_id, row.version)
      this.owner.database.driver.prepare('UPDATE inpatient_drg_review SET version=version+1 WHERE workspace_id=? AND epoch=? AND admission_id=?')
        .run(context.workspaceId, context.epoch, input.admissionId)
      this.owner.database.driver.prepare('INSERT INTO inpatient_drg_review_action VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, uuidv7(), input.admissionId, row.todo_id, input.action, input.note, context.actorId, context.roleCode,
          new Date().toISOString(), row.evidence_fingerprint)
      return { data: this.snapshot(context, input.admissionId), effects: [{ kind: 'updated' as const,
        reference: `InpatientDrgReviewTodo/${row.todo_id}`, versionId: String(row.version + 1) }] }
    })
  }
  handoff(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDrgReviewHandoffInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.drg.review.handoff',
      expectedVersions: {}, dataSchema: inpatientDrgReviewSchema,
      authorize: () => { this.owner.assertReadRole(context, ['inpatient-doctor', 'medical-records']); this.owner.readAdmissionBinding(context, input.admissionId) },
    }, () => {
      this.refreshPending(context.workspaceId, context.epoch)
      const task = z.object({ task_id: z.string(), version: z.number(), status: z.string() }).optional().parse(this.owner.database.driver.prepare(
        'SELECT task_id,version,status FROM inpatient_drg_followup WHERE workspace_id=? AND epoch=? AND admission_id=?')
        .get(context.workspaceId, context.epoch, input.admissionId))
      if (!task) throw new InpatientError('INPATIENT_DRG_FOLLOWUP_NOT_FOUND', '未找到住院跟进任务', 404)
      if (task.status === 'active') throw new InpatientError('INPATIENT_DRG_HANDOFF_NOT_READY', '归档、停止或失权后再收拢本轮结果与责任')
      const previous = this.#state(context, input.admissionId)
      if (input.expectedVersion !== (previous?.version ?? 0)) throw new InpatientError('INPATIENT_DRG_REVIEW_STALE', '核查或待办已变化，请刷新后交接')
      if (previous?.handoff_json && previous.task_version === task.version) throw new InpatientError('INPATIENT_DRG_HANDOFF_COMPLETED', '本轮已交接，原结果与未解决责任继续保留')
      const at = new Date().toISOString(), handedOver = { by: context.actorId, role: context.roleCode, at, note: input.note }
      this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_review(workspace_id,epoch,admission_id,task_id,version,task_version,handoff_json)
        VALUES(?,?,?,?,1,?,?) ON CONFLICT(workspace_id,epoch,admission_id) DO UPDATE SET version=version+1,task_version=excluded.task_version,handoff_json=excluded.handoff_json`)
        .run(context.workspaceId, context.epoch, input.admissionId, task.task_id, task.version, JSON.stringify(handedOver))
      this.owner.database.driver.prepare('INSERT INTO inpatient_drg_review_action VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, uuidv7(), input.admissionId, null, 'handoff', input.note, context.actorId, context.roleCode, at, previous?.snapshot_json ? inpatientDrgReviewBasisSchema.parse(JSON.parse(previous.snapshot_json)).fingerprint : canonicalJsonHash({ taskId: task.task_id, version: task.version }))
      return { data: this.snapshot(context, input.admissionId), effects: [{ kind: 'updated' as const,
        reference: `InpatientDrgReview/${input.admissionId}`, versionId: String((previous?.version ?? 0) + 1) }] }
    })
  }
  read(context: ActorContext, admissionId: string) {
    try {
      const result = this.snapshot(context, admissionId)
      this.owner.commands.auditRead(context, 'inpatient.drg.review.read', { admissionId }, 'success')
      return result
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.drg.review.read', { admissionId }, 'failed') } catch { /* Preserve the rejection. */ }
      throw error
    }
  }
  private snapshot(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records', 'cashier'])
    this.owner.readAdmissionBinding(context, admissionId)
    this.refreshPending(context.workspaceId, context.epoch)
    const state = this.#state(context, admissionId), basis = state?.snapshot_json ? inpatientDrgReviewBasisSchema.parse(JSON.parse(state.snapshot_json)) : undefined
    const task = z.object({ task_id: z.string(), status: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT task_id,status FROM inpatient_drg_followup WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId, context.epoch, admissionId))
    const financial = context.roleCode === 'cashier'
    const todos = this.#todos(context, admissionId).map(row => inpatientDrgReviewTodoSchema.parse({ ...row.issue, id: row.todo_id,
      version: row.version, evidenceFingerprint: row.evidence_fingerprint, status: row.status, reason: row.reason }))
    const model = financial ? undefined : this.owner.drgAgent.read(context, admissionId)
    const modelCurrent = task?.status === 'active' && model?.status === 'succeeded' && model.stage === 'postoperative'
    const retainedAnalysis = modelCurrent ? model?.analysis : model?.lastAnalysis
    return inpatientDrgReviewSchema.parse({ admissionId, taskId: task?.task_id ?? null, version: state?.version ?? 0,
      status: task?.status !== 'active' ? task ? 'frozen' : 'inactive' : !basis ? 'waiting-surgery' : basis.missing.length > 0 ? 'incomplete' : 'complete',
      fingerprint: basis?.fingerprint ?? null, freezeReason: task?.status === 'archived' ? '病案已归档，停止新的临床分析。'
        : task?.status === 'authorization-lost' ? '原病例授权或责任已变化，停止新分析并保留待交接结果。'
          : task?.status === 'stopped' ? '本轮由医生停止，保留既有结果与待办。' : null, summary: { formalDrgCode: financial ? null : basis?.summary.formalDrgCode ?? null,
        formalChargesFen: basis?.summary.formalChargesFen ?? null, projectedTotalFen: financial ? null : basis?.summary.projectedTotalFen ?? null },
      simulation: financial ? null : basis?.simulation ?? null, comparisons: financial ? [] : basis?.comparisons ?? [], missing: financial ? [] : basis?.missing ?? ['尚未形成术后核查结果'],
      todos: todos.filter(item => item.status !== 'resolved' && (!financial || item.ownerRole === 'cashier')),
      resolvedTodos: todos.filter(item => item.status === 'resolved' && (!financial || item.ownerRole === 'cashier')),
      actions: z.array(z.object({ todo_id: z.string().nullable(), action: z.string(), note: z.string(), actor_id: z.string(), role_code: z.string(), recorded_at: z.string() }))
        .parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_drg_review_action WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY recorded_at,action_id')
          .all(context.workspaceId, context.epoch, admissionId)).filter(item => !financial || todos.some(todo => todo.id === item.todo_id && todo.ownerRole === 'cashier'))
        .map(item => ({ todoId: item.todo_id, action: item.action, note: item.note, actorId: item.actor_id, role: item.role_code, at: item.recorded_at })),
      model: financial ? null : { current: modelCurrent, status: task?.status === 'active' ? model?.status ?? 'inactive' : model?.lastStatus ?? 'inactive',
        failureCode: model?.failureCode ?? null, observations: retainedAnalysis?.stage === 'postoperative' ? retainedAnalysis.observations : [] },
      handedOver: state?.handoff_json ? { ...JSON.parse(state.handoff_json), ...(financial ? { note: '已完成岗位责任交接。' } : {}) } : null })
  }
}
