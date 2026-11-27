import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  type ClinicalPromptBundle,
  type ClinicalPromptCard,
  type ClinicalPromptHistoricalReplay,
  type ClinicalPromptReadQuery,
  type ClinicalPromptReevaluateDiff,
  type ClinicalPromptRiskTag,
  type ClinicalPromptSafetyBlock,
  type ClinicalPromptTiming,
  clinicalPromptBundleSchema,
  clinicalPromptCardSchema,
  clinicalPromptReadQuerySchema,
  inpatientClinicalPromptDismissInputSchema,
  outpatientClinicalPromptDismissInputSchema,
} from '@clinmesh/contracts/clinical-prompt-cards'
import type { ClinicalQualityCheck } from '@clinmesh/contracts/clinical-quality'
import type { ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import type { DiseasePackRuntimeEntry } from '@clinmesh/contracts/disease-pack'
import type {
  KnowledgeAnchorCitation,
  KnowledgeVersionComparison,
} from '@clinmesh/contracts/knowledge-claims'
import { medicationSafetyRuleSchema } from '@clinmesh/contracts/medication-safety'
import {
  attachRiskTagsAndSideBySide,
  buildTimingPromptCards,
  compareKnowledgeEvaluations,
  computePromptCardKnowledgeDiff,
  filterPromptCardsBeforeDisplay,
  markStalePromptCardsForLedger,
  mergePhenotypeIntoRecognitionCard,
  type EvaluatedPackForPromptBuild,
  type PromptMedicationDescriptor,
} from '@clinmesh/core/clinical-prompt-cards'
import type { QualityMedication, RenalFunctionFact } from '@clinmesh/core/clinical-quality'
import { PUBLIC_CONCEPT_VOCABULARY } from '@clinmesh/core/concept-vocabulary'
import { evaluatePackTrigger } from '@clinmesh/core/disease-pack'
import {
  evaluateKnowledgeSnapshotForPatient,
  type KnowledgePassageVerifier,
} from '@clinmesh/core/knowledge-claims'
import { SYNTHETIC_PHENOTYPE_KB, matchPhenotypeCandidates } from '@clinmesh/core/phenotype-matcher'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import type { ClinicalFactLedgerService } from './clinical-fact-ledger-service.ts'
import type { ClinicalQualityService } from './clinical-quality-service.ts'
import type { ClinicalScoreService } from './clinical-score-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { DiseasePackRuntimeService } from './disease-pack-runtime-service.ts'
import { resolvePatientGuidelinePopulation } from './patient-age.ts'
import type { InpatientService } from './inpatient-service.ts'
import { listRegisteredOrderSetEntries } from './order-set-template-registry.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { standardMedicationSafety } from './scenario-data/standard-medications.ts'

export class ClinicalPromptCardError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message)
    this.name = 'ClinicalPromptCardError'
  }
}

const snapshotRowSchema = z.object({
  based_on_fact_versions_json: z.string(),
  card_id: z.string(),
  card_json: z.string(),
  created_as_of: z.string(),
  created_at: z.string(),
  delivery_mode: z.enum(['display', 'silent']),
  encounter_id: z.string(),
  knowledge_snapshot_version: z.string().nullable(),
  pack_id: z.string().nullable(),
  pack_version: z.string().nullable(),
  timing: z.string(),
}).strict()

const dismissalRowSchema = z.object({
  actor_id: z.string(),
  audit_id: z.string(),
  card_id: z.string(),
  dismissed_at: z.string(),
  note: z.string(),
  pack_id: z.string().nullable(),
  reason_code: z.enum([
    'documented-contraindication',
    'external-result-verified',
    'result-pending-follow-up',
    'patient-informed-refusal',
    'clinical-judgement',
    'emergency-care',
  ]),
}).strict()

const medicationCatalogRowSchema = z.object({
  code: z.string(),
  config_json: z.string(),
  item_id: z.string(),
  name_zh: z.string(),
}).strict()

const catalogSafetyWrapperSchema = z.object({
  safety: medicationSafetyRuleSchema.optional(),
}).loose()

const optionalBooleanOrFlag = z.custom<boolean | 'true' | 'false'>(
  value => typeof value === 'boolean' || value === 'true' || value === 'false',
  { message: 'Expected boolean or "true"/"false" string' },
).optional()

const rawQueryInputSchema = z.object({
  asOf: z.string().optional(),
  candidateMedicationClasses: z.string().optional(),
  catalogItemId: z.string().optional(),
  includeDismissed: optionalBooleanOrFlag,
  includeSilent: optionalBooleanOrFlag,
  reevaluateWithLatestKnowledge: optionalBooleanOrFlag,
  selectedTemplateId: z.string().optional(),
  timing: z.string().optional(),
}).strict()

