import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinicalFactCategory, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import {
  diseasePackRuntimeBundleSchema,
  diseasePackRuntimeEntrySchema,
  diseasePackSlugSchema,
  diseasePackTaskFactsResponseSchema,
  diseasePackTaskReadinessResultSchema,
  diseasePackToggleBodySchema,
  diseasePackToolAuthorizeBodySchema,
  type DeduplicatedQuestionnaireItem,
  type DiseasePackCatalogList,
  type DiseasePackRuntimeBundle,
  type DiseasePackMatchedCondition,
  type DiseasePackRuntimeEntry,
  type DiseasePackTaskFactsResponse,
  type DiseasePackTaskReadinessResult,
  type DiseasePackToggleBody,
  type EffectiveDiseasePack,
} from '@clinmesh/contracts/disease-pack'
import { type PackSourceSummary } from '@clinmesh/contracts/guideline-topics'
import type { ClinicalReviewerRecord } from '@clinmesh/contracts/knowledge-claims'
import {
  resolveEffectiveConceptVocabulary,
} from '@clinmesh/core/concept-vocabulary'
import {
  DEFAULT_PUBLIC_DISEASE_PACK_LAYER,
  DiseasePackValidationError,
  collectDeclaredTaskItemCodes,
  deduplicateQuestionnaireItems,
  evaluateLongitudinalLdlComparison,
  evaluatePackActivation,
  evaluatePackExit,
  evaluatePackStages,
  evaluateTaskReadiness,
  filterLedgerForTaskView,
  mergeThreeLayerPack,
  scanPackFilesForExecutableCode,
  validateAndParseDiseasePack,
  type PackMatchedCondition,
  type PackSourceFileInput,
  type PublicLayerPolicyInput,
} from '@clinmesh/core/disease-pack'
import { toFactVersionRefs } from '@clinmesh/core/clinical-prompt-cards'
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

