import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { groupDrgCase } from './drg-grouping.ts'
import type { DrgGroupingInput, DrgGroupingResult, DrgRules } from '@clinmesh/contracts/drg'
import type { inpatientOrderIssueInputSchema } from '@clinmesh/contracts/inpatient-clinical'
import { shanghaiBusinessDate } from '@clinmesh/contracts/scenario'
import { inpatientDrgPregroupResultSchema, type InpatientDrgPregroupResult } from '@clinmesh/contracts/inpatient-drg'
import { inpatientRecordSnapshotSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema,
  inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema,
  inpatientMaterialReservationBatchInputSchema, type InpatientMaterialReservationBatchInput,
  type InpatientDrgSimulation, type InpatientDrgSimulationInput, type InpatientMaterialReservationList } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientMaterialItemSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewCreateInputSchema, inpatientDrgPayerReviewSchema, inpatientDrgPayerReviewPreviewSchema,
  type InpatientDrgPayerReviewList } from '@clinmesh/contracts/inpatient-drg-payer'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext, CommandEffect } from './command-executor.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { syntheticDrgPaymentParameters } from './scenario-data/drg-payment-parameters.ts'
import { syntheticPciDrgPaymentParameters } from './scenario-data/pci-drg-payment-parameters.ts'
import { readInpatientBirthWeight } from './inpatient-birth-weight.ts'

const clinicalCodingNote = '病案首页为临床版编码（nhc-icd10-clinical@2022.r4），分组规则字典为医保版口径；'
  + '两套码同码直通，未同码的诊断/操作如实报告为无法入组，不做名称模糊映射。'

const coverageNote = '收费进度仅表达已发生收费净额占推演总额的比例，与成本覆盖不同；'
  + '合成医院支付参考与患者医保独立，缺少成本时不作完整盈亏结论，费用提示不自动调整治疗。'

const projectedNote = 'projected 为「若计划手术按当前计划实施」的推演分组，不构成临床事实或正式病组；'
  + '草稿与预留只参与计价对照，不改变分组。'
const birthDateSchema = z.iso.date()

function reservationSetFingerprint(context: ActorContext, admissionId: string, requestId: string,
  rows: Array<{ reservation_id: string; version: number }>) {
  return canonicalJsonHash({ workspaceId: context.workspaceId, epoch: context.epoch, admissionId, requestId,
    reservations: rows.map(row => ({ id: row.reservation_id, version: row.version })).sort((a, b) => a.id.localeCompare(b.id)) })
}

