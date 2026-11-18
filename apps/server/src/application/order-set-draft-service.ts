import type {
  OrderSetCandidate,
  OrderSetDraft,
  OrderSetDraftBundle,
  OrderSetDraftItem,
  OrderSetPatientFacts,
  OrderSetReason,
  OrderSetScope,
  OrderSetTemplate,
  OrderSetTemplateId,
  OrderSetTemplateItem,
  OrderSetTemplateList,
  OrderSetTemplateOption,
} from '@clinmesh/contracts/order-set-templates'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import { medicationSafetyRuleSchema } from '@clinmesh/contracts/medication-safety'
import type { ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import { resolveInpatientDose } from '@clinmesh/core/inpatient-dose'
import { medicationDailyFrequency, medicationQuantityAllowed, medicationRegimenDoseAllowed } from '@clinmesh/core/medication-safety'
import {
  orderSetAllergyReason,
  orderSetDisposition,
  orderSetOutpatientQuantity,
  screenOrderSetRules,
  type OrderSetScreeningFacts,
} from '@clinmesh/core/order-set-screening'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ClinicalScoreService } from './clinical-score-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { ExaminationRequestService } from './examination-request-service.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { laboratoryOutpatientPrice } from './outpatient-investigation-billing.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { orderSetTemplate, orderSetTemplates } from './order-set-template-registry.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { WorkflowError } from './workflow-error.ts'

type Resolution = { candidate: OrderSetCandidate; codes?: readonly string[] } | { unavailable: OrderSetReason }
type Allergy = OrderSetPatientFacts['allergies'][number]

interface CatalogResolver {
  laboratory(option: Extract<OrderSetTemplateOption, { kind: 'laboratory' }>): Resolution
  examination(option: Extract<OrderSetTemplateOption, { kind: 'examination' }>): Resolution
  medication(option: Extract<OrderSetTemplateOption, { kind: 'medication' }>): Resolution
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
  availableScopes: z.array(z.string()).optional(),
  drugConcept: z.object({ code: z.string().optional() }).optional(),
  inpatientDoseBasis: z.object({ amount: z.number().positive(), unit: z.string().min(1) }).optional(),
  product: z.object({ code: z.string().optional(), strength: z.string().optional() }).optional(),
  safety: medicationSafetyRuleSchema.optional(),
})
const medicationRowSchema = z.object({ code: z.string(), config_json: z.string(), item_id: z.string(), name_zh: z.string(), version: z.number().int().positive() })

function unavailable(code: 'catalog-unavailable' | 'catalog-rule-mismatch' | 'catalog-unpriced', messageZh: string): { unavailable: OrderSetReason } {
  return { unavailable: { code, messageZh, observedValue: null, severity: 'unavailable', sourceReference: null, threshold: null } }
}

function candidateCatalogId(candidate: OrderSetCandidate): string {
  return candidate.kind === 'examination' ? candidate.serviceId : candidate.catalogItemId
}

/** 门诊与住院共用的组套草稿预装配：只读取正式事实与院内目录，不写入任何业务表。 */
export class OrderSetDraftService {
  readonly #clinicalScores: ClinicalScoreService
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #examination: ExaminationRequestService
  readonly #fhir: FhirRepository
  readonly #outpatient: OutpatientWorkflowContext

