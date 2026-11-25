import {
  conceptVocabularyCatalogQuerySchema,
  conceptVocabularyCatalogResponseSchema,
  type ConceptVocabulary,
  type ConceptVocabularyCatalogResponse,
} from '@clinmesh/contracts/concept-vocabulary'
import {
  diseasePackKnowledgeEvaluationSchema,
  diseasePackKnowledgeReadQuerySchema,
  type DiseasePackKnowledgeEvaluation,
  type DiseasePackKnowledgeReadQuery,
  type KnowledgeAnchorCitation,
} from '@clinmesh/contracts/knowledge-claims'
import { shanghaiBusinessDate } from '@clinmesh/contracts/scenario'
import {
  PUBLIC_CONCEPT_VOCABULARY,
  evaluateConceptMappingEligibility,
  expandSearchQueryWithApprovedSynonyms,
  mergeThreeLayerConceptVocabulary,
} from '@clinmesh/core/concept-vocabulary'
import {
  compareKnowledgeEvaluations,
  evaluateKnowledgeSnapshotForPatient,
  type KnowledgePassageVerifier,
} from '@clinmesh/core/knowledge-claims'
import { z } from 'zod'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import type { ClinicalFactLedgerService } from './clinical-fact-ledger-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { DiseasePackRuntimeService } from './disease-pack-runtime-service.ts'
import type { InpatientService } from './inpatient-service.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { resolvePatientGuidelinePopulation } from './patient-age.ts'
import { WorkflowError } from './workflow-error.ts'

export class KnowledgeSemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'KnowledgeSemanticError'
  }
}

const CATALOG_READ_ROLES = [
  'administrator',
  'outpatient-doctor',
  'inpatient-doctor',
  'ward-nurse',
  'medical-records',
] as const

function parseBooleanQueryFlag(raw: unknown, fieldName: string): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  throw new KnowledgeSemanticError('INVALID_INPUT', `查询参数 ${fieldName} 必须为布尔值`, 400)
}

function parseKnowledgeQuery(rawQuery: unknown): DiseasePackKnowledgeReadQuery {
  const rawRecord = z.record(z.string(), z.unknown()).parse(rawQuery ?? {})
  const recheckLatest = parseBooleanQueryFlag(rawRecord.recheckLatest, 'recheckLatest')
  const includeRetired = parseBooleanQueryFlag(rawRecord.includeRetired, 'includeRetired')
  return diseasePackKnowledgeReadQuerySchema.parse({
    ...(rawRecord.asOf === undefined ? {} : { asOf: rawRecord.asOf }),
    ...(includeRetired === undefined ? {} : { includeRetired }),
    ...(recheckLatest === undefined ? {} : { recheckLatest }),
  })
}

function resolveAsOfDate(rawAsOf: string | undefined, fallbackVirtualTime: string): string {
  if (rawAsOf === undefined) {
    return shanghaiBusinessDate(fallbackVirtualTime)
  }
  const trimmed = rawAsOf.trim()
  if (z.iso.date().safeParse(trimmed).success) {
    return trimmed
  }
  if (z.iso.datetime({ offset: true }).safeParse(trimmed).success) {
    return trimmed.slice(0, 10)
  }
  throw new KnowledgeSemanticError('INVALID_INPUT', `无效的词表评估日期 asOf: ${rawAsOf}`, 400)
}

/** Read-only service for 3-layer concept vocabulary resolution and AC8/AC9 knowledge evaluation. */
export class KnowledgeSemanticService {
  readonly #commands: CommandExecutor
  readonly #diseasePacks: DiseasePackRuntimeService
  readonly #factLedger: ClinicalFactLedgerService
  readonly #fhir: FhirRepository
  readonly #guidelines: GuidelineCorpus | undefined
  readonly #outpatient: OutpatientWorkflowContext

  constructor(options: {
    commands: CommandExecutor
    diseasePacks: DiseasePackRuntimeService
    factLedger: ClinicalFactLedgerService
    fhir: FhirRepository
    guidelines?: GuidelineCorpus
    outpatientContext: OutpatientWorkflowContext
  }) {
    this.#commands = options.commands
    this.#diseasePacks = options.diseasePacks
    this.#factLedger = options.factLedger
    this.#fhir = options.fhir
    this.#guidelines = options.guidelines
    this.#outpatient = options.outpatientContext
  }

