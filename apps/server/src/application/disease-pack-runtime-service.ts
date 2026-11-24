import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  diseasePackRuntimeBundleSchema,
  diseasePackRuntimeEntrySchema,
  diseasePackSlugSchema,
  diseasePackTaskFactsResponseSchema,
  diseasePackTaskReadinessResultSchema,
  diseasePackToggleBodySchema,
  diseasePackToolAuthorizeBodySchema,
  type DiseasePack,
  type DiseasePackCatalogList,
  type DiseasePackRuntimeBundle,
  type DiseasePackRuntimeEntry,
  type DiseasePackTaskFactsResponse,
  type DiseasePackTaskReadinessResult,
  type DiseasePackToggleBody,
  type EffectiveDiseasePack,
} from '@clinmesh/contracts/disease-pack'
import {
  DiseasePackValidationError,
  collectDeclaredTaskItemCodes,
  evaluatePackActivation,
  evaluatePackStages,
  evaluateTaskReadiness,
  filterLedgerForTaskView,
  mergeThreeLayerPack,
  scanPackFilesForExecutableCode,
  validateAndParseDiseasePack,
  type PackSourceFileInput,
  type PublicLayerPolicyInput,
} from '@clinmesh/core/disease-pack'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ClinicalFactLedgerService } from './clinical-fact-ledger-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { WorkflowError } from './workflow-error.ts'

export class DiseasePackRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'DiseasePackRuntimeError'
  }
}

const overrideRowSchema = z.object({
  note: z.string().nullable(),
  override_mode: z.enum(['enabled', 'disabled']),
  pack_id: z.string(),
  updated_at: z.string(),
  version: z.number().int().positive(),
}).strict()

const stageAuditLatestSchema = z.object({
  to_stage_id: z.string(),
}).strict()

const auditIdRowSchema = z.object({
  audit_id: z.string().min(1),
}).strict()

const fhirEncounterRefResourceSchema = z.object({
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  id: z.string().min(1),
  resourceType: z.string().min(1),
}).loose()

export function computeDiseasePackFingerprint(pack: {
  manifest: Record<string, unknown>
  [key: string]: unknown
}): string {
  const { fingerprint: _fp, ...manifestBody } = pack.manifest
  return canonicalJsonHash({
    ...pack,
    manifest: manifestBody,
  })
}

function buildBuiltinCoronaryDraftPack(): DiseasePack {
  const unsigned = {
    examSuite: {
      cases: [
        {
          caseId: 'coronary-pci-preop-creatinine-gate',
          expectedActive: true,
          expectedBlockedTaskIds: ['pci-preop-guideline-advice'],
          expectedStageId: 'pci-preop',
          titleZh: '冠心病 PCI 术前肾功就绪门控检验例',
        },
      ],
      passThreshold: 0.85,
    },
    formulaRefs: [
      { formulaId: 'ckd-epi-2021', version: 1 },
      { formulaId: 'cockcroft-gault', version: 1 },
      { formulaId: 'grace-acs', version: 1 },
      { formulaId: 'timi-ua-nstemi', version: 1 },
      { formulaId: 'precise-dapt', version: 1 },
      { formulaId: 'ascvd-ldl-target', version: 1 },
    ],
    inapplicablePopulations: [],
    manifest: {
      dependencies: [],
      fingerprint: '0'.repeat(64),
      id: 'coronary-cad',
      packType: 'full' as const,
      specialty: 'cardiology',
      status: 'draft' as const,
      supportedTasks: ['pci-preop-guideline-advice', 'pci-stent', 'followup-review'],
      titleEn: 'Coronary Artery Disease & PCI Pathway (Draft Reservation)',
      titleZh: '冠心病与 PCI 专病路径（预留草案）',
      version: '2026-11-24.r1',
    },
    qualityTightenings: {
      examPassThreshold: 0.85,
      redLineRules: [
        {
          conditionSummary: 'PCI 术前须完成有效血清肌酐与 eGFR 评估',
          id: 'pci-preop-renal-redline',
          itemCode: '2160-0',
        },
      ],
      validityOverrides: [
        { itemCode: '2160-0', maxValidityDays: 14 },
      ],
    },
    readinessTasks: [
      {
        criticalItems: [
          {
            alternateItemCodes: ['14682-9', '1700404A'],
            category: 'laboratory' as const,
            itemCode: '2160-0',
            labelZh: '血清肌酐 / eGFR',
            maxAgeDays: 14,
          },
        ],
        relevantCategories: ['diagnosis' as const],
        relevantItemCodes: ['2160-0', 'smoking-status'],
        secondaryItems: [
          {
            category: 'bedside-questionnaire' as const,
            itemCode: 'smoking-status',
            labelZh: '吸烟状态',
          },
        ],
        taskId: 'pci-preop-guideline-advice',
        titleZh: 'PCI 术前指南参考意见',
      },
      {
        criticalItems: [
          {
            alternateItemCodes: ['14682-9', '1700404A'],
            category: 'laboratory' as const,
            itemCode: '2160-0',
            labelZh: '血清肌酐 / eGFR',
            maxAgeDays: 14,
          },
        ],
        relevantCategories: ['diagnosis' as const],
        relevantItemCodes: ['2160-0', 'smoking-status'],
        secondaryItems: [
          {
            category: 'bedside-questionnaire' as const,
            itemCode: 'smoking-status',
            labelZh: '吸烟状态',
          },
        ],
        taskId: 'pci-stent',
        titleZh: 'PCI 支架选型指南参考意见',
      },
      {
        criticalItems: [
          {
            alternateItemCodes: ['18262-6', '2089-1', '1700303A'],
            category: 'laboratory' as const,
            itemCode: '13457-7',
            labelZh: '低密度脂蛋白胆固醇 (LDL-C)',
          },
        ],
        relevantCategories: ['medication' as const],
        relevantItemCodes: ['13457-7', '8480-6', '8462-4', 'discharge-time'],
        secondaryItems: [
          {
            category: 'vital-sign' as const,
            itemCode: '8480-6',
            labelZh: '收缩压',
          },
          {
            category: 'vital-sign' as const,
            itemCode: '8462-4',
            labelZh: '舒张压',
          },
          {
            alternateItemCodes: ['18842-5', 'discharge-summary'],
            itemCode: 'discharge-time',
            labelZh: '出院时间',
          },
        ],
        taskId: 'followup-review',
        titleZh: '跨就诊复查核对',
      },
    ],
    stages: [
      {
        entryCondition: {
          category: 'diagnosis' as const,
          itemCodePattern: '^(?:I20|I21|I22|I23|I24|I25)',
          kind: 'fact' as const,
          presence: 'present' as const,
          requireEligible: true,
        },
        id: 'pci-preop',
        order: 1,
        orderSetIds: ['cad-admission-baseline'],
        questionnaireItemCodes: ['smoking-status'],
        taskIds: ['pci-preop-guideline-advice', 'pci-stent', 'followup-review'],
        titleEn: 'PCI Pre-operative Assessment',
        titleZh: 'PCI 术前评估期',
        topicIds: ['pci-stent'],
      },
    ],
    toolPolicy: {
      allowedTools: [
        'inpatient.disease-packs.read',
        'inpatient.disease-pack-task-facts.read',
        'inpatient.guideline-advice.request',
        'inpatient.guideline-topics.read',
        'inpatient.order-set-drafts.read',
        'outpatient.disease-packs.read',
        'outpatient.disease-pack-task-facts.read',
        'outpatient.guideline-topics.read',
        'outpatient.order-set-drafts.read',
      ],
      forbiddenActions: [],
    },
    triggers: [
      {
        condition: {
          category: 'diagnosis' as const,
          itemCodePattern: '^(?:I20|I21|I22|I23|I24|I25)',
          kind: 'fact' as const,
          presence: 'present' as const,
          requireEligible: true,
        },
        descriptionZh: '确认冠心病或急性冠脉综合征诊断',
        id: 'cad-diagnosis-trigger',
      },
    ],
  }
  const fingerprint = computeDiseasePackFingerprint(unsigned)
  return validateAndParseDiseasePack({
    ...unsigned,
    manifest: { ...unsigned.manifest, fingerprint },
  })
}