/** 年龄：以离院时点（无离院用入院时点）的医院当地日期计算整岁和日龄。 */
export function ageAt(birthDate: string, at: string | undefined): { ageYears: number, ageDays: number | null } {
  if (!birthDateSchema.safeParse(birthDate).success) return { ageYears: -1, ageDays: null }
  const referenceTime = at === undefined ? new Date() : new Date(at)
  if (Number.isNaN(referenceTime.getTime())) return { ageYears: -1, ageDays: null }
  const birth = new Date(birthDate)
  const reference = new Date(shanghaiBusinessDate(referenceTime.toISOString()))
  if (birth > reference) return { ageYears: -1, ageDays: null }
  const days = Math.max(0, Math.floor((reference.getTime() - birth.getTime()) / 86_400_000))
  let years = reference.getUTCFullYear() - birth.getUTCFullYear()
  if (reference.getUTCMonth() < birth.getUTCMonth()
    || (reference.getUTCMonth() === birth.getUTCMonth() && reference.getUTCDate() < birth.getUTCDate())) years -= 1
  return { ageYears: Math.min(150, Math.max(0, years)), ageDays: years === 0 ? days : null }
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
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records', 'medical-insurance'])
    this.owner.readAdmissionBinding(context, admissionId)
    if (context.roleCode === 'medical-insurance') return this.#frozenArchive(context, admissionId).frozen
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
      birthWeightGrams: patient.birthWeight?.grams ?? null,
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
    const { input, demographics } = this.#liveGroupingInput(context, admission)
    const dependencies = { ...this.#dependencies(context, admissionId, facts.charges, demographics), groupingInput: input }
    const formal = groupDrgCase(this.rules, input)
    const surgery = this.owner.surgery.read(context, admissionId)
    const requests = surgery.requests
      .filter(request => request.status === 'requested' || request.status === 'ready')
    const primaryRequestId = draft?.primarySurgeryRequestId ?? (requests.length === 1 ? requests[0]!.id : undefined)
    if (draft?.primarySurgeryRequestId !== undefined && !requests.some(request => request.id === primaryRequestId))
      throw new InpatientError('INPATIENT_DRG_PLAN_CONFLICT', '计划主操作已取消、完成或不属于本次住院，请刷新后重新选择')
    const requestProcedures = requests.map(request => ({ request,
      procedure: surgery.inProgress.find(execution => execution.requestId === request.id)?.actualProcedure ?? request.plannedProcedure }))
    const plannedOperations = requestProcedures.map(({ request, procedure }) => ({ code: procedure.coding.code, primary: request.id === primaryRequestId }))
    const projected = plannedOperations.length > 0
      ? groupDrgCase(this.rules, { ...input, operations: [
        ...input.operations.map(operation => ({ ...operation, primary: false })), ...plannedOperations,
      ] }) : null

    const chargesFen = facts.charges.reduce((sum, charge) => sum + charge.amountFen, 0)
    const quantities = new Map([
      ...facts.dispenses.map(item => [item.id, item.quantity] as const),
      ...[...surgery.executions, ...surgery.inProgress].flatMap(execution => (execution.materialHistory.length > 0 ? execution.materialHistory : execution.materials).map(item => [item.id, item.quantity] as const)),
      ...facts.executions.map(execution => [execution.id, facts.orders.find(order => order.id === execution.orderId)?.doseQuantity ?? 1] as const),
    ])
    const chargesById = new Map(facts.charges.map(charge => [charge.id, charge]))
    const scheduledOrderIds = new Set(facts.executions.map(execution => execution.orderId))
    const pendingOrders = z.array(z.object({ order_id: z.string(), kind: z.string(), display: z.string(),
      dose_quantity: z.number(), price_fen: z.number(), pending_executions: z.number() })).parse(this.owner.database.driver.prepare(`
      SELECT o.order_id, o.kind, o.display, o.dose_quantity, o.price_fen,
        (SELECT COUNT(*) FROM inpatient_execution e WHERE e.workspace_id=o.workspace_id AND e.epoch=o.epoch
          AND e.order_id=o.order_id AND e.status='pending') AS pending_executions
      FROM inpatient_order o WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? AND o.state NOT IN ('stopped','completed')
      ORDER BY o.order_id`).all(context.workspaceId, context.epoch, admissionId))
    const committed = [
      // 首次排程前保留下一剂（含已校对长期医嘱）；排程后仅计待执行，已记费发药/执行不计入。
      ...pendingOrders.map(row => {
        const quantity = (scheduledOrderIds.has(row.order_id) ? row.pending_executions : 1) * row.dose_quantity
        return { kind: row.kind as 'medication' | 'service', id: row.order_id, display: row.display,
          quantity, estimatedFen: quantity * row.price_fen }
      })
        .filter(item => item.quantity > 0),
      ...requestProcedures.map(({ request, procedure }) => ({
        kind: 'surgery' as const, id: request.id, display: procedure.coding.display, quantity: 1,
        estimatedFen: procedure.chargeDefinition.priceFen })),
    ]
    const reserved = z.array(z.object({ reservation_id: z.string(), material_display: z.string(),
      quantity: z.number(), price_fen: z.number() })).parse(this.owner.database.driver.prepare(
      "SELECT reservation_id, material_display, quantity-consumed_quantity quantity, price_fen FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND status='reserved' AND quantity>consumed_quantity ORDER BY created_at,reservation_id")
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
        kind: (charge.reversalOf === undefined ? charge : chargesById.get(charge.reversalOf) ?? charge).kind as 'medication' | 'service' | 'surgery' | 'material' | 'bed' | 'laboratory' | 'imaging',
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
    const parameters = code === 'FM39' ? syntheticPciDrgPaymentParameters : syntheticDrgPaymentParameters
    const weights: Readonly<Record<string, number>> = parameters.weightsBp
    const weight = code === null ? undefined : weights[code]
    return code === null || weight === undefined ? null : {
      parameterSetId: parameters.parameterSetId, parameterVersion: parameters.version,
      drgCode: code, referenceFen: Math.round(parameters.baseRateFen * weight / 10_000),
      note: parameters.note,
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
  #dependencies(context: ActorContext, admissionId: string, charges: { id: string, version: number, amountFen: number }[],
    demographics: { patientVersion: string, birthWeightObservations: { id: string, version: string }[] }) {
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
    const reservations = z.array(z.object({ reservation_id: z.string(), status: z.string(), quantity: z.number(), consumed_quantity: z.number(), version: z.number() })).parse(this.owner.database.driver.prepare(
      'SELECT reservation_id, status, quantity, consumed_quantity, version FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY reservation_id')
      .all(context.workspaceId, context.epoch, admissionId))
    const catalog = this.owner.orders.medicationsAndServices(context)
    const surgeryCatalog = this.owner.surgery.catalog(context)
    return {
      workspaceId: context.workspaceId, epoch: context.epoch, admissionId,
      demographics,
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
      paymentParameters: [syntheticDrgPaymentParameters, syntheticPciDrgPaymentParameters],
    }
  }

  /** 在院 live 分组输入：正式诊断与已实施操作；主操作以已提交首页修订的选择为准，未提交时无主操作。 */
  #liveGroupingInput(context: ActorContext, admission: { id: string, patientId: string, row: { admitted_at: string | null } }) {
    const diagnosis = this.owner.orders.diagnosis(context, admission.id)
    const executions = this.owner.surgery.executedForAdmission(context, admission.id)
    const revisionRow = z.object({ snapshot_json: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT snapshot_json FROM inpatient_record_revision WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY revision DESC LIMIT 1')
      .get(context.workspaceId, context.epoch, admission.id))
    const mainProcedureExecutionId = revisionRow === undefined ? null
      : z.object({ clinical: z.object({ mainProcedureExecutionId: z.string().nullable() }) }).parse(JSON.parse(revisionRow.snapshot_json)).clinical.mainProcedureExecutionId
    const patient = this.owner.fhir.read(context, 'Patient', admission.patientId)
    const birthWeight = readInpatientBirthWeight(this.owner.fhir, context, admission.patientId)
    const identity = z.object({ gender: z.string().optional(), birthDate: z.string().optional() }).parse(patient)
    const events = this.owner.discharge.events(context, admission.id)
    const reversed = new Set(events.filter(event => event.kind === 'recall').map(event => event.reversesEventId))
    const departure = events.filter(event => event.kind === 'depart' && !reversed.has(event.id)).at(-1)
    const admittedAt = admission.row.admitted_at ?? undefined
    const departedAt = departure?.virtualTime
    const input: DrgGroupingInput = {
      diagnoses: groupingDiagnoses(diagnosis.entries),
      operations: executions.map(item => ({ code: item.actualProcedure.coding.code, primary: item.id === mainProcedureExecutionId })),
      gender: genderOf(identity.gender),
      ...stayDemographics(identity.birthDate ?? '', admittedAt, departedAt, departure?.departureMethod ?? 'unknown'),
      birthWeightGrams: birthWeight.snapshot?.grams ?? null,
    }
    return { input, demographics: { patientVersion: patient.meta!.versionId!, birthWeightObservations: birthWeight.snapshot?.observations ?? [] } }
  }

  reservations(context: ActorContext, admissionId: string): InpatientMaterialReservationList {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(z.object({ reservation_id: z.string(), request_id: z.string().nullable(), material_id: z.string(),
      material_display: z.string(), catalog_version: z.number(), quantity: z.number(), price_fen: z.number(), status: z.string(),
      consumed_quantity: z.number(), version: z.number(), release_reason: z.string().nullable(),
      material_use_id: z.string().nullable(), reason: z.string(), created_at: z.string(), material_snapshot_json: z.string().nullable() })).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY created_at,reservation_id')
      .all(context.workspaceId, context.epoch, admissionId))
    const catalog = this.owner.surgery.catalog(context).materials
    const requests = z.array(z.object({ request_id: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT request_id FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY request_id')
      .all(context.workspaceId, context.epoch, admissionId))
    return inpatientMaterialReservationListSchema.parse({
      admissionId,
      encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
      reservationSets: requests.map(request => ({ requestId: request.request_id,
        fingerprint: reservationSetFingerprint(context, admissionId, request.request_id,
          rows.filter(row => row.request_id === request.request_id && row.status === 'reserved')) })),
      reservations: rows.map(row => {
        const used = row.material_snapshot_json === null && row.material_use_id !== null
          ? z.object({ item_json: z.string() }).optional().parse(this.owner.database.driver.prepare(
            `SELECT m.item_json FROM inpatient_surgery_material m JOIN inpatient_surgery_execution e
              ON e.workspace_id=m.workspace_id AND e.epoch=m.epoch AND e.execution_id=m.execution_id
              WHERE m.workspace_id=? AND m.epoch=? AND e.admission_id=? AND m.material_use_id=?`)
            .get(context.workspaceId, context.epoch, admissionId, row.material_use_id)) : undefined
        const frozen = row.material_snapshot_json ?? used?.item_json
        const snapshot = frozen === undefined || frozen === null ? undefined : inpatientMaterialItemSchema.parse(JSON.parse(frozen))
        if (snapshot && (snapshot.id !== row.material_id || snapshot.version !== row.catalog_version))
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '原预留的冻结耗材身份或版本不一致')
        const material = snapshot ?? catalog.find(item => item.id === row.material_id && item.version === row.catalog_version)
        return {
        id: row.reservation_id, admissionId, materialId: row.material_id, materialDisplay: row.material_display,
        unit: material && 'chargeDefinition' in material ? material.chargeDefinition.unit : null,
        specification: material?.reference?.specification ?? null,
        quantity: row.quantity, catalogVersion: row.catalog_version, consumedQuantity: row.consumed_quantity, remainingQuantity: row.status === 'reserved' ? row.quantity - row.consumed_quantity : 0, version: row.version, releaseReason: row.release_reason, priceFen: row.price_fen, status: row.status as 'reserved' | 'replaced' | 'released',
        reason: row.reason, createdAt: row.created_at,
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        ...(row.material_use_id === null ? {} : { replacedByMaterialUseId: row.material_use_id }),
      } }),
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
        (workspace_id,epoch,reservation_id,admission_id,request_id,material_id,catalog_version,material_display,price_fen,quantity,status,reason,actor_id,practitioner_role_id,created_at,material_snapshot_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?)`)
        .run(context.workspaceId, context.epoch, id, admission.id, input.requestId ?? null, input.materialId, input.catalogVersion,
          material.display, material.chargeDefinition.priceFen, input.quantity, input.reason, context.actorId, context.practitionerRoleId, this.owner.virtualTime(context), JSON.stringify(material))
      return { data: this.reservations(context, input.admissionId),
        effects: [{ kind: 'created' as const, reference: `InpatientMaterialReservation/${id}`, versionId: '1' }] }
    })
  }

  batchReservations(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientMaterialReservationBatchInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.reservation.replace-batch',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientMaterialReservationListSchema,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      const effects: CommandEffect[] = []
      const data = this.replaceReservationsInTransaction(context, input, effects)
      return { data, effects }
    })
  }

  /** 外层 Command 持有事务；同计划原预留与整份新清单一起提交。 */
  replaceReservationsInTransaction(context: ActorContext, input: InpatientMaterialReservationBatchInput, effects: CommandEffect[]) {
    this.owner.assertNotArchived(context, input.admissionId)
    this.owner.orders.assertAdmitted(context, input.admissionId)
    const request = z.object({ version: z.number(), status: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT version,status FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?')
      .get(context.workspaceId, context.epoch, input.admissionId, input.requestId))
    if (!request || request.version !== input.expectedRequestVersion || !['requested', 'ready'].includes(request.status))
      throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '计划已变化、取消或实施，请刷新后重新审阅')
    if (this.owner.database.driver.prepare('SELECT 1 FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?')
      .get(context.workspaceId, context.epoch, input.admissionId, input.requestId))
      throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，不能整批调整术前预留')
    const current = z.array(z.object({ reservation_id: z.string(), version: z.number(), consumed_quantity: z.number() })).parse(
      this.owner.database.driver.prepare("SELECT reservation_id,version,consumed_quantity FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? AND status='reserved'")
        .all(context.workspaceId, context.epoch, input.admissionId, input.requestId))
    if (reservationSetFingerprint(context, input.admissionId, input.requestId, current) !== input.expectedReservationFingerprint)
      throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '本计划的有效预留已变化，请重新审阅完整清单')
    if (current.some(row => row.consumed_quantity !== 0))
      throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '已部分使用的预留不能整批替换，请转入实际用量工作流')
    const catalog = this.owner.surgery.catalog(context).materials
    const selections = input.items.map(item => {
      const material = catalog.find(candidate => candidate.id === item.materialId && candidate.version === item.catalogVersion)
      if (!material || !('chargeDefinition' in material))
        throw new InpatientError('CATALOG_CONFLICT', '耗材目录、版本或计价单位不可用，请重新审阅整份清单')
      if (material.chargeDefinition.priceFen <= 0 || !Number.isSafeInteger(material.chargeDefinition.priceFen * item.quantity))
        throw new InpatientError('INPATIENT_RESERVATION_AMOUNT_INVALID', '预留耗材缺少有效正数目录价或金额超出安全范围')
      return { item, material }
    })
    if (selections.reduce((sum, { item, material }) => sum + BigInt(material.chargeDefinition.priceFen) * BigInt(item.quantity), 0n) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new InpatientError('INPATIENT_RESERVATION_AMOUNT_INVALID', '整批预留总金额超出安全范围')
    for (const row of current) {
      this.owner.database.driver.prepare("UPDATE inpatient_material_reservation SET status='released',release_reason=?,version=version+1 WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=? AND status='reserved'")
        .run(input.reason, context.workspaceId, context.epoch, row.reservation_id, row.version)
      effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${row.reservation_id}`, versionId: String(row.version + 1) })
    }
    for (const { item, material } of selections) {
      const id = uuidv7()
      this.owner.database.driver.prepare(`INSERT INTO inpatient_material_reservation
        (workspace_id,epoch,reservation_id,admission_id,request_id,material_id,catalog_version,material_display,price_fen,quantity,status,reason,actor_id,practitioner_role_id,created_at,material_snapshot_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?)`).run(context.workspaceId, context.epoch, id, input.admissionId, input.requestId,
          item.materialId, item.catalogVersion, material.display, material.chargeDefinition.priceFen, item.quantity, item.reason,
          context.actorId, context.practitionerRoleId, this.owner.virtualTime(context), JSON.stringify(material))
      effects.push({ kind: 'created', reference: `InpatientMaterialReservation/${id}`, versionId: '1' })
    }
    return this.reservations(context, input.admissionId)
  }

  releaseReservation(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientMaterialReservationReleaseInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.reservation.release',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientMaterialReservationListSchema,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      const row = z.object({ status: z.string(), version: z.number() }).optional().parse(this.owner.database.driver.prepare(
        'SELECT status,version FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
        .get(context.workspaceId, context.epoch, input.admissionId, input.reservationId))
      if (row === undefined) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
      if (row.status !== 'reserved') throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '仅预留中的耗材可以释放')
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      this.owner.database.driver.prepare(
        "UPDATE inpatient_material_reservation SET status='released',version=version+1,release_reason=? WHERE workspace_id=? AND epoch=? AND reservation_id=? AND status='reserved'")
        .run(input.reason, context.workspaceId, context.epoch, input.reservationId)
      return { data: this.reservations(context, input.admissionId),
        effects: [{ kind: 'updated' as const, reference: `InpatientMaterialReservation/${input.reservationId}`, versionId: String(row.version + 1) }] }
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
      differenceFen: row.difference_fen,
      note: [syntheticDrgPaymentParameters, syntheticPciDrgPaymentParameters]
        .find(parameters => parameters.parameterSetId === row.parameter_set_id && parameters.version === row.parameter_version)?.note
        ?? '历史版本的合成支付参数说明不可用；核定金额按原记录保留，不代表地区真实结算或完整盈亏。',
      reason: row.reason, reviewedAt: row.created_at })) })
  }
}
