import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { groupDrgCase } from './drg-grouping.ts'
import type { DrgGroupingInput, DrgGroupingResult, DrgRules } from '@clinmesh/contracts/drg'
import type { inpatientOrderIssueInputSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgPregroupResultSchema, type InpatientDrgPregroupResult } from '@clinmesh/contracts/inpatient-drg'
import { inpatientRecordSnapshotSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema,
  inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema,
  type InpatientDrgSimulation, type InpatientDrgSimulationInput, type InpatientMaterialReservationList } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewCreateInputSchema, inpatientDrgPayerReviewSchema, inpatientDrgPayerReviewPreviewSchema,
  type InpatientDrgPayerReviewList } from '@clinmesh/contracts/inpatient-drg-payer'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext } from './command-executor.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { syntheticDrgPaymentParameters } from './scenario-data/drg-payment-parameters.ts'

const clinicalCodingNote = '病案首页为临床版编码（nhc-icd10-clinical@2022.r4），分组规则字典为医保版口径；'
  + '两套码同码直通，未同码的诊断/操作如实报告为无法入组，不做名称模糊映射。'

const coverageNote = '收费进度仅表达已发生收费净额占推演总额的比例，与成本覆盖不同；'
  + '合成医院支付参考与患者医保独立，缺少成本时不作完整盈亏结论，费用提示不自动调整治疗。'

const projectedNote = 'projected 为「若计划手术按当前计划实施」的推演分组，不构成临床事实或正式病组；'
  + '草稿与预留只参与计价对照，不改变分组。'

/** 年龄：以离院时点（无离院用入院时点）按日历周年计算整岁，天龄余数用于低龄分组。 */
export function ageAt(birthDate: string, at: string | undefined): { ageYears: number, ageDays: number | null } {
  const birth = new Date(birthDate)
  const reference = at === undefined ? new Date() : new Date(at)
  if (Number.isNaN(birth.getTime())) return { ageYears: 0, ageDays: null }
  const days = Math.max(0, Math.floor((reference.getTime() - birth.getTime()) / 86_400_000))
  let years = reference.getUTCFullYear() - birth.getUTCFullYear()
  if (reference.getUTCMonth() < birth.getUTCMonth()
    || (reference.getUTCMonth() === birth.getUTCMonth() && reference.getUTCDate() < birth.getUTCDate())) years -= 1
  return { ageYears: Math.min(150, Math.max(0, years)), ageDays: days < 365 ? days : null }
}

function genderOf(rawGender: string | undefined): 'male' | 'female' | 'unknown' {
  return rawGender === 'male' ? 'male' : rawGender === 'female' ? 'female' : 'unknown'
}

/** 首页快照与在院 live 诊断共用的分组入口映射：primary→main，其余→secondary。 */
function groupingDiagnoses(entries: ReadonlyArray<{ coding: { code: string }, role: string }>) {
  return entries.map(entry => ({ code: entry.coding.code, role: entry.role === 'primary' ? 'main' as const : 'secondary' as const }))
}

/** 离院时点口径的人口与住院属性：年龄、出院方式与住院天数（缺时点记 0 天）。 */
function stayDemographics(birthDate: string, admittedAt: string | undefined, departedAt: string | undefined, dischargeMode: string) {
  return {
    ...ageAt(birthDate, departedAt ?? admittedAt),
    birthWeightGrams: null,
    dischargeMode,
    inpatientDays: admittedAt === undefined || departedAt === undefined ? 0
      : Math.min(3650, Math.max(0, Math.floor((new Date(departedAt).getTime() - new Date(admittedAt).getTime()) / 86_400_000))),
  }
}

/**
 * DRG 评估域：预分组（冻结首页快照）与处方推演（在院 live 事实 + 草稿对照），
 * 以及后续治疗预留的生命周期。只读评估不落库；预留替换经手术执行的业务引用完成，不重复计费。
 */
export class InpatientDrg {
  constructor(private readonly owner: InpatientService, private readonly rules: DrgRules | null) {}

