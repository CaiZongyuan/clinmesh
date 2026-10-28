import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientSurgeryCatalogSchema, inpatientProcedureItemSchema,
  inpatientSurgerySchema, inpatientSurgeryRequestSchema, inpatientSurgeryExecutionSchema,
  inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema,
  inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgeryMaterialSelectionSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryCompleteInputSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext } from './command-executor.ts'
import type { InpatientEffects } from './inpatient-billing.ts'
import { businessDate } from './inpatient-orders.ts'
import { readMaterialSnapshot } from './scenario-data/cardiovascular-materials.ts'

export class InpatientSurgery {
  constructor(readonly owner: InpatientService) {}
  catalog(context: ActorContext) {
    this.owner.assertReadRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    const rows = z.array(z.object({ kind: z.enum(['procedure','material']), snapshot_json: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT kind,snapshot_json FROM inpatient_surgery_catalog WHERE workspace_id=? AND epoch=? ORDER BY item_id').all(context.workspaceId, context.epoch))
    return inpatientSurgeryCatalogSchema.parse({ procedures: rows.filter(row => row.kind === 'procedure').map(row => JSON.parse(row.snapshot_json)),
      materials: rows.filter(row => row.kind === 'material').map(row => readMaterialSnapshot(JSON.parse(row.snapshot_json))) })
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(requestRowSchema).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY julianday(requested_at),request_id').all(context.workspaceId, context.epoch, admissionId))
    return inpatientSurgerySchema.parse({ admissionId, encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
      virtualTime: this.owner.virtualTime(context), requests: rows.map(row => inpatientSurgeryRequestSchema.parse({ id: row.request_id, admissionId, version: row.version, status: row.status,
        plannedProcedure: JSON.parse(row.planned_procedure_json), plannedFor: row.planned_for, reason: row.reason, requestedAt: row.requested_at,
        requestedBy: row.requested_by, organizationId: row.organization_id,
        ...(row.preop_check_json === null ? {} : { preopCheck: JSON.parse(row.preop_check_json) }),
        ...(row.consent_confirmation_json === null ? {} : { consentConfirmation: JSON.parse(row.consent_confirmation_json) }),
        ...(row.cancellation_json === null ? {} : { cancellation: JSON.parse(row.cancellation_json) }),
      })), executions: this.executedForAdmission(context, admissionId), inProgress: this.executions(context, admissionId, 'in-progress') })
  }
  /** 首页与术后医嘱只消费已完成操作；术中事实通过独立集合返回。 */
  executedForAdmission(context: ActorContext, admissionId: string) { return this.executions(context, admissionId, 'completed') }
  private executions(context: ActorContext, admissionId: string, status: 'in-progress' | 'completed') {
    this.owner.assertReadRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(executionRowSchema).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? AND status=? ORDER BY julianday(performed_at),execution_id')
      .all(context.workspaceId, context.epoch, admissionId, status))
    return rows.map(row => {
      const materials = z.array(z.object({ material_use_id: z.string(), item_json: z.string(), quantity: z.number(), amount_fen: z.number(),
        recorded_at: z.string().nullable(), recorded_by: z.string().nullable(), practitioner_role_id: z.string().nullable(), note: z.string().nullable(), reservation_id: z.string().nullable(),
        charge_id: z.string().nullable(), correction_json: z.string().nullable() })).parse(this.owner.database.driver.prepare(`
          SELECT m.*,r.recorded_at,r.recorded_by,r.practitioner_role_id,r.note,r.reservation_id,b.charge_id,
          CASE WHEN c.correction_id IS NULL THEN NULL ELSE json_object('id',c.correction_id,'recordedAt',c.recorded_at,
            'recordedBy',c.recorded_by,'practitionerRoleId',c.practitioner_role_id,'note',c.note,'replacementMaterialUseId',c.replacement_use_id,
            'originalChargeId',c.original_charge_id,'reversalChargeId',c.reversal_charge_id) END correction_json
          FROM inpatient_surgery_material m LEFT JOIN inpatient_surgery_material_record r
          ON r.workspace_id=m.workspace_id AND r.epoch=m.epoch AND r.material_use_id=m.material_use_id
          LEFT JOIN inpatient_charge b ON b.workspace_id=m.workspace_id AND b.epoch=m.epoch AND b.source_id=m.material_use_id AND b.kind='material' AND b.admission_id=?
          LEFT JOIN inpatient_surgery_material_correction c ON c.workspace_id=m.workspace_id AND c.epoch=m.epoch AND c.material_use_id=m.material_use_id
          WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=? ORDER BY m.material_use_id`).all(admissionId, context.workspaceId, context.epoch, row.execution_id))
      const uses = materials.map(item => ({ id: item.material_use_id, item: JSON.parse(item.item_json), quantity: item.quantity, amountFen: item.amount_fen }))
      return inpatientSurgeryExecutionSchema.parse({ id: row.execution_id, admissionId, requestId: row.request_id,
        actualProcedure: JSON.parse(row.actual_procedure_json), performedAt: row.performed_at, performedBy: row.performed_by,
        practitionerRoleId: row.practitioner_role_id, organizationId: row.organization_id, note: row.note,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }), materials: uses.filter((_item, index) => materials[index]!.correction_json === null),
        materialHistory: materials.map((item, index) => ({ ...uses[index], recordedAt: item.recorded_at ?? row.performed_at,
          recordedBy: item.recorded_by ?? row.performed_by, practitionerRoleId: item.practitioner_role_id ?? row.practitioner_role_id,
          note: item.note ?? row.note, reservationId: item.reservation_id, chargeId: item.charge_id, correction: item.correction_json === null ? null : JSON.parse(item.correction_json) })),
      })
    })
  }
  /** 调用者先授权；目标护士在接收事务内检查时尚未接管住院。 */
  assertNoPending(context: ActorContext, admissionId: string) {
    if (this.owner.database.driver.prepare("SELECT 1 FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND status IN ('requested','ready') LIMIT 1")
      .get(context.workspaceId, context.epoch, admissionId)) throw new InpatientError('INPATIENT_SURGERY_PENDING', '尚有未实施或未取消的手术申请')
  }
  assertExecution(context: ActorContext, admissionId: string, executionId: string) {
    this.owner.admissionBinding(context, admissionId)
    const row = this.owner.database.driver.prepare('SELECT 1 FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? AND execution_id=?')
      .get(context.workspaceId, context.epoch, admissionId, executionId)
    if (row === undefined) throw new InpatientError('INPATIENT_SURGERY_EXECUTION_REQUIRED', '术后医嘱须引用本次住院已实施的手术')
    const procedure = this.owner.fhir.read(context, 'Procedure', executionId)
    if (procedure.status !== 'completed') throw new InpatientError('INPATIENT_SURGERY_EXECUTION_REQUIRED', '术后医嘱须引用本次住院已实施的手术')
  }
  request(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryRequestInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.request',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context,input.admissionId)
      const admission = this.owner.orders.assertAdmitted(context, input.admissionId), now = this.owner.virtualTime(context)
      if (Date.parse(input.plannedFor) < Date.parse(now)) throw new InpatientError('INPATIENT_SURGERY_TIME_CONFLICT', '计划手术时间不能早于当前虚拟时间')
      const item = this.procedure(context, input.procedureId, input.catalogVersion), id = uuidv7()
      this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_request(workspace_id,epoch,request_id,admission_id,status,planned_procedure_json,planned_for,reason,requested_at,requested_by,organization_id)
        VALUES(?,?,?,?,'requested',?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, id, admission.id, JSON.stringify(item), input.plannedFor, input.reason, now, context.actorId, admission.organizationId)
      this.owner.fhir.create(context, { resourceType: 'ServiceRequest', id, status: 'active', intent: 'order', code: { concept: { coding: [clinicalCoding(item.coding)], text: item.coding.display } },
        subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, authoredOn: now,
        occurrenceDateTime: input.plannedFor, requester: { reference: `PractitionerRole/${context.practitionerRoleId}` }, note: [{ text: input.reason }] })
      return { data: this.read(context, admission.id), effects: [{ kind: 'created' as const, reference: `ServiceRequest/${id}`, versionId: '1' }] }
    })
  }
  prepare(context: ActorContext, raw: unknown, idempotencyKey: string, action: 'check-preop' | 'confirm-consent' | 'cancel') {
    const input = inpatientSurgeryActionInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: `inpatient.surgery.${action}`, expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, action === 'check-preop' ? ['ward-nurse'] : ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context,input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const row = this.currentRequest(context, input)
      if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，不能撤销或重做术前准备')
      const column = action === 'check-preop' ? 'preop_check_json' : action === 'confirm-consent' ? 'consent_confirmation_json' : 'cancellation_json'
      if (row[column] !== null) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '该准备事实已记录，请刷新手术记录')
      const fact = JSON.stringify({ actorId: context.actorId, practitionerRoleId: context.practitionerRoleId, recordedAt: this.owner.virtualTime(context), note: input.note })
      const ready = action === 'check-preop' ? row.consent_confirmation_json !== null : row.preop_check_json !== null
      this.owner.database.driver.prepare(`UPDATE inpatient_surgery_request SET ${column}=?,version=version+1,status=? WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?`)
        .run(fact, action === 'cancel' ? 'cancelled' : ready ? 'ready' : 'requested', context.workspaceId, context.epoch, row.request_id, row.version)
      const effects: InpatientEffects = [{ kind: 'updated', reference: `InpatientSurgeryRequest/${row.request_id}`, versionId: String(row.version + 1) }]
      if (action === 'cancel') this.updateRequestProjection(context, row.request_id, 'revoked', effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  execute(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryExecuteInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.execute', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      const row = this.readyRequest(context, input), effects: InpatientEffects = []
      const selections = input.materials.map(selection => {
        if (selection.reservationId === undefined) return selection
        const reservation = z.object({ quantity: z.number(), consumed_quantity: z.number(), version: z.number() }).optional().parse(this.owner.database.driver.prepare(
          'SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
          .get(context.workspaceId, context.epoch, input.admissionId, selection.reservationId))
        if (!reservation) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
        if (reservation.consumed_quantity !== 0 || reservation.quantity !== selection.quantity)
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '一次性完成仍须按整笔原预留替换，请使用逐笔登记处理部分使用')
        return { ...selection, expectedReservationVersion: reservation.version }
      })
      const execution = this.createExecution(context, row, this.procedure(context, input.procedureId, input.catalogVersion), input.note, 'completed', effects)
      this.billProcedure(context, execution, effects)
      for (const selection of selections) this.writeMaterial(context, execution, selection, input.note, effects)
      this.finish(context, row, execution, input.note, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  start(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryStartInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.start', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      const row = this.readyRequest(context, input), effects: InpatientEffects = []
      this.createExecution(context, row, this.procedure(context, input.procedureId, input.catalogVersion), input.note, 'in-progress', effects)
      this.advanceRequest(context, row, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  recordMaterial(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryRecordMaterialInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.record-material', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const request = this.currentRequest(context, input), execution = this.executionForRequest(context, request.request_id)
      if (!execution || execution.execution_id !== input.executionId || execution.status !== 'in-progress')
        throw new InpatientError('INPATIENT_SURGERY_NOT_IN_PROGRESS', '须引用本次住院正在进行的手术')
      const effects: InpatientEffects = []
      this.writeMaterial(context, execution, input.material, input.note, effects)
      this.advanceRequest(context, request, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  correctMaterial(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryCorrectMaterialInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.correct-material', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const request = this.requestRow(context, input), execution = this.executionForRequest(context, request.request_id)
      const admission = this.owner.admissionBinding(context, input.admissionId)
      if (admission.financialStatus !== 'open') throw new InpatientError('INPATIENT_ACCOUNT_SETTLED', '已结算住院账户不能更正临床耗材记录')
      if (!execution || execution.execution_id !== input.executionId) throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '未找到本次住院的手术', 404)
      const material = z.object({ quantity: z.number(), reservation_id: z.string().nullable(), charge_id: z.string().nullable(), charge_version: z.number().nullable() }).optional()
        .parse(this.owner.database.driver.prepare(`SELECT m.quantity,r.reservation_id,b.charge_id,b.version charge_version FROM inpatient_surgery_material m
          LEFT JOIN inpatient_surgery_material_record r ON r.workspace_id=m.workspace_id AND r.epoch=m.epoch AND r.material_use_id=m.material_use_id
          LEFT JOIN inpatient_charge b ON b.workspace_id=m.workspace_id AND b.epoch=m.epoch AND b.kind='material' AND b.source_id=m.material_use_id AND b.admission_id=?
          WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=? AND m.material_use_id=?`)
          .get(input.admissionId, context.workspaceId, context.epoch, execution.execution_id, input.materialUseId))
      if (!material) throw new InpatientError('INPATIENT_MATERIAL_USE_NOT_FOUND', '未找到本手术的耗材使用', 404)
      if (this.owner.database.driver.prepare('SELECT 1 FROM inpatient_surgery_material_correction WHERE workspace_id=? AND epoch=? AND material_use_id=?')
        .get(context.workspaceId, context.epoch, input.materialUseId)) throw new InpatientError('INPATIENT_MATERIAL_USE_CORRECTED', '该使用已更正，请核对当前有效记录')
      if (!material.charge_id || material.charge_version === null) throw new InpatientError('INPATIENT_MATERIAL_CHARGE_MISSING', '原耗材费用缺失，须先核实账务')
      const effects: InpatientEffects = [], now = this.owner.virtualTime(context)
      const reversal = z.object({ charge_id: z.string() }).optional().parse(this.owner.database.driver.prepare(
        'SELECT charge_id FROM inpatient_charge WHERE workspace_id=? AND epoch=? AND admission_id=? AND reversal_of=?')
        .get(context.workspaceId, context.epoch, input.admissionId, material.charge_id))
      const reversalId = reversal?.charge_id ?? this.owner.billing.reverse(context, { admissionId: input.admissionId,
        chargeId: material.charge_id, expectedChargeVersion: material.charge_version, reason: input.note, serviceDate: businessDate(now), virtualTime: now }, effects)
      let replacement = input.replacement
      if (material.reservation_id) {
        const reservation = z.object({ quantity: z.number(), consumed_quantity: z.number(), status: z.string(), version: z.number(), request_id: z.string().nullable() }).parse(
          this.owner.database.driver.prepare('SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND reservation_id=?')
            .get(context.workspaceId, context.epoch, material.reservation_id))
        if (reservation.consumed_quantity < material.quantity) throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '原预留消耗与使用不一致，须先核实')
        if (replacement?.reservationId === material.reservation_id) {
          if (replacement.expectedReservationVersion !== reservation.version)
            throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '原预留版本已变化，请重新核对')
          // 同一事务先退回原消耗；替换继续使用刚核实的预留及其内部新版本。
          replacement = { ...replacement, expectedReservationVersion: reservation.version + 1 }
        }
        const released = reservation.status === 'released' || (execution.status === 'completed' && reservation.request_id === execution.request_id)
        this.owner.database.driver.prepare(`UPDATE inpatient_material_reservation SET consumed_quantity=consumed_quantity-?,version=version+1,status=?,material_use_id=NULL,
          release_reason=CASE WHEN ? THEN COALESCE(release_reason,?) ELSE release_reason END WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?`)
          .run(material.quantity, released ? 'released' : 'reserved', released ? 1 : 0, '术后更正收拢本手术未使用预留余量', context.workspaceId, context.epoch, material.reservation_id, reservation.version)
        effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${material.reservation_id}`, versionId: String(reservation.version + 1) })
      }
      const replacementId = replacement === undefined ? null : this.writeMaterial(context, execution, replacement, input.note, effects, material.reservation_id ?? undefined)
      const correctionId = uuidv7()
      this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material_correction VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, correctionId, input.materialUseId, replacementId, material.charge_id,
          reversalId, now, context.actorId, context.practitionerRoleId!, input.note)
      const procedure = this.owner.fhir.read(context, 'Procedure', execution.execution_id)
      const updated = this.owner.fhir.updateProjection(context, { ...procedure, note: [...z.array(z.object({ text: z.string() })).parse(procedure.note ?? []), { text: input.note }] }, procedure.meta!.versionId!)
      effects.push({ kind: 'created', reference: `InpatientSurgeryMaterialCorrection/${correctionId}`, versionId: '1' },
        { kind: 'updated', reference: `Procedure/${execution.execution_id}`, versionId: updated.meta!.versionId! })
      this.advanceRequest(context, request, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  complete(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryCompleteInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.complete', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const request = this.currentRequest(context, input), execution = this.executionForRequest(context, request.request_id)
      if (!execution || execution.execution_id !== input.executionId || execution.status !== 'in-progress')
        throw new InpatientError('INPATIENT_SURGERY_NOT_IN_PROGRESS', '须完成本次住院正在进行的原手术')
      const effects: InpatientEffects = []
      this.finish(context, request, execution, input.note, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  private readyRequest(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    this.owner.assertNotArchived(context, input.admissionId)
    this.owner.orders.assertAdmitted(context, input.admissionId)
    const row = this.currentRequest(context, input)
    if (row.status !== 'ready' || row.preop_check_json === null || row.consent_confirmation_json === null)
      throw new InpatientError('INPATIENT_SURGERY_NOT_READY', '术前检查核对与已签署知情同意确认均须完成')
    if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，请逐笔登记并完成原手术')
    return row
  }
  private createExecution(context: ActorContext, row: z.infer<typeof requestRowSchema>, actual: z.infer<typeof inpatientProcedureItemSchema>,
    note: string, status: 'in-progress' | 'completed', effects: InpatientEffects) {
    const admission = this.owner.admissionBinding(context, row.admission_id), id = uuidv7(), now = this.owner.virtualTime(context)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_execution
      (workspace_id,epoch,execution_id,request_id,admission_id,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, id, row.request_id, admission.id,
        JSON.stringify(actual), now, context.actorId, context.practitionerRoleId!, admission.organizationId, note, status, status === 'completed' ? now : null)
    this.owner.fhir.createProjection(context, { resourceType: 'Procedure', id, status,
      code: { coding: [clinicalCoding(actual.coding)], text: actual.coding.display }, subject: { reference: `Patient/${admission.patientId}` },
      encounter: { reference: `Encounter/${admission.id}` }, basedOn: [{ reference: `ServiceRequest/${row.request_id}` }], occurrenceDateTime: now,
      recorded: now, performer: [{ actor: { reference: `PractitionerRole/${context.practitionerRoleId}` }, onBehalfOf: { reference: `Organization/${admission.organizationId}` } }], note: [{ text: note }] })
    effects.push({ kind: 'created', reference: `Procedure/${id}`, versionId: '1' })
    return this.executionForRequest(context, row.request_id)!
  }
  private billProcedure(context: ActorContext, execution: z.infer<typeof executionRowSchema>, effects: InpatientEffects) {
    const actual = inpatientProcedureItemSchema.parse(JSON.parse(execution.actual_procedure_json)), now = this.owner.virtualTime(context)
    this.owner.billing.record(context, { admissionId: execution.admission_id, organizationId: execution.organization_id,
      kind: 'surgery', sourceId: execution.execution_id, amountFen: actual.chargeDefinition.priceFen,
      serviceDate: businessDate(now), virtualTime: now, label: actual.coding.display }, effects)
  }
  private finish(context: ActorContext, request: z.infer<typeof requestRowSchema>, execution: z.infer<typeof executionRowSchema>, note: string, effects: InpatientEffects) {
    const now = this.owner.virtualTime(context)
    if (execution.status === 'in-progress') this.billProcedure(context, execution, effects)
    this.owner.database.driver.prepare("UPDATE inpatient_surgery_execution SET status='completed',completed_at=?,note=? WHERE workspace_id=? AND epoch=? AND execution_id=? AND status='in-progress'")
      .run(now, note, context.workspaceId, context.epoch, execution.execution_id)
    this.owner.database.driver.prepare("UPDATE inpatient_surgery_request SET status='completed',version=version+1 WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?")
      .run(context.workspaceId, context.epoch, request.request_id, request.version)
    if (execution.status === 'in-progress') {
      const reservations = z.array(z.object({ reservation_id: z.string(), version: z.number() })).parse(this.owner.database.driver.prepare(
        "SELECT reservation_id,version FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND request_id=? AND status='reserved' AND quantity>consumed_quantity")
        .all(context.workspaceId, context.epoch, request.request_id))
      for (const reservation of reservations) {
        this.owner.database.driver.prepare("UPDATE inpatient_material_reservation SET status='released',release_reason=?,version=version+1 WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?")
          .run('手术完成，收拢本手术未使用预留余量', context.workspaceId, context.epoch, reservation.reservation_id, reservation.version)
        effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${reservation.reservation_id}`, versionId: String(reservation.version + 1) })
      }
    }
    if (execution.status === 'in-progress') {
      const procedure = this.owner.fhir.read(context, 'Procedure', execution.execution_id)
      const updated = this.owner.fhir.updateProjection(context, { ...procedure, status: 'completed',
        note: [...z.array(z.object({ text: z.string() })).parse(procedure.note ?? []), { text: note }] }, procedure.meta!.versionId!)
      effects.push({ kind: 'updated', reference: `Procedure/${execution.execution_id}`, versionId: updated.meta!.versionId! })
    }
    effects.push({ kind: 'updated', reference: `InpatientSurgeryRequest/${request.request_id}`, versionId: String(request.version + 1) })
    this.updateRequestProjection(context, request.request_id, 'completed', effects)
  }
  private executionForRequest(context: ActorContext, requestId: string) {
    return executionRowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND request_id=?').get(context.workspaceId, context.epoch, requestId))
  }
  private advanceRequest(context: ActorContext, row: z.infer<typeof requestRowSchema>, effects: InpatientEffects) {
    this.owner.database.driver.prepare('UPDATE inpatient_surgery_request SET version=version+1 WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?')
      .run(context.workspaceId, context.epoch, row.request_id, row.version)
    effects.push({ kind: 'updated', reference: `InpatientSurgeryRequest/${row.request_id}`, versionId: String(row.version + 1) })
  }
  private writeMaterial(context: ActorContext, execution: z.infer<typeof executionRowSchema>, selection: z.infer<typeof inpatientSurgeryMaterialSelectionSchema>, note: string, effects: InpatientEffects, restoredReservationId?: string) {
    const reservation = selection.reservationId === undefined ? undefined : z.object({ reservation_id: z.string(), material_id: z.string(), catalog_version: z.number(),
      request_id: z.string().nullable(), quantity: z.number(), consumed_quantity: z.number(), price_fen: z.number(), status: z.string(), version: z.number() }).optional()
      .parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
        .get(context.workspaceId, context.epoch, execution.admission_id, selection.reservationId))
    if (selection.reservationId !== undefined && !reservation) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
    if (reservation && ((reservation.status !== 'reserved' && !(reservation.status === 'released' && reservation.reservation_id === restoredReservationId))
      || reservation.version !== selection.expectedReservationVersion
      || reservation.material_id !== selection.materialId || reservation.catalog_version !== selection.catalogVersion
      || reservation.quantity - reservation.consumed_quantity < selection.quantity || (reservation.request_id !== null && reservation.request_id !== execution.request_id)))
      throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '预留余量、产品、版本或手术归属已变化，请重新核对')
    const current = this.catalog(context).materials.find(item => item.id === selection.materialId && item.version === selection.catalogVersion)
    if (!current || !('chargeDefinition' in current)) throw new InpatientError('CATALOG_CONFLICT', '耗材目录、版本或计价单位不可用')
    const item = reservation ? { ...current, chargeDefinition: { ...current.chargeDefinition, priceFen: reservation.price_fen } } : current
    const id = uuidv7(), now = this.owner.virtualTime(context), amountFen = z.number().int().nonnegative().safe().parse(item.chargeDefinition.priceFen * selection.quantity)
    this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material VALUES(?,?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, id, execution.execution_id, JSON.stringify(item), selection.quantity, amountFen)
    this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material_record VALUES(?,?,?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, id, selection.reservationId ?? null, now, context.actorId, context.practitionerRoleId!, note)
    if (reservation) {
      const consumed = reservation.consumed_quantity + selection.quantity, replaced = consumed === reservation.quantity
      this.owner.database.driver.prepare(`UPDATE inpatient_material_reservation SET consumed_quantity=?,version=version+1,status=?,material_use_id=?
        WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?`).run(consumed, replaced ? 'replaced' : reservation.status, replaced ? id : null,
          context.workspaceId, context.epoch, reservation.reservation_id, reservation.version)
      effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${reservation.reservation_id}`, versionId: String(reservation.version + 1) })
    }
    this.owner.billing.record(context, { admissionId: execution.admission_id, organizationId: execution.organization_id,
      kind: 'material', sourceId: id, serviceDate: businessDate(now), virtualTime: now, amountFen, label: item.display }, effects)
    effects.push({ kind: 'created', reference: `InpatientSurgeryMaterial/${id}`, versionId: '1' })
    return id
  }
  private authorize(context: ActorContext, admissionId: string, roles: string[]) {
    this.owner.assertRole(context, roles)
    this.owner.admissionBinding(context, admissionId)
  }
  private procedure(context: ActorContext, id: string, version: number) {
    const item = this.catalog(context).procedures.find(item => item.id === id && item.version === version)
    if (!item) throw new InpatientError('CATALOG_CONFLICT', '术式目录或版本无效')
    return item
  }
  private requestRow(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    const row = requestRowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?').get(context.workspaceId, context.epoch, input.admissionId, input.requestId))
    if (!row) throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '未找到本次住院的手术申请', 404)
    if (row.version !== input.expectedRequestVersion) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '手术申请版本已变化')
    return row
  }
  private currentRequest(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    const row = this.requestRow(context, input)
    if (!['requested','ready'].includes(row.status)) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '手术申请状态已变化')
    return row
  }
  private updateRequestProjection(context: ActorContext, id: string, status: 'revoked' | 'completed', effects: InpatientEffects) {
    const request = this.owner.fhir.read(context, 'ServiceRequest', id)
    const updated = this.owner.fhir.update(context, { ...request, status }, request.meta!.versionId!)
    effects.push({ kind: 'updated', reference: `ServiceRequest/${id}`, versionId: updated.meta!.versionId! })
  }
}
const requestRowSchema = z.object({ request_id: z.string(), admission_id: z.string(), version: z.number(), status: inpatientSurgeryRequestSchema.shape.status,
  planned_procedure_json: z.string(), planned_for: z.string(), reason: z.string(),
  requested_at: z.string(), requested_by: z.string(), organization_id: z.string(), preop_check_json: z.string().nullable(), consent_confirmation_json: z.string().nullable(), cancellation_json: z.string().nullable() })
const executionRowSchema = z.object({ execution_id: z.string(), admission_id: z.string(), request_id: z.string(),
  actual_procedure_json: z.string(), performed_at: z.string(), performed_by: z.string(), practitioner_role_id: z.string(), organization_id: z.string(), note: z.string(), status: z.enum(['in-progress','completed']), completed_at: z.string().nullable() })

function clinicalCoding({ system, version, code, display }: z.infer<typeof inpatientProcedureItemSchema>['coding']) { return { system, version, code, display } }