  constructor(options: {
    clinicalScores: ClinicalScoreService
    commands: CommandExecutor
    database: ClinMeshDatabase
    examination: ExaminationRequestService
    fhir: FhirRepository
    outpatientContext: OutpatientWorkflowContext
  }) {
    this.#clinicalScores = options.clinicalScores
    this.#commands = options.commands
    this.#database = options.database
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
      const items = scope === undefined ? [...orderSetTemplates] : orderSetTemplates.filter(template => template.scopes.includes(scope))
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
      const templates = this.#templates('outpatient', templateId, reason => new WorkflowError('WORKFLOW_CONFLICT', reason, undefined, 'ORDER_SET_SCOPE_NOT_APPLICABLE'))
      const row = z.object({ encounter_id: z.string(), patient_id: z.string() }).parse(this.#database.driver.prepare(`
        SELECT encounter_id, patient_id FROM outpatient_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId))
      const scores = this.#clinicalScores.outpatientSnapshot(context, caseId)
      const vitals = scores.vitalSigns
      const facts = this.#facts(
        context,
        row.patient_id,
        scores,
        'triage',
        vitals?.weightKg === undefined ? undefined : { ...vitals, weightKg: vitals.weightKg },
      )
      const bundle = this.#bundle(templates, 'outpatient', facts, this.#outpatientCatalog(context), {
        caseId, encounterId: row.encounter_id, encounterVersion: scores.encounterVersion, scope: 'outpatient',
      }, this.#outpatient.virtualTime(context))
      this.#commands.auditRead(context, 'doctor.case.order-set-drafts.read', auditInput, 'success')
      return bundle
    } catch (error) {
      try { this.#commands.auditRead(context, 'doctor.case.order-set-drafts.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readInpatient(inpatient: InpatientService, context: ActorContext, admissionId: string, templateId?: OrderSetTemplateId): OrderSetDraftBundle {
    const auditInput = templateId === undefined ? { admissionId } : { admissionId, templateId }
    try {
      inpatient.assertRole(context, ['inpatient-doctor'])
      const binding = inpatient.admissionBinding(context, admissionId)
      const templates = this.#templates('inpatient', templateId, reason => new InpatientError('ORDER_SET_SCOPE_NOT_APPLICABLE', reason))
      const scores = this.#clinicalScores.inpatientSnapshot(inpatient, context, admissionId)
      const weighted = this.#clinicalScores.latestInpatientVitalSignsWithWeight(context, admissionId)
      const facts = this.#facts(
        context,
        binding.patientId,
        scores,
        'inpatient-nursing',
        weighted?.weightKg === undefined ? undefined : { ...weighted, weightKg: weighted.weightKg },
      )
      const bundle = this.#bundle(templates, 'inpatient', facts, this.#inpatientCatalog(inpatient, context), {
        admissionId, encounterVersion: scores.encounterVersion, scope: 'inpatient',
      }, inpatient.virtualTime(context))
      inpatient.commands.auditRead(context, 'inpatient.order-set-drafts.read', auditInput, 'success')
      return bundle
    } catch (error) {
      try { inpatient.commands.auditRead(context, 'inpatient.order-set-drafts.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  #templates(scope: OrderSetScope, templateId: OrderSetTemplateId | undefined, conflict: (reason: string) => Error): OrderSetTemplate[] {
    if (templateId === undefined) return orderSetTemplates.filter(template => template.scopes.includes(scope))
    const template = orderSetTemplate(templateId)
    if (!template.scopes.includes(scope)) throw conflict(`组套 ${template.titleZh} 不适用于${scope === 'outpatient' ? '门诊' : '住院'}`)
    return [template]
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

  #bundle(
    templates: OrderSetTemplate[],
    scope: OrderSetScope,
    facts: OrderSetPatientFacts,
    catalog: CatalogResolver,
    target: OrderSetDraftBundle['target'],
    evaluatedAt: string,
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
    const drafts = templates.map((template): OrderSetDraft => {
      const items = template.items.filter(item => item.scopes.includes(scope))
        .map(item => evaluateItem(item, screening, facts, catalog))
      const count = (disposition: OrderSetDraftItem['disposition']) => items.filter(item => item.disposition === disposition).length
      const { items: _templateItems, ...templateSummary } = template
      return {
        counts: { excluded: count('excluded'), needsReview: count('needs-review'), ready: count('ready'), unavailable: count('unavailable') },
        fingerprint: canonicalJsonHash({ facts, items, target, template: { fingerprint: template.fingerprint, id: template.id, version: template.version } }),
        items,
        template: templateSummary,
      }
    })
    return { drafts, evaluatedAt, patientFacts: facts, target }
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
        const strength = config.inpatientDoseBasis === undefined ? config.product?.strength : `${config.inpatientDoseBasis.amount} ${config.inpatientDoseBasis.unit}`
        const quantity = strength === undefined ? undefined : orderSetOutpatientQuantity({ courseDays: option.courseDays, doseText: option.doseText,
          frequencyCode: option.frequencyCode, prnQuantity: option.prnQuantity, strength })
        if ((config.availableScopes !== undefined && !config.availableScopes.includes('outpatient'))
          || (config.allowedCourseDays !== undefined && !config.allowedCourseDays.includes(option.courseDays))
          || !medicationRegimenDoseAllowed(config, option.doseText, option.frequencyCode)
          || quantity === undefined || !medicationQuantityAllowed(config, quantity, option.courseDays, option.frequencyCode)) {
          return unavailable('catalog-rule-mismatch', `${row.name_zh} 的组套剂量、频次或数量不符合本院门诊药事规则`)
        }
        return {
          candidate: { catalogItemId: row.item_id, catalogVersion: row.version, display: row.name_zh, doseText: option.doseText,
            frequencyCode: option.frequencyCode, inpatient: null, instructionsZh: option.instructionsZh ?? null, kind: 'medication',
            outpatient: { courseDays: option.frequencyCode === 'ONCE' ? 1 : option.courseDays, quantity } },
          codes,
        }
      },
    }
  }

  #inpatientCatalog(inpatient: InpatientService, context: ActorContext): CatalogResolver {
    const investigations = inpatient.investigations.catalog(context, new Set()).items
    const medications = inpatient.orders.medications(context)
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
        const services = this.#laboratoryServices(context, option)
        if (services.length === 0) return unavailable('catalog-unavailable', '本院目录未发布该检验项目')
        const entries = services.flatMap(service => {
          const matched = investigations.find(candidate => candidate.id === service.id && candidate.kind === 'laboratory')
          return matched === undefined ? [] : [matched]
        })
        const ready = entries.find(entry => entry.available && entry.priceFen !== undefined)
        if (ready === undefined) {
          return entries.some(entry => entry.unavailableReason === 'unpriced' || entry.priceFen === undefined)
            ? unavailable('catalog-unpriced', `${services[0]!.nameZh} 未声明住院价目`)
            : unavailable('catalog-unavailable', `${services[0]!.nameZh} 本院住院暂未开展`)
        }
        const indicationCodes = ready.indicationCodes.length > 0 ? ready.indicationCodes : ['clinical-evaluation']
        return { candidate: { catalogItemId: ready.id, catalogVersion: ready.version, display: ready.display,
          indicationCode: indicationCodes[0]!, indicationCodes, kind: 'laboratory', outpatientBilling: null, priceFen: ready.priceFen! } }
      },
      medication: option => {
        const resolved = this.#medicationEntry(context, option.medicationKey)
        const item = resolved === undefined ? undefined : medications.find(candidate => candidate.id === resolved.row.item_id)
        if (resolved === undefined || item === undefined) return unavailable('catalog-unavailable', '本院住院药品目录未启用该药品')
        const dose = resolveInpatientDose({ doses: item.doses, unit: item.unit, ...(item.doseBasis ? { doseBasis: item.doseBasis } : {}),
          ...(item.maxDoseQuantity === undefined ? {} : { maxDoseQuantity: item.maxDoseQuantity }) }, option.doseText)
        if (!('quantity' in dose) || !item.frequencyCodes.includes(option.frequencyCode)
          || (item.safety !== undefined && dose.quantity * medicationDailyFrequency(option.frequencyCode) > item.safety.maximumDailyQuantity)) {
          return unavailable('catalog-rule-mismatch', `${item.display} 的组套剂量或频次不符合本院住院药事规则`)
        }
        return {
          candidate: { catalogItemId: item.id, catalogVersion: item.version, display: item.display, doseText: option.doseText,
            frequencyCode: option.frequencyCode, inpatient: { doseQuantity: dose.quantity, duration: option.inpatientDuration },
            instructionsZh: option.instructionsZh ?? null, kind: 'medication', outpatient: null },
          codes: resolved.codes,
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
function evaluateItem(item: OrderSetTemplateItem, facts: OrderSetScreeningFacts, patient: OrderSetPatientFacts, catalog: CatalogResolver): OrderSetDraftItem {
  const base = { key: item.key, kind: item.kind, titleZh: item.titleZh }
  const itemReasons = screenOrderSetRules(item.rules, facts)
  const unavailableReasons: OrderSetReason[] = []
  for (const option of item.options) {
    const resolution = option.kind === 'laboratory' ? catalog.laboratory(option)
      : option.kind === 'examination' ? catalog.examination(option) : catalog.medication(option)
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
    const finalReasons = dedupe(reasons)
    const disposition = orderSetDisposition(finalReasons)
    if (disposition === 'excluded') {
      return { ...base, candidate: null, disposition: 'excluded', matchedCatalogId, reasons: finalReasons }
    }
    return { ...base, candidate: resolution.candidate, disposition, matchedCatalogId, reasons: finalReasons }
  }
  return { ...base, candidate: null, disposition: 'unavailable', matchedCatalogId: null, reasons: dedupe(unavailableReasons) }
}
