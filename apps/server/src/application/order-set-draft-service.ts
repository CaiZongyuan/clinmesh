import type {
  OrderSetCandidate,
  OrderSetDraft,
  OrderSetDraftBundle,
  OrderSetDraftItem,
  OrderSetPatientFacts,
  OrderSetReason,
  OrderSetScope,
  OrderSetTemplateId,
  OrderSetTemplateItem,
  OrderSetTemplateList,
  OrderSetTemplateOption,
} from '@clinmesh/contracts/order-set-templates'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import type { PreopOrderPolicy } from '@clinmesh/contracts/inpatient-surgery'
import { medicationRouteSchema, medicationSafetyRuleSchema } from '@clinmesh/contracts/medication-safety'
import type { ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import { resolveInpatientDose } from '@clinmesh/core/inpatient-dose'
import { medicationDailyFrequency, medicationQuantityAllowed, medicationRegimenDoseAllowed, medicationRouteAllowed } from '@clinmesh/core/medication-safety'
import {
  orderSetAllergyReason,
  orderSetDisposition,
  orderSetOutpatientQuantity,
  screenOrderSetActiveOrder,
  screenOrderSetInFlightInvestigation,
  screenOrderSetRules,
  type OrderSetActiveOrderFact,
  type OrderSetInFlightInvestigationFact,
  type OrderSetScreeningFacts,
} from '@clinmesh/core/order-set-screening'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ClinicalScoreService } from './clinical-score-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { DiseasePackRuntimeService } from './disease-pack-runtime-service.ts'
import type { ExaminationRequestService } from './examination-request-service.ts'
import { resolveCatalogMedicationRoutes } from './inpatient-medication-config.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { laboratoryOutpatientPrice } from './outpatient-investigation-billing.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import {
  getOrderSetTemplateEntry,
  listOrderSetTemplates,
  listRegisteredOrderSetEntries,
  type RegisteredOrderSetTemplateEntry,
} from './order-set-template-registry.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { WorkflowError } from './workflow-error.ts'
import { type PackSourceSummary } from '@clinmesh/contracts/guideline-topics'

type Resolution = {
  candidate: OrderSetCandidate
  codes?: readonly string[]
  drugConceptCode?: string | undefined
  genericName?: string | undefined
  pharmacologyClasses?: readonly string[]
  referenceCode?: string
} | { unavailable: OrderSetReason }
type Allergy = OrderSetPatientFacts['allergies'][number]

interface CatalogResolver {
  laboratory(option: Extract<OrderSetTemplateOption, { kind: 'laboratory' }>): Resolution
  examination(option: Extract<OrderSetTemplateOption, { kind: 'examination' }>): Resolution
  medication(option: Extract<OrderSetTemplateOption, { kind: 'medication' }>): Resolution
  service(option: Extract<OrderSetTemplateOption, { kind: 'service' }>): Resolution
}

interface ActiveDeduplicationContext {
  activeOrders: readonly OrderSetActiveOrderFact[]
  inFlightInvestigations: readonly OrderSetInFlightInvestigationFact[]
  alwaysApply: boolean
}

const allergySchema = z.object({
  category: z.array(z.string()).optional(),
  clinicalStatus: z.object({ coding: z.array(z.object({ code: z.string() })).optional() }).optional(),
  code: z.object({ coding: z.array(z.object({ code: z.string(), display: z.string().optional() })).optional(), text: z.string().optional() }).optional(),
  id: z.string(),
  verificationStatus: z.object({ coding: z.array(z.object({ code: z.string() })).optional() }).optional(),
})
const medicationConfigSchema = z.object({
  allowedCourseDays: z.array(z.number()).optional(),
  allowedDoseTexts: z.array(z.string()).default([]),
  allowedFrequencyCodes: z.array(z.string()).default([]),
  allowedQuantities: z.array(z.number()).default([]),
  allowedRouteCodes: z.array(medicationRouteSchema).min(1).optional(),
  availableScopes: z.array(z.string()).optional(),
  defaultRouteCode: medicationRouteSchema.optional(),
  drugConcept: z.object({ code: z.string().optional(), display: z.string().optional() }).optional(),
  inpatientDoseBasis: z.object({ amount: z.number().positive(), unit: z.string().min(1) }).optional(),
  product: z.object({ code: z.string().optional(), dosageForm: z.string().optional(), genericName: z.string().optional(), strength: z.string().optional() }).optional(),
  route: z.string().optional(),
  safety: medicationSafetyRuleSchema.optional(),
})
const medicationRowSchema = z.object({ code: z.string(), config_json: z.string(), item_id: z.string(), name_zh: z.string(), version: z.number().int().positive() })

function unavailable(code: 'catalog-unavailable' | 'catalog-rule-mismatch' | 'catalog-unpriced', messageZh: string): { unavailable: OrderSetReason } {
  return { unavailable: { code, messageZh, observedValue: null, severity: 'unavailable', sourceReference: null, threshold: null } }
}

const reducedHydrationInstructionsZh = '静脉滴注，合并心力衰竭或 LVEF ≤ 35% 按 0.5 mL/kg/h 减量调整滴速，覆盖造影前 3–12 h 至术后 6–24 h'