const SPLIT_PACK_FILES = [
  'triggers.json',
  'stages.json',
  'readiness.json',
  'clinical.json',
  'exam-suite.json',
  'recognition-card.json',
] as const

function parsePackJsonObject(content: string, filename: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new DiseasePackValidationError(
      'PACK_SCHEMA_INVALID',
      `${filename} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const checked = z.record(z.string(), z.unknown()).safeParse(parsed)
  if (!checked.success) {
    throw new DiseasePackValidationError('PACK_SCHEMA_INVALID', `${filename} must be a JSON object`)
  }
  return checked.data
}

export class DiseasePackRegistry {
  readonly #entries = new Map<string, EffectiveDiseasePack>()
  readonly #publicLayer: PublicLayerPolicyInput | undefined

  constructor(options?: {
    publicLayer?: PublicLayerPolicyInput
    includeBuiltinDraftPacks?: boolean
    packs?: readonly unknown[]
    packDirs?: readonly string[]
    overlays?: readonly unknown[]
    verifyFingerprint?: boolean
  }) {
    this.#publicLayer = options?.publicLayer
    if (options?.includeBuiltinDraftPacks !== false) {
      this.registerRawPack(buildBuiltinCoronaryDraftPack(), { verifyFingerprint: true })
    }
    const loadOptions = { verifyFingerprint: options?.verifyFingerprint !== false }
    for (const dir of options?.packDirs ?? []) {
      this.loadDirectory(dir, loadOptions)
    }
    for (const rawPack of options?.packs ?? []) {
      this.registerRawPack(rawPack, loadOptions)
    }
    for (const rawOverlay of options?.overlays ?? []) {
      this.applyHospitalOverlay(rawOverlay)
    }
  }

  registerRawPack(
    rawPack: unknown,
    options?: { files?: readonly PackSourceFileInput[]; overlay?: unknown; verifyFingerprint?: boolean },
  ): EffectiveDiseasePack {
    const parsed = validateAndParseDiseasePack(rawPack, options?.files ? { files: options.files } : undefined)
    if (options?.verifyFingerprint !== false) {
      const expected = computeDiseasePackFingerprint(parsed as unknown as { manifest: Record<string, unknown> })
      if (parsed.manifest.fingerprint !== expected) {
        throw new DiseasePackValidationError(
          'PACK_SCHEMA_INVALID',
          `Disease pack ${parsed.manifest.id} fingerprint mismatch: expected ${expected}, received ${parsed.manifest.fingerprint}`,
        )
      }
    }
    const merged = mergeThreeLayerPack({
      diseasePack: parsed,
      ...(options?.overlay === undefined ? {} : { hospitalOverlay: options.overlay }),
      ...(this.#publicLayer === undefined ? {} : { publicLayer: this.#publicLayer }),
    })
    this.#entries.set(merged.pack.manifest.id, merged)
    return merged
  }

  loadDirectory(
    dirPath: string,
    options?: { overlay?: unknown; verifyFingerprint?: boolean },
  ): EffectiveDiseasePack {
    if (!existsSync(dirPath)) {
      throw new DiseasePackRuntimeError('DISEASE_PACK_DIR_NOT_FOUND', `Disease pack directory was not found: ${dirPath}`, 404)
    }
    const entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    const files: PackSourceFileInput[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        throw new DiseasePackValidationError(
          'PACK_CODE_FORBIDDEN',
          `Disease pack directory must remain flat JSON data; unexpected subdirectory ${entry.name}`,
        )
      }
      if (entry.isFile()) {
        files.push({
          content: readFileSync(join(dirPath, entry.name), 'utf8'),
          filename: entry.name,
        })
      }
    }
    scanPackFilesForExecutableCode(files)

    const byName = new Map(files.map(file => [file.filename, file.content]))
    let rawPack: Record<string, unknown>
    const singleFile = byName.get('pack.json')
    if (singleFile !== undefined) {
      rawPack = parsePackJsonObject(singleFile, 'pack.json')
    } else {
      const manifestRaw = byName.get('manifest.json')
      if (manifestRaw === undefined) {
        throw new DiseasePackValidationError('PACK_SCHEMA_INVALID', `Missing manifest.json in pack directory ${dirPath}`)
      }
      const parsedManifest = parsePackJsonObject(manifestRaw, 'manifest.json')
      rawPack = 'manifest' in parsedManifest
        ? { ...parsedManifest }
        : { manifest: parsedManifest }

      for (const fileName of SPLIT_PACK_FILES) {
        const content = byName.get(fileName)
        if (content === undefined) continue
        Object.assign(rawPack, parsePackJsonObject(content, fileName))
      }
    }

    const overlayRaw = options?.overlay ?? (byName.has('hospital-overlay.json')
      ? parsePackJsonObject(byName.get('hospital-overlay.json')!, 'hospital-overlay.json')
      : byName.has('overlay.json')
        ? parsePackJsonObject(byName.get('overlay.json')!, 'overlay.json')
        : undefined)

    return this.registerRawPack(rawPack, {
      files,
      ...(overlayRaw === undefined ? {} : { overlay: overlayRaw }),
      ...(options?.verifyFingerprint === undefined ? {} : { verifyFingerprint: options.verifyFingerprint }),
    })
  }

  applyHospitalOverlay(rawOverlay: unknown): EffectiveDiseasePack {
    const partial = z.object({ packId: diseasePackSlugSchema }).loose().safeParse(rawOverlay)
    if (!partial.success) {
      throw new DiseasePackValidationError('PACK_SCHEMA_INVALID', 'Hospital overlay must specify a valid packId slug')
    }
    const existing = this.getEffective(partial.data.packId)
    const merged = mergeThreeLayerPack({
      diseasePack: existing.pack,
      hospitalOverlay: rawOverlay,
      ...(this.#publicLayer === undefined ? {} : { publicLayer: this.#publicLayer }),
    })
    this.#entries.set(merged.pack.manifest.id, merged)
    return merged
  }

  listEffective(): readonly EffectiveDiseasePack[] {
    return [...this.#entries.values()].sort((a, b) => a.pack.manifest.id.localeCompare(b.pack.manifest.id))
  }

  getEffective(packId: string): EffectiveDiseasePack {
    const entry = this.#entries.get(packId)
    if (entry === undefined) {
      throw new DiseasePackRuntimeError('DISEASE_PACK_NOT_FOUND', `未注册专病包 ${packId}`, 404)
    }
    return entry
  }

  listCatalogSummaries(): DiseasePackCatalogList {
    return {
      items: this.listEffective().map(entry => ({
        fingerprint: entry.pack.manifest.fingerprint,
        id: entry.pack.manifest.id,
        packType: entry.pack.manifest.packType,
        specialty: entry.pack.manifest.specialty,
        status: entry.pack.manifest.status,
        supportedTasks: [...entry.pack.manifest.supportedTasks],
        titleEn: entry.pack.manifest.titleEn,
        titleZh: entry.pack.manifest.titleZh,
        version: entry.pack.manifest.version,
      })),
    }
  }
}

export class DiseasePackRuntimeService {
  readonly registry: DiseasePackRegistry
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #factLedger: ClinicalFactLedgerService
  readonly #fhir: FhirRepository
  readonly #outpatient: OutpatientWorkflowContext

  constructor(options: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    factLedger: ClinicalFactLedgerService
    fhir: FhirRepository
    outpatientContext: OutpatientWorkflowContext
    registry?: DiseasePackRegistry
  }) {
    this.#commands = options.commands
    this.#database = options.database
    this.#factLedger = options.factLedger
    this.#fhir = options.fhir
    this.#outpatient = options.outpatientContext
    this.registry = options.registry ?? new DiseasePackRegistry()
  }

  listCatalog(context: ActorContext): DiseasePackCatalogList {
    try {
      if (!['administrator', 'outpatient-doctor', 'inpatient-doctor', 'ward-nurse', 'medical-records'].includes(context.roleCode)) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', '当前岗位无权读取已注册专病包目录')
      }
      const catalog = this.registry.listCatalogSummaries()
      this.#commands.auditRead(context, 'catalog.disease-packs.list', {}, 'success')
      return catalog
    } catch (error) {
      try { this.#commands.auditRead(context, 'catalog.disease-packs.list', {}, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readOutpatientPacks(context: ActorContext, caseId: string): DiseasePackRuntimeBundle {
    try {
      this.#outpatient.requireDoctorCase(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const caseRow = this.#readOutpatientCaseRow(context, caseId)
      const asOf = this.#outpatient.virtualTime(context)
      const subject = { id: caseId, kind: 'outpatient' as const, patientId: caseRow.patient_id }
      const bundle = this.#evaluateAllPacks(context, subject, asOf)
      this.#commands.auditRead(context, 'doctor.case.disease-packs.read', { caseId }, 'success')
      return bundle
    } catch (error) {
      try { this.#commands.auditRead(context, 'doctor.case.disease-packs.read', { caseId }, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readInpatientPacks(inpatient: InpatientService, context: ActorContext, admissionId: string): DiseasePackRuntimeBundle {
    try {
      inpatient.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const binding = inpatient.readAdmissionBinding(context, admissionId)
      const asOf = inpatient.virtualTime(context)
      const subject = { id: admissionId, kind: 'inpatient' as const, patientId: binding.patientId }
      const bundle = this.#evaluateAllPacks(context, subject, asOf)
      inpatient.commands.auditRead(context, 'inpatient.disease-packs.read', { admissionId }, 'success')
      return bundle
    } catch (error) {
      try { inpatient.commands.auditRead(context, 'inpatient.disease-packs.read', { admissionId }, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  toggleOutpatientPack(
    context: ActorContext,
    caseId: string,
    packId: string,
    rawBody: unknown,
    idempotencyKey: string,
  ) {
    const body = diseasePackToggleBodySchema.parse(rawBody)
    return this.#commands.execute({
      authorize: () => {
        this.#outpatient.requireDoctorCase(context, caseId)
        this.#outpatient.assertCaseResponsibility(context, caseId)
      },
      context,
      dataSchema: diseasePackRuntimeEntrySchema,
      expectedVersions: {},
      idempotencyKey,
      input: { caseId, packId, ...body },
      operation: 'doctor.case.disease-packs.toggle',
    }, () => {
      const effective = this.registry.getEffective(packId)
      const caseRow = this.#readOutpatientCaseRow(context, caseId)
      const now = this.#outpatient.virtualTime(context)
      return this.#applyOverrideAndAuditStage(context, { id: caseId, kind: 'outpatient', patientId: caseRow.patient_id }, effective, body, now)
    })
  }

  toggleInpatientPack(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    packId: string,
    rawBody: unknown,
    idempotencyKey: string,
  ) {
    const body = diseasePackToggleBodySchema.parse(rawBody)
    return inpatient.commands.execute({
      authorize: () => {
        inpatient.assertRole(context, ['inpatient-doctor'])
        inpatient.assertNotArchived(context, admissionId)
        inpatient.orders.assertAdmitted(context, admissionId)
      },
      context,
      dataSchema: diseasePackRuntimeEntrySchema,
      expectedVersions: {},
      idempotencyKey,
      input: { admissionId, packId, ...body },
      operation: 'inpatient.disease-packs.toggle',
    }, () => {
      const effective = this.registry.getEffective(packId)
      const binding = inpatient.admissionBinding(context, admissionId)
      const now = inpatient.virtualTime(context)
      return this.#applyOverrideAndAuditStage(context, { id: admissionId, kind: 'inpatient', patientId: binding.patientId }, effective, body, now)
    })
  }

  readOutpatientTaskReadiness(
    context: ActorContext,
    caseId: string,
    packId: string,
    taskId: string,
  ): DiseasePackTaskReadinessResult {
    const auditInput = { caseId, packId, taskId }
    try {
      this.#outpatient.requireDoctorCase(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const effective = this.registry.getEffective(packId)
      const caseRow = this.#readOutpatientCaseRow(context, caseId)
      const asOf = this.#outpatient.virtualTime(context)
      const ledger = this.#factLedger.buildInternalLedger(
        context,
        { id: caseId, kind: 'outpatient', patientId: caseRow.patient_id },
        { asOf, includeSuperseded: false },
      )
      const readiness = diseasePackTaskReadinessResultSchema.parse(evaluateTaskReadiness(effective, taskId, ledger, { asOf }))
      this.#commands.auditRead(context, 'doctor.case.disease-pack-task-readiness.read', auditInput, 'success')
      return readiness
    } catch (error) {
      try { this.#commands.auditRead(context, 'doctor.case.disease-pack-task-readiness.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readInpatientTaskReadiness(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    packId: string,
    taskId: string,
  ): DiseasePackTaskReadinessResult {
    const auditInput = { admissionId, packId, taskId }
    try {
      inpatient.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const effective = this.registry.getEffective(packId)
      const binding = inpatient.readAdmissionBinding(context, admissionId)
      const asOf = inpatient.virtualTime(context)
      const ledger = this.#factLedger.buildInternalLedger(
        context,
        { id: admissionId, kind: 'inpatient', patientId: binding.patientId },
        { asOf, includeSuperseded: false },
      )
      const readiness = diseasePackTaskReadinessResultSchema.parse(evaluateTaskReadiness(effective, taskId, ledger, { asOf }))
      inpatient.commands.auditRead(context, 'inpatient.disease-pack-task-readiness.read', auditInput, 'success')
      return readiness
    } catch (error) {
      try { inpatient.commands.auditRead(context, 'inpatient.disease-pack-task-readiness.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readOutpatientTaskFacts(
    context: ActorContext,
    caseId: string,
    packId: string,
    taskId: string,
  ): DiseasePackTaskFactsResponse {
    const auditInput = { caseId, packId, taskId }
    try {
      this.#outpatient.requireDoctorCase(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const effective = this.registry.getEffective(packId)
      const caseRow = this.#readOutpatientCaseRow(context, caseId)
      const asOf = this.#outpatient.virtualTime(context)
      const ledger = this.#factLedger.buildInternalLedger(
        context,
        { id: caseId, kind: 'outpatient', patientId: caseRow.patient_id },
        { asOf, includeSuperseded: false },
      )
      const response = this.#buildTaskFactsResponse(effective, taskId, ledger, asOf)
      this.#commands.auditRead(context, 'doctor.case.disease-pack-task-facts.read', auditInput, 'success')
      return response
    } catch (error) {
      try { this.#commands.auditRead(context, 'doctor.case.disease-pack-task-facts.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  readInpatientTaskFacts(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    packId: string,
    taskId: string,
  ): DiseasePackTaskFactsResponse {
    const auditInput = { admissionId, packId, taskId }
    try {
      inpatient.assertRole(context, ['inpatient-doctor'])
      const effective = this.registry.getEffective(packId)
      const binding = inpatient.admissionBinding(context, admissionId)
      const asOf = inpatient.virtualTime(context)
      const ledger = this.#factLedger.buildInternalLedger(
        context,
        { id: admissionId, kind: 'inpatient', patientId: binding.patientId },
        { asOf, includeSuperseded: false },
      )
      const response = this.#buildTaskFactsResponse(effective, taskId, ledger, asOf)
      inpatient.commands.auditRead(context, 'inpatient.disease-pack-task-facts.read', auditInput, 'success')
      return response
    } catch (error) {
      try { inpatient.commands.auditRead(context, 'inpatient.disease-pack-task-facts.read', auditInput, 'failed') } catch { /* preserve original error */ }
      throw error
    }
  }

  authorizePackToolInvocation(input: {
    context: ActorContext
    subjectKind: 'outpatient' | 'inpatient'
    subjectId: string
    packId: string
    rawBody: unknown
    inpatient?: InpatientService
  }): { auditId: string; authorized: true; operationId: string; packId: string } {
    const body = diseasePackToolAuthorizeBodySchema.parse(input.rawBody)
    let patientId: string
    let asOf: string

    if (input.subjectKind === 'outpatient') {
      this.#outpatient.requireDoctorCase(input.context, input.subjectId)
      this.#outpatient.assertCaseResponsibility(input.context, input.subjectId)
      patientId = this.#readOutpatientCaseRow(input.context, input.subjectId).patient_id
      asOf = this.#outpatient.virtualTime(input.context)
    } else {
      if (input.inpatient === undefined) {
        throw new Error('InpatientService is required for inpatient pack tool authorization')
      }
      input.inpatient.assertReadRole(input.context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      patientId = input.inpatient.readAdmissionBinding(input.context, input.subjectId).patientId
      asOf = input.inpatient.virtualTime(input.context)
    }

    const effective = this.registry.getEffective(input.packId)
    const subject = { id: input.subjectId, kind: input.subjectKind, patientId }
    const ledger = this.#factLedger.buildInternalLedger(input.context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(input.context, patientId)
    const override = this.#loadOverride(input.context, input.subjectKind, input.subjectId, input.packId)
    const activation = evaluatePackActivation(effective, ledger, {
      asOf,
      encounterIdByRecordId: encounterMap,
      manualOverride: override?.override_mode ?? null,
    })

    if (!activation.active) {
      this.#commands.auditRead(input.context, 'DSAP_TOOL_POLICY_DENIED', {
        actionTag: body.actionTag ?? null,
        operationId: body.operationId,
        packId: input.packId,
        reason: activation.activationReason,
        subjectId: input.subjectId,
        subjectKind: input.subjectKind,
      }, 'failed')
      throw new DiseasePackRuntimeError(
        'DSAP_PACK_INACTIVE',
        `专病包 ${input.packId} 当前未激活（${activation.activationReason}），拒绝执行 ${body.operationId}`,
        409,
        'DSAP_TOOL_POLICY_DENIED',
      )
    }

    const forbidden = new Set(effective.effectiveForbiddenActions)
    const allowed = new Set(effective.effectiveAllowedTools)
    if (
      forbidden.has(body.operationId)
      || (body.actionTag !== undefined && forbidden.has(body.actionTag))
      || !allowed.has(body.operationId)
    ) {
      this.#commands.auditRead(input.context, 'DSAP_TOOL_POLICY_DENIED', {
        actionTag: body.actionTag ?? null,
        operationId: body.operationId,
        packId: input.packId,
        reason: 'tool-not-permitted',
        subjectId: input.subjectId,
        subjectKind: input.subjectKind,
      }, 'failed')
      throw new DiseasePackRuntimeError(
        'DSAP_TOOL_POLICY_DENIED',
        `专病包 ${input.packId} 工具策略禁止执行 ${body.operationId}`,
        403,
        'DSAP_TOOL_POLICY_DENIED',
      )
    }

    this.#commands.auditRead(input.context, 'DSAP_TOOL_POLICY_AUTHORIZED', {
      actionTag: body.actionTag ?? null,
      operationId: body.operationId,
      packId: input.packId,
      subjectId: input.subjectId,
      subjectKind: input.subjectKind,
    }, 'success')
    const latestAudit = auditIdRowSchema.parse(this.#database.driver.prepare(`
      SELECT audit_id FROM audit_log
      WHERE workspace_id = ? AND epoch = ? AND operation = 'DSAP_TOOL_POLICY_AUTHORIZED'
      ORDER BY sequence DESC LIMIT 1
    `).get(input.context.workspaceId, input.context.epoch))

    return {
      auditId: latestAudit.audit_id,
      authorized: true,
      operationId: body.operationId,
      packId: input.packId,
    }
  }

  /**
   * Enforce mandatory & pack/hospital-declared forbiddenActions across all active packs
   * when an Agent tool call does not target a single explicit packId.
   */
  enforceActivePacksForbiddenActions(input: {
    context: ActorContext
    subjectKind: 'outpatient' | 'inpatient'
    subjectId: string
    operationId: string
    actionTag?: string
    inpatient?: InpatientService
  }): void {
    const effectiveList = this.registry.listEffective()
    if (effectiveList.length === 0) return

    const hasNonDraft = effectiveList.some(entry => entry.pack.manifest.status !== 'draft')
    const hasEnabledOverride = hasNonDraft
      ? true
      : this.#database.driver.prepare(`
          SELECT 1 AS found FROM disease_pack_activation_override
          WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND override_mode = 'enabled'
          LIMIT 1
        `).get(input.context.workspaceId, input.context.epoch, input.subjectKind, input.subjectId) !== undefined
    if (!hasEnabledOverride) return

    const patientRow = z.object({ patient_id: z.string().min(1) }).optional().parse(
      input.subjectKind === 'outpatient'
        ? this.#database.driver.prepare(`
            SELECT patient_id FROM outpatient_case
            WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          `).get(input.context.workspaceId, input.context.epoch, input.subjectId)
        : this.#database.driver.prepare(`
            SELECT patient_id FROM inpatient_admission
            WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
          `).get(input.context.workspaceId, input.context.epoch, input.subjectId),
    )
    if (patientRow === undefined) return
    const patientId = patientRow.patient_id
    const asOf = input.subjectKind === 'inpatient' && input.inpatient !== undefined
      ? input.inpatient.virtualTime(input.context)
      : this.#outpatient.virtualTime(input.context)

    const subject = { id: input.subjectId, kind: input.subjectKind, patientId }
    const ledger = this.#factLedger.buildInternalLedger(input.context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(input.context, patientId)

    for (const effective of effectiveList) {
      const override = this.#loadOverride(input.context, input.subjectKind, input.subjectId, effective.pack.manifest.id)
      const activation = evaluatePackActivation(effective, ledger, {
        asOf,
        encounterIdByRecordId: encounterMap,
        manualOverride: override?.override_mode ?? null,
      })
      if (!activation.active) continue

      const forbidden = new Set(effective.effectiveForbiddenActions)
      if (forbidden.has(input.operationId) || (input.actionTag !== undefined && forbidden.has(input.actionTag))) {
        this.#commands.auditRead(input.context, 'DSAP_TOOL_POLICY_DENIED', {
          actionTag: input.actionTag ?? null,
          operationId: input.operationId,
          packId: effective.pack.manifest.id,
          reason: 'active-pack-forbidden-action',
          subjectId: input.subjectId,
          subjectKind: input.subjectKind,
        }, 'failed')
        throw new DiseasePackRuntimeError(
          'DSAP_TOOL_POLICY_DENIED',
          `已激活专病包 ${effective.pack.manifest.id} 工具安全策略禁止执行 ${input.operationId}`,
          403,
          'DSAP_TOOL_POLICY_DENIED',
        )
      }
    }
  }

  /**
   * Evaluate readiness gates across all active disease packs for an inpatient guideline advice task
   * (e.g. PCI pre-op creatinine red line + smoking-status secondary annotation per AC20).
   */
  evaluateGuidelineAdviceTaskReadiness(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    topicId: string,
    requestId: string | null,
  ): {
    annotations: string[]
    blocked: boolean
    missingLabels: string[]
    readinessResults: DiseasePackTaskReadinessResult[]
  } {
    const effectiveList = this.registry.listEffective()
    const matchingTaskIdsByPack = new Map<string, string[]>()
    for (const entry of effectiveList) {
      const hasTopicTask = entry.pack.readinessTasks.some(task => task.taskId === topicId)
      const matchingTasks = hasTopicTask
        ? [topicId]
        : topicId === 'pci-stent' && requestId !== null
          ? entry.pack.readinessTasks
              .filter(task => task.taskId === 'pci-preop-guideline-advice')
              .map(task => task.taskId)
          : []
      if (matchingTasks.length > 0) {
        matchingTaskIdsByPack.set(entry.pack.manifest.id, matchingTasks)
      }
    }
    if (matchingTaskIdsByPack.size === 0) {
      return { annotations: [], blocked: false, missingLabels: [], readinessResults: [] }
    }

    const binding = inpatient.readAdmissionBinding(context, admissionId)
    const asOf = inpatient.virtualTime(context)
    const subject = { id: admissionId, kind: 'inpatient' as const, patientId: binding.patientId }
    const ledger = this.#factLedger.buildInternalLedger(context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(context, binding.patientId)

    const readinessResults: DiseasePackTaskReadinessResult[] = []
    const annotations: string[] = []
    const missingLabels: string[] = []
    let blocked = false

    for (const entry of effectiveList) {
      const taskIds = matchingTaskIdsByPack.get(entry.pack.manifest.id)
      if (!taskIds) continue
      const override = this.#loadOverride(context, 'inpatient', admissionId, entry.pack.manifest.id)
      const activation = evaluatePackActivation(entry, ledger, {
        asOf,
        encounterIdByRecordId: encounterMap,
        manualOverride: override?.override_mode ?? null,
      })
      if (!activation.active) continue
      for (const taskId of taskIds) {
        const res = evaluateTaskReadiness(entry, taskId, ledger, { asOf })
        readinessResults.push(res)
        if (!res.canProceed) {
          blocked = true
          missingLabels.push(...res.missingCriticalItems.map(item => item.labelZh))
        }
        annotations.push(...res.annotations)
      }
    }

    return {
      annotations: [...new Set(annotations)],
      blocked,
      missingLabels: [...new Set(missingLabels)],
      readinessResults,
    }
  }

  #buildTaskFactsResponse(
    effective: EffectiveDiseasePack,
    taskId: string,
    ledger: ClinicalFactLedger,
    asOf: string,
  ): DiseasePackTaskFactsResponse {
    try {
      const readiness = evaluateTaskReadiness(effective, taskId, ledger, { asOf })
      const scopedLedger = filterLedgerForTaskView(effective, taskId, ledger)
      const declaredItemCodes = collectDeclaredTaskItemCodes(effective, taskId)
      return diseasePackTaskFactsResponseSchema.parse({
        declaredItemCodes,
        ledger: scopedLedger,
        packId: effective.pack.manifest.id,
        readiness,
        taskId,
      })
    } catch (error) {
      if (error instanceof DiseasePackValidationError && error.code === 'TASK_NOT_FOUND_IN_PACK') {
        throw new DiseasePackRuntimeError('TASK_NOT_FOUND_IN_PACK', error.message, 404)
      }
      throw error
    }
  }

  #applyOverrideAndAuditStage(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    effective: EffectiveDiseasePack,
    body: DiseasePackToggleBody,
    now: string,
  ) {
    const packId = effective.pack.manifest.id
    const existing = this.#loadOverride(context, subject.kind, subject.id, packId)
    const currentVersion = existing?.version ?? 0
    if (body.expectedVersion !== undefined && body.expectedVersion !== currentVersion) {
      throw new DiseasePackRuntimeError(
        'DISEASE_PACK_VERSION_CONFLICT',
        `专病包 ${packId} 预期版本 ${body.expectedVersion} 与当前版本 ${currentVersion} 不一致`,
        409,
      )
    }

    if (body.overrideMode === 'auto') {
      this.#database.driver.prepare(`
        DELETE FROM disease_pack_activation_override
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
      `).run(context.workspaceId, context.epoch, subject.kind, subject.id, packId)
    } else if (existing === undefined) {
      this.#database.driver.prepare(`
        INSERT INTO disease_pack_activation_override (
          workspace_id, epoch, subject_kind, subject_id, pack_id,
          override_mode, note, updated_by_actor_id, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        context.workspaceId,
        context.epoch,
        subject.kind,
        subject.id,
        packId,
        body.overrideMode,
        body.note ?? null,
        context.actorId,
        now,
      )
    } else {
      this.#database.driver.prepare(`
        UPDATE disease_pack_activation_override
        SET override_mode = ?, note = ?, updated_by_actor_id = ?, updated_at = ?, version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
      `).run(
        body.overrideMode,
        body.note ?? null,
        context.actorId,
        now,
        context.workspaceId,
        context.epoch,
        subject.kind,
        subject.id,
        packId,
      )
    }

    const ledger = this.#factLedger.buildInternalLedger(context, subject, { asOf: now, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(context, subject.patientId)
    const updatedOverride = this.#loadOverride(context, subject.kind, subject.id, packId)
    const entry = this.#evaluateSinglePack(context, subject, effective, ledger, encounterMap, updatedOverride, now)

    const effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> = [
      {
        kind: existing === undefined ? 'created' : 'updated',
        reference: `DiseasePackActivation/${subject.kind}:${subject.id}:${packId}`,
        versionId: String(entry.manualOverrideVersion),
      },
    ]

    if (entry.activationStatus === 'active' && entry.currentStageId !== null) {
      const latestStage = stageAuditLatestSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT to_stage_id FROM disease_pack_stage_audit
          WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
          ORDER BY julianday(recorded_at) DESC, rowid DESC LIMIT 1
        `).get(context.workspaceId, context.epoch, subject.kind, subject.id, packId),
      )
      if (latestStage?.to_stage_id !== entry.currentStageId) {
        this.#database.driver.prepare(`
          INSERT INTO disease_pack_stage_audit (
            workspace_id, epoch, audit_id, subject_kind, subject_id, pack_id,
            from_stage_id, to_stage_id, recorded_by_actor_id, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.workspaceId,
          context.epoch,
          uuidv7(),
          subject.kind,
          subject.id,
          packId,
          latestStage?.to_stage_id ?? null,
          entry.currentStageId,
          context.actorId,
          now,
        )
      }
    }

    return { data: entry, effects }
  }

  #evaluateAllPacks(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    asOf: string,
  ): DiseasePackRuntimeBundle {
    const ledger = this.#factLedger.buildInternalLedger(context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(context, subject.patientId)
    const packs = this.registry.listEffective().map(effective => {
      const override = this.#loadOverride(context, subject.kind, subject.id, effective.pack.manifest.id)
      return this.#evaluateSinglePack(context, subject, effective, ledger, encounterMap, override, asOf)
    })
    return diseasePackRuntimeBundleSchema.parse({
      evaluatedAt: asOf,
      packs,
      subjectId: subject.id,
      subjectKind: subject.kind,
    })
  }

  #evaluateSinglePack(
    _context: ActorContext,
    _subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    effective: EffectiveDiseasePack,
    ledger: ClinicalFactLedger,
    encounterMap: Readonly<Record<string, string>>,
    override: z.infer<typeof overrideRowSchema> | undefined,
    asOf: string,
  ): DiseasePackRuntimeEntry {
    const evalOptions = {
      asOf,
      encounterIdByRecordId: encounterMap,
      manualOverride: override?.override_mode ?? null,
    }
    const activation = evaluatePackActivation(effective, ledger, evalOptions)
    const stageEval = evaluatePackStages(effective, ledger, evalOptions)
    const readinessTasks = effective.pack.readinessTasks.map(task => (
      evaluateTaskReadiness(effective, task.taskId, ledger, { asOf })
    ))

    return diseasePackRuntimeEntrySchema.parse({
      activationReason: activation.activationReason,
      activationStatus: activation.activationStatus,
      allowedTools: [...effective.effectiveAllowedTools],
      currentStageId: stageEval.currentStageId,
      forbiddenActions: [...effective.effectiveForbiddenActions],
      localizations: effective.localizations,
      manualOverride: override?.override_mode ?? null,
      manualOverrideVersion: override?.version ?? 0,
      matchedInapplicableIds: activation.matchedInapplicableIds,
      matchedTriggerIds: activation.matchedTriggerIds,
      packId: effective.pack.manifest.id,
      packType: effective.pack.manifest.packType,
      readinessTasks,
      recognitionCard: effective.pack.recognitionCard ?? null,
      specialty: effective.pack.manifest.specialty,
      stages: stageEval.stages,
      status: effective.pack.manifest.status,
      titleEn: effective.pack.manifest.titleEn,
      titleZh: effective.pack.manifest.titleZh,
      version: effective.pack.manifest.version,
    })
  }

  #loadOverride(
    context: Pick<ActorContext, 'workspaceId' | 'epoch'>,
    subjectKind: 'outpatient' | 'inpatient',
    subjectId: string,
    packId: string,
  ) {
    return overrideRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT pack_id, override_mode, note, updated_at, version
        FROM disease_pack_activation_override
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
      `).get(context.workspaceId, context.epoch, subjectKind, subjectId, packId),
    )
  }

  #readOutpatientCaseRow(context: ActorContext, caseId: string) {
    const row = z.object({ patient_id: z.string().min(1) }).optional().parse(
      this.#database.driver.prepare(`
        SELECT patient_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (row === undefined) {
      throw new DiseasePackRuntimeError('OUTPATIENT_CASE_NOT_FOUND', `Outpatient case ${caseId} was not found`, 404)
    }
    return row
  }

  #resolveEncounterMap(context: ActorContext, patientId: string): Record<string, string> {
    const map: Record<string, string> = {}
    for (const resourceType of ['Observation', 'DiagnosticReport', 'Condition', 'MedicationRequest', 'Procedure'] as const) {
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
        if (cursor) params.set('_cursor', cursor)
        const bundle = this.#fhir.search(context, resourceType, params)
        for (const raw of bundle.resources) {
          const parsed = fhirEncounterRefResourceSchema.safeParse(raw)
          if (!parsed.success) continue
          const ref = parsed.data.encounter?.reference
          if (!ref || !ref.startsWith('Encounter/')) continue
          const encId = ref.slice('Encounter/'.length)
          map[parsed.data.id] = encId
          map[`${parsed.data.resourceType}/${parsed.data.id}`] = encId
        }
        if (!bundle.nextCursor || bundle.nextCursor === cursor) break
        cursor = bundle.nextCursor
      }
    }
    return map
  }
}