  readConceptVocabularyCatalog(
    context: ActorContext,
    rawQuery: unknown,
  ): ConceptVocabularyCatalogResponse {
    const auditInput: Record<string, unknown> = {}
    try {
      if (!(CATALOG_READ_ROLES as readonly string[]).includes(context.roleCode)) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', '当前岗位无权读取概念词表目录')
      }
      const query = conceptVocabularyCatalogQuerySchema.parse(rawQuery ?? {})
      if (query.packId !== undefined) auditInput.packId = query.packId
      if (query.hospitalId !== undefined) auditInput.hospitalId = query.hospitalId
      if (query.query !== undefined) auditInput.query = query.query

      const asOfDate = resolveAsOfDate(query.asOf, this.#outpatient.virtualTime(context))
      auditInput.asOfDate = asOfDate

      const selectedEntries = query.packId === undefined
        ? this.#diseasePacks.registry.listEffective()
        : [this.#diseasePacks.registry.getEffective(query.packId)]

      const packLayers = selectedEntries
        .filter(entry => entry.pack.conceptVocabulary !== undefined)
        .map(entry => ({
          packId: entry.pack.manifest.id,
          vocabulary: entry.pack.conceptVocabulary!,
        }))

      let mergedVocabulary: ConceptVocabulary
      if (packLayers.length === 0) {
        mergedVocabulary = PUBLIC_CONCEPT_VOCABULARY
      } else {
        const combinedPackLayer: ConceptVocabulary = {
          mappings: packLayers.flatMap(item => item.vocabulary.mappings),
          nodes: packLayers.flatMap(item => item.vocabulary.nodes),
          version: [...new Set(packLayers.map(item => `${item.packId}@${item.vocabulary.version}`))].join('+'),
        }
        mergedVocabulary = mergeThreeLayerConceptVocabulary({
          packLayer: combinedPackLayer,
          publicLayer: PUBLIC_CONCEPT_VOCABULARY,
        })
      }

      const mappingEligibility = mergedVocabulary.mappings.map(mapping => (
        evaluateConceptMappingEligibility(mapping, { asOfDate })
      ))
      const expandedQueryTerms = query.query === undefined
        ? undefined
        : expandSearchQueryWithApprovedSynonyms(query.query, mergedVocabulary)

      const response = conceptVocabularyCatalogResponseSchema.parse({
        asOfDate,
        ...(expandedQueryTerms === undefined ? {} : { expandedQueryTerms }),
        ...(query.hospitalId === undefined ? {} : { hospitalId: query.hospitalId }),
        mappingEligibility,
        packIds: packLayers.map(item => item.packId),
        vocabulary: mergedVocabulary,
      })
      this.#commands.auditRead(context, 'catalog.concept-vocabulary.read', auditInput, 'success')
      return response
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'catalog.concept-vocabulary.read', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  readOutpatientKnowledge(
    context: ActorContext,
    caseId: string,
    packId: string,
    rawQuery: unknown,
  ): DiseasePackKnowledgeEvaluation {
    const auditInput: Record<string, unknown> = { caseId, packId }
    try {
      this.#outpatient.requireDoctorCase(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const query = parseKnowledgeQuery(rawQuery)
      if (query.asOf !== undefined) auditInput.asOf = query.asOf
      if (query.recheckLatest !== undefined) auditInput.recheckLatest = query.recheckLatest

      const patientId = this.#diseasePacks.readOutpatientPatientId(context, caseId)
      const virtualNow = this.#outpatient.virtualTime(context)
      const evaluation = this.#evaluateKnowledgeForSubject({
        context,
        packId,
        query,
        subject: { id: caseId, kind: 'outpatient', patientId },
        virtualNow,
      })
      this.#commands.auditRead(context, 'doctor.case.disease-pack-knowledge.read', auditInput, 'success')
      return evaluation
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'doctor.case.disease-pack-knowledge.read', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  readInpatientKnowledge(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    packId: string,
    rawQuery: unknown,
  ): DiseasePackKnowledgeEvaluation {
    const auditInput: Record<string, unknown> = { admissionId, packId }
    try {
      inpatient.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const query = parseKnowledgeQuery(rawQuery)
      if (query.asOf !== undefined) auditInput.asOf = query.asOf
      if (query.recheckLatest !== undefined) auditInput.recheckLatest = query.recheckLatest

      const binding = inpatient.readAdmissionBinding(context, admissionId)
      const virtualNow = inpatient.virtualTime(context)
      const evaluation = this.#evaluateKnowledgeForSubject({
        context,
        packId,
        query,
        subject: { id: admissionId, kind: 'inpatient', patientId: binding.patientId },
        virtualNow,
      })
      inpatient.commands.auditRead(context, 'inpatient.disease-pack-knowledge.read', auditInput, 'success')
      return evaluation
    } catch (error) {
      try {
        inpatient.commands.auditRead(context, 'inpatient.disease-pack-knowledge.read', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }

  #evaluateKnowledgeForSubject(input: {
    context: ActorContext
    subject: { id: string; kind: 'outpatient' | 'inpatient'; patientId: string }
    packId: string
    query: DiseasePackKnowledgeReadQuery
    virtualNow: string
  }): DiseasePackKnowledgeEvaluation {
    const effective = this.#diseasePacks.registry.getEffective(input.packId)
    const patient = this.#fhir.read(input.context, 'Patient', input.subject.patientId)
    const birthDate = patient.resourceType === 'Patient' && typeof patient.birthDate === 'string'
      ? patient.birthDate
      : undefined
    const population = resolvePatientGuidelinePopulation(birthDate, input.virtualNow)

    const ledgerAsOf = input.query.asOf ?? input.virtualNow
    const ledger = this.#factLedger.buildInternalLedger(input.context, input.subject, {
      asOf: ledgerAsOf,
      includeSuperseded: false,
    })
    const encounterMap = this.#diseasePacks.resolvePatientEncounterMap(input.context, input.subject.patientId)
    const vocabulary = effective.pack.conceptVocabulary === undefined
      ? PUBLIC_CONCEPT_VOCABULARY
      : mergeThreeLayerConceptVocabulary({
          packLayer: effective.pack.conceptVocabulary,
          publicLayer: PUBLIC_CONCEPT_VOCABULARY,
        })

    const verifySourcePassage: KnowledgePassageVerifier = (anchor: KnowledgeAnchorCitation) => {
      if (this.#guidelines === undefined) {
        return { reason: 'guideline-corpus-unavailable', valid: false }
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
        && (anchor.locator === undefined || item.locator === anchor.locator)
      ))
      if (matched.length === 0) {
        return { reason: 'passage-locator-mismatch', valid: false }
      }
      return {
        passageText: matched.map(item => item.text).join('\n'),
        valid: true,
      }
    }