function candidateCatalogId(candidate: OrderSetCandidate): string {
  return candidate.kind === 'examination' || candidate.kind === 'service' ? candidate.serviceId : candidate.catalogItemId
}

/** 门诊与住院共用的组套草稿预装配：只读取正式事实与院内目录，不写入任何业务表。 */
export class OrderSetDraftService {
  readonly #clinicalScores: ClinicalScoreService
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #diseasePacks: DiseasePackRuntimeService | undefined
  readonly #examination: ExaminationRequestService
  readonly #fhir: FhirRepository
  readonly #outpatient: OutpatientWorkflowContext

  constructor(options: {
    clinicalScores: ClinicalScoreService
    commands: CommandExecutor
    database: ClinMeshDatabase
    diseasePacks?: DiseasePackRuntimeService
    examination: ExaminationRequestService
    fhir: FhirRepository
    outpatientContext: OutpatientWorkflowContext
  }) {
    this.#clinicalScores = options.clinicalScores
    this.#commands = options.commands
    this.#database = options.database
    this.#diseasePacks = options.diseasePacks
    this.#examination = options.examination
    this.#fhir = options.fhir
    this.#outpatient = options.outpatientContext
  }

  listTemplates(context: ActorContext, scope?: OrderSetScope): OrderSetTemplateList {
    const auditInput = scope === undefined ? {} : { scope }
    try {
      if (!['administrator', 'outpatient-doctor', 'inpatient-doctor'].includes(context.roleCode)) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', '当前岗位无权读取专病组套模板定义')
      }
      const all = listOrderSetTemplates(this.#diseasePacks?.registry)
      const items = scope === undefined ? [...all] : all.filter(template => template.scopes.includes(scope))
      this.#commands.auditRead(context, 'catalog.order-set-templates.list', auditInput, 'success')
      return { items }
    } catch (error) {
      try { this.#commands.auditRead(context, 'catalog.order-set-templates.list', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readOutpatient(context: ActorContext, caseId: string, templateId?: OrderSetTemplateId): OrderSetDraftBundle {
    const auditInput = templateId === undefined ? { caseId } : { caseId, templateId }
    try {
      this.#outpatient.requireDoctorCase(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const row = z.object({ encounter_id: z.string(), patient_id: z.string() }).parse(this.#database.driver.prepare(`
        SELECT encounter_id, patient_id FROM outpatient_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId))
      const evaluatedAt = this.#outpatient.virtualTime(context)
      const activeRuntime = this.#diseasePacks?.activeRuntimeSummaryForSubject(
        context,
        { id: caseId, kind: 'outpatient', patientId: row.patient_id },
        evaluatedAt,
      )
      const entries = this.#templates(
        'outpatient',
        templateId,
        reason => new WorkflowError('WORKFLOW_CONFLICT', reason, undefined, 'ORDER_SET_SCOPE_NOT_APPLICABLE'),
        activeRuntime,
      )
      const scores = this.#clinicalScores.outpatientSnapshot(context, caseId)
      const vitals = scores.vitalSigns
      const facts = this.#facts(
        context,
        row.patient_id,
        scores,
        'triage',
        vitals?.weightKg === undefined ? undefined : { ...vitals, weightKg: vitals.weightKg },
      )
      const bundle = this.#bundle(entries, 'outpatient', facts, this.#outpatientCatalog(context), {
        caseId, encounterId: row.encounter_id, encounterVersion: scores.encounterVersion, scope: 'outpatient',
      }, evaluatedAt, undefined, undefined, activeRuntime, templateId !== undefined)
      this.#commands.auditRead(context, 'doctor.case.order-set-drafts.read', auditInput, 'success')
      return bundle
    } catch (error) {
      try { this.#commands.auditRead(context, 'doctor.case.order-set-drafts.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readInpatient(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    templateIdOrOptions?: OrderSetTemplateId | { surgeryExecutionId?: string | undefined; templateId?: OrderSetTemplateId | undefined },
  ): OrderSetDraftBundle {
    const options = typeof templateIdOrOptions === 'string'
      ? { templateId: templateIdOrOptions }
      : (templateIdOrOptions ?? {})
    const { surgeryExecutionId, templateId } = options
    const auditInput = {
      admissionId,
      ...(templateId === undefined ? {} : { templateId }),
      ...(surgeryExecutionId === undefined ? {} : { surgeryExecutionId }),
    }
    try {
      inpatient.assertRole(context, ['inpatient-doctor'])
      const binding = inpatient.admissionBinding(context, admissionId)
      let surgeryContext: {
        executionId: string
        procedureCode: string
        procedureDisplay: string
        preopOrderPolicy: PreopOrderPolicy
      } | undefined
      if (surgeryExecutionId !== undefined) {
        inpatient.surgery.assertExecution(context, admissionId, surgeryExecutionId)
        const surgery = inpatient.surgery.read(context, admissionId)
        const execution = surgery.executions.find(item => item.id === surgeryExecutionId)
        const request = execution === undefined ? undefined : surgery.requests.find(item => item.id === execution.requestId)
        if (execution === undefined || request === undefined) {
          throw new InpatientError('INPATIENT_SURGERY_EXECUTION_REQUIRED', '术后医嘱组套须引用本次住院已完成的手术')
        }
        surgeryContext = {
          executionId: execution.id,
          preopOrderPolicy: request.preopOrderPolicy,
          procedureCode: execution.actualProcedure.coding.code,
          procedureDisplay: execution.actualProcedure.coding.display,
        }
      }
      const evaluatedAt = inpatient.virtualTime(context)
      const activeRuntime = this.#diseasePacks?.activeRuntimeSummaryForSubject(
        context,
        { id: admissionId, kind: 'inpatient', patientId: binding.patientId },
        evaluatedAt,
      )
      const entries = this.#inpatientTemplates(templateId, surgeryContext, activeRuntime)
      const scores = this.#clinicalScores.inpatientSnapshot(inpatient, context, admissionId)
      const weighted = this.#clinicalScores.latestInpatientVitalSignsWithWeight(context, admissionId)
      const facts = this.#facts(
        context,
        binding.patientId,
        scores,
        'inpatient-nursing',
        weighted?.weightKg === undefined ? undefined : { ...weighted, weightKg: weighted.weightKg },
      )
      const deduplication = this.#inpatientDeduplicationContext(inpatient, context, admissionId, surgeryContext !== undefined)
      const target: OrderSetDraftBundle['target'] = {
        admissionId,
        encounterVersion: scores.encounterVersion,
        scope: 'inpatient',
        ...(surgeryContext === undefined
          ? {}
          : {
              preopOrderPolicy: surgeryContext.preopOrderPolicy,
              surgeryExecutionId: surgeryContext.executionId,
              surgeryProcedureCode: surgeryContext.procedureCode,
              surgeryProcedureDisplay: surgeryContext.procedureDisplay,
            }),
      }
      const bundle = this.#bundle(
        entries,
        'inpatient',
        facts,
        this.#inpatientCatalog(inpatient, context),
        target,
        evaluatedAt,
        this.#hydrationCautions(inpatient, context, admissionId, scores),
        deduplication,
        activeRuntime,
        templateId !== undefined,
      )
      inpatient.commands.auditRead(context, 'inpatient.order-set-drafts.read', auditInput, 'success')
      return bundle
    } catch (error) {
      try { inpatient.commands.auditRead(context, 'inpatient.order-set-drafts.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  #inpatientDeduplicationContext(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    alwaysApply: boolean,
  ): ActiveDeduplicationContext {
    const activeOrders: OrderSetActiveOrderFact[] = inpatient.orders.facts(context, admissionId).orders
      .filter(order => ['signed', 'verified'].includes(order.state))
      .map(order => {
        if (order.kind === 'medication') {
          const row = z.object({ code: z.string(), config_json: z.string() }).optional().parse(this.#database.driver.prepare(
            "SELECT code, config_json FROM outpatient_catalog WHERE workspace_id = ? AND epoch = ? AND item_id = ? AND kind = 'medication'",
          ).get(context.workspaceId, context.epoch, order.catalogItemId))
          const parsedConfig = row === undefined ? undefined : medicationConfigSchema.safeParse(JSON.parse(row.config_json))
          const config = parsedConfig?.success ? parsedConfig.data : undefined
          return {
            catalogItemId: order.catalogItemId,
            code: row?.code,
            display: order.display,
            drugConceptCode: config?.drugConcept?.code,
            duration: order.duration,
            genericName: config?.product?.genericName ?? config?.drugConcept?.display,
            kind: 'medication' as const,
            orderId: order.id,
            pharmacologyClasses: inpatient.workflow.clinicalQuality.medicationClasses(context, order.catalogItemId),
            reference: `MedicationRequest/${order.id}`,
          }
        }
        return {
          catalogItemId: order.catalogItemId,
          display: order.display,
          duration: order.duration,
          kind: 'service' as const,
          orderId: order.id,
          reference: `ServiceRequest/${order.id}`,
        }
      })
    const investigations = inpatient.investigations.readSnapshot(context, admissionId)
    const inFlightStatuses = new Set(['issued', 'accepted', 'in-progress', 'generation-failed'])
    const inFlightInvestigations: OrderSetInFlightInvestigationFact[] = [
      ...investigations.laboratoryRequests
        .filter(request => inFlightStatuses.has(request.status))
        .map(request => ({
          catalogItemId: request.catalogItemId,
          display: request.laboratoryService?.nameZh ?? request.referenceConcept?.display ?? request.catalogItemId,
          kind: 'laboratory' as const,
          reference: `ServiceRequest/${request.serviceRequestId}`,
          referenceCode: request.laboratoryService?.referenceConcept.code ?? request.referenceConcept?.code,
          status: request.status,
        })),
      ...investigations.examinationRequests
        .filter(request => inFlightStatuses.has(request.status))
        .map(request => ({
          catalogItemId: request.service.id,
          display: request.service.name,
          examCode: request.service.examCode,
          kind: 'examination' as const,
          reference: `ServiceRequest/${request.serviceRequestId}`,
          status: request.status,
        })),
    ]
    return { activeOrders, alwaysApply, inFlightInvestigations }
  }

  #inpatientTemplates(
    templateId: OrderSetTemplateId | undefined,
    surgeryContext: { procedureCode: string; procedureDisplay: string } | undefined,
    activeRuntime?: { allowedPackOrderSetIds: readonly string[]; hasStageScopeRestriction: boolean },
  ): RegisteredOrderSetTemplateEntry[] {
    if (templateId === undefined) {
      const allowedPackIds = activeRuntime?.hasStageScopeRestriction === true
        ? new Set(activeRuntime.allowedPackOrderSetIds)
        : undefined
      return listRegisteredOrderSetEntries(this.#diseasePacks?.registry).filter(entry =>
        entry.template.scopes.includes('inpatient')
        && (entry.ownerPack === undefined || allowedPackIds === undefined || allowedPackIds.has(entry.template.id))
        && (surgeryContext === undefined
          ? entry.template.applicableProcedureCodes === undefined
          : entry.template.applicableProcedureCodes?.includes(surgeryContext.procedureCode) === true))
    }
    const [entry] = this.#templates(
      'inpatient',
      templateId,
      reason => new InpatientError('ORDER_SET_SCOPE_NOT_APPLICABLE', reason),
      activeRuntime,
    )
    const template = entry!.template
    if (template.applicableProcedureCodes !== undefined) {
      if (surgeryContext === undefined) {
        throw new InpatientError('ORDER_SET_SCOPE_NOT_APPLICABLE', `术后组套 ${template.titleZh} 须绑定适用术式的已完成手术`)
      }
      if (!template.applicableProcedureCodes.includes(surgeryContext.procedureCode)) {
        throw new InpatientError(
          'ORDER_SET_SCOPE_NOT_APPLICABLE',
          `术后组套 ${template.titleZh} 不适用于已完成术式 ${surgeryContext.procedureDisplay}（${surgeryContext.procedureCode}）`,
        )
      }
    }
    return [entry!]
  }

  #templates(
    scope: OrderSetScope,
    templateId: OrderSetTemplateId | undefined,
    conflict: (reason: string) => Error,
    activeRuntime?: { allowedPackOrderSetIds: readonly string[]; hasStageScopeRestriction: boolean },
  ): RegisteredOrderSetTemplateEntry[] {
    if (templateId === undefined) {
      const allowedPackIds = activeRuntime?.hasStageScopeRestriction === true
        ? new Set(activeRuntime.allowedPackOrderSetIds)
        : undefined
      return listRegisteredOrderSetEntries(this.#diseasePacks?.registry).filter(entry => (
        entry.template.scopes.includes(scope)
        && (entry.ownerPack === undefined || allowedPackIds === undefined || allowedPackIds.has(entry.template.id))
      ))
    }
    const entry = getOrderSetTemplateEntry(templateId, this.#diseasePacks?.registry)
    if (!entry.template.scopes.includes(scope)) throw conflict(`组套 ${entry.template.titleZh} 不适用于${scope === 'outpatient' ? '门诊' : '住院'}`)
    return [entry]
  }

  #facts(
    context: ActorContext,
    patientId: string,
    scores: ClinicalScoreBundle,
    vitalSource: 'triage' | 'inpatient-nursing',
    weighted: { observationId: string; observationVersion: string; recordedAt: string; weightKg: number } | undefined,
  ): OrderSetPatientFacts {
    const egfr = scores.scores.find(score => score.id === 'ckd-epi-2021-egfr')!
    const vitals = scores.vitalSigns
    const allergies = this.#fhir.search(context, 'AllergyIntolerance', new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })).resources
      .flatMap(resource => {
        const allergy = allergySchema.parse(resource)
        if (!allergy.category?.includes('medication') || !allergy.clinicalStatus?.coding?.some(item => item.code === 'active')
          || !allergy.verificationStatus?.coding?.some(item => item.code === 'confirmed')) return []
        return (allergy.code?.coding ?? []).map(coding => ({
          code: coding.code,
          display: coding.display ?? allergy.code?.text ?? coding.code,
          reference: `AllergyIntolerance/${allergy.id}`,
        }))
      })
    return {
      allergies: allergies.slice(0, 100),
      egfr: egfr.status === 'complete'
        ? { sourceReferences: egfr.sourceReferences.slice(0, 8), status: 'present', valueMlMin173: egfr.value }
        : { missingInputs: egfr.missingInputs, status: 'missing' },
      vitalSigns: vitals === null ? { source: vitalSource, status: 'missing' } : {
        diastolicMmHg: vitals.bloodPressure.diastolicMmHg,
        pulseBpm: vitals.pulseBpm,
        recordedAt: vitals.recordedAt,
        reference: `Observation/${vitals.observationId}`,
        source: vitalSource,
        status: 'present',
        systolicMmHg: vitals.bloodPressure.systolicMmHg,
        versionId: vitals.observationVersion,
      },
      weight: weighted === undefined ? { status: 'missing' } : {
        recordedAt: weighted.recordedAt,
        reference: `Observation/${weighted.observationId}`,
        status: 'present',
        versionId: weighted.observationVersion,
        weightKg: weighted.weightKg,
      },
    }
  }

  #hydrationCautions(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    scores: ClinicalScoreBundle,
  ): OrderSetReason[] {
    const reasons: OrderSetReason[] = []
    const hfDx = inpatient.orders.diagnosis(context, admissionId).entries.find(entry => entry.coding.code.startsWith('I50'))
    if (hfDx !== undefined) {
      reasons.push({
        code: 'heart-failure-or-reduced-lvef',
        messageZh: `已确认心力衰竭诊断（${hfDx.coding.display} ${hfDx.coding.code}）：围术期水化滴速须减至 0.5 mL/kg/h 并严密监测心功能与容量负荷。`,
        observedValue: null,
        severity: 'caution',
        sourceReference: `Condition/${hfDx.conditionId}`,
        threshold: null,
      })
    }
    const killip = scores.riskAssessment?.values.killipClass ?? null
    if (killip !== null && killip !== 'I') {
      reasons.push({
        code: 'heart-failure-or-reduced-lvef',
        messageZh: `住院风险评估提示 Killip ${killip} 级心功能不全：围术期水化滴速须减至 0.5 mL/kg/h 并核对容量状态后再开立。`,
        observedValue: null,
        severity: 'caution',
        sourceReference: `Observation/${scores.riskAssessment!.observationId}`,
        threshold: null,
      })
    }
    const latestTte = this.#examination.state(context, admissionId).requests
      .filter(req => req.service.examCode === 'tte' && (req.status === 'reported' || req.status === 'acknowledged') && req.report !== undefined)
      .toSorted((left, right) => Date.parse(right.report!.issuedAt) - Date.parse(left.report!.issuedAt))[0]?.report
    const lvef = latestTte?.results.find(item => item.code === 'lvef' && typeof item.value === 'number')
    if (latestTte !== undefined && lvef !== undefined && typeof lvef.value === 'number' && lvef.value <= 35) {
      const value = Math.round(lvef.value * 10) / 10
      reasons.push({
        code: 'heart-failure-or-reduced-lvef',
        messageZh: `经胸超声心动图 LVEF ${value}% ≤ 35%：围术期水化滴速须减至 0.5 mL/kg/h 并严密监测容量负荷。`,
        observedValue: value,
        severity: 'caution',
        sourceReference: `DiagnosticReport/${latestTte.diagnosticReportId}`,
        threshold: 35,
      })
    }
    return reasons
  }

  #bundle(
    entries: readonly RegisteredOrderSetTemplateEntry[],
    scope: OrderSetScope,
    facts: OrderSetPatientFacts,
    catalog: CatalogResolver,
    target: OrderSetDraftBundle['target'],
    evaluatedAt: string,
    hydrationCautions: readonly OrderSetReason[] = [],
    deduplication?: ActiveDeduplicationContext,
    activeRuntime?: { primaryPack?: PackSourceSummary | undefined; sourcePacks: readonly PackSourceSummary[] },
    explicitTemplateRequested = false,
  ): OrderSetDraftBundle {
    const vitals = facts.vitalSigns.status === 'present' ? facts.vitalSigns : undefined
    const screening: OrderSetScreeningFacts = {
      egfr: facts.egfr.status === 'present'
        ? { reference: facts.egfr.sourceReferences[0]?.reference ?? null, value: facts.egfr.valueMlMin173 }
        : null,
      pulseBpm: vitals === undefined ? null : { reference: vitals.reference, value: vitals.pulseBpm },
      systolicMmHg: vitals === undefined ? null : { reference: vitals.reference, value: vitals.systolicMmHg },
      weightKg: facts.weight.status === 'present' ? { reference: facts.weight.reference, value: facts.weight.weightKg } : null,
    }
    const drafts = entries.map((entry): OrderSetDraft => {
      const template = entry.template
      const applyDedupe = deduplication !== undefined && (deduplication.alwaysApply || template.applicableProcedureCodes !== undefined)
      const items = template.items.filter(item => item.scopes.includes(scope))
        .map(item => evaluateItem(
          item,
          screening,
          facts,
          catalog,
          item.key === 'isotonic-saline-hydration' || item.key === 'postop-saline-hydration' ? hydrationCautions : [],
          applyDedupe ? deduplication : undefined,
        ))
      const count = (disposition: OrderSetDraftItem['disposition']) => items.filter(item => item.disposition === disposition).length
      const { items: _templateItems, ...templateSummary } = template
      return {
        counts: {
          excluded: count('excluded'),
          needsReview: count('needs-review'),
          ready: count('ready'),
          skipped: count('skipped'),
          unavailable: count('unavailable'),
        },
        fingerprint: canonicalJsonHash({ facts, items, target, template: { fingerprint: template.fingerprint, id: template.id, version: template.version } }),
        items,
        ...(entry.ownerPack === undefined
          ? {}
          : {
              packId: entry.ownerPack.packId,
              packVersion: entry.ownerPack.packVersion,
            }),
        template: templateSummary,
      }
    })
    const derivedSourcePacks = new Map<string, PackSourceSummary>()
    for (const sp of activeRuntime?.sourcePacks ?? []) {
      derivedSourcePacks.set(sp.packId, sp)
    }
    if (derivedSourcePacks.size === 0 && explicitTemplateRequested) {
      for (const entry of entries) {
        if (entry.ownerPack !== undefined) {
          derivedSourcePacks.set(entry.ownerPack.packId, entry.ownerPack)
        }
      }
    }
    const sourcePacks = [...derivedSourcePacks.values()]
    const primaryPack = activeRuntime?.primaryPack ?? sourcePacks[0]
    return {
      drafts,
      evaluatedAt,
      ...(primaryPack === undefined
        ? {}
        : {
            packId: primaryPack.packId,
            packVersion: primaryPack.packVersion,
          }),
      patientFacts: facts,
      ...(sourcePacks.length === 0 ? {} : { sourcePacks }),
      target,
    }
  }

  #outpatientCatalog(context: ActorContext): CatalogResolver {
    const examinations = this.#examination.serviceCatalog(context).items
    return {
      examination: option => {
        const match = examinations.find(item => item.service.examCode === option.examCode)
        if (match === undefined || !match.available) return unavailable('catalog-unavailable', '本院尚未开展该功能检查')
        if (match.service.outpatientBilling === undefined) return unavailable('catalog-unpriced', '该功能检查未配置本院门诊价格')
        return { candidate: { catalogVersion: match.service.version, display: match.service.name, examCode: option.examCode,
          indication: option.indication, kind: 'examination', outpatientBilling: match.service.outpatientBilling,
          priceFen: match.service.outpatientBilling.priceFen, serviceId: match.service.id } }
      },
      laboratory: option => {
        const entry = this.#laboratoryServices(context, option)[0]
        if (entry === undefined) return unavailable('catalog-unavailable', '本院目录未发布该检验项目')
        if (entry.snapshot === undefined) return unavailable('catalog-unavailable', `${entry.nameZh} 本院门诊暂未开展`)
        const service = entry.snapshot
        const price = laboratoryOutpatientPrice(service)
        if (price === undefined) return unavailable('catalog-unpriced', `${service.nameZh} 未配置本院门诊价格`)
        const indicationCodes = service.allowedIndicationCodes.length > 0 ? service.allowedIndicationCodes : ['clinical-evaluation']
        return { candidate: { catalogItemId: service.id, catalogVersion: service.version, display: service.nameZh,
          indicationCode: indicationCodes[0]!, indicationCodes, kind: 'laboratory', outpatientBilling: price, priceFen: price.priceFen } }
      },
      medication: option => {
        const resolved = this.#medicationEntry(context, option.medicationKey)
        if (resolved === undefined) return unavailable('catalog-unavailable', '本院药房未启用该药品')
        const { codes, config, row } = resolved
        const routes = resolveCatalogMedicationRoutes(config, row.name_zh)
        const strength = config.inpatientDoseBasis === undefined ? config.product?.strength : `${config.inpatientDoseBasis.amount} ${config.inpatientDoseBasis.unit}`
        const quantity = strength === undefined ? undefined : orderSetOutpatientQuantity({ courseDays: option.courseDays, doseText: option.doseText,
          frequencyCode: option.frequencyCode, prnQuantity: option.prnQuantity, strength })
        if ((config.availableScopes !== undefined && !config.availableScopes.includes('outpatient'))
          || (config.allowedCourseDays !== undefined && !config.allowedCourseDays.includes(option.courseDays))
          || !medicationRouteAllowed(routes.allowedRouteCodes, option.routeCode)
          || !medicationRegimenDoseAllowed(config, option.doseText, option.frequencyCode)
          || quantity === undefined || !medicationQuantityAllowed(config, quantity, option.courseDays, option.frequencyCode)) {
          return unavailable('catalog-rule-mismatch', `${row.name_zh} 的组套剂量、途径、频次或数量不符合本院门诊药事规则`)
        }
        return {
          candidate: { catalogItemId: row.item_id, catalogVersion: row.version, display: row.name_zh, doseText: option.doseText,
            frequencyCode: option.frequencyCode, inpatient: null, instructionsZh: option.instructionsZh ?? null, kind: 'medication',
            outpatient: { courseDays: option.frequencyCode === 'ONCE' ? 1 : option.courseDays, quantity }, routeCode: option.routeCode },
          codes,
        }
      },
      service: () => unavailable('catalog-unavailable', '病房护理服务仅适用于住院医嘱'),
    }
  }

  #inpatientCatalog(inpatient: InpatientService, context: ActorContext): CatalogResolver {
    const investigations = inpatient.investigations.catalog(context, new Set()).items
    const { medications, services } = inpatient.orders.medicationsAndServices(context)
    return {
      examination: option => {
        const serviceId = z.object({ service_id: z.string() }).optional().parse(this.#database.driver.prepare(`
          SELECT service_id FROM hospital_service_catalog
          WHERE workspace_id = ? AND epoch = ? AND active = 1 AND json_extract(config_json, '$.examinationService.examCode') = ?
          ORDER BY service_id LIMIT 1
        `).get(context.workspaceId, context.epoch, option.examCode))?.service_id
        if (serviceId === undefined) return unavailable('catalog-unavailable', '本院尚未开展该功能检查')
        const item = investigations.find(candidate => candidate.id === serviceId && candidate.kind === 'examination')
        if (item === undefined || item.unavailableReason === 'unpriced' || item.priceFen === undefined) {
          return unavailable('catalog-unpriced', '该功能检查未声明住院价目')
        }
        if (!item.available) return unavailable('catalog-unavailable', '本院住院暂未开展该功能检查')
        return { candidate: { catalogVersion: item.version, display: item.display, examCode: option.examCode, indication: option.indication,
          kind: 'examination', outpatientBilling: null, priceFen: item.priceFen, serviceId: item.id } }
      },
      laboratory: option => {
        const labServices = this.#laboratoryServices(context, option)
        if (labServices.length === 0) return unavailable('catalog-unavailable', '本院目录未发布该检验项目')
        const entries = labServices.flatMap(service => {
          const matched = investigations.find(candidate => candidate.id === service.id && candidate.kind === 'laboratory')
          return matched === undefined ? [] : [matched]
        })
        const ready = entries.find(entry => entry.available && entry.priceFen !== undefined)
        if (ready === undefined) {
          return entries.some(entry => entry.unavailableReason === 'unpriced' || entry.priceFen === undefined)
            ? unavailable('catalog-unpriced', `${labServices[0]!.nameZh} 未声明住院价目`)
            : unavailable('catalog-unavailable', `${labServices[0]!.nameZh} 本院住院暂未开展`)
        }
        const indicationCodes = ready.indicationCodes.length > 0 ? ready.indicationCodes : ['clinical-evaluation']
        return {
          candidate: {
            catalogItemId: ready.id, catalogVersion: ready.version, display: ready.display,
            indicationCode: indicationCodes[0]!, indicationCodes, kind: 'laboratory', outpatientBilling: null, priceFen: ready.priceFen!,
          },
          referenceCode: option.referenceCode,
        }
      },
      medication: option => {
        const resolved = this.#medicationEntry(context, option.medicationKey)
        const item = resolved === undefined ? undefined : medications.find(candidate => candidate.id === resolved.row.item_id)
        if (resolved === undefined || item === undefined) return unavailable('catalog-unavailable', '本院住院药品目录未启用该药品')
        const dose = resolveInpatientDose({ doses: item.doses, unit: item.unit, ...(item.doseBasis ? { doseBasis: item.doseBasis } : {}),
          ...(item.maxDoseQuantity === undefined ? {} : { maxDoseQuantity: item.maxDoseQuantity }) }, option.doseText)
        if (!('quantity' in dose) || !item.frequencyCodes.includes(option.frequencyCode)
          || !medicationRouteAllowed(item.allowedRouteCodes, option.routeCode)
          || (item.safety !== undefined && dose.quantity * medicationDailyFrequency(option.frequencyCode) > item.safety.maximumDailyQuantity)) {
          return unavailable('catalog-rule-mismatch', `${item.display} 的组套剂量、途径或频次不符合本院住院药事规则`)
        }
        return {
          candidate: { catalogItemId: item.id, catalogVersion: item.version, display: item.display, doseText: option.doseText,
            frequencyCode: option.frequencyCode, inpatient: { doseQuantity: dose.quantity, duration: option.inpatientDuration },
            instructionsZh: option.instructionsZh ?? null, kind: 'medication', outpatient: null, routeCode: option.routeCode },
          codes: resolved.codes,
          drugConceptCode: resolved.config.drugConcept?.code,
          genericName: resolved.config.product?.genericName ?? resolved.config.drugConcept?.display,
          pharmacologyClasses: resolved.config.safety?.pharmacologyClasses ?? inpatient.workflow.clinicalQuality.medicationClasses(context, item.id),
        }
      },
      service: option => {
        const item = services.find(candidate => candidate.id === option.serviceId)
        if (item === undefined) return unavailable('catalog-unavailable', '本院住院服务目录未启用该护理服务')
        if (item.priceFen <= 0) return unavailable('catalog-unpriced', `${item.display} 未声明有效住院服务价格`)
        return {
          candidate: {
            display: item.display,
            duration: option.inpatientDuration,
            kind: 'service',
            priceFen: item.priceFen,
            quantity: option.quantity,
            serviceId: item.id,
            serviceVersion: item.version,
            unit: item.unit,
          },
        }
      },
    }
  }

  #laboratoryServices(context: ActorContext, option: Extract<OrderSetTemplateOption, { kind: 'laboratory' }>) {
    return z.array(z.object({ config_json: z.string(), name_zh: z.string(), service_id: z.string() })).parse(this.#database.driver.prepare(`
      SELECT service_id, name_zh, config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND active = 1
        AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.system') = ?
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.code') = ?
      ORDER BY version DESC, service_id
    `).all(context.workspaceId, context.epoch, option.referenceSystem, option.referenceCode))
      .map(row => {
        const parsed = z.object({ laboratoryService: laboratoryServiceSnapshotSchema }).safeParse(JSON.parse(row.config_json))
        return { id: row.service_id, nameZh: row.name_zh, snapshot: parsed.success ? parsed.data.laboratoryService : undefined }
      })
  }

  #medicationEntry(context: ActorContext, key: string) {
    // 常备药品沿用 PCI 固定数据包身份时为 medication-pci-*，其余为 medication-*。
    const primary = `medication-pci-${key}`
    const fallback = `medication-${key}`
    const row = medicationRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT item_id, code, name_zh, version, config_json FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND kind = 'medication' AND active = 1 AND item_id IN (?, ?)
      ORDER BY CASE item_id WHEN ? THEN 0 ELSE 1 END LIMIT 1
    `).get(context.workspaceId, context.epoch, primary, fallback, primary))
    if (row === undefined) return undefined
    const config = medicationConfigSchema.parse(JSON.parse(row.config_json))
    const codes = [row.code, config.product?.code, config.drugConcept?.code].filter((code): code is string => code !== undefined)
    return { codes, config, row }
  }
}