function parseQueryBoolean(value: boolean | 'true' | 'false' | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

export function parsePromptReadQuery(raw: unknown): ClinicalPromptReadQuery {
  const checked = rawQueryInputSchema.parse(raw ?? {})
  return clinicalPromptReadQuerySchema.parse({
    ...(checked.asOf === undefined ? {} : { asOf: checked.asOf }),
    ...(checked.candidateMedicationClasses === undefined
      ? {}
      : { candidateMedicationClasses: checked.candidateMedicationClasses }),
    ...(checked.catalogItemId === undefined ? {} : { catalogItemId: checked.catalogItemId }),
    ...(parseQueryBoolean(checked.includeDismissed) === undefined
      ? {}
      : { includeDismissed: parseQueryBoolean(checked.includeDismissed) }),
    ...(parseQueryBoolean(checked.includeSilent) === undefined
      ? {}
      : { includeSilent: parseQueryBoolean(checked.includeSilent) }),
    ...(parseQueryBoolean(checked.reevaluateWithLatestKnowledge) === undefined
      ? {}
      : { reevaluateWithLatestKnowledge: parseQueryBoolean(checked.reevaluateWithLatestKnowledge) }),
    ...(checked.selectedTemplateId === undefined ? {} : { selectedTemplateId: checked.selectedTemplateId }),
    ...(checked.timing === undefined ? {} : { timing: checked.timing }),
  })
}

function renalFactFromScores(bundle: ClinicalScoreBundle): RenalFunctionFact {
  const egfr = bundle.scores.find(s => s.id === 'ckd-epi-2021-egfr')
  if (egfr?.status === 'complete') {
    return {
      egfr: egfr.value,
      evidence: egfr.sourceReferences.map(r => ({
        label: r.label.slice(0, 240),
        reference: r.reference,
        versionId: r.versionId,
      })),
      status: 'measured',
    }
  }
  return egfr?.missingInputs.includes('serumCreatinine')
    ? { status: 'creatinine-missing' }
    : { status: 'not-computable' }
}

interface PromptSubject {
  encounterId: string
  id: string
  kind: 'outpatient' | 'inpatient'
  patientId: string
}

export class ClinicalPromptCardService {
  readonly #clinicalQuality: ClinicalQualityService
  readonly #clinicalScores: ClinicalScoreService
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #diseasePacks: DiseasePackRuntimeService
  readonly #factLedger: ClinicalFactLedgerService
  readonly #fhir: FhirRepository
  readonly #guidelines: GuidelineCorpus | undefined
  readonly #outpatient: OutpatientWorkflowContext
  #inpatient: InpatientService | undefined

  constructor(options: {
    clinicalQuality: ClinicalQualityService
    clinicalScores: ClinicalScoreService
    commands: CommandExecutor
    database: ClinMeshDatabase
    diseasePacks: DiseasePackRuntimeService
    factLedger: ClinicalFactLedgerService
    fhir: FhirRepository
    guidelines?: GuidelineCorpus
    outpatientContext: OutpatientWorkflowContext
  }) {
    this.#clinicalQuality = options.clinicalQuality
    this.#clinicalScores = options.clinicalScores
    this.#commands = options.commands
    this.#database = options.database
    this.#diseasePacks = options.diseasePacks
    this.#factLedger = options.factLedger
    this.#fhir = options.fhir
    this.#guidelines = options.guidelines
    this.#outpatient = options.outpatientContext

    this.#commands.subscribe((context, effects) => {
      const reportRefs = effects
        .filter(effect => effect.reference.startsWith('DiagnosticReport/'))
        .map(effect => effect.reference)
      if (reportRefs.length === 0) return
      try {
        this.#handleReportEffectsPostCommit(context, reportRefs)
      } catch {
        // Post-commit refresh runs non-blockingly and must never disrupt committed report writes.
      }
    })
  }

  setInpatient(inpatient: InpatientService): void {
    this.#inpatient = inpatient
  }

  readOutpatientPrompts(context: ActorContext, caseId: string, rawQuery: unknown): ClinicalPromptBundle {
    try {
      this.#outpatient.assertRole(context, ['outpatient-doctor'])
      const query = parsePromptReadQuery(rawQuery)
      const subject = this.#resolveOutpatientSubject(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const bundle = this.#evaluatePromptsForSubject(context, subject, query, this.#outpatient.virtualTime(context), true)
      this.#commands.auditRead(context, 'doctor.case.clinical-prompts.read', { caseId, ...query }, 'success')
      return bundle
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'doctor.case.clinical-prompts.read', { caseId }, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  readInpatientPrompts(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    rawQuery: unknown,
  ): ClinicalPromptBundle {
    try {
      inpatient.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const query = parsePromptReadQuery(rawQuery)
      const binding = inpatient.readAdmissionBinding(context, admissionId)
      const subject: PromptSubject = {
        encounterId: admissionId,
        id: admissionId,
        kind: 'inpatient',
        patientId: binding.patientId,
      }
      const bundle = this.#evaluatePromptsForSubject(context, subject, query, inpatient.virtualTime(context), true, inpatient)
      inpatient.commands.auditRead(context, 'inpatient.clinical-prompts.read', { admissionId, ...query }, 'success')
      return bundle
    } catch (error) {
      try {
        inpatient.commands.auditRead(context, 'inpatient.clinical-prompts.read', { admissionId }, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  dismissOutpatientPrompt(context: ActorContext, rawInput: unknown, idempotencyKey: string) {
    const input = outpatientClinicalPromptDismissInputSchema.parse(rawInput)
    return this.#commands.execute(
      {
        authorize: () => {
          this.#outpatient.assertRole(context, ['outpatient-doctor'])
          this.#outpatient.assertCaseResponsibility(context, input.caseId)
        },
        context,
        contextRequirement: 'current',
        dataSchema: clinicalPromptCardSchema,
        expectedVersions: {},
        idempotencyKey,
        input,
        operation: 'doctor.case.clinical-prompts.dismiss',
      },
      () => {
        const subject = this.#resolveOutpatientSubject(context, input.caseId)
        const now = this.#outpatient.virtualTime(context)
        return this.#executeDismiss(context, subject, input, now)
      },
    )
  }

  dismissInpatientPrompt(
    inpatient: InpatientService,
    context: ActorContext,
    rawInput: unknown,
    idempotencyKey: string,
  ) {
    const input = inpatientClinicalPromptDismissInputSchema.parse(rawInput)
    return inpatient.commands.execute(
      {
        authorize: () => {
          inpatient.assertReadRole(context, ['inpatient-doctor'])
          inpatient.readAdmissionBinding(context, input.admissionId)
        },
        context,
        contextRequirement: 'current',
        dataSchema: clinicalPromptCardSchema,
        expectedVersions: {},
        idempotencyKey,
        input,
        operation: 'inpatient.clinical-prompts.dismiss',
      },
      () => {
        const binding = inpatient.readAdmissionBinding(context, input.admissionId)
        const subject: PromptSubject = {
          encounterId: input.admissionId,
          id: input.admissionId,
          kind: 'inpatient',
          patientId: binding.patientId,
        }
        return this.#executeDismiss(context, subject, input, inpatient.virtualTime(context), inpatient)
      },
    )
  }

  /**
   * 供门急诊智能推荐与住院指南意见在结果发布前执行确定性展示前安全过滤（严格 0 LLM 调用）。
   * 自动向 `clinical_prompt_safety_block_audit` 写入审计，永不泄露拦截条目。
   */
  filterCandidateCardsForSubject(input: {
    asOf?: string | undefined
    cards: readonly ClinicalPromptCard[]
    context: ActorContext
    inpatient?: InpatientService | undefined
    ledger?: ClinicalFactLedger | undefined
    medicationCandidatesByCardId?: ReadonlyMap<string, readonly PromptMedicationDescriptor[]> | undefined
    recordAudit?: boolean | undefined
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string }
    timing: ClinicalPromptTiming
  }): {
    blockedRecords: ClinicalPromptSafetyBlock[]
    primaryPack: { knowledgeSnapshotVersion: string | null; packId: string; packVersion: string } | undefined
    visibleCards: ClinicalPromptCard[]
  } {
    const asOf = input.asOf ?? this.#outpatient.virtualTime(input.context)
    const ledger = input.ledger ?? this.#factLedger.buildInternalLedger(input.context, input.subject, {
      asOf,
      includeSuperseded: false,
    })
    const { evaluatedPacks, riskTagsByPackId, retiredClaimIds, snapshotVersionsByPackId } =
      this.#evaluatePacksForSubject(input.context, input.subject, ledger, asOf)
    const effectiveInpatient = input.inpatient ?? this.#inpatient
    const needsMedicationContext = (
      input.medicationCandidatesByCardId !== undefined && input.medicationCandidatesByCardId.size > 0
    ) || input.cards.some(card => card.suggestions.length > 0)
    const scores: ClinicalScoreBundle | undefined = !needsMedicationContext
      ? undefined
      : input.subject.kind === 'outpatient'
        ? this.#clinicalScores.outpatientSnapshot(input.context, input.subject.id)
        : effectiveInpatient
          ? this.#clinicalScores.inpatientSnapshot(effectiveInpatient, input.context, input.subject.id)
          : undefined
    const activeMedications: QualityMedication[] = needsMedicationContext
      ? this.#activeMedications(input.context, input.subject, effectiveInpatient)
      : []
    const allergyCodes: ReadonlySet<string> = needsMedicationContext
      ? this.#outpatient.patientAllergyCodes(input.context, input.subject.patientId)
      : new Set<string>()
    const medicationCatalog = needsMedicationContext
      ? this.#buildMedicationCatalog(input.context)
      : new Map<string, PromptMedicationDescriptor>()

    const filterResult = filterPromptCardsBeforeDisplay({
      activeMedications,
      allergyCodes,
      cards: input.cards,
      effectivePacks: evaluatedPacks.map(item => item.effective),
      evaluatedEntries: evaluatedPacks.map(item => item.entry),
      ledger,
      ...(input.medicationCandidatesByCardId ? { medicationCandidatesByCardId: input.medicationCandidatesByCardId } : {}),
      medicationCatalog,
      ...(scores === undefined ? {} : { renal: renalFactFromScores(scores) }),
      retiredOrInactiveClaimIds: retiredClaimIds,
      verifySourcePassage: this.#sourceVerifier(input.context, input.subject.patientId, asOf),
    })

    const auditedBlocks = input.recordAudit === false
      ? filterResult.blockedRecords
      : this.#recordSafetyBlocks(
          input.context,
          input.subject,
          filterResult.blockedRecords,
          asOf,
        )
    const attached = attachRiskTagsAndSideBySide(filterResult.visibleCards, riskTagsByPackId)
    const firstActive = evaluatedPacks.find(item => item.entry.activationStatus === 'active')
    return {
      blockedRecords: auditedBlocks,
      primaryPack: firstActive === undefined
        ? undefined
        : {
            knowledgeSnapshotVersion: snapshotVersionsByPackId.get(firstActive.effective.pack.manifest.id) ?? null,
            packId: firstActive.effective.pack.manifest.id,
            packVersion: firstActive.effective.pack.manifest.version,
          },
      visibleCards: attached.cards,
    }
  }

  /** 对外暴露患者激活主专病包及当前生效知识快照版本供推荐/建议模块附着元数据。 */
  activePackMetadata(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    asOfInput?: string,
  ): {
    ledger: ClinicalFactLedger
    primaryPack: { knowledgeSnapshotVersion: string | null; packId: string; packVersion: string } | undefined
    snapshotVersionsByPackId: Map<string, string>
  } {
    const asOf = asOfInput ?? this.#outpatient.virtualTime(context)
    const ledger = this.#factLedger.buildInternalLedger(context, subject, {
      asOf,
      includeSuperseded: false,
    })
    const { evaluatedPacks, snapshotVersionsByPackId } =
      this.#evaluatePacksForSubject(context, subject, ledger, asOf)
    const firstActive = evaluatedPacks.find(item => item.entry.activationStatus === 'active')
    return {
      ledger,
      primaryPack: firstActive === undefined
        ? undefined
        : {
            knowledgeSnapshotVersion: snapshotVersionsByPackId.get(firstActive.effective.pack.manifest.id) ?? null,
            packId: firstActive.effective.pack.manifest.id,
            packVersion: firstActive.effective.pack.manifest.version,
          },
      snapshotVersionsByPackId,
    }
  }

  /**
   * 检验/检查/影像/病理/造影报告完成或更正后非阻塞刷新（严格 0 LLM 调用）：
   * 1. 将引用了已更正/已替代事实版本的持久化卡片标记为 `stale: true`
   * 2. 重新评估 `report-arrived` 触发卡片并保留已标陈旧的卡片状态
   * 3. 刷新住院已有待解锁 `inpatient_guideline_advice` 任务就绪状态
   */
  handleReportArrived(
    context: ActorContext,
    subject: PromptSubject,
  ): void {
    const asOf = this.#outpatient.virtualTime(context)
    const fullLedger = this.#factLedger.buildInternalLedger(context, subject, {
      asOf,
      includeSuperseded: true,
    })

    // 1. Mark any existing persisted prompt cards stale if referenced facts were superseded or amended
    const existingRows = z.array(snapshotRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT based_on_fact_versions_json, card_id, card_json, created_as_of, created_at,
               delivery_mode, encounter_id, knowledge_snapshot_version, pack_id, pack_version, timing
        FROM clinical_prompt_card_snapshot
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ?
      `).all(context.workspaceId, context.epoch, subject.kind, subject.id),
    )

    const existingCards = existingRows.map(row => clinicalPromptCardSchema.parse(JSON.parse(row.card_json)))
    const staleEvaluated = markStalePromptCardsForLedger(existingCards, fullLedger)
    const staleCardIds = new Set<string>()
    for (let index = 0; index < existingRows.length; index++) {
      const row = existingRows[index]!
      const prev = existingCards[index]!
      const next = staleEvaluated[index]!
      if (next.stale) staleCardIds.add(next.cardId)
      if (!prev.stale && next.stale) {
        this.#database.driver.prepare(`
          UPDATE clinical_prompt_card_snapshot
          SET card_json = ?
          WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND encounter_id = ? AND card_id = ?
        `).run(
          JSON.stringify(next),
          context.workspaceId,
          context.epoch,
          subject.kind,
          subject.id,
          row.encounter_id,
          row.card_id,
        )
      }
    }

    // 2. Refresh deterministic clinical score snapshot & report-arrived cards (0 LLM calls)
    if (subject.kind === 'outpatient') {
      try {
        this.#clinicalScores.outpatientSnapshot(context, subject.id)
      } catch {
        // Ignore score snapshot error during partial visits or non-clinical system actors
      }
    } else if (this.#inpatient !== undefined) {
      try {
        this.#clinicalScores.inpatientSnapshot(this.#inpatient, context, subject.id)
      } catch {
        // Ignore score snapshot error during partial stays or non-clinical system actors
      }
    }

    const evaluated = this.#evaluatePromptsForSubject(
      context,
      subject,
      { includeSilent: true, timing: 'report-arrived' },
      asOf,
      false,
      this.#inpatient,
      staleCardIds,
      true,
    )
    this.#persistSnapshots(context, subject, evaluated.cards, asOf, asOf, staleCardIds)

    // 3. Re-evaluate existing blocked/stale inpatient guideline advice tasks if newly arrived reports unblock readiness
    if (subject.kind === 'inpatient' && this.#inpatient !== undefined) {
      this.#inpatient.guidelineAdvice.refreshAfterReportArrived(context, subject.id)
    }
  }

  #handleReportEffectsPostCommit(context: ActorContext, reportRefs: readonly string[]): void {
    const seenSubjects = new Set<string>()
    for (const ref of reportRefs) {
      const reportId = ref.replace(/^DiagnosticReport\//, '').split('/_history/')[0]!
      let reportRaw: unknown
      try {
        reportRaw = this.#fhir.read(context, 'DiagnosticReport', reportId)
      } catch {
        continue
      }
      const parsed = z.object({
        encounter: z.object({ reference: z.string() }).optional(),
      }).loose().safeParse(reportRaw)
      const encRef = parsed.success ? parsed.data.encounter?.reference : undefined
      if (!encRef?.startsWith('Encounter/')) continue
      const encounterId = encRef.slice('Encounter/'.length)

      const outpatientRow = z.object({ case_id: z.string(), encounter_id: z.string(), patient_id: z.string() })
        .optional()
        .parse(
          this.#database.driver.prepare(`
            SELECT case_id, encounter_id, patient_id FROM outpatient_case
            WHERE workspace_id = ? AND epoch = ? AND encounter_id = ?
          `).get(context.workspaceId, context.epoch, encounterId),
        )
      if (outpatientRow !== undefined) {
        const key = `outpatient:${outpatientRow.case_id}`
        if (seenSubjects.has(key)) continue
        seenSubjects.add(key)
        this.handleReportArrived(context, {
          encounterId: outpatientRow.encounter_id,
          id: outpatientRow.case_id,
          kind: 'outpatient',
          patientId: outpatientRow.patient_id,
        })
        continue
      }

      const inpatientRow = z.object({ admission_id: z.string(), patient_id: z.string() })
        .optional()
        .parse(
          this.#database.driver.prepare(`
            SELECT admission_id, patient_id FROM inpatient_admission
            WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
          `).get(context.workspaceId, context.epoch, encounterId),
        )
      if (inpatientRow !== undefined) {
        const key = `inpatient:${inpatientRow.admission_id}`
        if (seenSubjects.has(key)) continue
        seenSubjects.add(key)
        this.handleReportArrived(context, {
          encounterId: inpatientRow.admission_id,
          id: inpatientRow.admission_id,
          kind: 'inpatient',
          patientId: inpatientRow.patient_id,
        })
      }
    }
  }

  #resolveOutpatientSubject(context: ActorContext, caseId: string): PromptSubject {
    const row = z.object({ encounter_id: z.string().min(1), patient_id: z.string().min(1) }).optional().parse(
      this.#database.driver.prepare(`
        SELECT encounter_id, patient_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (row === undefined) {
      throw new ClinicalPromptCardError('OUTPATIENT_CASE_NOT_FOUND', `未找到门诊病例 ${caseId}`, 404)
    }
    return {
      encounterId: row.encounter_id,
      id: caseId,
      kind: 'outpatient',
      patientId: row.patient_id,
    }
  }

  #sourceVerifier(
    context: ActorContext,
    patientId: string,
    asOf: string,
  ): KnowledgePassageVerifier {
    const patient = this.#fhir.read(context, 'Patient', patientId)
    const birthDate = patient.resourceType === 'Patient' && typeof patient.birthDate === 'string'
      ? patient.birthDate
      : undefined
    const population = resolvePatientGuidelinePopulation(birthDate, asOf)
    return (anchor: KnowledgeAnchorCitation) => {
      if (this.#guidelines === undefined) {
        return { passageText: anchor.quoteFragment, valid: true }
      }
      const read = this.#guidelines.readReferences(
        [{ page: anchor.page, sha256: anchor.sha256, sourceId: anchor.sourceId, version: anchor.version }],
        { population },
      )
      if (read.missing.length > 0) {
        return { reason: read.missing[0]!.reason, valid: false }
      }
      const matched = read.guidelines.filter(item => (
        item.sourceHash === anchor.sha256
        && item.version === anchor.version
        && (
          anchor.locator === undefined
          || item.locator === anchor.locator
          || item.locator.startsWith(`${anchor.locator}；`)
          || item.locator.startsWith(`${anchor.locator};`)
        )
      ))
      if (matched.length === 0) {
        return { reason: 'passage-locator-mismatch', valid: false }
      }
      return {
        passageText: matched.map(item => item.text).join('\n'),
        valid: true,
      }
    }
  }

  #buildMedicationCatalog(context: Pick<ActorContext, 'workspaceId' | 'epoch'>): Map<string, PromptMedicationDescriptor> {
    const rows = z.array(medicationCatalogRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT item_id, code, name_zh, config_json
        FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'medication' AND active = 1
      `).all(context.workspaceId, context.epoch),
    )
    const map = new Map<string, PromptMedicationDescriptor>()
    for (const row of rows) {
      const parsed = catalogSafetyWrapperSchema.safeParse(JSON.parse(row.config_json))
      const safety = (parsed.success ? parsed.data.safety : undefined) ?? standardMedicationSafety(row.item_id)
      const descriptor: PromptMedicationDescriptor = {
        allergenCodes: [row.code, row.item_id],
        catalogItemId: row.item_id,
        code: row.code,
        display: row.name_zh,
        doseLimits: safety?.doseLimits,
        pharmacologyClasses: [...(safety?.pharmacologyClasses ?? [])],
      }
      map.set(row.item_id, descriptor)
      map.set(row.code, descriptor)
      const standardKey = row.item_id.replace(/^med-/, '').replace(/^medication-/, '')
      if (standardKey.length > 0 && !map.has(standardKey)) {
        map.set(standardKey, descriptor)
      }
    }
    return map
  }

  #resolveTemplateMedicationMaps(
    medicationCatalog: ReadonlyMap<string, PromptMedicationDescriptor>,
  ): {
    classesByTemplateId: Map<string, string[]>
    itemsByTemplateId: Map<string, { catalogItemId: string; classes: string[] }[]>
  } {
    const classesByTemplateId = new Map<string, string[]>()
    const itemsByTemplateId = new Map<string, { catalogItemId: string; classes: string[] }[]>()
    for (const entry of listRegisteredOrderSetEntries(this.#diseasePacks.registry)) {
      const classes = new Set<string>()
      const items: { catalogItemId: string; classes: string[] }[] = []
      for (const item of entry.template.items) {
        if (item.kind !== 'medication') continue
        for (const opt of item.options) {
          if (opt.kind !== 'medication') continue
          const safety = standardMedicationSafety(opt.medicationKey)
            ?? standardMedicationSafety(`med-${opt.medicationKey}`)
            ?? standardMedicationSafety(`medication-${opt.medicationKey}`)
          const desc = medicationCatalog.get(opt.medicationKey)
            ?? medicationCatalog.get(`med-${opt.medicationKey}`)
            ?? medicationCatalog.get(`medication-${opt.medicationKey}`)
            ?? medicationCatalog.get(`pci-${opt.medicationKey}`)
          const optionClasses = [...(safety?.pharmacologyClasses ?? desc?.pharmacologyClasses ?? [])]
          for (const cls of optionClasses) classes.add(cls)
          if (desc !== undefined) items.push({ catalogItemId: desc.catalogItemId, classes: optionClasses })
        }
      }
      classesByTemplateId.set(entry.template.id, [...classes])
      itemsByTemplateId.set(entry.template.id, items)
    }
    return { classesByTemplateId, itemsByTemplateId }
  }

  #activeMedications(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient' },
    inpatient?: InpatientService,
  ): QualityMedication[] {
    if (subject.kind === 'inpatient' && inpatient !== undefined) {
      return inpatient.orders.facts(context, subject.id).orders
        .filter(order => order.kind === 'medication' && ['signed', 'verified'].includes(order.state))
        .map(order => ({
          catalogItemId: order.catalogItemId,
          display: order.display,
          pharmacologyClasses: this.#clinicalQuality.medicationClasses(context, order.catalogItemId),
        }))
    }
    // 门急诊 `prescription_draft_state` 为待定/可整体替换的草稿而非已签发在用医嘱；与 `ClinicalQualityService.outpatientPrescription` 一致，不将其视为互斥在用药物。
    return []
  }

  #evaluatePacksForSubject(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string },
    ledger: ClinicalFactLedger,
    asOf: string,
  ): {
    evaluatedPacks: EvaluatedPackForPromptBuild[]
    retiredClaimIds: Set<string>
    riskTagsByPackId: Map<string, ClinicalPromptRiskTag[]>
    snapshotVersionsByPackId: Map<string, string>
  } {
    const encounterMap = this.#diseasePacks.resolvePatientEncounterMap(context, subject.patientId)
    const runtimeBundle = this.#diseasePacks.activeRuntimeSummaryForSubject(context, subject, asOf, ledger)
    const entriesByPackId = new Map<string, DiseasePackRuntimeEntry>(
      runtimeBundle.entries.map(entry => [entry.packId, entry]),
    )

    const evaluatedPacks: EvaluatedPackForPromptBuild[] = []
    const snapshotVersionsByPackId = new Map<string, string>()
    const retiredClaimIds = new Set<string>()
    const riskTagsByPackId = new Map<string, ClinicalPromptRiskTag[]>()
    const asOfMs = Date.parse(asOf)
    const verifySourcePassage = this.#sourceVerifier(context, subject.patientId, asOf)

    for (const effective of this.#diseasePacks.registry.listEffective()) {
      const packId = effective.pack.manifest.id
      const entry = entriesByPackId.get(packId)
      if (!entry) continue
      const vocabulary: ConceptVocabulary = this.#diseasePacks.registry.resolvePackVocabulary(effective)
      const exitMeta = this.#diseasePacks.readExitMetadata(context, subject.kind, subject.id, packId)
      evaluatedPacks.push({
        effective,
        entry,
        ...(exitMeta.exited
          ? {
              exitMatchedFactIds: exitMeta.matchedFactIds,
              exitSummaryAlreadyEmitted: exitMeta.exitSummaryDelivered,
            }
          : {}),
        vocabulary,
      })

      const snapshots = effective.pack.knowledgeSnapshots ?? []
      if (snapshots.some(s => { const t = Date.parse(s.effectiveFrom); return !Number.isNaN(t) && t <= asOfMs })) {
        const evalRes = evaluateKnowledgeSnapshotForPatient({
          asOf,
          encounterIdByRecordId: encounterMap,
          includeRetired: true,
          ledger,
          packId,
          packVersion: effective.pack.manifest.version,
          snapshots,
          verifySourcePassage,
          vocabulary,
        })
        snapshotVersionsByPackId.set(packId, evalRes.snapshotVersion)
        for (const claim of evalRes.claims) {
          if (claim.status === 'superseded' || claim.status === 'retracted' || claim.status === 'rejected'
            || claim.status === 'draft' || claim.status === 'imported' || !claim.anchorValid) {
            retiredClaimIds.add(claim.id)
          }
        }
        for (const retiredId of Object.keys(evalRes.retiredClaimStatuses ?? {})) {
          retiredClaimIds.add(retiredId)
        }
      }

      if (entry.activationStatus === 'active') {
        const tags: ClinicalPromptRiskTag[] = []
        for (const tag of effective.pack.riskTags ?? []) {
          if (tag.candidateMedicationClasses !== undefined || tag.timing === 'order-draft-select') continue
          if (evaluatePackTrigger(tag.condition, ledger, { asOf, encounterIdByRecordId: encounterMap, vocabulary }).matched) {
            tags.push({ id: tag.id, labelZh: tag.labelZh, severity: tag.severity })
          }
        }
        if (tags.length > 0) riskTagsByPackId.set(packId, tags)
      }
    }

    return { evaluatedPacks, retiredClaimIds, riskTagsByPackId, snapshotVersionsByPackId }
  }

  #qualityCheckForTiming(
    context: ActorContext,
    subject: PromptSubject,
    timing: ClinicalPromptTiming,
    query: ClinicalPromptReadQuery,
    inpatient?: InpatientService,
  ): ClinicalQualityCheck | undefined {
    if (subject.kind === 'outpatient') {
      if (timing === 'order-sign') {
        return this.#clinicalQuality.previewOutpatient(context, {
          encounterId: subject.encounterId,
          gate: 'outpatient-prescription',
        })
      }
      if (timing === 'encounter-complete') {
        return this.#clinicalQuality.previewOutpatient(context, {
          encounterId: subject.encounterId,
          gate: 'outpatient-completion',
        })
      }
      return undefined
    }

    if (!inpatient || context.roleCode !== 'inpatient-doctor') return undefined
    if (timing === 'order-sign') {
      return this.#clinicalQuality.previewInpatient(inpatient, context, {
        admissionId: subject.id,
        ...(query.catalogItemId === undefined ? {} : { catalogItemId: query.catalogItemId }),
        gate: 'inpatient-order',
      })
    }
    if (timing === 'pci-plan') {
      return this.#clinicalQuality.previewInpatient(inpatient, context, {
        admissionId: subject.id,
        gate: 'inpatient-pci-plan',
      })
    }
    if (timing === 'discharge') {
      return this.#clinicalQuality.previewInpatient(inpatient, context, {
        admissionId: subject.id,
        gate: 'inpatient-discharge',
      })
    }
    return undefined
  }

  #appendPhenotypeCandidateCards(input: {
    asOf: string
    cards: readonly ClinicalPromptCard[]
    context: ActorContext
    encounterMap: Readonly<Record<string, string>>
    evaluatedPacks: readonly EvaluatedPackForPromptBuild[]
    ledger: ClinicalFactLedger
    patientId: string
    timing: ClinicalPromptTiming
  }): ClinicalPromptCard[] {
    if (input.timing !== 'encounter-open' && input.timing !== 'report-arrived') {
      return [...input.cards]
    }
    const patient = this.#fhir.read(input.context, 'Patient', input.patientId)
    const patientBirthDate = patient.resourceType === 'Patient' && typeof patient.birthDate === 'string'
      ? patient.birthDate
      : undefined
    const patientSex = patient.resourceType === 'Patient' && (
      patient.gender === 'male'
      || patient.gender === 'female'
      || patient.gender === 'other'
      || patient.gender === 'unknown'
    )
      ? patient.gender
      : undefined

    const nodeByCode = new Map<string, ConceptVocabulary['nodes'][number]>()
    const mappingByKey = new Map<string, ConceptVocabulary['mappings'][number]>()
    for (const vocab of [PUBLIC_CONCEPT_VOCABULARY, ...input.evaluatedPacks.map(item => item.vocabulary)]) {
      for (const node of vocab.nodes) nodeByCode.set(node.code, node)
      for (const mapping of vocab.mappings) {
        mappingByKey.set(`${mapping.sourceSystem}|${mapping.sourceCode}|${mapping.targetConceptCode}`, mapping)
      }
    }
    const mergedVocabulary: ConceptVocabulary = {
      mappings: [...mappingByKey.values()],
      nodes: [...nodeByCode.values()],
      version: PUBLIC_CONCEPT_VOCABULARY.version,
    }

    const matchResult = matchPhenotypeCandidates({
      asOf: input.asOf,
      encounterIdByRecordId: input.encounterMap,
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: input.ledger,
      ...(patientBirthDate === undefined ? {} : { patientBirthDate }),
      ...(patientSex === undefined ? {} : { patientSex }),
      timing: input.timing,
      vocabulary: mergedVocabulary,
    })

    const combined = [...input.cards]
    const mergePhenotypeIntoRecognition = (candidateCard: ClinicalPromptCard): boolean => {
      const index = combined.findIndex(card => (
        card.category === 'recognition' && card.packId === candidateCard.packId && card.timing === candidateCard.timing
      ))
      if (index < 0) return false
      combined[index] = mergePhenotypeIntoRecognitionCard(combined[index]!, candidateCard)
      return true
    }
    const seenCardIds = new Set(combined.map(card => card.cardId))
    const packEntryById = new Map(input.evaluatedPacks.map(item => [item.effective.pack.manifest.id, item]))
    for (const candidateCard of matchResult.promptCards) {
      if (seenCardIds.has(candidateCard.cardId)) continue
      const targetPack = candidateCard.packId ? packEntryById.get(candidateCard.packId) : undefined
      if (targetPack) {
        const entry = targetPack.entry
        if (
          entry.exited === true
          || entry.activationStatus === 'inapplicable'
          || entry.activationReason === 'manual-disabled'
          || entry.activationReason === 'pack-draft'
          || entry.activationReason === 'pack-retired'
          || entry.status !== 'active'
        ) {
          continue
        }
      }
      seenCardIds.add(candidateCard.cardId)
      if (candidateCard.packId !== null && mergePhenotypeIntoRecognition(candidateCard)) continue
      combined.push(candidateCard)
    }
    return combined
  }

  #evaluateSingleSnapshotPass(input: {
    asOf: string
    context: ActorContext
    inpatient?: InpatientService | undefined
    query: ClinicalPromptReadQuery
    recordAudit: boolean
    subject: PromptSubject
    systemBackgroundRefresh?: boolean | undefined
    timing: ClinicalPromptTiming
  }): {
    blockedRecords: ClinicalPromptSafetyBlock[]
    cards: ClinicalPromptCard[]
    evaluatedPacks: EvaluatedPackForPromptBuild[]
    ledger: ClinicalFactLedger
    snapshotVersionsByPackId: Map<string, string>
  } {
    const ledger = this.#factLedger.buildInternalLedger(input.context, input.subject, {
      asOf: input.asOf,
      includeSuperseded: false,
    })
    const encounterMap = this.#diseasePacks.resolvePatientEncounterMap(input.context, input.subject.patientId)
    const { evaluatedPacks } = this.#evaluatePacksForSubject(input.context, input.subject, ledger, input.asOf)
    const medicationCatalog = this.#buildMedicationCatalog(input.context)
    const { classesByTemplateId: templateClassesByTemplateId, itemsByTemplateId: templateMedicationItemsByTemplateId } =
      this.#resolveTemplateMedicationMaps(medicationCatalog)
    const activeMedications = this.#activeMedications(input.context, input.subject, input.inpatient)
    const activeMedicationClasses = [...new Set(activeMedications.flatMap(m => [...m.pharmacologyClasses]))]
    const candidateMedicationClasses = input.query.candidateMedicationClasses
      ?.split(',')
      .map(s => s.trim())
      .filter(Boolean)

    const qualityCheck = this.#qualityCheckForTiming(
      input.context,
      input.subject,
      input.timing,
      input.query,
      input.inpatient,
    )
    const verifySourcePassage = this.#sourceVerifier(input.context, input.subject.patientId, input.asOf)

    const built = buildTimingPromptCards({
      activeMedicationClasses,
      asOf: input.asOf,
      ...(candidateMedicationClasses === undefined ? {} : { candidateMedicationClasses }),
      encounterIdByRecordId: encounterMap,
      evaluatedPacks,
      ledger,
      subjectKind: input.subject.kind,
      ...(qualityCheck === undefined ? {} : { qualityCheck }),
      satisfiedBedsideCodes: input.subject.kind === 'inpatient'
        ? this.#clinicalScores.satisfiedBedsideCodes(input.context, input.subject.id)
        : [],
      ...(input.query.selectedTemplateId === undefined ? {} : { selectedTemplateId: input.query.selectedTemplateId }),
      templateClassesByTemplateId,
      templateMedicationItemsByTemplateId,
      timing: input.timing,
      verifySourcePassage,
    })

    const cardsToFilter = this.#appendPhenotypeCandidateCards({
      asOf: input.asOf,
      cards: built.cards,
      context: input.context,
      encounterMap,
      evaluatedPacks,
      ledger,
      patientId: input.subject.patientId,
      timing: input.timing,
    })

    const allergyCodes = this.#outpatient.patientAllergyCodes(input.context, input.subject.patientId)
    let scores: ClinicalScoreBundle | undefined
    try {
      scores = input.subject.kind === 'outpatient'
        ? this.#clinicalScores.outpatientSnapshot(input.context, input.subject.id)
        : input.inpatient
          ? this.#clinicalScores.inpatientSnapshot(input.inpatient, input.context, input.subject.id)
          : undefined
    } catch (error) {
      if (!input.systemBackgroundRefresh) throw error
      scores = undefined
    }

    const filtered = filterPromptCardsBeforeDisplay({
      activeMedications,
      allergyCodes,
      cards: cardsToFilter,
      effectivePacks: evaluatedPacks.map(item => item.effective),
      evaluatedEntries: evaluatedPacks.map(item => item.entry),
      ledger,
      medicationCatalog,
      ...(scores === undefined ? {} : { renal: renalFactFromScores(scores) }),
      retiredOrInactiveClaimIds: built.retiredOrInactiveClaimIds,
      verifySourcePassage,
    })

    const blockedRecords = input.recordAudit
      ? this.#recordSafetyBlocks(input.context, input.subject, filtered.blockedRecords, input.asOf)
      : filtered.blockedRecords

    const attached = attachRiskTagsAndSideBySide(filtered.visibleCards, built.riskTagsByPackId)
    return {
      blockedRecords,
      cards: attached.cards,
      evaluatedPacks,
      ledger,
      snapshotVersionsByPackId: built.snapshotVersionsByPackId,
    }
  }

  #evaluatePromptsForSubject(
    context: ActorContext,
    subject: PromptSubject,
    query: ClinicalPromptReadQuery,
    virtualNow: string,
    persistSnapshot: boolean,
    inpatient?: InpatientService,
    preserveStaleCardIds?: ReadonlySet<string>,
    systemBackgroundRefresh?: boolean,
  ): ClinicalPromptBundle {
    const timing: ClinicalPromptTiming = query.timing ?? 'encounter-open'
    const baselineAsOf = query.asOf ?? virtualNow

    const baseline = this.#evaluateSingleSnapshotPass({
      asOf: baselineAsOf,
      context,
      inpatient,
      query,
      recordAudit: persistSnapshot,
      subject,
      systemBackgroundRefresh,
      timing,
    })

    let workingCards = baseline.cards
    let blockedRecords = baseline.blockedRecords
    let reevaluateDiffs: ClinicalPromptReevaluateDiff[] | undefined
    let historicalReplay: ClinicalPromptHistoricalReplay | null = null

    if (query.reevaluateWithLatestKnowledge === true) {
      const latest = this.#evaluateSingleSnapshotPass({
        asOf: virtualNow,
        context,
        inpatient,
        query,
        recordAudit: persistSnapshot,
        subject,
        timing,
      })
      blockedRecords = [...baseline.blockedRecords, ...latest.blockedRecords]

      const comparisonsByPack = new Map<string, KnowledgeVersionComparison>()
      const verifyLatest = this.#sourceVerifier(context, subject.patientId, virtualNow)
      const verifyBaseline = this.#sourceVerifier(context, subject.patientId, baselineAsOf)
      const baselineEncounterMap = this.#diseasePacks.resolvePatientEncounterMap(context, subject.patientId)

      for (const item of latest.evaluatedPacks) {
        const snapshots = item.effective.pack.knowledgeSnapshots ?? []
        if (snapshots.length === 0) continue
        const baselineMs = Date.parse(baselineAsOf)
        if (!snapshots.some(s => Date.parse(s.effectiveFrom) <= baselineMs)) continue
        const evalBase = evaluateKnowledgeSnapshotForPatient({
          asOf: baselineAsOf,
          encounterIdByRecordId: baselineEncounterMap,
          ledger: baseline.ledger,
          packId: item.effective.pack.manifest.id,
          packVersion: item.effective.pack.manifest.version,
          snapshots,
          verifySourcePassage: verifyBaseline,
          vocabulary: item.vocabulary,
        })
        const evalLatest = evaluateKnowledgeSnapshotForPatient({
          asOf: virtualNow,
          encounterIdByRecordId: baselineEncounterMap,
          ledger: latest.ledger,
          packId: item.effective.pack.manifest.id,
          packVersion: item.effective.pack.manifest.version,
          snapshots,
          verifySourcePassage: verifyLatest,
          vocabulary: item.vocabulary,
        })
        comparisonsByPack.set(
          item.effective.pack.manifest.id,
          compareKnowledgeEvaluations(evalBase, evalLatest),
        )
      }

      const diffResult = computePromptCardKnowledgeDiff(
        baseline.cards,
        latest.cards,
        comparisonsByPack,
      )
      workingCards = diffResult.cards
      reevaluateDiffs = diffResult.diffs
      historicalReplay = {
        asOf: baselineAsOf,
        baselineSnapshotVersions: Object.fromEntries(baseline.snapshotVersionsByPackId.entries()),
        latestAsOf: virtualNow,
        latestSnapshotVersions: Object.fromEntries(latest.snapshotVersionsByPackId.entries()),
        reevaluated: true,
        retiredHiddenClaimIds: diffResult.retiredHiddenClaimIds,
      }
    } else if (query.asOf !== undefined) {
      const latestSnapshotVersions = new Map<string, string>()
      for (const item of baseline.evaluatedPacks) {
        const snapshots = item.effective.pack.knowledgeSnapshots ?? []
        if (snapshots.length === 0) continue
        const latestVer = evaluateKnowledgeSnapshotForPatient({
          asOf: virtualNow,
          ledger: baseline.ledger,
          packId: item.effective.pack.manifest.id,
          packVersion: item.effective.pack.manifest.version,
          snapshots,
          verifySourcePassage: this.#sourceVerifier(context, subject.patientId, virtualNow),
          vocabulary: item.vocabulary,
        }).snapshotVersion
        latestSnapshotVersions.set(item.effective.pack.manifest.id, latestVer)
      }
      historicalReplay = {
        asOf: baselineAsOf,
        baselineSnapshotVersions: Object.fromEntries(baseline.snapshotVersionsByPackId.entries()),
        latestAsOf: virtualNow,
        latestSnapshotVersions: Object.fromEntries(latestSnapshotVersions.entries()),
        reevaluated: false,
        retiredHiddenClaimIds: [],
      }
    }

    // Merge stale state from persisted snapshots when reading current view after report amendment
    if (query.asOf === undefined && query.reevaluateWithLatestKnowledge !== true) {
      workingCards = this.#mergePersistedStaleSnapshots(context, subject, timing, workingCards)
    }

    // Never re-surface stale snapshots from packs that are currently exited
    const exitedPackIds = new Set(
      baseline.evaluatedPacks
        .filter(item => item.entry.exited === true || item.entry.activationReason === 'pack-exited')
        .map(item => item.entry.packId),
    )
    if (exitedPackIds.size > 0) {
      workingCards = workingCards.filter(
        card => card.packId === null || !exitedPackIds.has(card.packId) || card.category === 'exit-summary',
      )
    }

    if (persistSnapshot && query.asOf === undefined) {
      const skipIds = new Set<string>(preserveStaleCardIds ?? [])
      for (const c of workingCards) {
        if (c.stale) skipIds.add(c.cardId)
      }
      this.#persistSnapshots(context, subject, workingCards, virtualNow, baselineAsOf, skipIds)
    }

    if (persistSnapshot && !systemBackgroundRefresh && query.asOf === undefined) {
      for (const card of workingCards) {
        if (card.category === 'exit-summary' && card.packId !== null) {
          this.#diseasePacks.markExitSummaryDelivered(context, subject.kind, subject.id, card.packId)
        }
      }
    }

    // Apply clinician dismissals
    const dismissals = this.#loadDismissals(context, subject)
    const withDismissals = workingCards.map(card => {
      const dismissal = dismissals.get(card.cardId)
      if (!dismissal) return card
      return clinicalPromptCardSchema.parse({
        ...card,
        dismissal: {
          auditId: dismissal.audit_id,
          dismissedAt: dismissal.dismissed_at,
          dismissedByActorId: dismissal.actor_id,
          note: dismissal.note,
          reasonCode: dismissal.reason_code,
        },
        status: 'dismissed',
      })
    })

    const filteredVisibility = withDismissals.filter(card => {
      if (card.deliveryMode === 'silent' && query.includeSilent !== true) return false
      if (card.status === 'dismissed' && query.includeDismissed !== true) return false
      return true
    })

    const finalizedGroups = attachRiskTagsAndSideBySide(filteredVisibility, new Map())
    const persistedBlockCount = z.object({ cnt: z.number().int().nonnegative() }).parse(
      this.#database.driver.prepare(`
        SELECT COUNT(*) AS cnt FROM clinical_prompt_safety_block_audit
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ?
      `).get(context.workspaceId, context.epoch, subject.kind, subject.id),
    ).cnt

    return clinicalPromptBundleSchema.parse({
      blockedAuditCount: Math.max(blockedRecords.length, persistedBlockCount),
      blockedRecords,
      cards: finalizedGroups.cards,
      evaluatedAt: query.reevaluateWithLatestKnowledge ? virtualNow : baselineAsOf,
      historicalReplay,
      llmInvocationCount: 0,
      ...(reevaluateDiffs === undefined ? {} : { reevaluateDiffs }),
      sideBySideGroups: finalizedGroups.sideBySideGroups,
      subjectId: subject.id,
      subjectKind: subject.kind,
    })
  }

  #mergePersistedStaleSnapshots(
    context: ActorContext,
    subject: PromptSubject,
    timing: ClinicalPromptTiming,
    freshCards: readonly ClinicalPromptCard[],
  ): ClinicalPromptCard[] {
    const persistedRows = z.array(snapshotRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT based_on_fact_versions_json, card_id, card_json, created_as_of, created_at,
               delivery_mode, encounter_id, knowledge_snapshot_version, pack_id, pack_version, timing
        FROM clinical_prompt_card_snapshot
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND timing = ?
      `).all(context.workspaceId, context.epoch, subject.kind, subject.id, timing),
    )
    if (persistedRows.length === 0) return [...freshCards]

    const staleById = new Map<string, ClinicalPromptCard>()
    for (const row of persistedRows) {
      const card = clinicalPromptCardSchema.parse(JSON.parse(row.card_json))
      if (card.stale) staleById.set(card.cardId, card)
    }
    if (staleById.size === 0) return [...freshCards]

    const merged = freshCards.map(card => staleById.get(card.cardId) ?? card)
    const seen = new Set(merged.map(c => c.cardId))
    for (const staleCard of staleById.values()) {
      if (!seen.has(staleCard.cardId)) merged.push(staleCard)
    }
    return merged
  }

  #persistSnapshots(
    context: ActorContext,
    subject: PromptSubject,
    cards: readonly ClinicalPromptCard[],
    createdAt: string,
    createdAsOf: string,
    skipCardIds?: ReadonlySet<string>,
  ): void {
    const stmt = this.#database.driver.prepare(`
      INSERT INTO clinical_prompt_card_snapshot (
        workspace_id, epoch, subject_kind, subject_id, encounter_id, card_id,
        timing, pack_id, pack_version, knowledge_snapshot_version, delivery_mode,
        based_on_fact_versions_json, card_json, created_at, created_as_of
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, epoch, subject_kind, subject_id, encounter_id, card_id) DO UPDATE SET
        timing = excluded.timing,
        pack_id = excluded.pack_id,
        pack_version = excluded.pack_version,
        knowledge_snapshot_version = excluded.knowledge_snapshot_version,
        delivery_mode = excluded.delivery_mode,
        based_on_fact_versions_json = excluded.based_on_fact_versions_json,
        card_json = excluded.card_json,
        created_as_of = excluded.created_as_of
    `)
    for (const card of cards) {
      if (skipCardIds?.has(card.cardId)) continue
      stmt.run(
        context.workspaceId,
        context.epoch,
        subject.kind,
        subject.id,
        subject.encounterId,
        card.cardId,
        card.timing,
        card.packId,
        card.packVersion,
        card.knowledgeSnapshotVersion,
        card.deliveryMode,
        JSON.stringify(card.basedOnFactVersions),
        JSON.stringify(card),
        createdAt,
        createdAsOf,
      )
    }
  }

  #recordSafetyBlocks(
    context: ActorContext,
    subject: { id: string; kind: 'outpatient' | 'inpatient' },
    blocks: readonly ClinicalPromptSafetyBlock[],
    blockedAt: string,
  ): ClinicalPromptSafetyBlock[] {
    if (blocks.length === 0) return []
    const insert = this.#database.driver.prepare(`
      INSERT INTO clinical_prompt_safety_block_audit (
        workspace_id, epoch, audit_id, subject_kind, subject_id, blocked_at,
        timing, pack_id, block_reason, card_summary, detail_json, actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const existingLookup = this.#database.driver.prepare(`
      SELECT audit_id FROM clinical_prompt_safety_block_audit
      WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ?
        AND timing = ? AND block_reason = ? AND card_summary = ? AND detail_json = ?
      ORDER BY blocked_at DESC LIMIT 1
    `)

    return blocks.map(block => {
      const detailJson = JSON.stringify({
        cardId: block.cardId,
        detailHash: canonicalJsonHash(block),
        detailZh: block.detailZh,
        ruleId: block.ruleId,
        suggestionIds: block.suggestionIds,
      })
      const existing = z.object({ audit_id: z.string() }).optional().parse(
        existingLookup.get(
          context.workspaceId,
          context.epoch,
          subject.kind,
          subject.id,
          block.timing,
          block.blockedReason,
          block.cardSummary,
          detailJson,
        ),
      )
      const auditId = existing?.audit_id ?? uuidv7()
      if (existing === undefined) {
        insert.run(
          context.workspaceId,
          context.epoch,
          auditId,
          subject.kind,
          subject.id,
          blockedAt,
          block.timing,
          block.packId,
          block.blockedReason,
          block.cardSummary,
          detailJson,
          context.actorId,
        )
      }
      return { ...block, auditId, blockedAt }
    })
  }

  #loadDismissals(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, subject: { id: string; kind: 'outpatient' | 'inpatient' }) {
    const rows = z.array(dismissalRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT actor_id, audit_id, card_id, dismissed_at, note, pack_id, reason_code
        FROM clinical_prompt_card_dismissal
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ?
      `).all(context.workspaceId, context.epoch, subject.kind, subject.id),
    )
    return new Map(rows.map(row => [row.card_id, row]))
  }

  #executeDismiss(
    context: ActorContext,
    subject: PromptSubject,
    input: { cardId: string; note: string; packId?: string | undefined; reasonCode: z.infer<typeof dismissalRowSchema.shape.reason_code>; timing?: ClinicalPromptTiming | undefined },
    now: string,
    inpatient?: InpatientService,
  ) {
    // Check persisted snapshots first across any timing, or evaluate target timing to verify card exists
    const persisted = snapshotRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT based_on_fact_versions_json, card_id, card_json, created_as_of, created_at,
               delivery_mode, encounter_id, knowledge_snapshot_version, pack_id, pack_version, timing
        FROM clinical_prompt_card_snapshot
        WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND card_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(context.workspaceId, context.epoch, subject.kind, subject.id, input.cardId),
    )

    let targetCard: ClinicalPromptCard | undefined = persisted
      ? clinicalPromptCardSchema.parse(JSON.parse(persisted.card_json))
      : undefined
    if (!targetCard) {
      const candidateTimings: ClinicalPromptTiming[] = input.timing
        ? [input.timing]
        : ['encounter-open', 'order-draft-select', 'order-sign', 'encounter-complete', 'pci-plan', 'discharge', 'report-arrived']
      for (const timing of candidateTimings) {
        const bundle = this.#evaluatePromptsForSubject(
          context,
          subject,
          { includeDismissed: true, includeSilent: true, timing },
          now,
          false,
          inpatient,
        )
        const found = bundle.cards.find(c => c.cardId === input.cardId)
        if (found) {
          targetCard = found
          break
        }
      }
    }

    if (!targetCard) {
      throw new ClinicalPromptCardError('CLINICAL_PROMPT_CARD_NOT_FOUND', `未找到临床提示卡 ${input.cardId}`, 404)
    }

    const auditId = uuidv7()
    const effectivePackId = input.packId ?? targetCard.packId ?? null
    const existingDismissal = this.#database.driver.prepare(`
      SELECT 1 FROM clinical_prompt_card_dismissal
      WHERE workspace_id = ? AND epoch = ? AND subject_kind = ? AND subject_id = ? AND card_id = ?
    `).get(context.workspaceId, context.epoch, subject.kind, subject.id, input.cardId)

    this.#database.driver.prepare(`
      INSERT INTO clinical_prompt_card_dismissal (
        workspace_id, epoch, subject_kind, subject_id, card_id, pack_id,
        reason_code, note, actor_id, dismissed_at, audit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, epoch, subject_kind, subject_id, card_id) DO UPDATE SET
        pack_id = excluded.pack_id,
        reason_code = excluded.reason_code,
        note = excluded.note,
        actor_id = excluded.actor_id,
        dismissed_at = excluded.dismissed_at,
        audit_id = excluded.audit_id
    `).run(
      context.workspaceId,
      context.epoch,
      subject.kind,
      subject.id,
      input.cardId,
      effectivePackId,
      input.reasonCode,
      input.note,
      context.actorId,
      now,
      auditId,
    )

    const dismissedCard = clinicalPromptCardSchema.parse({
      ...targetCard,
      dismissal: {
        auditId,
        dismissedAt: now,
        dismissedByActorId: context.actorId,
        note: input.note,
        reasonCode: input.reasonCode,
      },
      status: 'dismissed',
    })

    this.#persistSnapshots(context, subject, [dismissedCard], now, now)

    return {
      data: dismissedCard,
      effects: [
        {
          kind: (existingDismissal === undefined ? 'created' : 'updated') as 'created' | 'updated',
          reference: `ClinicalPromptCardDismissal/${subject.kind}:${subject.id}:${input.cardId}`,
          versionId: '1',
        },
      ],
    }
  }
}
