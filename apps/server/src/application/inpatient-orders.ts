import { inpatientPharmacyListSchema, inpatientPharmacySchema, inpatientPharmacyResponseSchema, inpatientChargesSchema, inpatientChargesResponseSchema, inpatientChargeReverseInputSchema, inpatientExecutionActionInputSchema, inpatientDispenseInputSchema, inpatientDiagnosisConfirmInputSchema, inpatientDiagnosisSchema, inpatientFullCatalogSchema, inpatientFullClinicalSchema, inpatientFullClinicalResponseSchema, inpatientOrderIssueInputSchema, inpatientOrderActionInputSchema, inpatientOrderReasonInputSchema, inpatientOrderSchema, inpatientExecutionSchema, inpatientDispenseSchema, inpatientChargeSchema, type InpatientOrder } from '@clinmesh/contracts/inpatient-clinical'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import type { ActorContext } from './command-executor.ts'
import { medicationDoseAndFrequencyAllowed } from './medication-rules.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'

export class InpatientOrders {
  constructor(readonly owner: InpatientService) {}
  catalog(context: ActorContext) {
    this.owner.assertRole(context, ['inpatient-doctor', 'ward-nurse'])
    const rows = z.array(z.object({ item_id: z.string(), code_system: z.string(), code: z.string(), name_zh: z.string(), version: z.number() })).parse(
      this.owner.database.driver.prepare('SELECT * FROM diagnosis_catalog WHERE workspace_id=? AND epoch=? AND active=1 ORDER BY item_id').all(context.workspaceId, context.epoch))
    return inpatientFullCatalogSchema.parse({ ...this.medicationsAndServices(context), diagnoses: rows.map(row => ({ id: row.item_id, system: row.code_system, code: row.code, display: row.name_zh, version: String(row.version), sourceLocator: 'operational:diagnosis_catalog' })) })
  }
  medications(context: ActorContext, ids?: string[]) {
    const medications = z.array(z.object({ item_id: z.string(), name_zh: z.string(), version: z.number(), price_fen: z.number(), config_json: z.string() })).parse(this.owner.database.driver.prepare(
      `SELECT * FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND kind='medication' AND active=1 AND json_type(config_json,'$.inpatientDoses')='array' ${ids === undefined ? '' : `AND item_id IN (${ids.map(() => '?').join(',') || 'NULL'})`}`).all(context.workspaceId, context.epoch, ...(ids ?? [])))
    return medications.map(row => {
      const config = medicationConfigSchema.parse(JSON.parse(row.config_json))
      return { id: row.item_id, display: row.name_zh, version: row.version, priceFen: row.price_fen, unit: config.unit, doses: config.inpatientDoses,
        frequencyCodes: config.allowedFrequencyCodes.filter(code => ['QD','BID','PRN'].includes(code)),
        lots: z.array(z.object({ lot_id: z.string(), version: z.number(), quantity_on_hand: z.number(), expires_on: z.string() })).parse(this.owner.database.driver.prepare(
          'SELECT * FROM inventory_lot WHERE workspace_id=? AND epoch=? AND medication_id=? AND location_id=? AND expires_on>=? AND quantity_on_hand>0 ORDER BY expires_on,lot_id')
          .all(context.workspaceId, context.epoch, row.item_id, context.roleCode === 'pharmacist' ? context.locationId ?? '' : 'location-pharmacist', businessDate(this.owner.virtualTime(context))))
          .map(lot => ({ id: lot.lot_id, version: lot.version, quantityOnHand: lot.quantity_on_hand, expiresOn: lot.expires_on })) }
    })
  }
  medicationsAndServices(context: ActorContext) {
    const services = z.array(z.object({ service_id: z.string(), name_zh: z.string(), version: z.number(), config_json: z.string() })).parse(this.owner.database.driver.prepare(
      "SELECT * FROM hospital_service_catalog WHERE workspace_id=? AND epoch=? AND active=1 AND json_extract(config_json,'$.inpatientBillingTrigger')='execution'").all(context.workspaceId, context.epoch))
    return { medications: this.medications(context), services: services.map(row => { const config = serviceConfigSchema.parse(JSON.parse(row.config_json));
      return { id: row.service_id, display: row.name_zh, version: row.version, priceFen: config.chargeDefinition.priceFen, unit: config.billingUnit.display } }) }
  }
  orderFacts(context: ActorContext, admissionId: string, medicationOnly = false) {
    const rows = z.array(orderRowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_order WHERE workspace_id=? AND epoch=? AND admission_id=? ${medicationOnly ? "AND kind='medication'" : ''} ORDER BY julianday(signed_at),order_id`)
      .all(context.workspaceId, context.epoch, admissionId))
    const orders = rows.map(row => this.orderDto(context, row))
    const executions = z.array(executionRowSchema).parse(this.owner.database.driver.prepare(`SELECT e.* FROM inpatient_execution e JOIN inpatient_order o
      ON o.workspace_id=e.workspace_id AND o.epoch=e.epoch AND o.order_id=e.order_id WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? ${medicationOnly ? "AND o.kind='medication'" : ''} ORDER BY julianday(e.scheduled_for),e.execution_id`)
      .all(context.workspaceId, context.epoch, admissionId)).map(row => inpatientExecutionSchema.parse({ id: row.execution_id, orderId: row.order_id,
        scheduledFor: row.scheduled_for, status: row.status, version: row.version, ...(row.administration_id === null ? {} : { administrationId: row.administration_id }), ...(row.reason === null ? {} : { reason: row.reason }) }))
    const dispenses = z.array(z.object({ dispense_id: z.string(), execution_id: z.string(), lot_id: z.string(), quantity: z.number(), dispensed_at: z.string(), dispensed_by: z.string() })).parse(this.owner.database.driver.prepare(`SELECT d.* FROM inpatient_dispense d JOIN inpatient_execution e ON e.workspace_id=d.workspace_id AND e.epoch=d.epoch AND e.execution_id=d.execution_id
      JOIN inpatient_order o ON o.workspace_id=e.workspace_id AND o.epoch=e.epoch AND o.order_id=e.order_id WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? ${medicationOnly ? "AND o.kind='medication'" : ''} ORDER BY julianday(d.dispensed_at),d.dispense_id`)
      .all(context.workspaceId, context.epoch, admissionId)).map(row => inpatientDispenseSchema.parse({ id: row.dispense_id, executionId: row.execution_id, lotId: row.lot_id, quantity: row.quantity, dispensedAt: row.dispensed_at, dispensedBy: row.dispensed_by }))
    return { orders, executions, dispenses }
  }
  chargeFacts(context: ActorContext, admissionId: string) {
    const charges = z.array(z.object({ charge_id: z.string(), kind: z.string(), source_id: z.string(), organization_id: z.string(), service_date: z.string(), amount_fen: z.number(), virtual_time: z.string(), version: z.number(), reversal_of: z.string().nullable(), reason: z.string().nullable() })).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_charge WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY julianday(virtual_time),charge_id').all(context.workspaceId, context.epoch, admissionId))
      .map(row => inpatientChargeSchema.parse({ id: row.charge_id, label: z.object({ text: z.string().min(1) }).parse(this.owner.fhir.read(context, 'ChargeItem', row.charge_id).code).text, kind: row.kind, sourceId: row.source_id, organizationId: row.organization_id, serviceDate: row.service_date, amountFen: row.amount_fen,
        virtualTime: row.virtual_time, version: row.version, ...(row.reversal_of === null ? {} : { reversalOf: row.reversal_of }), ...(row.reason === null ? {} : { reason: row.reason }) }))
    return { charges, chargesFen: charges.reduce((sum, charge) => sum + charge.amountFen, 0) }
  }
  facts(context: ActorContext, admissionId: string) {
    return { ...this.orderFacts(context, admissionId), ...this.chargeFacts(context, admissionId) }
  }
  pharmacyAdmission(context: ActorContext, admissionId: string) {
    const { row } = this.owner.admissionBinding(context, admissionId)
    const patient = this.owner.fhir.read(context, 'Patient', row.patient_id)
    const names = z.array(z.object({ text: z.string().optional() })).optional().parse(patient.name)
    return { admissionId, patientId: row.patient_id, patientName: names?.[0]?.text ?? row.patient_id,
      inpatientNumber: row.inpatient_number, wardId: row.ward_id, status: row.status }
  }
  pharmacyList(context: ActorContext) {
    this.owner.assertRole(context, ['pharmacist'])
    const rows = z.array(z.object({ admission_id: z.string() })).parse(this.owner.database.driver.prepare(`SELECT a.admission_id FROM inpatient_admission a
      WHERE a.workspace_id=? AND a.epoch=? AND EXISTS (SELECT 1 FROM inpatient_order o WHERE o.workspace_id=a.workspace_id AND o.epoch=a.epoch AND o.admission_id=a.admission_id AND o.kind='medication')
      ORDER BY julianday(a.registered_at),a.admission_id`).all(context.workspaceId, context.epoch))
    return inpatientPharmacyListSchema.parse({ items: rows.map(row => this.pharmacyAdmission(context, row.admission_id)) })
  }
  pharmacy(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['pharmacist'])
    const admission = this.pharmacyAdmission(context, admissionId), facts = this.orderFacts(context, admissionId, true)
    const allergies = this.owner.fhir.search(context, 'AllergyIntolerance', new URLSearchParams({ patient: `Patient/${admission.patientId}`, _count: '100' })).resources
    const medicationAllergies = allergies.filter(resource => { const allergy = allergySchema.parse(resource)
      return allergy.category?.includes('medication') && allergy.clinicalStatus?.coding?.some(item => item.code === 'active') && allergy.verificationStatus?.coding?.some(item => item.code === 'confirmed')
    }).map(resource => {
      const code = z.object({ text: z.string().optional(), coding: z.array(z.object({ code: z.string(), display: z.string().optional() })).optional() }).parse(resource.code)
      return { id: resource.id, display: code.text ?? code.coding?.[0]?.display ?? code.coding?.[0]?.code ?? '药物过敏' }
    })
    return inpatientPharmacySchema.parse({ admission, ...facts,
      executions: facts.executions.map(({ administrationId: _administration, ...execution }) => execution),
      medications: this.medications(context, [...new Set(facts.orders.map(order => order.catalogItemId))]).map(({ id, display, unit, lots }) => ({ id, display, unit, lots })), medicationAllergies })
  }
  charges(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['cashier'])
    const admission = this.owner.admissionBinding(context, admissionId)
    return inpatientChargesSchema.parse({ admissionId, financialStatus: admission.financialStatus, ...this.chargeFacts(context, admissionId) })
  }
  orderDto(context: ActorContext, row: OrderRow): InpatientOrder {
    const postoperative = z.object({ surgery_execution_id: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT surgery_execution_id FROM inpatient_postoperative_order WHERE workspace_id=? AND epoch=? AND order_id=?').get(context.workspaceId, context.epoch, row.order_id))
    return inpatientOrderSchema.parse({ id: row.order_id, admissionId: row.admission_id, kind: row.kind, duration: row.duration, catalogItemId: row.catalog_item_id,
      catalogVersion: row.catalog_version, display: row.display, doseText: row.dose_text, doseQuantity: row.dose_quantity, unit: row.unit, frequencyCode: row.frequency_code,
      state: row.state, version: row.version, requestVersion: this.owner.fhir.read(context, row.kind === 'medication' ? 'MedicationRequest' : 'ServiceRequest', row.order_id).meta!.versionId,
      ...(postoperative === undefined ? {} : { surgeryExecutionId: postoperative.surgery_execution_id }),
      signedAt: row.signed_at, signedBy: row.signed_by, organizationId: row.organization_id,
      ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }), ...(row.stopped_at === null ? {} : { stoppedAt: row.stopped_at }) })
  }
  order(context: ActorContext, admissionId: string, orderId: string) {
    const row = orderRowSchema.optional().parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_order WHERE workspace_id=? AND epoch=? AND admission_id=? AND order_id=?')
      .get(context.workspaceId, context.epoch, admissionId, orderId))
    if (row === undefined) throw new InpatientError('INPATIENT_ORDER_NOT_FOUND', '未找到本次住院的医嘱', 404)
    return row
  }
  assertAdmitted(context: ActorContext, admissionId: string) {
    const admission = this.owner.admissionBinding(context, admissionId)
    if (admission.status !== 'admitted') throw new InpatientError('INPATIENT_STATE_CONFLICT', '仅在院且未办理出院的住院可以操作医嘱')
    return admission
  }
  issue(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientOrderIssueInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.order.issue',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      const admission = this.assertAdmitted(context, input.admissionId)
      if (input.surgeryExecutionId !== undefined) this.owner.surgery.assertExecution(context, admission.id, input.surgeryExecutionId)
      const selection = input.selection, catalog = this.catalog(context)
      let itemId: string, display: string, catalogVersion: number, unit: string, price: number, doseText = '', frequency: 'QD' | 'BID' | 'PRN' = 'QD', quantity: number
      if (selection.kind === 'medication') {
        const item = catalog.medications.find(item => item.id === selection.catalogItemId)
        if (item === undefined || item.version !== selection.catalogVersion) throw new InpatientError('CATALOG_CONFLICT', '住院药品目录或版本无效')
        const config = medicationConfigSchema.parse(JSON.parse(z.object({ config_json: z.string() }).parse(this.owner.database.driver.prepare(
          'SELECT config_json FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=?').get(context.workspaceId, context.epoch, item.id)).config_json))
        if (!config.availableScopes.includes('inpatient') || !medicationDoseAndFrequencyAllowed(config, selection.doseText, selection.frequencyCode)
          || !config.inpatientDoses.some(dose => dose.doseText === selection.doseText && dose.quantity === selection.doseQuantity)) throw new InpatientError('CATALOG_CONFLICT', '剂量、频次或每次片数不符合住院目录')
        const diagnoses = this.diagnosis(context, admission.id).entries
        if (!diagnoses.some(entry => entry.coding.sourceLocator === 'operational:diagnosis_catalog'
          ? config.allowedDiagnosisCatalogItemIds.includes(entry.coding.id)
          : config.inpatientIndications.some(indication => indication.id === entry.coding.id && indication.system === entry.coding.system && indication.version === entry.coding.version && indication.code === entry.coding.code && indication.sourceLocator === entry.coding.sourceLocator))) throw new InpatientError('CATALOG_CONFLICT', '本次住院确诊不符合药品适应症')
        const allergies = this.owner.fhir.search(context, 'AllergyIntolerance', new URLSearchParams({ patient: `Patient/${admission.patientId}`, _count: '100' })).resources
        const code = z.object({ code: z.string() }).parse(this.owner.database.driver.prepare('SELECT code FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=?').get(context.workspaceId, context.epoch, item.id)).code
        if (allergies.some(allergy => { const value = allergySchema.parse(allergy); return value.category?.includes('medication') && value.clinicalStatus?.coding?.some(c => c.code === 'active')
          && value.verificationStatus?.coding?.some(c => c.code === 'confirmed') && value.code?.coding?.some(c => c.code === code) })) throw new InpatientError('CATALOG_CONFLICT', '药品与已确认的有效药物过敏冲突')
        const active = this.facts(context, admission.id).orders.filter(order => order.kind === 'medication' && !['stopped','completed'].includes(order.state))
        for (const other of active) {
          const otherConfig = medicationConfigSchema.parse(JSON.parse(z.object({ config_json: z.string() }).parse(this.owner.database.driver.prepare('SELECT config_json FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=?').get(context.workspaceId, context.epoch, other.catalogItemId)).config_json))
          if (other.catalogItemId === item.id || !config.allowedCombinationIds.includes(other.catalogItemId) || !otherConfig.allowedCombinationIds.includes(item.id)) throw new InpatientError('CATALOG_CONFLICT', '现有有效药品医嘱不允许此药品组合')
        }
        itemId = item.id
        display = item.display
        catalogVersion = item.version
        unit = item.unit
        price = item.priceFen
        doseText = selection.doseText
        frequency = selection.frequencyCode
        quantity = selection.doseQuantity
      } else {
        const item = catalog.services.find(item => item.id === selection.serviceId)
        if (item === undefined || item.version !== selection.serviceVersion) throw new InpatientError('CATALOG_CONFLICT', '住院服务目录或版本无效')
        itemId = item.id
        display = item.display
        catalogVersion = item.version
        unit = item.unit
        price = item.priceFen
        quantity = selection.quantity
      }
      const id = uuidv7(), now = this.owner.virtualTime(context)
      this.owner.database.driver.prepare(`INSERT INTO inpatient_order(workspace_id,epoch,order_id,admission_id,kind,duration,catalog_item_id,catalog_version,display,dose_text,dose_quantity,unit,frequency_code,price_fen,state,organization_id,signed_at,signed_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'signed',?,?,?)`).run(context.workspaceId, context.epoch, id, admission.id, selection.kind, input.duration, itemId, catalogVersion, display, doseText, quantity, unit, frequency, price, admission.organizationId, now, context.actorId)
      if (input.surgeryExecutionId !== undefined) this.owner.database.driver.prepare('INSERT INTO inpatient_postoperative_order VALUES(?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, admission.id, id, input.surgeryExecutionId)
      const request = this.owner.fhir.create(context, { resourceType: selection.kind === 'medication' ? 'MedicationRequest' : 'ServiceRequest', id, status: 'active', intent: 'order',
        ...(selection.kind === 'medication' ? { medication: { reference: { reference: `Medication/${itemId}`, display } }, dosageInstruction: [{ text: `${doseText} ${frequency}；每次${quantity}${unit}` }] }
          : { code: { concept: { text: display } }, quantityQuantity: { value: quantity, unit } }),
        ...(input.surgeryExecutionId === undefined ? {} : selection.kind === 'medication'
          ? { supportingInformation: [{ reference: `Procedure/${input.surgeryExecutionId}` }] }
          : { supportingInfo: [{ reference: { reference: `Procedure/${input.surgeryExecutionId}` } }] }),
        subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, authoredOn: now, requester: { reference: `PractitionerRole/${context.practitionerRoleId}` } })
      return { data: this.read(context, admission.id), effects: [{ kind: 'created' as const, reference: `${request.resourceType}/${id}`, versionId: '1' }] }
    })
  }
  action(context: ActorContext, raw: unknown, idempotencyKey: string, action: 'verify' | 'request-stop' | 'verify-stop') {
    const input = (action === 'request-stop' ? inpatientOrderReasonInputSchema : inpatientOrderActionInputSchema).parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: `inpatient.order.${action}`, expectedVersions: {},
      dataSchema: inpatientFullClinicalResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, action === 'request-stop' ? ['inpatient-doctor'] : ['ward-nurse']) }, () => {
      this.assertAdmitted(context, input.admissionId)
      const row = this.order(context, input.admissionId, input.orderId)
      const stateAllowsAction = action === 'verify' ? row.state === 'signed'
        : action === 'request-stop' ? ['signed','verified'].includes(row.state) : row.state === 'stop-requested'
      if (row.version !== input.expectedOrderVersion || !stateAllowsAction) {
        throw new InpatientError('INPATIENT_ORDER_CONFLICT', '医嘱状态或版本已变化')
      }
      const now = this.owner.virtualTime(context), state = action === 'verify' ? 'verified' : action === 'request-stop' ? 'stop-requested' : 'stopped'
      this.owner.database.driver.prepare(`UPDATE inpatient_order SET state=?,version=version+1,
        verified_at=CASE WHEN ?='verify' THEN ? ELSE verified_at END,stopped_at=CASE WHEN ?='request-stop' THEN ? ELSE stopped_at END WHERE workspace_id=? AND epoch=? AND order_id=? AND version=?`)
        .run(state, action, now, action, now, context.workspaceId, context.epoch, row.order_id, row.version)
      if (action !== 'request-stop') this.owner.database.driver.prepare('INSERT INTO inpatient_order_verification VALUES(?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, row.order_id, action, row.version, context.actorId, context.practitionerRoleId, now)
      const request = this.owner.fhir.read(context, row.kind === 'medication' ? 'MedicationRequest' : 'ServiceRequest', row.order_id)
      const updated = this.owner.fhir.update(context, { ...request, status: action === 'verify-stop' ? (row.kind === 'medication' ? 'stopped' : 'revoked') : 'active',
        extension: [{ url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/inpatient-order-state', valueCode: state }],
        ...('reason' in input ? { note: [...(Array.isArray(request.note) ? request.note : []), { text: input.reason }] } : {}) }, request.meta!.versionId!)
      const effects: Effects = [{ kind: 'updated', reference: `${request.resourceType}/${row.order_id}`, versionId: updated.meta!.versionId! }]
      if (action === 'verify') {
        const fresh = this.order(context, input.admissionId, row.order_id)
        if (row.duration === 'temporary' && row.frequency_code !== 'PRN') this.createExecution(context, fresh, now, undefined, effects)
        else this.expandOrder(context, fresh, now, now, effects)
      }
      if (action === 'verify-stop') {
        const pending = z.array(executionRowSchema).parse(this.owner.database.driver.prepare("SELECT * FROM inpatient_execution WHERE workspace_id=? AND epoch=? AND order_id=? AND status IN ('pending','dispensed')").all(context.workspaceId, context.epoch, row.order_id))
        for (const execution of pending) this.updateExecution(context, execution, 'cancelled', effects)
      }
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  createExecution(context: ActorContext, order: OrderRow, time: string, reason: string | undefined, effects: Effects) {
    if (this.owner.database.driver.prepare('SELECT 1 FROM inpatient_execution WHERE workspace_id=? AND epoch=? AND order_id=? AND scheduled_for=?').get(context.workspaceId, context.epoch, order.order_id, time)) return
    const id = uuidv7()
    this.owner.database.driver.prepare("INSERT INTO inpatient_execution(workspace_id,epoch,execution_id,order_id,scheduled_for,status,reason) VALUES(?,?,?,?,?,'pending',?)").run(context.workspaceId, context.epoch, id, order.order_id, time, reason ?? null)
    this.owner.fhir.create(context, { resourceType: 'Task', id, status: 'ready', intent: 'order',
      focus: { reference: `${order.kind === 'medication' ? 'MedicationRequest' : 'ServiceRequest'}/${order.order_id}` }, for: z.object({ reference: z.string() }).parse(this.owner.fhir.read(context, 'Encounter', order.admission_id).subject),
      restriction: { period: { start: time } }, ...(reason === undefined ? {} : { description: reason }) })
    effects.push({ kind: 'created', reference: `Task/${id}`, versionId: '1' })
  }
  updateExecution(context: ActorContext, row: ExecutionRow, status: 'dispensed' | 'completed' | 'cancelled', effects: Effects, administrationId?: string) {
    const updated = this.owner.database.driver.prepare('UPDATE inpatient_execution SET status=?,version=version+1,administration_id=? WHERE workspace_id=? AND epoch=? AND execution_id=? AND version=?')
      .run(status, administrationId ?? null, context.workspaceId, context.epoch, row.execution_id, row.version)
    if (updated.changes !== 1) throw new InpatientError('INPATIENT_EXECUTION_CONFLICT', '执行单版本已变化')
    const task = this.owner.fhir.read(context, 'Task', row.execution_id)
    const resource = this.owner.fhir.update(context, { ...task, status: status === 'dispensed' ? 'in-progress' : status }, String(row.version))
    effects.push({ kind: 'updated', reference: `Task/${row.execution_id}`, versionId: resource.meta!.versionId! })
  }
  expandOrder(context: ActorContext, order: OrderRow, from: string, through: string, effects: Effects) {
    if (order.duration !== 'long' || order.frequency_code === 'PRN' || order.state !== 'verified' || order.verified_at === null) return
    const first = Math.floor((Date.parse(from) + 28800000) / 86400000), last = Math.floor((Date.parse(through) + 28800000) / 86400000)
    for (let day = first; day <= last; day += 1) for (const hour of order.frequency_code === 'BID' ? [8,20] : [8]) {
      const time = day * 86400000 + hour * 3600000 - 28800000
      if (time >= Date.parse(order.verified_at)) this.createExecution(context, order, new Date(time).toISOString(), undefined, effects)
    }
  }
  execution(context: ActorContext, admissionId: string, executionId: string) {
    const row = executionRowSchema.optional().parse(this.owner.database.driver.prepare(`SELECT e.* FROM inpatient_execution e JOIN inpatient_order o
      ON o.workspace_id=e.workspace_id AND o.epoch=e.epoch AND o.order_id=e.order_id WHERE e.workspace_id=? AND e.epoch=? AND e.execution_id=? AND o.admission_id=?`)
      .get(context.workspaceId, context.epoch, executionId, admissionId))
    if (row === undefined) throw new InpatientError('INPATIENT_EXECUTION_NOT_FOUND', '未找到本次住院的执行单', 404)
    return row
  }
  dispense(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDispenseInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.execution.dispense', expectedVersions: {}, dataSchema: inpatientPharmacyResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['pharmacist']) }, transaction => {
      const admission = this.assertAdmitted(context, input.admissionId), execution = this.execution(context, admission.id, input.executionId), order = this.order(context, admission.id, execution.order_id)
      if (order.kind !== 'medication' || order.state !== 'verified' || execution.status !== 'pending' || execution.version !== input.expectedExecutionVersion) throw new InpatientError('INPATIENT_EXECUTION_CONFLICT', '医嘱未校对、已停嘱或执行单版本已变化')
      if (!context.locationId || new Set(input.lotSelections.map(lot => lot.lotId)).size !== input.lotSelections.length || input.lotSelections.reduce((sum,lot) => sum + lot.quantity, 0) !== order.dose_quantity) throw new InpatientError('INPATIENT_DISPENSE_CONFLICT', '发药批次不能重复，合计必须等于本次所需片数')
      const now = this.owner.virtualTime(context), effects: Effects = []
      for (const selection of input.lotSelections) {
        const lot = z.object({ medication_id: z.string(), location_id: z.string(), expires_on: z.string(), quantity_on_hand: z.number(), version: z.number() }).optional().parse(this.owner.database.driver.prepare('SELECT * FROM inventory_lot WHERE workspace_id=? AND epoch=? AND lot_id=?').get(context.workspaceId, context.epoch, selection.lotId))
        if (!lot || lot.medication_id !== order.catalog_item_id || lot.location_id !== context.locationId || lot.version !== selection.expectedVersion || lot.quantity_on_hand < selection.quantity || lot.expires_on < businessDate(now)) throw new InpatientError('INPATIENT_STOCK_CONFLICT', '批次药品、库位、效期、数量或版本不可用')
        const changed = this.owner.database.driver.prepare(`UPDATE inventory_lot SET quantity_on_hand=quantity_on_hand-?,version=version+1 WHERE workspace_id=? AND epoch=? AND lot_id=? AND medication_id=? AND location_id=? AND version=? AND quantity_on_hand>=? AND expires_on>=?`)
          .run(selection.quantity, context.workspaceId, context.epoch, selection.lotId, order.catalog_item_id, context.locationId, selection.expectedVersion, selection.quantity, businessDate(now))
        if (changed.changes !== 1) throw new InpatientError('INPATIENT_STOCK_CONFLICT', '库存已被其他操作修改')
        const inventory = transaction.fhir.read(context, 'InventoryItem', selection.lotId)
        transaction.fhir.updateProjection(context, { ...inventory, netContent: { ...z.object({}).passthrough().parse(inventory.netContent), value: lot.quantity_on_hand - selection.quantity } }, String(selection.expectedVersion))
        const id = uuidv7()
        transaction.fhir.create(context, { resourceType: 'MedicationDispense', id, status: 'completed', medication: { reference: { reference: `Medication/${order.catalog_item_id}` } },
          subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, authorizingPrescription: [{ reference: `MedicationRequest/${order.order_id}` }],
          performer: [{ actor: { reference: `PractitionerRole/${context.practitionerRoleId}` } }], location: { reference: `Location/${context.locationId}` }, quantity: { value: selection.quantity, unit: order.unit }, whenPrepared: now, whenHandedOver: now })
        this.owner.database.driver.prepare('INSERT INTO inpatient_dispense VALUES(?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, id, execution.execution_id, selection.lotId, selection.quantity, now, context.actorId)
        const movementId = uuidv7()
        this.owner.database.driver.prepare('INSERT INTO inventory_movement(workspace_id,epoch,movement_id,inpatient_dispense_id,lot_id,quantity,occurred_at) VALUES(?,?,?,?,?,?,?)')
          .run(context.workspaceId, context.epoch, movementId, id, selection.lotId, selection.quantity, now)
        effects.push({ kind: 'created', reference: `MedicationDispense/${id}`, versionId: '1' }, { kind: 'created', reference: `InventoryMovement/${movementId}`, versionId: '1' }, { kind: 'updated', reference: `InventoryItem/${selection.lotId}`, versionId: String(selection.expectedVersion + 1) })
        this.owner.billing.record(context, { admissionId: admission.id, organizationId: admission.organizationId, kind: 'medication', sourceId: id, serviceDate: businessDate(now), amountFen: order.price_fen * selection.quantity, virtualTime: now, label: `${order.display} ${selection.quantity}${order.unit}` }, effects)
      }
      this.updateExecution(context, execution, 'dispensed', effects)
      return { data: this.pharmacy(context, admission.id), effects }
    })
  }
  administer(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientExecutionActionInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.execution.administer', expectedVersions: {}, dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['ward-nurse']) }, () => {
      const admission = this.assertAdmitted(context, input.admissionId), execution = this.execution(context, admission.id, input.executionId), order = this.order(context, admission.id, execution.order_id), now = this.owner.virtualTime(context)
      if (order.kind !== 'medication' || order.state !== 'verified' || execution.status !== 'dispensed' || execution.version !== input.expectedExecutionVersion || Date.parse(execution.scheduled_for) > Date.parse(now)) throw new InpatientError('INPATIENT_EXECUTION_CONFLICT', '给药须引用已校对、已发药且到期的有效执行单')
      const supplies = this.facts(context, admission.id).dispenses.filter(item => item.executionId === execution.execution_id)
      if (supplies.reduce((sum,item) => sum + item.quantity, 0) !== order.dose_quantity) throw new InpatientError('INPATIENT_DISPENSE_CONFLICT', '实际发药量不足本次给药')
      const id = uuidv7(), effects: Effects = []
      this.owner.fhir.create(context, { resourceType: 'MedicationAdministration', id, status: 'completed', medication: { reference: { reference: `Medication/${order.catalog_item_id}` } },
        subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, request: { reference: `MedicationRequest/${order.order_id}` },
        partOf: supplies.map(supply => ({ reference: `MedicationDispense/${supply.id}` })), occurenceDateTime: now, recorded: now,
        performer: [{ actor: { reference: { reference: `PractitionerRole/${context.practitionerRoleId}` } } }], dosage: { text: order.dose_text, dose: { value: order.dose_quantity, unit: order.unit } } })
      effects.push({ kind: 'created', reference: `MedicationAdministration/${id}`, versionId: '1' })
      this.updateExecution(context, execution, 'completed', effects, id)
      this.completeTemporaryOrder(context, order, effects)
      return { data: this.read(context, admission.id), effects }
    })
  }
  completeService(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientExecutionActionInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.execution.complete', expectedVersions: {}, dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['ward-nurse']) }, () => {
      const admission = this.assertAdmitted(context, input.admissionId), execution = this.execution(context, admission.id, input.executionId), order = this.order(context, admission.id, execution.order_id), now = this.owner.virtualTime(context)
      if (order.kind !== 'service' || order.state !== 'verified' || execution.status !== 'pending' || execution.version !== input.expectedExecutionVersion || Date.parse(execution.scheduled_for) > Date.parse(now)) throw new InpatientError('INPATIENT_EXECUTION_CONFLICT', '服务须引用已校对且到期的有效执行单')
      const effects: Effects = []
      this.updateExecution(context, execution, 'completed', effects)
      this.owner.billing.record(context, { admissionId: admission.id, organizationId: admission.organizationId, kind: 'service', sourceId: execution.execution_id, serviceDate: businessDate(now), amountFen: order.price_fen * order.dose_quantity, virtualTime: now, label: order.display }, effects)
      this.completeTemporaryOrder(context, order, effects)
      return { data: this.read(context, admission.id), effects }
    })
  }
  reverseCharge(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientChargeReverseInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.charge.reverse', expectedVersions: {}, dataSchema: inpatientChargesResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      const admission = this.owner.detail(context, input.admissionId).admission
      const charge = this.chargeFacts(context, admission.id).charges.find(item => item.id === input.chargeId)
      if (admission.financialStatus !== 'open' || !charge || charge.version !== input.expectedChargeVersion || charge.reversalOf !== undefined
        || this.chargeFacts(context, admission.id).charges.some(item => item.reversalOf === charge.id)) throw new InpatientError('INPATIENT_CHARGE_CONFLICT', '账目已结算、版本已变化或该费用已冲正')
      const id = uuidv7(), now = this.owner.virtualTime(context)
      this.owner.database.driver.prepare(`INSERT INTO inpatient_charge(workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time,reversal_of,reason)
        VALUES(?,?,?,?,?,'reversal',?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, id, admission.id, charge.organizationId, charge.id, businessDate(now), -charge.amountFen, now, charge.id, input.reason)
      this.owner.fhir.create(context, { resourceType: 'ChargeItem', id, status: 'billable', code: { text: `费用冲正：${input.reason}` }, partOf: [{ reference: `ChargeItem/${charge.id}` }],
        subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, account: [{ reference: `Account/${admission.id}` }], occurrenceDateTime: now,
        totalPriceComponent: { amount: { value: -charge.amountFen / 100, currency: 'CNY' } } })
      return { data: this.charges(context, admission.id), effects: [{ kind: 'created' as const, reference: `ChargeItem/${id}`, versionId: '1' }] }
    })
  }
  requestPrn(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientOrderReasonInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.execution.request-prn', expectedVersions: {}, dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['ward-nurse']) }, () => {
      this.assertAdmitted(context, input.admissionId)
      const order = this.order(context, input.admissionId, input.orderId), now = this.owner.virtualTime(context)
      if (order.state !== 'verified' || order.frequency_code !== 'PRN' || order.version !== input.expectedOrderVersion) throw new InpatientError('INPATIENT_ORDER_CONFLICT', 'PRN任务须引用已校对的有效医嘱')
      if (order.duration === 'temporary' && this.owner.database.driver.prepare('SELECT 1 FROM inpatient_execution WHERE workspace_id=? AND epoch=? AND order_id=?').get(context.workspaceId, context.epoch, order.order_id)) throw new InpatientError('INPATIENT_ORDER_CONFLICT', '临时PRN医嘱只能形成一次执行任务')
      if(this.owner.database.driver.prepare('SELECT 1 FROM inpatient_execution WHERE workspace_id=? AND epoch=? AND order_id=? AND julianday(scheduled_for)=julianday(?)').get(context.workspaceId,context.epoch,order.order_id,now)) throw new InpatientError('INPATIENT_ORDER_CONFLICT','该虚拟时点已有PRN执行任务')
      const effects: Effects = []
      this.createExecution(context, order, now, input.reason, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  completeTemporaryOrder(context: ActorContext, order: OrderRow, effects: Effects) {
    if (order.duration !== 'temporary') return
    this.owner.database.driver.prepare("UPDATE inpatient_order SET state='completed',version=version+1 WHERE workspace_id=? AND epoch=? AND order_id=?").run(context.workspaceId, context.epoch, order.order_id)
    const request = this.owner.fhir.read(context, order.kind === 'medication' ? 'MedicationRequest' : 'ServiceRequest', order.order_id)
    const updated = this.owner.fhir.update(context, { ...request, status: 'completed' }, request.meta!.versionId!)
    effects.push({ kind: 'updated', reference: `${request.resourceType}/${order.order_id}`, versionId: updated.meta!.versionId! })
  }
  applyDueExecutions(context: ActorContext, from: string, through: string, effects: Effects) {
    const orders = z.array(orderRowSchema).parse(this.owner.database.driver.prepare(`SELECT o.* FROM inpatient_order o JOIN inpatient_admission a
      ON a.workspace_id=o.workspace_id AND a.epoch=o.epoch AND a.admission_id=o.admission_id WHERE o.workspace_id=? AND o.epoch=? AND o.state='verified' AND a.status='admitted'`).all(context.workspaceId, context.epoch))
    for (const order of orders) this.expandOrder(context, order, from, through, effects)
  }
  diagnosis(context: ActorContext, admissionId: string) {
    const revision = z.object({ revision: z.number() }).parse(this.owner.database.driver.prepare(
      'SELECT COALESCE(MAX(revision),0) revision FROM inpatient_diagnosis_confirmation WHERE workspace_id=? AND epoch=? AND admission_id=?')
      .get(context.workspaceId, context.epoch, admissionId)).revision
    const rows = z.array(z.object({ condition_id: z.string(), role: z.enum(['primary', 'secondary']), coding_json: z.string(), note: z.string().nullable(), admission_condition: z.enum(['1','2','3','4']), ordinal: z.number().int().positive() })).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_diagnosis_entry WHERE workspace_id=? AND epoch=? AND admission_id=? AND revision=? ORDER BY ordinal')
      .all(context.workspaceId, context.epoch, admissionId, revision))
    return inpatientDiagnosisSchema.parse({ revision, entries: rows.map(row => ({ conditionId: row.condition_id, role: row.role, admissionCondition: row.admission_condition, ordinal: row.ordinal, coding: JSON.parse(row.coding_json), ...(row.note === null ? {} : { note: row.note }) })) })
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    const admission = this.owner.detail(context, admissionId).admission
    return inpatientFullClinicalSchema.parse({ admissionId, encounterVersion: admission.versionId, diagnosis: this.diagnosis(context, admissionId), ...this.facts(context, admissionId) })
  }
  confirmDiagnosis(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDiagnosisConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.diagnosis.confirm',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      const admission = this.owner.detail(context, input.admissionId).admission
      if (admission.status !== 'admitted') throw new InpatientError('INPATIENT_STATE_CONFLICT', '仅在院患者可以确认诊断')
      const previous = this.diagnosis(context, input.admissionId)
      if (previous.revision !== input.expectedRevision) throw new InpatientError('INPATIENT_DIAGNOSIS_CONFLICT', '诊断确认版本已变化')
      const catalog = this.catalog(context).diagnoses
      const selected = input.entries.map(entry => {
        const reference = this.owner.referenceData.diagnosisById(context, entry.catalogItemId)
        const coding = reference === undefined ? catalog.find(item => item.id === entry.catalogItemId) : { id: reference.id, system: reference.system, version: reference.version, code: reference.code, display: reference.display, sourceLocator: reference.sourceLocator, releaseId: this.owner.referenceData.current().releaseId }
        if (coding === undefined) throw new InpatientError('CATALOG_CONFLICT', '诊断目录不存在或已停用')
        return { ...entry, coding }
      })
      const now = this.owner.virtualTime(context)
      const effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> = []
      for (const entry of previous.entries) {
        const existing = this.owner.fhir.read(context, 'Condition', entry.conditionId)
        const { clinicalStatus: _status, ...rest } = existing
        const updated = this.owner.fhir.update(context, { ...rest, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'entered-in-error' }] } }, existing.meta!.versionId!)
        effects.push({ kind: 'updated', reference: `Condition/${updated.id}`, versionId: updated.meta!.versionId! })
      }
      this.owner.database.driver.prepare('INSERT INTO inpatient_diagnosis_confirmation VALUES(?,?,?,?,?,?)').run(context.workspaceId, context.epoch, input.admissionId, previous.revision + 1, context.actorId, now)
      const entries = selected.map((entry,index) => {
        const condition = this.owner.fhir.create(context, { resourceType: 'Condition', id: uuidv7(),
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }],
          clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
          verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
          code: { coding: [{ system: entry.coding.system, version: entry.coding.version, code: entry.coding.code, display: entry.coding.display }], text: entry.coding.display },
          subject: { reference: `Patient/${admission.patientId}` }, encounter: { reference: `Encounter/${admission.id}` }, recordedDate: now,
          extension: [{ url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/inpatient-admission-condition', valueCode: entry.admissionCondition }],
          participant: [{ actor: { reference: `PractitionerRole/${context.practitionerRoleId}` } }], ...(entry.note === undefined ? {} : { note: [{ text: entry.note }] }) })
        this.owner.database.driver.prepare('INSERT INTO inpatient_diagnosis_entry VALUES(?,?,?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, admission.id, previous.revision + 1, condition.id, entry.role, JSON.stringify(entry.coding), entry.note ?? null, entry.admissionCondition, index+1)
        effects.push({ kind: 'created', reference: `Condition/${condition.id}`, versionId: '1' })
        return { condition: [{ reference: { reference: `Condition/${condition.id}` } }], use: [{ coding: [{ system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/encounter-diagnosis-role', code: entry.role }] }] }
      })
      const encounter = this.owner.fhir.read(context, 'Encounter', admission.id)
      const updated = this.owner.fhir.update(context, { ...encounter, diagnosis: entries }, input.encounterVersion)
      effects.push({ kind: 'updated', reference: `Encounter/${admission.id}`, versionId: updated.meta!.versionId! })
      return { data: this.read(context, admission.id), effects }
    })
  }
}

const medicationConfigSchema = z.object({ availableScopes: z.array(z.string()), unit: z.string(), inpatientDoses: z.array(z.object({ doseText: z.string(), quantity: z.number().int().positive() })),
  allowedDoseTexts: z.array(z.string()), allowedFrequencyCodes: z.array(z.string()), allowedCombinationIds: z.array(z.string()), allowedDiagnosisCatalogItemIds: z.array(z.string()), inpatientIndications: z.array(z.object({ id: z.string(), system: z.string(), version: z.string(), code: z.string(), sourceLocator: z.string() })), inpatientBillingTrigger: z.literal('dispense') })
const serviceConfigSchema = z.object({ billingUnit: z.object({ display: z.string() }), chargeDefinition: z.object({ priceFen: z.number().int().nonnegative() }), inpatientBillingTrigger: z.literal('execution') })
const allergySchema = z.object({ category: z.array(z.string()).optional(), clinicalStatus: z.object({ coding: z.array(z.object({ code: z.string() })).optional() }).optional(),
  verificationStatus: z.object({ coding: z.array(z.object({ code: z.string() })).optional() }).optional(), code: z.object({ coding: z.array(z.object({ code: z.string() })).optional() }).optional() })
const orderRowSchema = z.object({ order_id: z.string(), admission_id: z.string(), kind: z.enum(['medication','service']), duration: z.enum(['long','temporary']), catalog_item_id: z.string(), catalog_version: z.number(),
 display: z.string(), dose_text: z.string(), dose_quantity: z.number(), unit: z.string(), frequency_code: z.enum(['QD','BID','PRN']), price_fen: z.number(), state: inpatientOrderSchema.shape.state,
 version: z.number(), organization_id: z.string(), signed_at: z.string(), signed_by: z.string(), verified_at: z.string().nullable(), stopped_at: z.string().nullable() })
const executionRowSchema = z.object({ execution_id: z.string(), order_id: z.string(), scheduled_for: z.string(), status: inpatientExecutionSchema.shape.status, version: z.number(), administration_id: z.string().nullable(), reason: z.string().nullable() })
type OrderRow = z.infer<typeof orderRowSchema>
type ExecutionRow = z.infer<typeof executionRowSchema>
type Effects = Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }>
export function businessDate(time: string) { return new Date(Date.parse(time) + 28800000).toISOString().slice(0,10) }
