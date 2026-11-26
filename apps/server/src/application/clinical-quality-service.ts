import type {
  ClinicalOverrideInput,
  ClinicalQualityAlert,
  ClinicalQualityCheck,
  ClinicalQualityGate,
  ClinicalQualityReceipt,
  ClinicalQualityRedLine,
} from '@clinmesh/contracts/clinical-quality'
import type { ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import { medicationSafetyRuleSchema, type MedicationSafetyRule } from '@clinmesh/contracts/medication-safety'
import {
  antibioticIndicationFindings,
  chestPainWorkupFindings,
  classDuplicationFindings,
  clinicalOverrideCovers,
  dischargeSecondaryPreventionFindings,
  doseLimitFindings,
  nonIschemicPciFindings,
  renalMedicationFindings,
  renalMonitoredClasses,
  secondaryPreventionClasses,
  type QualityEvidence,
  type QualityMedication,
  type RenalFunctionFact,
} from '@clinmesh/core/clinical-quality'
import { resolveInpatientDose } from '@clinmesh/core/inpatient-dose'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ClinicalScoreService } from './clinical-score-service.ts'
import type { ClinicalFactLedgerService } from './clinical-fact-ledger-service.ts'
import type { ActorContext, CommandEffect, CommandExecutor } from './command-executor.ts'
import type { DiseasePackRuntimeService } from './disease-pack-runtime-service.ts'
import { extractSupplementaryIndicators } from './guideline-topic-registry.ts'
import { inpatientMedicationConfigSchema } from './inpatient-medication-config.ts'
import type { InpatientService } from './inpatient-service.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { standardMedicationSafety } from './scenario-data/standard-medications.ts'

/** 事中临床质控拒绝：红线不可越权；警示须补齐事实或附覆盖全部警示的 Clinical Override。 */
export class ClinicalQualityError extends Error {
  readonly status = 409
  constructor(readonly code: 'CLINICAL_QUALITY_ALERT' | 'CLINICAL_QUALITY_RED_LINE', message: string, readonly check: ClinicalQualityCheck) {
    super(message)
    this.name = 'ClinicalQualityError'
  }
}

const catalogConfigSchema = z.object({ safety: medicationSafetyRuleSchema.optional() }).loose()

export type QualityMedicationCandidate = QualityMedication & { code?: string | undefined }

interface Facts {
  allergyCodes?: ReadonlySet<string> | undefined
  activeMedications?: readonly QualityMedication[] | undefined
  diagnosisCodes?: readonly string[] | undefined
  medications?: readonly QualityMedicationCandidate[] | undefined
  renal?: (() => RenalFunctionFact) | undefined
}

