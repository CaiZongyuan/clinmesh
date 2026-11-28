import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import { clinicalReviewerRecordSchema, type ClinicalReviewerRecord } from '@clinmesh/contracts/knowledge-claims'
import {
  adjudicateConflictRequestSchema,
  conceptMappingImpactRequestSchema,
  guidelineDiffReportRequestSchema,
  offlineGuidelineSearchRequestSchema,
  offlineGuidelineSearchResponseSchema,
  offlineKnowledgePipelineInputSchema,
  type AdjudicateConflictResult,
  type ConceptMappingImpactReport,
  type GuidelineSourceDiffReport,
  type OfflineGuidelineSearchResponse,
  type OfflineKnowledgePipelineResult,
} from '@clinmesh/contracts/knowledge-pipeline'
import { shanghaiBusinessDate } from '@clinmesh/contracts/scenario'
import {
  resolveEffectiveConceptVocabulary,
  validateAndNormalizeVocabularyOverride,
} from '@clinmesh/core/concept-vocabulary'
import { KnowledgeClaimError } from '@clinmesh/core/knowledge-claims'
import {
  adjudicateGuidelineClaimConflict,
  buildConceptMappingImpactReport as buildCoreMappingImpactReport,
  buildGuidelineSourceDiffReport as buildCoreGuidelineDiffReport,
  createDeterministicClaimDraftStream,
  createPassageBackedDeterministicDraftStream,
  runOfflineKnowledgeClaimPipeline,
} from '@clinmesh/core/knowledge-pipeline'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import { WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'
import type { ClinicalFactLedgerService } from './clinical-fact-ledger-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { DiseasePackRuntimeService } from './disease-pack-runtime-service.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'

export class KnowledgePipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'KnowledgePipelineError'
  }
}

const patientIdRowSchema = z.object({
  patient_id: z.string().min(1),
}).strict()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertClinicianReviewerAuthorized(
  rawReviewer: unknown,
  registeredReviewers: readonly ClinicalReviewerRecord[],
): void {
  const check = clinicalReviewerRecordSchema.safeParse(rawReviewer)
  if (!check.success) {
    throw new KnowledgeClaimError(
      'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
      '临床审核人未通过执业校验（licenseVerified 必须为 true），禁止签署或裁决正式知识主张',
    )
  }
  const matched = registeredReviewers.some(registered =>
    registered.reviewerId === check.data.reviewerId
    && registered.nameZh === check.data.nameZh
    && registered.specialty === check.data.specialty
    && registered.licenseVerified === true,
  )
  if (!matched) {
    throw new KnowledgeClaimError(
      'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
      `临床审核人 ${check.data.reviewerId} 未在服务端登记名单中，禁止签署或裁决正式知识主张`,
    )
  }
}

/**
 * Offline developer/admin-only tooling service for claim drafting,
 * guideline diff & expert adjudication, mapping impact reporting,
 * and synonym-expanded guideline search. Never exposed to online Agent runtime.
 */