function dedupe(reasons: OrderSetReason[]): OrderSetReason[] {
  const seen = new Set<string>()
  return reasons.filter(reason => {
    const key = `${reason.code}:${reason.severity}:${reason.threshold}:${reason.sourceReference}:${reason.messageZh}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 16)
}

/** 依序尝试同一临床目的的目录编码候选；一旦命中已启用条目则按患者客观禁忌筛选，不在过敏或体征禁用时跨药自动改选。 */
function evaluateItem(
  item: OrderSetTemplateItem,
  facts: OrderSetScreeningFacts,
  patient: OrderSetPatientFacts,
  catalog: CatalogResolver,
  extraReasons: readonly OrderSetReason[] = [],
  deduplication?: ActiveDeduplicationContext,
): OrderSetDraftItem {
  const base = { key: item.key, kind: item.kind, titleZh: item.titleZh }
  const itemReasons = [...screenOrderSetRules(item.rules, facts), ...extraReasons]
  const unavailableReasons: OrderSetReason[] = []
  for (const option of item.options) {
    const resolution = option.kind === 'laboratory' ? catalog.laboratory(option)
      : option.kind === 'examination' ? catalog.examination(option)
        : option.kind === 'service' ? catalog.service(option)
          : catalog.medication(option)
    if ('unavailable' in resolution) {
      unavailableReasons.push(resolution.unavailable)
      continue
    }
    const matchedCatalogId = candidateCatalogId(resolution.candidate)
    const reasons = [...itemReasons]
    if (option.kind === 'medication') {
      reasons.push(...screenOrderSetRules(option.rules, facts))
      const normalizedCodes = new Set((resolution.codes ?? []).map(code => code.trim().toUpperCase()))
      const allergy = patient.allergies.find((candidate: Allergy) => normalizedCodes.has(candidate.code.trim().toUpperCase()))
      if (allergy !== undefined) reasons.push(orderSetAllergyReason(allergy))
    }
    if (deduplication !== undefined) {
      if (resolution.candidate.kind === 'medication') {
        const skipReason = screenOrderSetActiveOrder({
          catalogItemId: resolution.candidate.catalogItemId,
          code: resolution.codes?.[0],
          display: resolution.candidate.display,
          drugConceptCode: resolution.drugConceptCode,
          genericName: resolution.genericName,
          kind: 'medication',
          pharmacologyClasses: resolution.pharmacologyClasses,
        }, deduplication.activeOrders)
        if (skipReason !== undefined) reasons.push(skipReason)
      } else if (resolution.candidate.kind === 'service') {
        const skipReason = screenOrderSetActiveOrder({
          catalogItemId: resolution.candidate.serviceId,
          display: resolution.candidate.display,
          kind: 'service',
        }, deduplication.activeOrders)
        if (skipReason !== undefined) reasons.push(skipReason)
      } else if (resolution.candidate.kind === 'laboratory') {
        const skipReason = screenOrderSetInFlightInvestigation({
          catalogItemId: resolution.candidate.catalogItemId,
          display: resolution.candidate.display,
          kind: 'laboratory',
          referenceCode: resolution.referenceCode,
        }, deduplication.inFlightInvestigations)
        if (skipReason !== undefined) reasons.push(skipReason)
      } else if (resolution.candidate.kind === 'examination') {
        const skipReason = screenOrderSetInFlightInvestigation({
          catalogItemId: resolution.candidate.serviceId,
          display: resolution.candidate.display,
          examCode: resolution.candidate.examCode,
          kind: 'examination',
        }, deduplication.inFlightInvestigations)
        if (skipReason !== undefined) reasons.push(skipReason)
      }
    }
    const finalReasons = dedupe(reasons)
    const disposition = orderSetDisposition(finalReasons)
    if (disposition === 'excluded' || disposition === 'skipped') {
      return { ...base, candidate: null, disposition, matchedCatalogId, reasons: finalReasons }
    }
    const candidate = resolution.candidate.kind === 'medication'
      && (item.key === 'isotonic-saline-hydration' || item.key === 'postop-saline-hydration')
      && extraReasons.length > 0
      ? { ...resolution.candidate, instructionsZh: reducedHydrationInstructionsZh }
      : resolution.candidate
    return { ...base, candidate, disposition, matchedCatalogId, reasons: finalReasons }
  }
  return { ...base, candidate: null, disposition: 'unavailable', matchedCatalogId: null, reasons: dedupe(unavailableReasons) }
}