  #auditedRead<T>(context: ActorContext, operation: string, admissionId: string, query: () => T): T {
    let result: T
    try {
      result = query()
    } catch (error) {
      try { this.owner.commands.auditRead(context, operation, { admissionId }, 'failed') }
      catch { /* Preserve the original rejection when its audit cannot be stored. */ }
      throw error
    }
    this.owner.commands.auditRead(context, operation, { admissionId }, 'success')
    return result
  }

  readReservations(context: ActorContext, admissionId: string): InpatientMaterialReservationList {
    return this.#auditedRead(context, 'inpatient.drg.reservations.read', admissionId, () => this.reservations(context, admissionId))
  }

  readPregroup(context: ActorContext, admissionId: string): InpatientDrgPregroupResult {
    return this.#auditedRead(context, 'inpatient.drg.pregroup', admissionId, () => this.pregroup(context, admissionId))
  }

  readSimulation(context: ActorContext, admissionId: string, draft: InpatientDrgSimulationInput | undefined): InpatientDrgSimulation {
    return this.#auditedRead(context, 'inpatient.drg.simulate', admissionId, () => this.simulate(context, admissionId, draft))
  }

  readPayerReviews(context: ActorContext, admissionId: string): InpatientDrgPayerReviewList {
    return this.#auditedRead(context, 'inpatient.drg.payer-reviews.read', admissionId, () => this.payerReviews(context, admissionId))
  }

  readPayerReviewPreview(context: ActorContext, admissionId: string) {
    return this.#auditedRead(context, 'inpatient.drg.payer.review.preview', admissionId, () => this.payerReviewPreview(context, admissionId))
  }

  pregroup(context: ActorContext, admissionId: string): InpatientDrgPregroupResult {
    const record = this.owner.records.read(context, admissionId)
    // 归档病例回看冻结结果不依赖当前规则包；未归档病例保持规则未配置优先报错。
    if (record.archive !== undefined) return this.#frozenArchive(context, admissionId).frozen
    if (this.rules === null) throw new InpatientError('DRG_RULES_NOT_CONFIGURED', '分组规则数据包未配置，无法预分组', 409)
    return this.#groupedResult(admissionId, record.revision?.revision ?? 0, false,
      this.#snapshotGroupingInput(record.snapshot))
  }

  /** 规则已就绪前提下的完整预分组结果：调用方自行保证 this.rules 非 null。 */
  #groupedResult(admissionId: string, recordRevision: number, frozen: boolean, input: DrgGroupingInput): InpatientDrgPregroupResult {
    return inpatientDrgPregroupResultSchema.parse({
      admissionId,
      recordRevision,
      rulesId: this.rules!.rulesId,
      rulesVersion: this.rules!.version,
      inputCoding: 'nhc-icd10-clinical@2022.r4',
      codingNote: clinicalCodingNote,
      frozen,
      result: groupDrgCase(this.rules!, input),
    })
  }

  /** 归档冻结读取：冻结分组、归档来源哈希与归档快照正式收费净额；未归档或缺冻结明确报错。 */
  #frozenArchive(context: ActorContext, admissionId: string) {
    const row = z.object({ drg_result_json: z.string().nullable(), sources_hash: z.string(), snapshot_json: z.string() }).optional().parse(
      this.owner.database.driver.prepare(
        'SELECT drg_result_json, sources_hash, snapshot_json FROM inpatient_record_archive WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY archive_id DESC LIMIT 1')
        .get(context.workspaceId, context.epoch, admissionId))
    if (row === undefined) throw new InpatientError('INPATIENT_DRG_NOT_ARCHIVED', '病案归档后才能读取冻结分组', 409)
    if (row.drg_result_json === null) throw new InpatientError('DRG_FROZEN_RESULT_MISSING', '归档时未形成冻结分组（规则包未配置）', 409)
    const snapshot = inpatientRecordSnapshotSchema.parse(JSON.parse(row.snapshot_json))
    return { frozen: inpatientDrgPregroupResultSchema.parse(JSON.parse(row.drg_result_json)),
      sourcesHash: row.sources_hash, chargesFen: snapshot.fees.chargesFen, snapshot }
  }

  /** 归档事务内冻结分组：与首页快照同事务落盘；规则包未配置时返回 null，归档不带冻结结果。 */
  freezeForArchive(recordRevision: number, snapshot: z.infer<typeof inpatientRecordSnapshotSchema>): string | null {
    if (this.rules === null) return null
    const frozen = this.#groupedResult(snapshot.stay.admissionId, recordRevision, true, this.#snapshotGroupingInput(snapshot))
    return JSON.stringify({ ...frozen, paymentEstimate: this.#paymentReference(frozen.result) })
  }

  #snapshotGroupingInput(snapshot: z.infer<typeof inpatientRecordSnapshotSchema>): DrgGroupingInput {
    const { patient, stay, clinical } = snapshot
    return {
      diagnoses: groupingDiagnoses(clinical.diagnosis.entries),
      operations: clinical.operations.map(operation => ({
        code: operation.actualProcedure.coding.code, primary: operation.primary })),
      gender: genderOf(patient.gender),
      ...stayDemographics(patient.birthDate, stay.admittedAt, stay.departedAt, stay.departureMethod ?? 'unknown'),
    }
  }

  /**
   * 处方推演：正式收费、未记费承诺、治疗预留与草稿逐项计量对照，附依赖指纹与双口径分组。
   * 草稿只参与计价，不落库、不改变临床事实；评估过期由调用方比对 fingerprint 隔离。
   */
  simulate(context: ActorContext, admissionId: string, draft: InpatientDrgSimulationInput | undefined): InpatientDrgSimulation {
    if (this.rules === null) throw new InpatientError('DRG_RULES_NOT_CONFIGURED', '分组规则数据包未配置，无法推演', 409)
    this.owner.assertReadRole(context, ['inpatient-doctor', 'medical-records'])
    const admission = this.owner.readAdmissionBinding(context, admissionId)
    const facts = this.owner.orders.facts(context, admissionId)
    const input = this.#liveGroupingInput(context, admission)
    const dependencies = { ...this.#dependencies(context, admissionId, facts.charges), groupingInput: input }
    const formal = groupDrgCase(this.rules, input)
    const surgery = this.owner.surgery.read(context, admissionId)
    const requests = surgery.requests
      .filter(request => request.status === 'requested' || request.status === 'ready')
    const plannedOperations = requests.map(request => ({ code: request.plannedProcedure.coding.code, primary: true as const }))
    const projected = plannedOperations.length > 0
      ? groupDrgCase(this.rules, { ...input, operations: [...input.operations, ...plannedOperations] }) : null

    const chargesFen = facts.charges.reduce((sum, charge) => sum + charge.amountFen, 0)
    const quantities = new Map([
      ...facts.dispenses.map(item => [item.id, item.quantity] as const),
      ...surgery.executions.flatMap(execution => execution.materials.map(item => [item.id, item.quantity] as const)),
      ...facts.executions.map(execution => [execution.id, facts.orders.find(order => order.id === execution.orderId)?.doseQuantity ?? 1] as const),
    ])
    const chargesById = new Map(facts.charges.map(charge => [charge.id, charge]))
    const pendingOrders = z.array(z.object({ order_id: z.string(), kind: z.string(), display: z.string(), state: z.string(),
      dose_quantity: z.number(), price_fen: z.number(), pending_executions: z.number() })).parse(this.owner.database.driver.prepare(`
      SELECT o.order_id, o.kind, o.display, o.state, o.dose_quantity, o.price_fen,
        (SELECT COUNT(*) FROM inpatient_execution e WHERE e.workspace_id=o.workspace_id AND e.epoch=o.epoch
          AND e.order_id=o.order_id AND e.status='pending') AS pending_executions
      FROM inpatient_order o WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? AND o.state NOT IN ('stopped','completed')
      ORDER BY o.order_id`).all(context.workspaceId, context.epoch, admissionId))
    const committed = [
      // 已有排程按待执行次数计；已签署尚未物化执行单的按「待排程的下一剂量」计 1 次，已计费的发药/执行不计入。
      ...pendingOrders.map(row => ({
        kind: row.kind as 'medication' | 'service', id: row.order_id, display: row.display,
        quantity: row.state === 'signed' ? 1 : row.pending_executions,
        estimatedFen: (row.state === 'signed' ? 1 : row.pending_executions) * row.dose_quantity * row.price_fen }))
        .filter(item => item.quantity > 0),
      ...requests.map(request => ({
        kind: 'surgery' as const, id: request.id, display: request.plannedProcedure.coding.display, quantity: 1,
        estimatedFen: request.plannedProcedure.chargeDefinition.priceFen })),
    ]
    const reserved = z.array(z.object({ reservation_id: z.string(), material_display: z.string(),
      quantity: z.number(), price_fen: z.number() })).parse(this.owner.database.driver.prepare(
      "SELECT reservation_id, material_display, quantity, price_fen FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND status='reserved' ORDER BY created_at,reservation_id")
      .all(context.workspaceId, context.epoch, admissionId))
      .map(row => ({ kind: 'material' as const, id: row.reservation_id, display: row.material_display,
        quantity: row.quantity, estimatedFen: row.price_fen * row.quantity }))
    const draftGroups = this.#priceDraft(context, draft)

    const estimatedAdditionalFen = [...committed, ...reserved, ...draftGroups.items]
      .reduce((sum, item) => sum + (item.estimatedFen ?? 0), 0)
    const estimatedTotalFen = chargesFen + estimatedAdditionalFen
    const paymentReference = this.#paymentReference(formal)
    return inpatientDrgSimulationSchema.parse({
      admissionId,
      evaluatedAt: this.owner.virtualTime(context),
      fingerprint: canonicalJsonHash({ ...dependencies, draft: draft ?? null }),
      rulesId: this.rules.rulesId,
      rulesVersion: this.rules.version,
      formal: { chargesFen, items: facts.charges.map(charge => ({
        kind: charge.kind as 'medication' | 'service' | 'surgery' | 'material' | 'bed' | 'laboratory' | 'imaging',
        id: charge.id, display: charge.label,
        quantity: quantities.get((charge.reversalOf === undefined ? charge : chargesById.get(charge.reversalOf) ?? charge).sourceId) ?? 1,
        estimatedFen: charge.amountFen })) },
      committed: { items: committed },
      reserved: { items: reserved },
      draft: draftGroups,
      coverage: { coveredFen: chargesFen, estimatedTotalFen,
        coveredRatioBp: estimatedTotalFen > 0 ? Math.max(0, Math.min(10_000, Math.round(chargesFen / estimatedTotalFen * 10_000))) : null,
        note: coverageNote },
      grouping: { formal, projected, note: projectedNote },
      paymentReference,
      incompleteness: { costMissing: true, paymentReferenceMissing: paymentReference === null },
    })
  }

  /** 复核绑定实际开具选择，客户端只提交已审阅的指纹。 */
  assertOrderReview(context: ActorContext, admissionId: string,
    selection: z.infer<typeof inpatientOrderIssueInputSchema>['selection'], fingerprint: string) {
    const draft: InpatientDrgSimulationInput = selection.kind === 'medication'
      ? { medications: [{ catalogItemId: selection.catalogItemId, catalogVersion: selection.catalogVersion,
        doseText: selection.doseText, frequencyCode: selection.frequencyCode, doseQuantity: selection.doseQuantity }], services: [] }
      : { medications: [], services: [{ serviceId: selection.serviceId, serviceVersion: selection.serviceVersion, quantity: selection.quantity }] }
    if (this.simulate(context, admissionId, draft).fingerprint !== fingerprint)
      throw new InpatientError('INPATIENT_DRG_EVALUATION_STALE', '病例、医嘱、费用或规则已变化，请重新推演并审阅')
  }

  #paymentReference(result: DrgGroupingResult) {
    const code = result.status === 'grouped' ? result.drgCode : null
    const weight = code === null ? undefined : syntheticDrgPaymentParameters.weightsBp[code]
    return code === null || weight === undefined ? null : {
      parameterSetId: syntheticDrgPaymentParameters.parameterSetId, parameterVersion: syntheticDrgPaymentParameters.version,
      drgCode: code, referenceFen: Math.round(syntheticDrgPaymentParameters.baseRateFen * weight / 10_000),
      note: syntheticDrgPaymentParameters.note,
    }
  }

  /** 草稿计价：按目录 id+版本定位，未命中显式列出不完整，不以零值或跨版本价格填充。 */
  #priceDraft(context: ActorContext, draft: InpatientDrgSimulationInput | undefined): InpatientDrgSimulation['draft'] {
    const items: InpatientDrgSimulation['draft']['items'] = []
    const missing: InpatientDrgSimulation['draft']['missing'] = []
    if (draft !== undefined) {
      const catalog = this.owner.orders.medicationsAndServices(context)
      for (const entry of draft.medications) {
        const medication = catalog.medications.find(item => item.id === entry.catalogItemId && item.version === entry.catalogVersion)
        if (medication === undefined) { missing.push({ kind: 'medication', id: entry.catalogItemId }); continue }
        items.push({ kind: 'medication', id: entry.catalogItemId, display: `${medication.display} ${entry.doseText} ${entry.frequencyCode}`,
          quantity: entry.doseQuantity, estimatedFen: medication.priceFen * entry.doseQuantity })
      }
      for (const entry of draft.services) {
        const service = catalog.services.find(item => item.id === entry.serviceId && item.version === entry.serviceVersion)
        if (service === undefined) { missing.push({ kind: 'service', id: entry.serviceId }); continue }
        items.push({ kind: 'service', id: entry.serviceId, display: service.display,
          quantity: entry.quantity, estimatedFen: service.priceFen * entry.quantity })
      }
    }
    return { items, missing }
  }

  /** 依赖指纹：临床、医嘱、费用、手术、预留、目录价格与规则版本任一变化即过期。 */
  #dependencies(context: ActorContext, admissionId: string, charges: { id: string, version: number, amountFen: number }[]) {
    const diagnosis = this.owner.orders.diagnosis(context, admissionId)
    const executions = z.array(z.object({ execution_id: z.string(), version: z.number(), status: z.string() })).parse(this.owner.database.driver.prepare(`
      SELECT e.execution_id, e.version, e.status FROM inpatient_execution e JOIN inpatient_order o
        ON o.workspace_id=e.workspace_id AND o.epoch=e.epoch AND o.order_id=e.order_id
      WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? ORDER BY e.execution_id`)
      .all(context.workspaceId, context.epoch, admissionId))
    const requests = z.array(z.object({ request_id: z.string(), version: z.number(), status: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT request_id, version, status FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY request_id')
      .all(context.workspaceId, context.epoch, admissionId))
    const surgeryExecutions = z.array(z.object({ execution_id: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT execution_id FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY execution_id')
      .all(context.workspaceId, context.epoch, admissionId))
    const reservations = z.array(z.object({ reservation_id: z.string(), status: z.string(), quantity: z.number() })).parse(this.owner.database.driver.prepare(
      'SELECT reservation_id, status, quantity FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY reservation_id')
      .all(context.workspaceId, context.epoch, admissionId))
    const catalog = this.owner.orders.medicationsAndServices(context)
    const surgeryCatalog = this.owner.surgery.catalog(context)
    return {
      workspaceId: context.workspaceId, epoch: context.epoch, admissionId,
      encounter: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
      diagnosisRevision: diagnosis.revision,
      orders: z.array(z.object({ order_id: z.string(), version: z.number(), state: z.string() })).parse(this.owner.database.driver.prepare(
        'SELECT order_id, version, state FROM inpatient_order WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY order_id')
        .all(context.workspaceId, context.epoch, admissionId)),
      executions, requests, surgeryExecutions, reservations,
      charges: charges.map(charge => ({ id: charge.id, version: charge.version, amountFen: charge.amountFen })),
      prices: { medications: catalog.medications.map(item => [item.id, item.version, item.priceFen]),
        services: catalog.services.map(item => [item.id, item.version, item.priceFen]),
        procedures: surgeryCatalog.procedures.map(item => [item.id, item.version, item.chargeDefinition.priceFen]),
        // 计价单位未确认的耗材无价格，指纹以 null 占位；补价后指纹随之变化即过期。
        materials: surgeryCatalog.materials.map(item => [item.id, item.version, 'chargeDefinition' in item ? item.chargeDefinition.priceFen : null]) },
      rulesId: this.rules!.rulesId,
      rulesVersion: this.rules!.version,
      paymentParameters: syntheticDrgPaymentParameters,
    }
  }

  /** 在院 live 分组输入：正式诊断与已实施操作；主操作以已提交首页修订的选择为准，未提交时无主操作。 */
  #liveGroupingInput(context: ActorContext, admission: { id: string, patientId: string, row: { admitted_at: string | null } }): DrgGroupingInput {
    const diagnosis = this.owner.orders.diagnosis(context, admission.id)
    const executions = this.owner.surgery.executedForAdmission(context, admission.id)
    const revisionRow = z.object({ snapshot_json: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT snapshot_json FROM inpatient_record_revision WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY revision DESC LIMIT 1')
      .get(context.workspaceId, context.epoch, admission.id))
    const mainProcedureExecutionId = revisionRow === undefined ? null
      : z.object({ clinical: z.object({ mainProcedureExecutionId: z.string().nullable() }) }).parse(JSON.parse(revisionRow.snapshot_json)).clinical.mainProcedureExecutionId
    const patient = this.owner.fhir.read(context, 'Patient', admission.patientId)
    const identity = z.object({ gender: z.string().optional(), birthDate: z.string().optional() }).parse(patient)
    const events = this.owner.discharge.events(context, admission.id)
    const reversed = new Set(events.filter(event => event.kind === 'recall').map(event => event.reversesEventId))
    const departure = events.filter(event => event.kind === 'depart' && !reversed.has(event.id)).at(-1)
    const admittedAt = admission.row.admitted_at ?? undefined
    const departedAt = departure?.virtualTime
    return {
      diagnoses: groupingDiagnoses(diagnosis.entries),
      operations: executions.map(item => ({ code: item.actualProcedure.coding.code, primary: item.id === mainProcedureExecutionId })),
      gender: genderOf(identity.gender),
      ...stayDemographics(identity.birthDate ?? '', admittedAt, departedAt, departure?.departureMethod ?? 'unknown'),
    }
  }

  reservations(context: ActorContext, admissionId: string): InpatientMaterialReservationList {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(z.object({ reservation_id: z.string(), request_id: z.string().nullable(), material_id: z.string(),
      material_display: z.string(), quantity: z.number(), price_fen: z.number(), status: z.string(),
      material_use_id: z.string().nullable(), reason: z.string(), created_at: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY created_at,reservation_id')
      .all(context.workspaceId, context.epoch, admissionId))
    return inpatientMaterialReservationListSchema.parse({
      admissionId,
      encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
      reservations: rows.map(row => ({
        id: row.reservation_id, admissionId, materialId: row.material_id, materialDisplay: row.material_display,
        quantity: row.quantity, priceFen: row.price_fen, status: row.status as 'reserved' | 'replaced' | 'released',
        reason: row.reason, createdAt: row.created_at,
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        ...(row.material_use_id === null ? {} : { replacedByMaterialUseId: row.material_use_id }),
      })),
    })
  }

  createReservation(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientMaterialReservationCreateInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.reservation.create',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion },
      dataSchema: inpatientMaterialReservationListSchema,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const admission = this.owner.orders.assertAdmitted(context, input.admissionId)
      const material = this.owner.surgery.catalog(context).materials
        .find(item => item.id === input.materialId && item.version === input.catalogVersion)
      if (material === undefined || !('chargeDefinition' in material)) throw new InpatientError('CATALOG_CONFLICT', '耗材目录、版本或计价单位不可用')
      if (input.requestId !== undefined) {
        const request = z.object({ status: z.string() }).optional().parse(this.owner.database.driver.prepare(
          'SELECT status FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?')
          .get(context.workspaceId, context.epoch, input.admissionId, input.requestId))
        if (request === undefined || !['requested', 'ready'].includes(request.status))
          throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '预留须引用本次住院未实施或未取消的手术申请', 404)
      }
      const id = uuidv7()
      this.owner.database.driver.prepare(`INSERT INTO inpatient_material_reservation
        (workspace_id,epoch,reservation_id,admission_id,request_id,material_id,catalog_version,material_display,price_fen,quantity,status,reason,actor_id,practitioner_role_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?)`)
        .run(context.workspaceId, context.epoch, id, admission.id, input.requestId ?? null, input.materialId, input.catalogVersion,
          material.display, material.chargeDefinition.priceFen, input.quantity, input.reason, context.actorId, context.practitionerRoleId, this.owner.virtualTime(context))
      return { data: this.reservations(context, input.admissionId),
        effects: [{ kind: 'created' as const, reference: `InpatientMaterialReservation/${id}`, versionId: '1' }] }
    })
  }

  releaseReservation(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientMaterialReservationReleaseInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.reservation.release',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientMaterialReservationListSchema,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      const row = z.object({ status: z.string() }).optional().parse(this.owner.database.driver.prepare(
        'SELECT status FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
        .get(context.workspaceId, context.epoch, input.admissionId, input.reservationId))
      if (row === undefined) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
      if (row.status !== 'reserved') throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '仅预留中的耗材可以释放')
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      this.owner.database.driver.prepare(
        "UPDATE inpatient_material_reservation SET status='released' WHERE workspace_id=? AND epoch=? AND reservation_id=? AND status='reserved'")
        .run(context.workspaceId, context.epoch, input.reservationId)
      return { data: this.reservations(context, input.admissionId),
        effects: [{ kind: 'updated' as const, reference: `InpatientMaterialReservation/${input.reservationId}`, versionId: '2' }] }
    })
  }

  payerReviewPreview(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['medical-insurance', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    return this.#payerBasis(context, admissionId).preview
  }

  #payerBasis(context: ActorContext, admissionId: string) {
    const { frozen, sourcesHash, chargesFen, snapshot } = this.#frozenArchive(context, admissionId)
    if (frozen.result.status !== 'grouped' || frozen.result.drgCode === null)
      throw new InpatientError('DRG_FROZEN_UNGROUPED', '归档冻结分组未确定病组，无法模拟核定', 409)
    const reference = this.#paymentReference(frozen.result)
    if (reference === null)
      throw new InpatientError('DRG_PAYMENT_PARAMETER_MISSING', `病组 ${frozen.result.drgCode} 不在合成支付参数覆盖范围内`, 409)
    const basis = {
      admissionId, encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId!,
      archiveSourcesHash: sourcesHash, frozenResultHash: canonicalJsonHash(frozen),
      drgCode: reference.drgCode, parameterSetId: reference.parameterSetId, parameterVersion: reference.parameterVersion,
      simulatedPaymentFen: reference.referenceFen, hospitalChargesFen: chargesFen,
      differenceFen: reference.referenceFen - chargesFen, note: reference.note,
      paymentEstimate: frozen.paymentEstimate ?? null,
      estimateDifferenceFen: frozen.paymentEstimate == null ? null : reference.referenceFen - frozen.paymentEstimate.referenceFen,
      caseSummary: {
        recordRevision: frozen.recordRevision, rulesId: frozen.rulesId, rulesVersion: frozen.rulesVersion,
        inputCoding: frozen.inputCoding, codingNote: frozen.codingNote,
        groupingInput: this.#snapshotGroupingInput(snapshot),
        diagnoses: snapshot.clinical.diagnosis.entries.map(({ note: _note, ...entry }) => entry),
        operations: snapshot.clinical.operations.map(operation => ({ executionId: operation.id,
          procedureVersion: operation.procedureVersion, primary: operation.primary, coding: operation.actualProcedure.coding })),
      },
    }
    const preview = inpatientDrgPayerReviewPreviewSchema.parse({ ...basis,
      fingerprint: canonicalJsonHash({ workspaceId: context.workspaceId, epoch: context.epoch, ...basis }) })
    return { frozen, preview }
  }

  /** 医保办模拟核定：重验已审阅预览，归档冻结分组与合成参数共同确定金额。 */
  payerReview(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDrgPayerReviewCreateInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.payer.review',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientDrgPayerReviewListSchema,
      authorize: () => this.owner.assertRole(context, ['medical-insurance']) }, () => {
      const { frozen, preview } = this.#payerBasis(context, input.admissionId)
      if (input.expectedFingerprint !== preview.fingerprint)
        throw new InpatientError('INPATIENT_DRG_PAYER_PREVIEW_STALE', '分组或支付参数已变化，请重新读取核定预览并审阅')
      const id = uuidv7()
      this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_payer_review
        (workspace_id,epoch,review_id,admission_id,archive_sources_hash,record_revision,frozen_rules_id,frozen_rules_version,frozen_result_hash,drg_code,parameter_set_id,parameter_version,simulated_payment_fen,hospital_charges_fen,difference_fen,reason,actor_id,practitioner_role_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(context.workspaceId, context.epoch, id, input.admissionId, preview.archiveSourcesHash, frozen.recordRevision,
          frozen.rulesId, frozen.rulesVersion, preview.frozenResultHash, preview.drgCode,
          preview.parameterSetId, preview.parameterVersion,
          preview.simulatedPaymentFen, preview.hospitalChargesFen, preview.differenceFen,
          input.reason, context.actorId, context.practitionerRoleId, this.owner.virtualTime(context))
      return { data: this.#payerReviews(context, input.admissionId),
        effects: [{ kind: 'created' as const, reference: `InpatientDrgPayerReview/${id}`, versionId: '1' }] }
    })
  }

  /** 复核记录读取：医保办与病案人员可回查，其他岗位越界拒绝。 */
  payerReviews(context: ActorContext, admissionId: string): InpatientDrgPayerReviewList {
    this.owner.assertReadRole(context, ['medical-insurance', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    return this.#payerReviews(context, admissionId)
  }

  #payerReviews(context: ActorContext, admissionId: string): InpatientDrgPayerReviewList {
    const rows = z.array(z.object({ review_id: z.string(), archive_sources_hash: z.string(), record_revision: z.number(),
      frozen_rules_id: z.string(), frozen_rules_version: z.string(), frozen_result_hash: z.string(), drg_code: z.string(),
      parameter_set_id: z.string(), parameter_version: z.string(), simulated_payment_fen: z.number(), hospital_charges_fen: z.number(),
      difference_fen: z.number(), reason: z.string(), created_at: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_drg_payer_review WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY created_at,review_id')
      .all(context.workspaceId, context.epoch, admissionId))
    const archive = rows.length === 0 ? null : this.#frozenArchive(context, admissionId)
    const frozenResultHash = archive === null ? null : canonicalJsonHash(archive.frozen)
    return inpatientDrgPayerReviewListSchema.parse({ admissionId, reviews: rows.map(row => inpatientDrgPayerReviewSchema.parse({
      id: row.review_id, admissionId, archiveSourcesHash: row.archive_sources_hash, recordRevision: row.record_revision,
      frozenRulesId: row.frozen_rules_id, frozenRulesVersion: row.frozen_rules_version, frozenResultHash: row.frozen_result_hash,
      drgCode: row.drg_code, parameterSetId: row.parameter_set_id, parameterVersion: row.parameter_version,
      simulatedPaymentFen: row.simulated_payment_fen, hospitalChargesFen: row.hospital_charges_fen,
      paymentEstimate: archive?.sourcesHash === row.archive_sources_hash && frozenResultHash === row.frozen_result_hash
        ? archive.frozen.paymentEstimate ?? null : null,
      estimateDifferenceFen: archive?.sourcesHash === row.archive_sources_hash && frozenResultHash === row.frozen_result_hash
        && archive.frozen.paymentEstimate != null ? row.simulated_payment_fen - archive.frozen.paymentEstimate.referenceFen : null,
      differenceFen: row.difference_fen, note: syntheticDrgPaymentParameters.note, reason: row.reason, reviewedAt: row.created_at })) })
  }
}