/** 基于正式临床事实的双层事中质控；由各业务 Command 在同一写事务内调用，HTTP、CLI、Agent 与页面不复制规则。 */
export class ClinicalQualityService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  #diseasePacks: DiseasePackRuntimeService | undefined
  readonly #factLedger: ClinicalFactLedgerService | undefined
  readonly #fhir: FhirRepository
  readonly #outpatient: OutpatientWorkflowContext
  readonly #scores: ClinicalScoreService

  constructor(options: { commands: CommandExecutor; database: ClinMeshDatabase; diseasePacks?: DiseasePackRuntimeService; factLedger?: ClinicalFactLedgerService; fhir: FhirRepository; outpatientContext: OutpatientWorkflowContext; scores: ClinicalScoreService }) {
    this.#commands = options.commands
    this.#database = options.database
    this.#diseasePacks = options.diseasePacks
    this.#factLedger = options.factLedger
    this.#fhir = options.fhir
    this.#outpatient = options.outpatientContext
    this.#scores = options.scores
  }

  setDiseasePacks(diseasePacks: DiseasePackRuntimeService): void {
    this.#diseasePacks = diseasePacks
  }

  #withPackProvenance(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    check: ClinicalQualityCheck,
    asOf: string,
  ): ClinicalQualityCheck {
    if (this.#diseasePacks === undefined) return check
    const activeRuntime = this.#diseasePacks.activeRuntimeSummaryForSubject(context, subject, asOf)
    if (activeRuntime.sourcePacks.length === 0) return check
    return {
      ...check,
      ...(activeRuntime.primaryPack === undefined
        ? {}
        : { packId: activeRuntime.primaryPack.packId, packVersion: activeRuntime.primaryPack.packVersion }),
      sourcePacks: activeRuntime.sourcePacks,
    }
  }

  #ineligibleObservationIds(
    context: ActorContext,
    subject: { kind: 'outpatient' | 'inpatient'; id: string; patientId: string },
    asOf: string,
  ): ReadonlySet<string> | undefined {
    if (!this.#factLedger) return undefined
    const ledger = this.#factLedger.buildInternalLedger(context, subject, { asOf, includeSuperseded: false })
    return new Set(
      ledger.facts
        .filter(f => (
          f.institutionScope === 'local'
          && f.provenance.recordType === 'Observation'
          && f.ineligibleReasons.some(reason => reason !== 'expired')
        ))
        .map(f => f.provenance.recordId),
    )
  }

  medicationSafety(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, catalogItemId: string): MedicationSafetyRule | undefined {
    const row = z.object({ config_json: z.string() }).optional().parse(this.#database.driver.prepare(
      "SELECT config_json FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=? AND kind='medication'").get(context.workspaceId, context.epoch, catalogItemId))
    const parsed = row === undefined ? undefined : catalogConfigSchema.safeParse(JSON.parse(row.config_json))
    return (parsed?.success ? parsed.data.safety : undefined) ?? standardMedicationSafety(catalogItemId)
  }

  medicationClasses(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, catalogItemId: string): string[] {
    return [...(this.medicationSafety(context, catalogItemId)?.pharmacologyClasses ?? [])]
  }

  /** 将住院制剂单位或效价剂量（如“1 片”、“6250 IU”）换算为药事极量比较所需的有效剂量字符串。 */
  inpatientSafetyDose(configJson: string, doseText: string | undefined, doseQuantity?: number): string | undefined {
    if (doseText === undefined) return undefined
    const parsed = inpatientMedicationConfigSchema.safeParse(JSON.parse(configJson))
    if (!parsed.success) return doseText
    const config = parsed.data
    const resolved = resolveInpatientDose({
      unit: config.unit,
      doses: config.inpatientDoses,
      ...(config.inpatientDoseBasis ? { doseBasis: config.inpatientDoseBasis } : {}),
      ...(config.inpatientMaxDoseQuantity ? { maxDoseQuantity: config.inpatientMaxDoseQuantity } : {}),
    }, doseText.trim())
    const match = /^(\d+(?:\.\d+)?)\s*([^\s\d]+)$/.exec(doseText.trim())
    const qty = 'quantity' in resolved ? resolved.quantity : match && match[2] === config.unit ? doseQuantity ?? Number(match[1]) : undefined
    if (config.safety?.doseLimits.unit === config.unit && qty !== undefined && Number.isFinite(qty)) return `${qty} ${config.unit}`
    if (match && match[2] === config.unit && qty !== undefined && Number.isFinite(qty)) {
      const strength = /^(\d+(?:\.\d+)?)\s*(mg|g|mL|IU)/i.exec(config.product.strength)
      const basis = config.inpatientDoseBasis ?? (strength ? { amount: Number(strength[1]), unit: strength[2]! } : undefined)
      if (basis !== undefined) return `${qty * basis.amount} ${basis.unit}`
    }
    return doseText
  }

  outpatientPrescription(context: ActorContext, input: {
    caseId?: string | undefined
    patientId?: string | undefined
    diagnosisCodes?: readonly string[] | undefined
    medications: readonly QualityMedicationCandidate[]
  }): ClinicalQualityCheck {
    return this.#check(context, 'outpatient-prescription', {
      allergyCodes: input.patientId === undefined ? undefined : this.#outpatient.patientAllergyCodes(context, input.patientId),
      diagnosisCodes: input.diagnosisCodes,
      medications: input.medications,
      renal: input.caseId === undefined ? undefined : () => renalFact(this.#scores.outpatientSnapshot(context, input.caseId!)),
    })
  }

  outpatientCompletion(context: ActorContext, input: { caseId: string; encounterId: string }): ClinicalQualityCheck {
    const patientRow = this.#factLedger
      ? z.object({ patient_id: z.string().min(1) }).optional().parse(
          this.#database.driver.prepare('SELECT patient_id FROM outpatient_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?').get(context.workspaceId, context.epoch, input.caseId),
        )
      : undefined
    const asOf = this.#outpatient.virtualTime(context)
    const ineligibleObservationIds = patientRow
      ? this.#ineligibleObservationIds(context, { kind: 'outpatient', id: input.caseId, patientId: patientRow.patient_id }, asOf)
      : undefined
    const indicators = extractSupplementaryIndicators({ caseId: input.caseId, context, database: this.#database, encounterId: input.encounterId, fhir: this.#fhir, ineligibleObservationIds })
    return this.#result(context, 'outpatient-completion', [], chestPainWorkupFindings({
      presentation: evidence('急性胸痛就诊依据', indicators.acsEligibility),
      ecg: indicators.ecgSummary && { label: '12 导联心电图报告', reference: indicators.ecgSummary.sourceReference, versionId: indicators.ecgSummary.versionId },
      troponin: indicators.troponinSeries && { label: '心肌肌钙蛋白', reference: indicators.troponinSeries.latestReference, versionId: indicators.troponinSeries.versionId },
    }))
  }

  inpatientOrder(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    patientId: string,
    medication: QualityMedicationCandidate,
    active: readonly QualityMedication[],
    options?: { skipRenal?: boolean },
  ): ClinicalQualityCheck {
    return this.#check(context, 'inpatient-order', {
      activeMedications: active,
      allergyCodes: this.#outpatient.patientAllergyCodes(context, patientId),
      diagnosisCodes: inpatient.orders.diagnosis(context, admissionId).entries.map(entry => entry.coding.code),
      medications: [medication],
      renal: options?.skipRenal ? undefined : () => renalFact(this.#scores.inpatientSnapshot(inpatient, context, admissionId)),
    })
  }

  inpatientPciPlan(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    options?: { requestId?: string | undefined; reportReferences?: readonly string[] | undefined },
  ): ClinicalQualityCheck {
    const reports = inpatient.angiography.reports(context, admissionId).filter(item => item.status === 'final' || item.status === 'partial')
    const draft = options?.requestId === undefined
      ? undefined
      : inpatient.pciSelection.drafts(context, admissionId).find(item => item.requestId === options.requestId)
    const refIds = (options?.reportReferences ?? []).flatMap(ref => ref.startsWith('DiagnosticReport/') ? [ref.slice('DiagnosticReport/'.length)] : [])
    const report = (draft === undefined
      ? undefined
      : reports.find(item => item.id === draft.reportId && item.version === draft.reportVersion)
        ?? reports.find(item => item.id === draft.reportId))
      ?? (refIds.length > 0 ? reports.find(item => refIds.includes(item.id)) : undefined)
      ?? reports[0]
    return this.#result(context, 'inpatient-pci-plan', [], report === undefined ? [] : nonIschemicPciFindings(report.vessels,
      { label: '冠脉造影功能学报告', reference: `DiagnosticReport/${report.id}`, versionId: String(report.version) }))
  }

  /** 截止时点为出院医嘱开立时刻：签离前排除已停医嘱；离院后结合 action_trace 序列区分签离前已停与签离后按出区要求停嘱。 */
  inpatientDischarge(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    patientId: string,
    cutoff: string,
    issueEventId?: string,
  ): ClinicalQualityCheck {
    const ineligibleObservationIds = this.#ineligibleObservationIds(context, { kind: 'inpatient', id: admissionId, patientId }, cutoff)
    const indicators = extractSupplementaryIndicators({ caseId: admissionId, context, database: this.#database, encounterId: admissionId, fhir: this.#fhir,
      ineligibleObservationIds, inpatient: { actor: context, service: inpatient }, patientId })
    const rows = z.array(z.object({ order_id: z.string(), catalog_item_id: z.string(), stopped_at: z.string().nullable() })).parse(
      issueEventId === undefined
        ? this.#database.driver.prepare(`SELECT order_id, catalog_item_id, stopped_at FROM inpatient_order
            WHERE workspace_id=? AND epoch=? AND admission_id=? AND kind='medication' AND duration='long'
              AND julianday(signed_at) <= julianday(?) AND stopped_at IS NULL`).all(context.workspaceId, context.epoch, admissionId, cutoff)
        : this.#database.driver.prepare(`SELECT order_id, catalog_item_id, stopped_at FROM inpatient_order
            WHERE workspace_id=? AND epoch=? AND admission_id=? AND kind='medication' AND duration='long'
              AND julianday(signed_at) <= julianday(?) AND (stopped_at IS NULL OR julianday(stopped_at) >= julianday(?))`).all(context.workspaceId, context.epoch, admissionId, cutoff, cutoff),
    )
    const issueSeq = issueEventId === undefined ? null : z.object({ seq: z.number().nullable() }).parse(this.#database.driver.prepare(`
      SELECT MAX(sequence) AS seq FROM action_trace
      WHERE workspace_id=? AND epoch=? AND operation='inpatient.discharge.issue' AND outcome='success' AND instr(effect_json, ?) > 0
    `).get(context.workspaceId, context.epoch, `"InpatientDischargeEvent/${issueEventId}"`)).seq
    const cutoffMs = Date.parse(cutoff)
    const orders = rows.filter((row) => {
      if (row.stopped_at === null) return true
      if (issueEventId === undefined) return false
      if (Date.parse(row.stopped_at) > cutoffMs) return true
      if (issueSeq === null) return false
      const stopSeq = z.object({ seq: z.number().nullable() }).parse(this.#database.driver.prepare(`
        SELECT MAX(sequence) AS seq FROM action_trace
        WHERE workspace_id=? AND epoch=? AND operation IN ('inpatient.order.request-stop','inpatient.surgery.complete','inpatient.surgery.execute','inpatient.surgery.finalize-standby') AND outcome='success' AND instr(effect_json, ?) > 0
      `).get(context.workspaceId, context.epoch, `"MedicationRequest/${row.order_id}"`)).seq
      return stopSeq !== null && stopSeq > issueSeq
    })
    const longTermClasses = [...new Set(orders.map(order => order.catalog_item_id))]
      .flatMap(catalogItemId => this.medicationClasses(context, catalogItemId))
      .filter(item => (secondaryPreventionClasses as readonly string[]).includes(item))
    return this.#result(context, 'inpatient-discharge', [], dischargeSecondaryPreventionFindings({ cad: evidence('冠心病/PCI 依据', indicators.cadEligibility), longTermClasses }))
  }

  previewOutpatient(context: ActorContext, input: { encounterId: string; gate: 'outpatient-prescription' | 'outpatient-completion' }): ClinicalQualityCheck {
    this.#outpatient.assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#outpatient.caseByEncounter(context, input.encounterId)
    this.#outpatient.assertCaseResponsibility(context, outpatientCase.case_id)
    const subject = { id: outpatientCase.case_id, kind: 'outpatient' as const, patientId: outpatientCase.patient_id }
    const asOf = this.#outpatient.virtualTime(context)
    if (input.gate === 'outpatient-completion') {
      return this.#withPackProvenance(
        context,
        subject,
        this.outpatientCompletion(context, { caseId: outpatientCase.case_id, encounterId: input.encounterId }),
        asOf,
      )
    }
    const draft = z.object({ draft_json: z.string().nullable() }).optional().parse(this.#database.driver.prepare(
      'SELECT draft_json FROM prescription_draft_state WHERE workspace_id=? AND epoch=? AND case_id=?').get(context.workspaceId, context.epoch, outpatientCase.case_id))
    const items = draft?.draft_json
      ? z.object({ items: z.array(z.object({ catalogItemId: z.string(), doseText: z.string().optional(), frequencyCode: z.string().optional() }).loose()) }).loose().parse(JSON.parse(draft.draft_json)).items
      : []
    const medications: QualityMedicationCandidate[] = items.flatMap(item => {
      const row = z.object({ code: z.string(), name_zh: z.string() }).optional().parse(this.#database.driver.prepare(
        "SELECT code, name_zh FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=? AND kind='medication'").get(context.workspaceId, context.epoch, item.catalogItemId))
      if (row === undefined) return []
      const safety = this.medicationSafety(context, item.catalogItemId)
      return [{
        catalogItemId: item.catalogItemId,
        code: row.code,
        display: row.name_zh,
        pharmacologyClasses: [...(safety?.pharmacologyClasses ?? [])],
        doseLimits: safety?.doseLimits,
        doseText: item.doseText,
        frequencyCode: item.frequencyCode,
      }]
    })
    const check = this.outpatientPrescription(context, {
      caseId: outpatientCase.case_id,
      patientId: outpatientCase.patient_id,
      diagnosisCodes: this.#outpatient.confirmedDiagnoses(context, outpatientCase.case_id)?.entries.map(entry => entry.code) ?? [],
      medications,
    })
    return this.#withPackProvenance(context, subject, check, asOf)
  }

  readOutpatient(context: ActorContext, input: { encounterId: string; gate: 'outpatient-prescription' | 'outpatient-completion' }): ClinicalQualityCheck {
    return this.#auditedRead(context, 'encounter.clinical-quality.read', input, () => this.previewOutpatient(context, input))
  }

  previewInpatient(inpatient: InpatientService, context: ActorContext, input: {
    admissionId: string
    gate: 'inpatient-order' | 'inpatient-pci-plan' | 'inpatient-discharge'
    catalogItemId?: string | undefined
    doseText?: string | undefined
    frequencyCode?: string | undefined
  }): ClinicalQualityCheck {
    inpatient.assertReadRole(context, ['inpatient-doctor'])
    const admission = inpatient.readAdmissionBinding(context, input.admissionId)
    const subject = { id: admission.id, kind: 'inpatient' as const, patientId: admission.patientId }
    const asOf = inpatient.virtualTime(context)
    if (input.gate === 'inpatient-pci-plan') {
      return this.#withPackProvenance(context, subject, this.inpatientPciPlan(inpatient, context, admission.id), asOf)
    }
    if (input.gate === 'inpatient-discharge') {
      const latestIssue = admission.status === 'admitted' ? undefined : inpatient.discharge.events(context, admission.id).filter(event => event.kind === 'issue').at(-1)
      const dischargeTime = latestIssue?.virtualTime ?? asOf
      return this.#withPackProvenance(
        context,
        subject,
        this.inpatientDischarge(inpatient, context, admission.id, admission.patientId, dischargeTime, latestIssue?.id),
        dischargeTime,
      )
    }
    const active = inpatient.orders.facts(context, admission.id).orders.filter(order => order.kind === 'medication' && ['signed', 'verified'].includes(order.state))
      .map(order => ({ catalogItemId: order.catalogItemId, display: order.display, pharmacologyClasses: this.medicationClasses(context, order.catalogItemId) }))
    if (input.catalogItemId === undefined) {
      return this.#withPackProvenance(context, subject, this.#check(context, 'inpatient-order', {
        allergyCodes: this.#outpatient.patientAllergyCodes(context, admission.patientId),
        diagnosisCodes: inpatient.orders.diagnosis(context, admission.id).entries.map(entry => entry.coding.code),
        medications: active,
        renal: () => renalFact(this.#scores.inpatientSnapshot(inpatient, context, admission.id)),
      }), asOf)
    }
    const item = z.object({ code: z.string(), name_zh: z.string(), config_json: z.string() }).optional().parse(this.#database.driver.prepare(
      "SELECT code, name_zh, config_json FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=? AND kind='medication' AND active=1").get(context.workspaceId, context.epoch, input.catalogItemId))
    if (item === undefined) throw new ClinicalQualityReadError('住院药品目录项不存在或未启用')
    const safety = this.medicationSafety(context, input.catalogItemId)
    const medication: QualityMedicationCandidate = {
      catalogItemId: input.catalogItemId,
      code: item.code,
      display: item.name_zh,
      pharmacologyClasses: [...(safety?.pharmacologyClasses ?? [])],
      doseLimits: safety?.doseLimits,
      doseText: this.inpatientSafetyDose(item.config_json, input.doseText),
      frequencyCode: input.frequencyCode,
    }
    return this.#withPackProvenance(
      context,
      subject,
      this.inpatientOrder(inpatient, context, admission.id, admission.patientId, medication, active),
      asOf,
    )
  }

  readInpatient(inpatient: InpatientService, context: ActorContext, input: {
    admissionId: string
    gate: 'inpatient-order' | 'inpatient-pci-plan' | 'inpatient-discharge'
    catalogItemId?: string | undefined
    doseText?: string | undefined
    frequencyCode?: string | undefined
  }): ClinicalQualityCheck {
    return this.#auditedRead(context, 'inpatient.clinical-quality.read', input, () => this.previewInpatient(inpatient, context, input))
  }

  /** 在调用方的 Command 事务内执行：红线或未覆盖警示时整笔回滚，越权放行时写入正式留痕并返回回执片段。 */
  enforce(context: ActorContext, input: { check: ClinicalQualityCheck; operation: string; override?: ClinicalOverrideInput | undefined; patientId: string; subjectReference: string })
    : { effects: CommandEffect[]; receipt?: ClinicalQualityReceipt } {
    const { check } = input
    if (check.redLines.length > 0) {
      throw new ClinicalQualityError('CLINICAL_QUALITY_RED_LINE', `命中药事安全红线，不可越权提交：${check.redLines.map(item => `${item.code} ${item.message}`).join('；')}`, check)
    }
    if (check.alerts.length === 0) return { effects: [] }
    if (!clinicalOverrideCovers(input.override, check.alerts)) {
      throw new ClinicalQualityError('CLINICAL_QUALITY_ALERT',
        `临床质控警示待处理（${check.alerts.map(item => item.code).join('、')}）：补齐检查或医嘱后重试，或附 clinicalOverride 逐项确认全部警示并说明原因`, check)
    }
    const override = input.override!, overrideId = uuidv7(), recordedAt = check.evaluatedAt
    this.#database.driver.prepare(`INSERT INTO clinical_quality_override(workspace_id,epoch,override_id,gate,operation,subject_reference,patient_id,alerts_json,
      reason_code,note,actor_id,practitioner_role_id,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, overrideId, check.gate, input.operation,
      input.subjectReference, input.patientId, JSON.stringify(check.alerts), override.reasonCode, override.note, context.actorId, context.practitionerRoleId ?? null, recordedAt)
    return {
      effects: [{ kind: 'created', reference: `ClinicalQualityOverride/${overrideId}`, versionId: '1' }],
      receipt: { alerts: check.alerts, gate: check.gate, override: { note: override.note, reasonCode: override.reasonCode }, overrideId, recordedAt },
    }
  }

  #check(context: ActorContext, gate: ClinicalQualityGate, facts: Facts): ClinicalQualityCheck {
    const medications = facts.medications ?? []
    const redLines: ClinicalQualityRedLine[] = [], alerts: ClinicalQualityAlert[] = []
    if (facts.allergyCodes !== undefined) {
      for (const medication of medications) {
        if (medication.code !== undefined && facts.allergyCodes.has(medication.code)) {
          redLines.push({ code: 'MEDICATION_ALLERGY_CONFLICT', tier: 'red-line', message: `${medication.display}与已确认的有效药物过敏冲突。`, evidence: [], catalogItemId: medication.catalogItemId })
        }
      }
    }
    redLines.push(...doseLimitFindings(medications))
    redLines.push(...classDuplicationFindings(medications, facts.activeMedications))
    if (medications.some(medication => medication.pharmacologyClasses.some(item => (renalMonitoredClasses as readonly string[]).includes(item))) && facts.renal !== undefined) {
      const renal = renalMedicationFindings(medications, facts.renal())
      redLines.push(...renal.redLines)
      alerts.push(...renal.alerts)
    }
    alerts.push(...antibioticIndicationFindings(medications, facts.diagnosisCodes ?? []))
    return this.#result(context, gate, redLines, alerts)
  }

  #result(context: ActorContext, gate: ClinicalQualityGate, redLines: ClinicalQualityRedLine[], alerts: ClinicalQualityAlert[]): ClinicalQualityCheck {
    return {
      alerts,
      evaluatedAt: this.#outpatient.virtualTime(context),
      gate,
      redLines,
      status: redLines.length > 0 ? 'blocked' : alerts.length > 0 ? 'alert' : 'pass',
    }
  }

  #auditedRead(context: ActorContext, operation: string, input: unknown, read: () => ClinicalQualityCheck): ClinicalQualityCheck {
    let result: ClinicalQualityCheck
    try {
      result = read()
    } catch (error) {
      try { this.#commands.auditRead(context, operation, input, 'failed') } catch { /* preserve original error */ }
      throw error
    }
    this.#commands.auditRead(context, operation, input, 'success')
    return result
  }
}

export class ClinicalQualityReadError extends Error {
  readonly code = 'CLINICAL_QUALITY_INPUT_INVALID'
  readonly status = 404
}

function evidence(label: string, value: { sourceReference: string; valueText: string; versionId: string } | undefined): QualityEvidence | undefined {
  return value === undefined ? undefined : { label: `${label}：${value.valueText}`.slice(0, 240), reference: value.sourceReference, versionId: value.versionId }
}

function renalFact(bundle: ClinicalScoreBundle): RenalFunctionFact {
  const egfr = bundle.scores.find(score => score.id === 'ckd-epi-2021-egfr')
  if (egfr?.status === 'complete') {
    return { status: 'measured', egfr: egfr.value, evidence: egfr.sourceReferences.map(item => ({ label: item.label.slice(0, 240), reference: item.reference, versionId: item.versionId })) }
  }
  return egfr?.missingInputs.includes('serumCreatinine') ? { status: 'creatinine-missing' } : { status: 'not-computable' }
}