export class KnowledgePipelineService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #diseasePacks: DiseasePackRuntimeService
  readonly #factLedger: ClinicalFactLedgerService
  readonly #guidelines: GuidelineCorpus | undefined
  readonly #outpatient: OutpatientWorkflowContext
  readonly #registeredReviewers: readonly ClinicalReviewerRecord[]
  readonly #workspaces: WorkspaceRepository

  constructor(options: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    diseasePacks: DiseasePackRuntimeService
    factLedger: ClinicalFactLedgerService
    guidelines?: GuidelineCorpus
    outpatientContext: OutpatientWorkflowContext
    registeredReviewers?: readonly ClinicalReviewerRecord[]
  }) {
    this.#commands = options.commands
    this.#database = options.database
    this.#diseasePacks = options.diseasePacks
    this.#factLedger = options.factLedger
    this.#guidelines = options.guidelines
    this.#outpatient = options.outpatientContext
    this.#registeredReviewers = options.registeredReviewers ?? []
    this.#workspaces = new WorkspaceRepository(options.database)
  }

  #assertOfflineAdministrator(context: ActorContext): void {
    if (context.agentGrantId !== undefined) {
      throw new KnowledgePipelineError(
        'OFFLINE_TOOL_FORBIDDEN_FOR_AGENT',
        '离线知识制卡与影响分析工具严禁在线 Agent 运行时调用',
        403,
      )
    }
    if (context.roleCode !== 'administrator') {
      throw new KnowledgePipelineError(
        'ROLE_NOT_ALLOWED',
        '离线知识制卡与影响分析工具仅限管理员（administrator）调用',
        403,
      )
    }
    this.#workspaces.assertCurrent(context, context.scenarioRunId)
  }

  #resolveVocabulary(packId: string | undefined, override?: ConceptVocabulary): ConceptVocabulary {
    if (override !== undefined) {
      return validateAndNormalizeVocabularyOverride(override)
    }
    if (packId === undefined) {
      return resolveEffectiveConceptVocabulary()
    }
    const effective = this.#diseasePacks.registry.getEffective(packId)
    return resolveEffectiveConceptVocabulary({
      ...(effective.hospitalOverlay?.conceptVocabulary === undefined
        ? {}
        : { hospitalLayer: effective.hospitalOverlay.conceptVocabulary }),
      ...(effective.pack.conceptVocabulary === undefined
        ? {}
        : { packLayer: effective.pack.conceptVocabulary }),
    })
  }

  #buildEmptyLedger(asOf: string): ClinicalFactLedger {
    return {
      facts: [],
      includeSuperseded: false,
      patientId: 'offline-impact-analysis',
      subjectId: 'offline-impact-analysis',
      subjectKind: 'outpatient',
      summary: {
        conflictCount: 0,
        eligibleCount: 0,
        expiredCount: 0,
        externalUnverifiedCount: 0,
        notAskedCount: 0,
        supersededCount: 0,
        suspiciousCount: 0,
        totalFacts: 0,
        verifiedExternalCount: 0,
      },
      trace: {
        evaluatedAsOf: asOf,
        hospitalId: 'hospital-synthetic-clinmesh',
        mappingVersion: '2026-11-24.r1',
      },
    }
  }

  runDraftPipeline(context: ActorContext, rawBody: unknown): OfflineKnowledgePipelineResult {
    const auditInput: Record<string, unknown> = {}
    try {
      this.#assertOfflineAdministrator(context)
      if (isPlainRecord(rawBody) && rawBody['clinicianReviewer'] !== undefined) {
        throw new KnowledgeClaimError(
          'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
          '离线制卡流水线最高仅产出试用版（auto-verified），禁止在草拟阶段传入临床审核人直接发布',
        )
      }
      const input = offlineKnowledgePipelineInputSchema.parse(rawBody)
      auditInput.packId = input.packId
      auditInput.topicId = input.topicId
      auditInput.snapshotVersion = input.snapshotVersion

      const vocabulary = this.#resolveVocabulary(input.packId, input.vocabulary)
      const controlledDraftStream = input.candidates !== undefined
        ? createDeterministicClaimDraftStream(input.candidates)
        : createPassageBackedDeterministicDraftStream()

      const result = runOfflineKnowledgeClaimPipeline({
        ...(input.clinicianReviewer === undefined ? {} : { clinicianReviewer: input.clinicianReviewer }),
        controlledDraftStream,
        effectiveFrom: input.effectiveFrom,
        packId: input.packId,
        snapshotVersion: input.snapshotVersion,
        sourceDocument: input.sourceDocument,
        topicId: input.topicId,
        ...(input.topicMetadata === undefined ? {} : { topicMetadata: input.topicMetadata }),
        version: input.version,
        vocabulary,
      })

      this.#commands.auditRead(context, 'offline.knowledge-claims.draft-pipeline', {
        ...auditInput,
        acceptedCount: result.acceptedClaims.length,
        draftedCount: result.draftedCount,
        rejectedCount: result.rejectedClaims.length,
      }, 'success')
      return result
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'offline.knowledge-claims.draft-pipeline', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  buildGuidelineDiffReport(context: ActorContext, rawBody: unknown): GuidelineSourceDiffReport {
    const auditInput: Record<string, unknown> = {}
    try {
      this.#assertOfflineAdministrator(context)
      const input = guidelineDiffReportRequestSchema.parse(rawBody)
      auditInput.packId = input.packId
      auditInput.v1Version = input.v1Document.version
      auditInput.v2Version = input.v2Document.version

      const effectivePack = this.#diseasePacks.registry.getEffective(input.packId)
      let snapshot = input.snapshot
      if (snapshot === undefined) {
        const snapshots = effectivePack.pack.knowledgeSnapshots ?? []
        if (snapshots.length === 0) {
          throw new KnowledgeClaimError('KNOWLEDGE_SNAPSHOT_NOT_FOUND', `专病包 ${input.packId} 未声明基线知识快照`)
        }
        snapshot = [...snapshots].sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom)).at(-1)!
      }

      const report = buildCoreGuidelineDiffReport({
        effectivePack,
        snapshot,
        v1Document: input.v1Document,
        ...(input.v2Candidates === undefined ? {} : { v2Candidates: input.v2Candidates }),
        v2Document: input.v2Document,
      })

      this.#commands.auditRead(context, 'offline.guidelines.diff-report', {
        ...auditInput,
        affectedClaimCount: report.affectedClaimIds.length,
        conflictCount: report.conflicts.length,
      }, 'success')
      return report
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'offline.guidelines.diff-report', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  adjudicateGuidelineConflict(context: ActorContext, rawBody: unknown): AdjudicateConflictResult {
    const auditInput: Record<string, unknown> = {}
    try {
      this.#assertOfflineAdministrator(context)
      const rawReviewer = isPlainRecord(rawBody) && isPlainRecord(rawBody['adjudication'])
        ? rawBody['adjudication']['reviewer']
        : undefined
      assertClinicianReviewerAuthorized(rawReviewer, this.#registeredReviewers)
      const input = adjudicateConflictRequestSchema.parse(rawBody)
      auditInput.conflictId = input.adjudication.conflictId
      auditInput.decision = input.adjudication.decision
      auditInput.reviewerId = input.adjudication.reviewer.reviewerId

      const result = adjudicateGuidelineClaimConflict({
        adjudication: input.adjudication,
        ...(input.effectiveFrom === undefined ? {} : { effectiveFrom: input.effectiveFrom }),
        nowIso: this.#outpatient.virtualTime(context),
        registeredReviewers: this.#registeredReviewers,
        report: input.report,
        snapshot: input.snapshot,
      })

      this.#commands.auditRead(context, 'offline.guidelines.adjudicate-conflict', auditInput, 'success')
      return result
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'offline.guidelines.adjudicate-conflict', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  buildConceptMappingImpactReport(
    context: ActorContext,
    rawBody: unknown,
  ): ConceptMappingImpactReport {
    const auditInput: Record<string, unknown> = {}
    try {
      this.#assertOfflineAdministrator(context)
      const input = conceptMappingImpactRequestSchema.parse(rawBody)
      auditInput.packId = input.packId

      const effectivePack = this.#diseasePacks.registry.getEffective(input.packId)
      const beforeVocabulary = this.#resolveVocabulary(input.packId, input.beforeVocabulary)
      const afterVocabulary = this.#resolveVocabulary(input.packId, input.afterVocabulary)
      const virtualNow = this.#outpatient.virtualTime(context)
      const asOfDate = input.asOfDate ?? shanghaiBusinessDate(virtualNow)

      let ledger: ClinicalFactLedger
      if (input.ledger !== undefined) {
        ledger = input.ledger
      } else if (input.caseId !== undefined) {
        const patientId = this.#diseasePacks.readOutpatientPatientId(context, input.caseId)
        ledger = this.#factLedger.buildInternalLedger(
          context,
          { id: input.caseId, kind: 'outpatient', patientId },
          { asOf: virtualNow, includeSuperseded: false },
        )
      } else if (input.admissionId !== undefined) {
        const admissionRow = patientIdRowSchema.optional().parse(
          this.#database.driver.prepare(`
            SELECT patient_id FROM inpatient_admission
            WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
          `).get(context.workspaceId, context.epoch, input.admissionId),
        )
        if (admissionRow === undefined) {
          throw new KnowledgePipelineError('INPATIENT_NOT_FOUND', `未找到住院记录 ${input.admissionId}`, 404)
        }
        ledger = this.#factLedger.buildInternalLedger(
          context,
          { id: input.admissionId, kind: 'inpatient', patientId: admissionRow.patient_id },
          { asOf: virtualNow, includeSuperseded: false },
        )
      } else {
        ledger = this.#buildEmptyLedger(virtualNow)
      }

      const snapshots = input.snapshots ?? effectivePack.pack.knowledgeSnapshots ?? []
      const report = buildCoreMappingImpactReport({
        afterVocabulary,
        asOfDate,
        beforeVocabulary,
        effectivePack,
        ...(input.examCases === undefined ? {} : { examCases: input.examCases }),
        ledger,
        snapshots,
      })

      this.#commands.auditRead(context, 'offline.concept-mappings.impact-report', {
        ...auditInput,
        affectedFactCount: report.affectedHistoricalFactIds.length,
        downgradedCount: report.downgradedMappingIds.length,
      }, 'success')
      return report
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'offline.concept-mappings.impact-report', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  searchGuidelinesWithSynonyms(context: ActorContext, rawBody: unknown): OfflineGuidelineSearchResponse {
    const auditInput: Record<string, unknown> = {}
    try {
      this.#assertOfflineAdministrator(context)
      const input = offlineGuidelineSearchRequestSchema.parse(rawBody)
      auditInput.query = input.query

      if (this.#guidelines === undefined) {
        throw new KnowledgePipelineError('GUIDELINE_CORPUS_UNAVAILABLE', '指南全文检索库未初始化', 404)
      }

      const vocabulary = this.#resolveVocabulary(input.packId, input.vocabulary)
      const asOfDate = input.asOfDate ?? shanghaiBusinessDate(this.#outpatient.virtualTime(context))

      const result = this.#guidelines.search(input.query, {
        asOfDate,
        ...(input.population === undefined ? {} : { population: input.population }),
        vocabulary,
      })

      this.#commands.auditRead(context, 'offline.guidelines.search', {
        ...auditInput,
        expandedCount: result.expandedTerms?.length ?? 0,
        hitCount: result.guidelines.length,
      }, 'success')
      return offlineGuidelineSearchResponseSchema.parse(result)
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'offline.guidelines.search', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }
}
