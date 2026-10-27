import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientSurgeryCatalogSchema, inpatientProcedureItemSchema,
  inpatientSurgerySchema, inpatientSurgeryRequestSchema, inpatientSurgeryExecutionSchema,
  inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema,
  inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgeryMaterialSelectionSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext } from './command-executor.ts'
import type { InpatientEffects } from './inpatient-billing.ts'
import { businessDate } from './inpatient-orders.ts'
import { readMaterialSnapshot } from './scenario-data/cardiovascular-materials.ts'

export class InpatientSurgery {
  constructor(readonly owner: InpatientService) {}
  catalog(context: ActorContext) {
    this.owner.assertRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    const rows = z.array(z.object({ kind: z.enum(['procedure','material']), snapshot_json: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT kind,snapshot_json FROM inpatient_surgery_catalog WHERE workspace_id=? AND epoch=? ORDER BY item_id').all(context.workspaceId, context.epoch))
    return inpatientSurgeryCatalogSchema.parse({ procedures: rows.filter(row => row.kind === 'procedure').map(row => JSON.parse(row.snapshot_json)),
      materials: rows.filter(row => row.kind === 'material').map(row => readMaterialSnapshot(JSON.parse(row.snapshot_json))) })
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.admissionBinding(context, admissionId)
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
    this.owner.assertRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.admissionBinding(context, admissionId)
    const rows = z.array(executionRowSchema).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? AND status=? ORDER BY julianday(performed_at),execution_id')
      .all(context.workspaceId, context.epoch, admissionId, status))
    return rows.map(row => {
      const materials = z.array(z.object({ material_use_id: z.string(), item_json: z.string(), quantity: z.number(), amount_fen: z.number(),
        recorded_at: z.string().nullable(), recorded_by: z.string().nullable(), practitioner_role_id: z.string().nullable(), note: z.string().nullable(), reservation_id: z.string().nullable() }))
        .parse(this.owner.database.driver.prepare(`SELECT m.*,r.recorded_at,r.recorded_by,r.practitioner_role_id,r.note,r.reservation_id
          FROM inpatient_surgery_material m LEFT JOIN inpatient_surgery_material_record r
          ON r.workspace_id=m.workspace_id AND r.epoch=m.epoch AND r.material_use_id=m.material_use_id
          WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=? ORDER BY m.material_use_id`).all(context.workspaceId, context.epoch, row.execution_id))
      const uses = materials.map(item => ({ id: item.material_use_id, item: JSON.parse(item.item_json), quantity: item.quantity, amountFen: item.amount_fen }))
      return inpatientSurgeryExecutionSchema.parse({ id: row.execution_id, admissionId, requestId: row.request_id,
        actualProcedure: JSON.parse(row.actual_procedure_json), performedAt: row.performed_at, performedBy: row.performed_by,
        practitionerRoleId: row.practitioner_role_id, organizationId: row.organization_id, note: row.note,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }), materials: uses,
        materialHistory: materials.map((item, index) => ({ ...uses[index], recordedAt: item.recorded_at ?? row.performed_at,
          recordedBy: item.recorded_by ?? row.performed_by, practitionerRoleId: item.practitioner_role_id ?? row.practitioner_role_id,
          note: item.note ?? row.note, reservationId: item.reservation_id })),
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
      this.owner.assertNotArchived(context,input.admissionId)
      const admission = this.owner.orders.assertAdmitted(context, input.admissionId), row = this.currentRequest(context, input)
      if (row.status !== 'ready' || row.preop_check_json === null || row.consent_confirmation_json === null) throw new InpatientError('INPATIENT_SURGERY_NOT_READY', '术前检查核对与已签署知情同意确认均须完成')
      if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，请逐笔登记并完成原手术')
      const actual = this.procedure(context, input.procedureId, input.catalogVersion), catalog = this.catalog(context)
      // 预留替换：先于计价定位校验预留状态、数量与目录版本，替换以业务引用落地，不重复计费。
      for (const selection of input.materials) {
        if (selection.reservationId === undefined) continue
        const reservation = z.object({ status: z.string(), request_id: z.string().nullable(), material_id: z.string(), quantity: z.number(), catalog_version: z.number() }).optional().parse(this.owner.database.driver.prepare(
          'SELECT status, request_id, material_id, quantity, catalog_version FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
          .get(context.workspaceId, context.epoch, admission.id, selection.reservationId))
        if (reservation === undefined) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
        if (reservation.status !== 'reserved') throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '耗材预留已被替换或释放，请刷新预留列表')
        if (reservation.request_id !== null && reservation.request_id !== row.request_id)
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '耗材预留属于另一手术申请，须按原计划替换')
        if (reservation.material_id !== selection.materialId || reservation.quantity !== selection.quantity)
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '实际使用与预留的耗材或数量不一致，须按预留原样替换')
        if (reservation.catalog_version !== selection.catalogVersion)
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '置换目录版本须与预留版本一致，按预留冻结价计价')
      }
      const materials = input.materials.map(selection => {
        const item = catalog.materials.find(item => item.id === selection.materialId && item.version === selection.catalogVersion)
        if (!item || !('chargeDefinition' in item)) throw new InpatientError('CATALOG_CONFLICT', '耗材目录、版本或计价单位不可用')
        return { id: uuidv7(), item, quantity: selection.quantity, amountFen: z.number().int().safe().parse(item.chargeDefinition.priceFen * selection.quantity) }
      })
      const id = uuidv7(), now = this.owner.virtualTime(context), effects: InpatientEffects = []
      this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_execution(workspace_id,epoch,execution_id,request_id,admission_id,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, id, row.request_id, admission.id, JSON.stringify(actual), now, context.actorId, context.practitionerRoleId!, admission.organizationId, input.note)
      for (const material of materials) this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material VALUES(?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, material.id, id, JSON.stringify(material.item), material.quantity, material.amountFen)
      for (const [index, selection] of input.materials.entries()) {
        this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material_record VALUES(?,?,?,?,?,?,?,?)')
          .run(context.workspaceId, context.epoch, materials[index]!.id, selection.reservationId ?? null, now, context.actorId, context.practitionerRoleId!, input.note)
        if (selection.reservationId === undefined) continue
        const replaced = this.owner.database.driver.prepare(
          "UPDATE inpatient_material_reservation SET status='replaced', consumed_quantity=quantity,version=version+1, material_use_id=? WHERE workspace_id=? AND epoch=? AND reservation_id=? AND status='reserved'")
          .run(materials[index]!.id, context.workspaceId, context.epoch, selection.reservationId)
        if (replaced.changes !== 1) throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '耗材预留状态已变化，替换未生效')
      }
      this.owner.database.driver.prepare('UPDATE inpatient_surgery_execution SET completed_at=? WHERE workspace_id=? AND epoch=? AND execution_id=?').run(now, context.workspaceId, context.epoch, id)
      this.owner.fhir.createProjection(context, { resourceType: 'Procedure', id, status: 'completed', code: { coding: [clinicalCoding(actual.coding)], text: actual.coding.display },
        subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, basedOn: [{ reference: `ServiceRequest/${row.request_id}` }],
        occurrenceDateTime: now, recorded: now, performer: [{ actor: { reference: `PractitionerRole/${context.practitionerRoleId}` }, onBehalfOf: { reference: `Organization/${admission.organizationId}` } }], note: [{ text: input.note }] })
      effects.push({ kind: 'created', reference: `Procedure/${id}`, versionId: '1' })
      const common = { admissionId: admission.id, organizationId: admission.organizationId, serviceDate: businessDate(now), virtualTime: now }
      this.owner.billing.record(context, { ...common, kind: 'surgery', sourceId: id, amountFen: actual.chargeDefinition.priceFen, label: actual.coding.display }, effects)
      for (const material of materials) this.owner.billing.record(context, { ...common, kind: 'material', sourceId: material.id, amountFen: material.amountFen, label: material.item.display }, effects)
      this.owner.database.driver.prepare("UPDATE inpatient_surgery_request SET status='completed',version=version+1 WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?")
        .run(context.workspaceId, context.epoch, row.request_id, row.version)
      this.updateRequestProjection(context, row.request_id, 'completed', effects)
      return { data: this.read(context, admission.id), effects }
    })
  }
  start(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryStartInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.start', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const admission = this.owner.orders.assertAdmitted(context, input.admissionId), row = this.currentRequest(context, input)
      if (row.status !== 'ready' || row.preop_check_json === null || row.consent_confirmation_json === null)
        throw new InpatientError('INPATIENT_SURGERY_NOT_READY', '术前检查核对与已签署知情同意确认均须完成')
      if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '本手术已开始，请继续原手术')
      const actual = this.procedure(context, input.procedureId, input.catalogVersion), id = uuidv7(), now = this.owner.virtualTime(context)
      this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_execution
        (workspace_id,epoch,execution_id,request_id,admission_id,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'in-progress')`).run(context.workspaceId, context.epoch, id, row.request_id, admission.id,
          JSON.stringify(actual), now, context.actorId, context.practitionerRoleId!, admission.organizationId, input.note)
      this.owner.fhir.createProjection(context, { resourceType: 'Procedure', id, status: 'in-progress',
        code: { coding: [clinicalCoding(actual.coding)], text: actual.coding.display }, subject: { reference: `Patient/${admission.patientId}` },
        encounter: { reference: `Encounter/${admission.id}` }, basedOn: [{ reference: `ServiceRequest/${row.request_id}` }], occurrenceDateTime: now,
        recorded: now, performer: [{ actor: { reference: `PractitionerRole/${context.practitionerRoleId}` } }], note: [{ text: input.note }] })
      const effects: InpatientEffects = [{ kind: 'created', reference: `Procedure/${id}`, versionId: '1' }]
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
  private executionForRequest(context: ActorContext, requestId: string) {
    return executionRowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND request_id=?').get(context.workspaceId, context.epoch, requestId))
  }
  private advanceRequest(context: ActorContext, row: z.infer<typeof requestRowSchema>, effects: InpatientEffects) {
    this.owner.database.driver.prepare('UPDATE inpatient_surgery_request SET version=version+1 WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?')
      .run(context.workspaceId, context.epoch, row.request_id, row.version)
    effects.push({ kind: 'updated', reference: `InpatientSurgeryRequest/${row.request_id}`, versionId: String(row.version + 1) })
  }
  private writeMaterial(context: ActorContext, execution: z.infer<typeof executionRowSchema>, selection: z.infer<typeof inpatientSurgeryMaterialSelectionSchema>, note: string, effects: InpatientEffects) {
    const reservation = selection.reservationId === undefined ? undefined : z.object({ reservation_id: z.string(), material_id: z.string(), catalog_version: z.number(),
      request_id: z.string().nullable(), quantity: z.number(), consumed_quantity: z.number(), price_fen: z.number(), status: z.string(), version: z.number() }).optional()
      .parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
        .get(context.workspaceId, context.epoch, execution.admission_id, selection.reservationId))
    if (selection.reservationId !== undefined && !reservation) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
    if (reservation && (reservation.status !== 'reserved' || reservation.version !== selection.expectedReservationVersion
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
        WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?`).run(consumed, replaced ? 'replaced' : 'reserved', replaced ? id : null,
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
  private currentRequest(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    const row = requestRowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?').get(context.workspaceId, context.epoch, input.admissionId, input.requestId))
    if (!row) throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '未找到本次住院的手术申请', 404)
    if (row.version !== input.expectedRequestVersion || !['requested','ready'].includes(row.status)) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '手术申请状态或版本已变化')
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