const exitStateRowSchema = z.object({
  audit_id: z.string(),
  exit_criterion_id: z.string(),
  exit_reason_zh: z.string(),
  exit_summary_delivered: z.number().int(),
  exited_at: z.string(),
  matched_fact_ids_json: z.string(),
  pack_id: z.string(),
  status: z.enum(['exited', 're-enabled']),
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

/**
 * 从当前模块目录向上查找 `@clinmesh/server` 包内资产（兼容 `src/application`、打包后的 `dist/`、`dist/assets/`
 * 以及任意工作目录），避免 `pnpm start` 运行 `dist/index.js` 时相对路径错位。
 */
export function resolveServerPackageAsset(
  relativePath: string,
  moduleDir = import.meta.dirname,
): string {
  let current = resolve(moduleDir)
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, relativePath)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const cwdDirect = resolve(process.cwd(), relativePath)
  if (existsSync(cwdDirect)) return cwdDirect
  const cwdServer = resolve(process.cwd(), 'apps/server', relativePath)
  if (existsSync(cwdServer)) return cwdServer
  return resolve(moduleDir, '../..', relativePath)
}

export function discoverDefaultDiseasePackDirs(moduleDir?: string): string[] {
  const defaultRoot = resolveServerPackageAsset('disease-packs', moduleDir)
  if (!existsSync(defaultRoot)) return []
  return readdirSync(defaultRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => join(defaultRoot, entry.name))
}

const SPLIT_PACK_FILES = [
  'triggers.json',
  'stages.json',
  'readiness.json',
  'clinical.json',
  'exam-suite.json',
  'recognition-card.json',
  'vocabulary.json',
  'knowledge.json',
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

let defaultDiscoveredPacksCache: readonly EffectiveDiseasePack[] | undefined
const packVocabularyCache = new WeakMap<EffectiveDiseasePack, ConceptVocabulary>()

export class DiseasePackRegistry {
  readonly #entries = new Map<string, EffectiveDiseasePack>()
  readonly #publicLayer: PublicLayerPolicyInput
  readonly #registeredClinicianReviewers: readonly ClinicalReviewerRecord[]
  readonly #startupDemotionReasons = new Map<string, readonly string[]>()

  constructor(options?: {
    publicLayer?: PublicLayerPolicyInput
    includeBuiltinDraftPacks?: boolean
    packs?: readonly unknown[]
    packDirs?: readonly string[]
    overlays?: readonly unknown[]
    registeredClinicianReviewers?: readonly ClinicalReviewerRecord[]
    verifyFingerprint?: boolean
  }) {
    this.#publicLayer = options?.publicLayer ?? DEFAULT_PUBLIC_DISEASE_PACK_LAYER
    this.#registeredClinicianReviewers = options?.registeredClinicianReviewers ?? []
    const loadOptions = { verifyFingerprint: options?.verifyFingerprint !== false }
    const disableDefaultDirs =
      options?.includeBuiltinDraftPacks === false ||
      (options?.packDirs !== undefined && options.packDirs.length === 0)
    const canUseDefaultDiscoveryCache =
      !disableDefaultDirs
      && options?.publicLayer === undefined
      && this.#registeredClinicianReviewers.length === 0
      && loadOptions.verifyFingerprint
    if (!disableDefaultDirs) {
      if (canUseDefaultDiscoveryCache && defaultDiscoveredPacksCache !== undefined) {
        for (const cached of defaultDiscoveredPacksCache) {
          this.#entries.set(cached.pack.manifest.id, cached)
        }
      } else {
        for (const dir of discoverDefaultDiseasePackDirs()) {
          this.loadDirectory(dir, loadOptions)
        }
        if (canUseDefaultDiscoveryCache) {
          defaultDiscoveredPacksCache = [...this.#entries.values()]
        }
      }
    }
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

  resolvePackVocabulary(effective: EffectiveDiseasePack): ConceptVocabulary {
    const cached = packVocabularyCache.get(effective)
    if (cached !== undefined) return cached
    const resolved = resolveEffectiveConceptVocabulary({
      ...(effective.hospitalOverlay?.conceptVocabulary === undefined
        ? {}
        : { hospitalLayer: effective.hospitalOverlay.conceptVocabulary }),
      ...(effective.pack.conceptVocabulary === undefined
        ? {}
        : { packLayer: effective.pack.conceptVocabulary }),
    })
    packVocabularyCache.set(effective, resolved)
    return resolved
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
    const verifiedReviewerIds = new Set(
      this.#registeredClinicianReviewers
        .filter(r => r.licenseVerified === true)
        .map(r => r.reviewerId),
    )
    for (const snapshot of parsed.knowledgeSnapshots ?? []) {
      for (const claim of snapshot.claims) {
        if ((claim.status === 'published' || claim.status === 'clinician-reviewed')
          && (claim.reviewerId === null || !verifiedReviewerIds.has(claim.reviewerId))) {
          throw new DiseasePackValidationError(
            'PACK_UNVERIFIED_PUBLICATION',
            `Disease pack ${parsed.manifest.id} claim ${claim.id} has status '${claim.status}' with unregistered reviewerId '${claim.reviewerId ?? 'null'}'`,
          )
        }
      }
      for (const topic of snapshot.topics) {
        if ((topic.status === 'published' || topic.status === 'clinician-reviewed')
          && (topic.reviewerId === null || !verifiedReviewerIds.has(topic.reviewerId))) {
          throw new DiseasePackValidationError(
            'PACK_UNVERIFIED_PUBLICATION',
            `Disease pack ${parsed.manifest.id} topic ${topic.id} has status '${topic.status}' with unregistered reviewerId '${topic.reviewerId ?? 'null'}'`,
          )
        }
      }
    }
    const merged = mergeThreeLayerPack({
      diseasePack: parsed,
      ...(options?.overlay === undefined ? {} : { hospitalOverlay: options.overlay }),
      publicLayer: this.#publicLayer,
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
      publicLayer: this.#publicLayer,
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

  hasPack(packId: string): boolean {
    return this.#entries.has(packId)
  }

  activatePack(
    packId: string,
    options?: { packDir?: string },
  ): { previousStatus: 'draft' | 'active' | 'retired'; effective: EffectiveDiseasePack } {
    if (options?.packDir !== undefined && !this.#entries.has(packId)) {
      const loaded = this.loadDirectory(options.packDir, { verifyFingerprint: true })
      if (loaded.pack.manifest.id !== packId) {
        this.#entries.delete(loaded.pack.manifest.id)
        throw new DiseasePackRuntimeError(
          'DISEASE_PACK_NOT_FOUND',
          `目录 ${options.packDir} 中的专病包标识为 ${loaded.pack.manifest.id}，与请求的 ${packId} 不一致`,
          404,
        )
      }
    }
    const existing = this.getEffective(packId)
    const previousStatus = existing.pack.manifest.status
    const updatedPack = {
      ...existing.pack,
      manifest: {
        ...existing.pack.manifest,
        status: 'active' as const,
      },
    }
    const updatedFingerprint = computeDiseasePackFingerprint(
      updatedPack as unknown as { manifest: Record<string, unknown> },
    )
    const promotedPack = {
      ...updatedPack,
      manifest: {
        ...updatedPack.manifest,
        fingerprint: updatedFingerprint,
      },
    }
    const merged = mergeThreeLayerPack({
      diseasePack: promotedPack,
      ...(existing.hospitalOverlay === undefined ? {} : { hospitalOverlay: existing.hospitalOverlay }),
      publicLayer: this.#publicLayer,
    })
    this.#startupDemotionReasons.delete(packId)
    this.#entries.set(packId, merged)
    return { effective: merged, previousStatus }
  }

  demotePackToDraft(packId: string, reasonsZh: readonly string[]): EffectiveDiseasePack {
    const existing = this.getEffective(packId)
    const updatedPack = {
      ...existing.pack,
      manifest: {
        ...existing.pack.manifest,
        status: 'draft' as const,
      },
    }
    const updatedFingerprint = computeDiseasePackFingerprint(
      updatedPack as unknown as { manifest: Record<string, unknown> },
    )
    const demotedPack = {
      ...updatedPack,
      manifest: {
        ...updatedPack.manifest,
        fingerprint: updatedFingerprint,
      },
    }
    const merged = mergeThreeLayerPack({
      diseasePack: demotedPack,
      ...(existing.hospitalOverlay === undefined ? {} : { hospitalOverlay: existing.hospitalOverlay }),
      publicLayer: this.#publicLayer,
    })
    this.#startupDemotionReasons.set(packId, [...reasonsZh])
    this.#entries.set(packId, merged)
    return merged
  }

  startupDemotionReasons(packId: string): readonly string[] | undefined {
    return this.#startupDemotionReasons.get(packId)
  }

  listRegisteredClinicianReviewers(): readonly ClinicalReviewerRecord[] {
    return this.#registeredClinicianReviewers
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
      const vocabulary = this.#resolvePackVocabulary(effective)
      const readiness = diseasePackTaskReadinessResultSchema.parse(
        evaluateTaskReadiness(effective, taskId, ledger, { asOf, vocabulary }),
      )
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
      const vocabulary = this.#resolvePackVocabulary(effective)
      const readiness = diseasePackTaskReadinessResultSchema.parse(
        evaluateTaskReadiness(effective, taskId, ledger, { asOf, vocabulary }),
      )
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
    const vocabulary = this.#resolvePackVocabulary(effective)
    const subject = { id: input.subjectId, kind: input.subjectKind, patientId }
    const ledger = this.#factLedger.buildInternalLedger(input.context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(input.context, patientId)
    const override = this.#loadOverride(input.context, input.subjectKind, input.subjectId, input.packId)
    const activation = this.#resolveActivationWithExit(
      input.context,
      subject,
      effective,
      ledger,
      encounterMap,
      override,
      vocabulary,
      asOf,
    )

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
   * Enforce mandatory/pack/hospital forbiddenActions and allowedTools whitelist across all
   * active packs even when an Agent tool call omits `packId`.
   */
  enforceActivePacksToolPolicy(input: {
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

    const activeEntries: EffectiveDiseasePack[] = []
    for (const effective of effectiveList) {
      const override = this.#loadOverride(input.context, input.subjectKind, input.subjectId, effective.pack.manifest.id)
      const vocabulary = this.#resolvePackVocabulary(effective)
      const activation = this.#resolveActivationWithExit(
        input.context,
        subject,
        effective,
        ledger,
        encounterMap,
        override,
        vocabulary,
        asOf,
      )
      if (!activation.active) continue
      activeEntries.push(effective)

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

    if (activeEntries.length > 0) {
      const allowedUnion = new Set(activeEntries.flatMap(entry => [...entry.effectiveAllowedTools]))
      if (!allowedUnion.has(input.operationId)) {
        const primaryPackId = activeEntries[0]!.pack.manifest.id
        this.#commands.auditRead(input.context, 'DSAP_TOOL_POLICY_DENIED', {
          actionTag: input.actionTag ?? null,
          operationId: input.operationId,
          packId: primaryPackId,
          reason: 'active-pack-tool-not-in-whitelist',
          subjectId: input.subjectId,
          subjectKind: input.subjectKind,
        }, 'failed')
        throw new DiseasePackRuntimeError(
          'DSAP_TOOL_POLICY_DENIED',
          `操作 ${input.operationId} 不在当前已激活专病包允许的工具白名单中`,
          403,
          'DSAP_TOOL_POLICY_DENIED',
        )
      }
    }
  }

  /**
   * Evaluate 3-tier task readiness across active packs for the subject's current stage tasks.
   */
  evaluateSubjectStageReadiness(input: {
    auditBlockedOperation?: string
    context: ActorContext
    relevantCategory?: ClinicalFactCategory
    subjectKind: 'outpatient' | 'inpatient'
    subjectId: string
    inpatient?: InpatientService
  }): {
    annotations: string[]
    blocked: boolean
    missingCriticalLabels: string[]
    readinessResults: DiseasePackTaskReadinessResult[]
  } {
    const effectiveList = this.registry.listEffective()
    if (effectiveList.length === 0) {
      return { annotations: [], blocked: false, missingCriticalLabels: [], readinessResults: [] }
    }

    let patientId: string | undefined
    let asOf: string
    if (input.subjectKind === 'outpatient') {
      const outpatientRow = z.object({ patient_id: z.string().min(1) }).optional().parse(
        this.#database.driver.prepare(`
          SELECT patient_id FROM outpatient_case
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.subjectId),
      )
      patientId = outpatientRow?.patient_id
      asOf = this.#outpatient.virtualTime(input.context)
    } else {
      if (input.inpatient === undefined) {
        return { annotations: [], blocked: false, missingCriticalLabels: [], readinessResults: [] }
      }
      patientId = input.inpatient.readAdmissionBinding(input.context, input.subjectId).patientId
      asOf = input.inpatient.virtualTime(input.context)
    }

    if (patientId === undefined) {
      return { annotations: [], blocked: false, missingCriticalLabels: [], readinessResults: [] }
    }

    const subject = { id: input.subjectId, kind: input.subjectKind, patientId }
    const ledger = this.#factLedger.buildInternalLedger(input.context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(input.context, patientId)

    const readinessResults: DiseasePackTaskReadinessResult[] = []
    const annotations: string[] = []
    const missingCriticalLabels: string[] = []
    let blocked = false

    for (const effective of effectiveList) {
      const override = this.#loadOverride(input.context, input.subjectKind, input.subjectId, effective.pack.manifest.id)
      const vocabulary = this.#resolvePackVocabulary(effective)
      const activation = this.#resolveActivationWithExit(
        input.context,
        subject,
        effective,
        ledger,
        encounterMap,
        override,
        vocabulary,
        asOf,
      )
      if (!activation.active) continue

      const stageState = evaluatePackStages(effective, ledger, { asOf, vocabulary })
      const stage = stageState.currentStageId === null
        ? undefined
        : effective.pack.stages.find(item => item.id === stageState.currentStageId)
      const taskIds = stage !== undefined
        ? stage.taskIds
        : effective.pack.stages.length === 0
          ? effective.pack.readinessTasks.map(t => t.taskId)
          : []

      for (const taskId of taskIds) {
        const declaration = effective.pack.readinessTasks.find(task => task.taskId === taskId)
        if (declaration === undefined) continue
        if (
          input.relevantCategory !== undefined
          && declaration.relevantCategories !== undefined
          && declaration.relevantCategories.length > 0
          && !declaration.relevantCategories.includes(input.relevantCategory)
        ) {
          continue
        }
        const res = evaluateTaskReadiness(effective, taskId, ledger, { asOf, vocabulary })
        readinessResults.push(res)
        if (!res.canProceed) {
          blocked = true
          missingCriticalLabels.push(...res.missingCriticalItems.map(item => item.labelZh))
        }
        annotations.push(...res.annotations)
      }
    }

    if (blocked && input.auditBlockedOperation !== undefined) {
      this.#commands.auditRead(input.context, 'DSAP_TASK_READINESS_BLOCKED', {
        missingCriticalLabels: [...new Set(missingCriticalLabels)],
        operationId: input.auditBlockedOperation,
        subjectId: input.subjectId,
        subjectKind: input.subjectKind,
      }, 'failed')
    }

    return {
      annotations: [...new Set(annotations)],
      blocked,
      missingCriticalLabels: [...new Set(missingCriticalLabels)],
      readinessResults,
    }
  }

  /**
   * Evaluate readiness gates across all active disease packs for an inpatient guideline advice task
   * (e.g. PCI pre-op creatinine red line + smoking-status secondary annotation).
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
      const stageTaskIds = requestId !== null
        ? entry.pack.stages
            .filter(stage => stage.topicIds.includes(topicId))
            .flatMap(stage => stage.taskIds)
            .filter(taskId => entry.pack.readinessTasks.some(task => task.taskId === taskId))
        : []
      const matchingTasks = hasTopicTask
        ? [topicId]
        : [...new Set(stageTaskIds)]
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
      const vocabulary = this.#resolvePackVocabulary(entry)
      const activation = evaluatePackActivation(entry, ledger, {
        asOf,
        encounterIdByRecordId: encounterMap,
        manualOverride: override?.override_mode ?? null,
        vocabulary,
      })
      if (!activation.active) continue
      for (const taskId of taskIds) {
        const res = evaluateTaskReadiness(entry, taskId, ledger, { asOf, vocabulary })
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

  #resolvePackVocabulary(effective: EffectiveDiseasePack): ConceptVocabulary {
    return this.registry.resolvePackVocabulary(effective)
  }

  #buildTaskFactsResponse(
    effective: EffectiveDiseasePack,
    taskId: string,
    ledger: ClinicalFactLedger,
    asOf: string,
  ): DiseasePackTaskFactsResponse {
    try {
      const vocabulary = this.#resolvePackVocabulary(effective)
      const readiness = evaluateTaskReadiness(effective, taskId, ledger, { asOf, vocabulary })
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
      this.#database.driver.prepare(`
        DELETE FROM disease_pack_exit_state
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
      `).run(context.workspaceId, context.epoch, subject.kind, subject.id, packId)
    } else {
      if (existing === undefined) {
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
      if (body.overrideMode === 'enabled') {
        this.#database.driver.prepare(`
          UPDATE disease_pack_exit_state
          SET status = 're-enabled', re_enabled_at = ?, re_enabled_by_actor_id = ?
          WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ? AND status = 'exited'
        `).run(now, context.actorId, context.workspaceId, context.epoch, subject.kind, subject.id, packId)
      }
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
      this.#recordStageAuditIfChanged(context, subject, packId, entry.currentStageId, now)
    }

    return { data: entry, effects }
  }

  #recordStageAuditIfChanged(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient' },
    packId: string,
    currentStageId: string,
    recordedAt: string,
  ): void {
    const latestStage = stageAuditLatestSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT to_stage_id FROM disease_pack_stage_audit
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
        ORDER BY julianday(recorded_at) DESC, rowid DESC LIMIT 1
      `).get(context.workspaceId, context.epoch, subject.kind, subject.id, packId),
    )
    if (latestStage?.to_stage_id !== currentStageId) {
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
        currentStageId,
        context.actorId,
        recordedAt,
      )
    }
  }

  activeRuntimeSummaryForSubject(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    asOf: string,
    precomputedLedger?: ClinicalFactLedger,
  ): {
    activePacks: EffectiveDiseasePack[]
    activeQuestionnaireItems: DeduplicatedQuestionnaireItem[]
    allowedPackOrderSetIds: string[]
    allowedPackTopicIds: string[]
    entries: DiseasePackRuntimeEntry[]
    hasStageScopeRestriction: boolean
    primaryPack: PackSourceSummary | undefined
    sourcePacks: PackSourceSummary[]
  } {
    const ledger = precomputedLedger ?? this.#factLedger.buildInternalLedger(context, subject, { asOf, includeSuperseded: false })
    const encounterMap = this.#resolveEncounterMap(context, subject.patientId)
    const activePacks: EffectiveDiseasePack[] = []
    const entries: DiseasePackRuntimeEntry[] = []
    const allowedTopicIds = new Set<string>()
    const allowedOrderSetIds = new Set<string>()
    let hasStageScopeRestriction = false

    for (const effective of this.registry.listEffective()) {
      const override = this.#loadOverride(context, subject.kind, subject.id, effective.pack.manifest.id)
      const entry = this.#evaluateSinglePack(context, subject, effective, ledger, encounterMap, override, asOf)
      entries.push(entry)
      if (entry.activationStatus !== 'active') continue
      activePacks.push(effective)
      const activeStage = entry.currentStageId === null
        ? undefined
        : effective.pack.stages.find(stage => stage.id === entry.currentStageId)
      if (activeStage?.restrictRuntimeScope === true) {
        hasStageScopeRestriction = true
        for (const id of activeStage.topicIds) allowedTopicIds.add(id)
        for (const id of activeStage.orderSetIds) allowedOrderSetIds.add(id)
      } else {
        for (const topic of effective.pack.guidelineTopics ?? []) allowedTopicIds.add(topic.id)
        for (const orderSet of effective.pack.orderSets ?? []) allowedOrderSetIds.add(orderSet.id)
      }
    }

    const activeQuestionnaireItems = deduplicateQuestionnaireItems(activePacks)
    const sourcePacks: PackSourceSummary[] = activePacks.map(effective => ({
      packId: effective.pack.manifest.id,
      packVersion: effective.pack.manifest.version,
      titleZh: effective.pack.manifest.titleZh,
    }))
    return {
      activePacks,
      activeQuestionnaireItems,
      allowedPackOrderSetIds: [...allowedOrderSetIds],
      allowedPackTopicIds: [...allowedTopicIds],
      entries,
      hasStageScopeRestriction,
      primaryPack: sourcePacks[0],
      sourcePacks,
    }
  }

  #evaluateAllPacks(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    asOf: string,
  ): DiseasePackRuntimeBundle {
    const summary = this.activeRuntimeSummaryForSubject(context, subject, asOf)
    for (const entry of summary.entries) {
      if (entry.activationStatus === 'active' && entry.currentStageId !== null) {
        this.#recordStageAuditIfChanged(context, subject, entry.packId, entry.currentStageId, asOf)
      }
    }
    return diseasePackRuntimeBundleSchema.parse({
      activeQuestionnaireItems: summary.activeQuestionnaireItems,
      evaluatedAt: asOf,
      packs: summary.entries,
      subjectId: subject.id,
      subjectKind: subject.kind,
    })
  }

  readExitMetadata(
    context: Pick<ActorContext, 'workspaceId' | 'epoch'>,
    subjectKind: 'outpatient' | 'inpatient',
    subjectId: string,
    packId: string,
    asOf?: string,
  ): { exited: boolean; exitSummaryDelivered: boolean; matchedFactIds: string[] } {
    const row = this.#loadExitState(context, subjectKind, subjectId, packId)
    if (row === undefined || row.status !== 'exited') {
      return { exited: false, exitSummaryDelivered: false, matchedFactIds: [] }
    }
    if (asOf !== undefined) {
      const asOfMs = Date.parse(asOf)
      const exitedMs = Date.parse(row.exited_at)
      if (Number.isFinite(asOfMs) && Number.isFinite(exitedMs) && exitedMs > asOfMs) {
        return { exited: false, exitSummaryDelivered: false, matchedFactIds: [] }
      }
    }
    const matchedFactIds = z.array(z.string()).catch([]).parse(JSON.parse(row.matched_fact_ids_json))
    return {
      exited: true,
      exitSummaryDelivered: row.exit_summary_delivered === 1,
      matchedFactIds,
    }
  }

  markExitSummaryDelivered(
    context: Pick<ActorContext, 'workspaceId' | 'epoch'>,
    subjectKind: 'outpatient' | 'inpatient',
    subjectId: string,
    packId: string,
  ): void {
    this.#database.driver.prepare(`
      UPDATE disease_pack_exit_state
      SET exit_summary_delivered = 1
      WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ? AND status = 'exited'
    `).run(context.workspaceId, context.epoch, subjectKind, subjectId, packId)
  }

  #resolveActivationWithExit(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    effective: EffectiveDiseasePack,
    ledger: ClinicalFactLedger,
    encounterMap: Readonly<Record<string, string>>,
    override: z.infer<typeof overrideRowSchema> | undefined,
    vocabulary: ConceptVocabulary,
    asOf: string,
  ) {
    const evalOptions = {
      asOf,
      encounterIdByRecordId: encounterMap,
      manualOverride: override?.override_mode ?? null,
      vocabulary,
    }
    const activation = evaluatePackActivation(effective, ledger, evalOptions)
    const packId = effective.pack.manifest.id
    if (override?.override_mode === 'enabled') {
      return { ...activation, exitReasonZh: null, exited: false }
    }
    const existingExit = this.#loadExitState(context, subject.kind, subject.id, packId)
    const asOfMs = Date.parse(asOf)
    const existingExitedAtMs = existingExit !== undefined ? Date.parse(existingExit.exited_at) : Number.NaN
    const existingExitAppliesAtAsOf = existingExit?.status === 'exited'
      && (!Number.isFinite(asOfMs) || !Number.isFinite(existingExitedAtMs) || existingExitedAtMs <= asOfMs)
    if (existingExitAppliesAtAsOf && existingExit !== undefined) {
      return {
        ...activation,
        activationReason: 'pack-exited' as const,
        activationStatus: 'inactive' as const,
        active: false,
        exitReasonZh: existingExit.exit_reason_zh,
        exited: true,
      }
    }
    if (activation.active && existingExit?.status !== 're-enabled') {
      const exitEval = evaluatePackExit(effective, ledger, evalOptions)
      if (exitEval.exited) {
        if (!this.#database.driver.inTransaction && existingExit?.status !== 'exited') {
          this.#persistExitedState(context, subject, packId, exitEval, asOf)
        }
        return {
          ...activation,
          activationReason: 'pack-exited' as const,
          activationStatus: 'inactive' as const,
          active: false,
          exitReasonZh: exitEval.exitReasonZh,
          exited: true,
        }
      }
    }
    return { ...activation, exitReasonZh: null, exited: false }
  }

  #persistExitedState(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient' },
    packId: string,
    exitEval: ReturnType<typeof evaluatePackExit>,
    exitedAt: string,
  ): void {
    const existing = this.#loadExitState(context, subject.kind, subject.id, packId)
    if (existing?.status === 'exited') return
    const criterionId = exitEval.matchedCriterionId ?? 'exit-criterion'
    const reasonZh = exitEval.exitReasonZh ?? '满足专病包退出条件'
    this.#commands.auditRead(context, 'disease-pack.exit', {
      exitCriterionId: criterionId,
      exitReasonZh: reasonZh,
      packId,
      subjectId: subject.id,
      subjectKind: subject.kind,
    }, 'success')
    const latestAudit = auditIdRowSchema.parse(
      this.#database.driver.prepare(`
        SELECT audit_id FROM audit_log
        WHERE workspace_id = ? AND epoch = ? AND operation = 'disease-pack.exit'
        ORDER BY sequence DESC LIMIT 1
      `).get(context.workspaceId, context.epoch),
    )
    this.#database.driver.prepare(`
      INSERT OR REPLACE INTO disease_pack_exit_state (
        workspace_id, epoch, subject_kind, subject_id, pack_id,
        status, exit_criterion_id, exit_reason_zh, matched_fact_ids_json,
        audit_id, exit_summary_delivered, exited_at, re_enabled_at, re_enabled_by_actor_id
      ) VALUES (?, ?, ?, ?, ?, 'exited', ?, ?, ?, ?, 0, ?, NULL, NULL)
    `).run(
      context.workspaceId,
      context.epoch,
      subject.kind,
      subject.id,
      packId,
      criterionId,
      reasonZh,
      JSON.stringify(exitEval.matchedFactIds),
      latestAudit.audit_id,
      exitedAt,
    )
  }

  #evaluateSinglePack(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    effective: EffectiveDiseasePack,
    ledger: ClinicalFactLedger,
    encounterMap: Readonly<Record<string, string>>,
    override: z.infer<typeof overrideRowSchema> | undefined,
    asOf: string,
  ): DiseasePackRuntimeEntry {
    const vocabulary = this.#resolvePackVocabulary(effective)
    const evalOptions = {
      asOf,
      encounterIdByRecordId: encounterMap,
      manualOverride: override?.override_mode ?? null,
      vocabulary,
    }
    const activation = this.#resolveActivationWithExit(
      context,
      subject,
      effective,
      ledger,
      encounterMap,
      override,
      vocabulary,
      asOf,
    )
    const stageEval = evaluatePackStages(effective, ledger, evalOptions)
    const activeStage = stageEval.currentStageId === null
      ? undefined
      : effective.pack.stages.find(stage => stage.id === stageEval.currentStageId)
    const visibleReadinessTasks = activeStage?.restrictRuntimeScope === true
      ? effective.pack.readinessTasks.filter(task => activeStage.taskIds.includes(task.taskId))
      : effective.pack.readinessTasks
    const readinessTasks = visibleReadinessTasks.map(task => (
      evaluateTaskReadiness(effective, task.taskId, ledger, { asOf, vocabulary })
    ))
    const followUpLdlSummary = evaluateLongitudinalLdlComparison(ledger)
    const factsById = new Map(ledger.facts.map(fact => [fact.factId, fact]))
    const withFactRefs = (condition: PackMatchedCondition): DiseasePackMatchedCondition => ({
      basedOnFactVersions: toFactVersionRefs(condition.matchedFactIds, factsById).slice(0, 16),
      descriptionZh: condition.descriptionZh,
      id: condition.id,
    })

    return diseasePackRuntimeEntrySchema.parse({
      activationReason: activation.activationReason,
      activationStatus: activation.activationStatus,
      allowedTools: [...effective.effectiveAllowedTools],
      currentStageId: stageEval.currentStageId,
      ...(activation.exited ? { exitReasonZh: activation.exitReasonZh, exited: true } : {}),
      ...(followUpLdlSummary === null ? {} : { followUpLdlSummary }),
      forbiddenActions: [...effective.effectiveForbiddenActions],
      localizations: effective.localizations,
      manualOverride: override?.override_mode ?? null,
      manualOverrideVersion: override?.version ?? 0,
      matchedInapplicableIds: activation.matchedInapplicableIds,
      matchedInapplicables: activation.matchedInapplicables.map(withFactRefs),
      matchedTriggerIds: activation.matchedTriggerIds,
      matchedTriggers: activation.matchedTriggers.map(withFactRefs),
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

  #loadExitState(
    context: Pick<ActorContext, 'workspaceId' | 'epoch'>,
    subjectKind: 'outpatient' | 'inpatient',
    subjectId: string,
    packId: string,
  ) {
    return exitStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT pack_id, status, exit_criterion_id, exit_reason_zh, matched_fact_ids_json,
               audit_id, exit_summary_delivered, exited_at
        FROM disease_pack_exit_state
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND pack_id = ?
      `).get(context.workspaceId, context.epoch, subjectKind, subjectId, packId),
    )
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

  readOutpatientPatientId(context: ActorContext, caseId: string): string {
    return this.#readOutpatientCaseRow(context, caseId).patient_id
  }

  resolvePatientEncounterMap(context: ActorContext, patientId: string): Record<string, string> {
    return this.#resolveEncounterMap(context, patientId)
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
    const dischargeRows = z.array(z.object({
      admission_id: z.string().min(1),
      event_id: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT de.event_id, de.admission_id
        FROM inpatient_discharge_event de
        JOIN inpatient_admission ia
          ON ia.workspace_id = de.workspace_id AND ia.epoch = de.epoch AND ia.admission_id = de.admission_id
        WHERE de.workspace_id = ? AND de.epoch = ? AND ia.patient_id = ?
      `).all(context.workspaceId, context.epoch, patientId),
    )
    for (const row of dischargeRows) {
      map[row.event_id] = `Admission/${row.admission_id}`
      map[`DischargeEvent/${row.event_id}`] = `Admission/${row.admission_id}`
    }
    const outpatientRows = z.array(z.object({
      case_id: z.string().min(1),
      encounter_id: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT case_id, encounter_id
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND patient_id = ?
      `).all(context.workspaceId, context.epoch, patientId),
    )
    for (const row of outpatientRows) {
      map[`outpatient-encounter-context:${row.case_id}`] = `Encounter/${row.encounter_id}`
      map[`EncounterContext/outpatient-encounter-context:${row.case_id}`] = `Encounter/${row.encounter_id}`
    }
    return map
  }
}