    const snapshots = effective.pack.knowledgeSnapshots ?? []
    const baselineEval = evaluateKnowledgeSnapshotForPatient({
      ...(input.query.asOf === undefined ? {} : { asOf: input.query.asOf }),
      encounterIdByRecordId: encounterMap,
      ...(input.query.includeRetired === undefined ? {} : { includeRetired: input.query.includeRetired }),
      ledger,
      packId: effective.pack.manifest.id,
      packVersion: effective.pack.manifest.version,
      snapshots,
      verifySourcePassage,
      vocabulary,
    })

    if (input.query.recheckLatest !== true) {
      return diseasePackKnowledgeEvaluationSchema.parse(baselineEval)
    }

    const latestLedger = input.query.asOf === undefined
      ? ledger
      : this.#factLedger.buildInternalLedger(input.context, input.subject, {
          asOf: input.virtualNow,
          includeSuperseded: false,
        })
    const latestEval = evaluateKnowledgeSnapshotForPatient({
      encounterIdByRecordId: encounterMap,
      ...(input.query.includeRetired === undefined ? {} : { includeRetired: input.query.includeRetired }),
      ledger: latestLedger,
      packId: effective.pack.manifest.id,
      packVersion: effective.pack.manifest.version,
      snapshots,
      verifySourcePassage,
      vocabulary,
    })
    const latestComparison = compareKnowledgeEvaluations(baselineEval, latestEval)

    return diseasePackKnowledgeEvaluationSchema.parse({
      ...baselineEval,
      latestComparison,
    })
  }
}
