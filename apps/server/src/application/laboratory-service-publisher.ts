import { createHash, randomUUID } from 'node:crypto'
import {
  laboratoryServiceCandidateSearchSchema,
  laboratoryServicePublicationJobSchema,
  laboratoryServiceSnapshotSchema,
  type LaboratoryServicePublicationJob,
  type LaboratoryServiceSnapshot,
} from '@clinmesh/contracts/his'
import { investigationCodeableValueSchema } from '@clinmesh/contracts/scenario'
import {
  referenceConceptSnapshotSchema,
  type ReferenceLaboratoryDefinition,
  type ReferenceLaboratoryRecord,
  type ReferenceLaboratorySourceDataset,
} from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import {
  ChatCompletionsError,
  type JsonChatCompletionsProvider,
} from '../infrastructure/ai/openai-chat-completions.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import {
  type ClaimedLaboratoryServicePublicationJob,
  type LaboratoryServicePublicationRepository,
  LaboratoryServicePublicationVersionError,
} from '../infrastructure/sqlite/laboratory-service-publication-repository.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { ReferenceDataService } from './reference-data-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const promptVersion = 'laboratory-service-enrichment-v1'
const laboratoryCnPublicationPolicyVersion = 'clinmesh-laboratory-defaults-v1'
const laboratoryCnConclusion = '本报告为 ClinMesh 合成检验结果，仅用于仿真。'
const laboratorySpecimenSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-specimen-cn'
const wst886EffectiveOn = '2026-11-01'
const maximumPanelDepth = 32
const maximumPanelEdges = 512
const maximumPanelNodes = 256
const systemPrompt = [
  '你是中国合成医院检验服务目录配置器。',
  '只返回符合 JSON Schema 的 JSON，不要返回 Markdown。',
  '为每个已选择的 LOINC 根项目生成本院中英文名称、合成价格、TAT、结论模板和每个叶子结果定义。',
  '不得新增、删除或替换输入中的根项目或叶子项目。',
  '数量结果必须给出数值参考范围；定性结果必须给出受控 allowedValues。',
  '价格仅用于合成医院仿真，不得声称是真实医院价格。',
].join('\n')

const enrichmentResultSchema = z.object({
  services: z.array(z.object({
    conclusionTemplate: z.string().trim().min(1).max(1_000),
    nameEn: z.string().trim().min(1).max(1_000),
    nameZh: z.string().trim().min(1).max(1_000),
    priceFen: z.number().int().nonnegative().max(1_000_000),
    results: z.array(z.object({
      allowedValues: z.array(z.union([
        z.boolean(),
        z.string().min(1).max(256),
        investigationCodeableValueSchema,
      ]))
        .min(1)
        .max(64)
        .optional(),
      conceptId: z.string().min(1).max(512),
      referenceRange: z.object({
        high: z.number().finite().optional(),
        low: z.number().finite().optional(),
        text: z.string().trim().min(1).max(500),
      }).strict(),
      valueType: z.enum(['boolean', 'codeable', 'quantity', 'string']),
    }).strict()).min(1).max(128),
    rootConceptId: z.string().min(1).max(512),
    tatMinutes: z.number().int().nonnegative().max(7 * 24 * 60),
  }).strict()).min(1).max(50),
}).strict()

type EnrichedService = z.infer<typeof enrichmentResultSchema>['services'][number]

interface ResolvedRoot {
  leaves: ReferenceLaboratoryRecord[]
  root: ReferenceLaboratoryRecord
}

type LoincLaboratoryRecord = ReferenceLaboratoryRecord & {
  definition: Extract<ReferenceLaboratoryDefinition, { kind: 'loinc' }>
}

type LaboratoryCnTestRecord = ReferenceLaboratoryRecord & {
  definition: Extract<ReferenceLaboratoryDefinition, { kind: 'laboratory-cn-test' }>
}

function isLoincLaboratoryRecord(
  record: ReferenceLaboratoryRecord,
): record is LoincLaboratoryRecord {
  return record.definition.kind === 'loinc'
}

function isLaboratoryCnTestRecord(
  record: ReferenceLaboratoryRecord | undefined,
): record is LaboratoryCnTestRecord {
  return record?.definition.kind === 'laboratory-cn-test'
}

type ServiceDraft = Omit<LaboratoryServiceSnapshot, 'version'>

export class LaboratoryServicePublisherError extends Error {
  readonly code: string
  readonly status: 403 | 404 | 409 | 503

  constructor(code: string, message: string, status: 403 | 404 | 409 | 503) {
    super(message)
    this.name = 'LaboratoryServicePublisherError'
    this.code = code
    this.status = status
  }
}

export class LaboratoryServicePublisher {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #model: string | undefined
  readonly #provider: JsonChatCompletionsProvider | undefined
  readonly #publications: LaboratoryServicePublicationRepository
  readonly #referenceData: ReferenceDataService

  constructor(input: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    model?: string
    provider?: JsonChatCompletionsProvider
    publications: LaboratoryServicePublicationRepository
    referenceData: ReferenceDataService
  }) {
    this.#commands = input.commands
    this.#database = input.database
    this.#model = input.model
    this.#provider = input.provider
    this.#publications = input.publications
    this.#referenceData = input.referenceData
  }

  candidates(
    context: ActorContext,
    input: {
      page: number
      pageSize: number
      panelOnly?: boolean
      query?: string
      sourceDataset?: ReferenceLaboratorySourceDataset
    },
  ) {
    this.#assertAdministrator(context)
    const result = this.#referenceData.searchLaboratoryCandidates(context, input)
    const states = this.#publications.candidateStates(
      context.workspaceId,
      context.epoch,
      result.referenceReleaseId,
      result.items.map(item => item.concept.id),
    )
    const publishedServices = this.#publishedServices(
      context,
      result.items.map(item => item.concept.id),
    )
    return laboratoryServiceCandidateSearchSchema.parse({
      items: result.items.map((item) => {
        const state = states.get(item.concept.id)
        const publishedServiceId = state?.publishedServiceId
          ?? publishedServices.get(item.concept.id)
          ?? null
        const metadata = this.#candidateMetadata(context, item)
        return {
          ...metadata,
          concept: item.concept,
          definition: item.definition,
          error: state?.error ?? null,
          publishedServiceId,
          status: state?.status ?? (publishedServiceId === null ? 'unconfigured' : 'published'),
          version: state?.version ?? 0,
        }
      }),
      page: input.page,
      pageSize: input.pageSize,
      referenceReleaseId: result.referenceReleaseId,
      total: result.total,
    })
  }

  #candidateMetadata(context: ActorContext, record: ReferenceLaboratoryRecord) {
    if (record.definition.kind !== 'laboratory-cn-panel') {
      const source = this.#referenceData.current().sources.find(item => (
        item.candidate?.datasetId === 'loinc-zh-cn' || item.sourceId.includes('loinc')
      ))
      return {
        adultApplicability: null,
        memberCount: record.panelMembers.length,
        referenceSources: [],
        sourceDataset: {
          datasetId: 'loinc-zh-cn' as const,
          releaseId: source?.candidate?.releaseId ?? source?.upstreamVersion ?? record.concept.version,
        },
        specimen: record.specimens[0]?.display ?? null,
        standardStatus: null,
      }
    }
    const leaves = record.panelMembers.map(member => (
      this.#referenceData.laboratoryRecord(context, member.memberConceptId)
    )).filter(isLaboratoryCnTestRecord)
    const patientSexes = (['female', 'male', 'other', 'unknown'] as const).filter(sex => (
      leaves.length > 0 && leaves.every(leaf => (
        leaf.definition.adultReferenceRules.some(rule => (
          rule.sex === 'all' || rule.sex === sex
        ))
      ))
    ))
    const sources = new Map<string, {
      sourceLocation: string
      sourceStandard: string
      sourceType: 'national-standard' | 'project-curated'
      sourceVersion: string
    }>()
    for (const leaf of leaves) {
      for (const rule of leaf.definition.adultReferenceRules) {
        const source = {
          sourceLocation: rule.sourceLocation,
          sourceStandard: rule.sourceStandard,
          sourceType: rule.sourceType,
          sourceVersion: rule.sourceVersion,
        }
        sources.set(JSON.stringify(source), source)
      }
    }
    return {
      adultApplicability: patientSexes.length === 0
        ? null
        : { minimumAgeYears: 18 as const, patientSexes },
      memberCount: record.panelMembers.length,
      referenceSources: [...sources.values()].toSorted((left, right) => (
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )),
      sourceDataset: {
        datasetId: 'laboratory-cn' as const,
        releaseId: record.definition.datasetReleaseId,
      },
      specimen: record.definition.specimen,
      standardStatus: this.#laboratoryStandardStatus(context),
    }
  }

  #laboratoryStandardStatus(context: ActorContext) {
    const state = z.object({ virtual_time: z.iso.datetime({ offset: true }) }).parse(
      this.#database.driver.prepare(`
        SELECT virtual_time FROM scenario_epoch_state
        WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
      `).get(context.workspaceId, context.epoch, context.scenarioRunId),
    )
    return {
      effectiveOn: wst886EffectiveOn,
      mode: state.virtual_time.slice(0, 10) < wst886EffectiveOn
        ? 'future-standard-preview'
        : 'effective',
      standard: 'WS/T 886-2026',
    } as const
  }

  enqueue(input: {
    context: ActorContext
    entries: readonly { conceptId: string; expectedVersion: number }[]
    idempotencyKey: string
  }) {
    return this.#commands.execute({
      authorize: () => this.#assertAdministrator(input.context),
      context: input.context,
      contextRequirement: 'current',
      dataSchema: laboratoryServicePublicationJobSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { entries: input.entries },
      operation: 'laboratory-service-publication.create',
    }, () => {
      const conceptIds = input.entries.map(entry => entry.conceptId)
      if (new Set(conceptIds).size !== conceptIds.length) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_SERVICE_SELECTION_INVALID',
          'Laboratory Service publication concept IDs must be unique',
          409,
        )
      }
      for (const conceptId of conceptIds) {
        this.#assertEligibleRoot(this.#referenceData.laboratoryRecord(
          input.context,
          conceptId,
        ))
      }
      const now = new Date().toISOString()
      const referenceReleaseId = this.#referenceData.current().releaseId
      const job = laboratoryServicePublicationJobSchema.parse({
        conceptIds,
        createdAt: now,
        error: null,
        finishedAt: null,
        jobId: `laboratory-service-publication-${randomUUID()}`,
        publishedServiceIds: [],
        referenceReleaseId,
        startedAt: null,
        status: 'queued',
        updatedAt: now,
        workspaceId: input.context.workspaceId,
      })
      try {
        this.#publications.create(
          job,
          input.entries,
          input.context,
          this.#model ?? 'unconfigured',
        )
      } catch (error) {
        if (error instanceof LaboratoryServicePublicationVersionError) {
          throw new LaboratoryServicePublisherError(
            'LABORATORY_SERVICE_VERSION_CONFLICT',
            error.message,
            409,
          )
        }
        throw error
      }
      return {
        data: job,
        effects: [{
          kind: 'created' as const,
          reference: `LaboratoryServicePublicationJob/${job.jobId}`,
          versionId: '1',
        }],
      }
    })
  }

  getJob(context: ActorContext, jobId: string): LaboratoryServicePublicationJob {
    this.#assertAdministrator(context)
    const job = this.#publications.get(context.workspaceId, context.epoch, jobId)
    if (job === undefined) {
      throw new LaboratoryServicePublisherError(
        'LABORATORY_SERVICE_PUBLICATION_NOT_FOUND',
        'The Laboratory Service publication job was not found',
        404,
      )
    }
    return job
  }

  async processNext(signal?: AbortSignal): Promise<LaboratoryServicePublicationJob | undefined> {
    const claimed = this.#publications.claimNext(new Date().toISOString())
    if (claimed === undefined) return undefined
    try {
      const roots = claimed.conceptIds.map(conceptId => this.#resolveRoot(
        claimed.actorContext,
        claimed.referenceReleaseId,
        conceptId,
      ))
      const laboratoryCnRoots = roots.filter(
        item => item.root.definition.kind === 'laboratory-cn-panel',
      )
      const loincRoots = roots.filter(item => item.root.definition.kind === 'loinc')
      const drafts = this.#laboratoryCnServiceDrafts(claimed, laboratoryCnRoots)
      let output: unknown = {
        policyVersion: laboratoryCnPublicationPolicyVersion,
        roots: laboratoryCnRoots.map(item => item.root.concept.id),
      }
      if (loincRoots.length > 0) {
        if (this.#provider === undefined || claimed.model === 'unconfigured') {
          throw new LaboratoryServicePublisherError(
            'CATALOG_ENRICHMENT_UNAVAILABLE',
            'Catalog Enrichment is not configured',
            503,
          )
        }
        const payload = {
          promptVersion,
          referenceReleaseId: claimed.referenceReleaseId,
          services: loincRoots.map(item => ({
            leaves: item.leaves.map(leaf => ({
              concept: leaf.concept,
              definition: leaf.definition,
              specimens: leaf.specimens,
              units: leaf.units,
            })),
            root: {
              concept: item.root.concept,
              definition: item.root.definition,
              specimens: item.root.specimens,
            },
          })),
        }
        const completion = await this.#provider.completeJson({
          jsonSchema: z.toJSONSchema(enrichmentResultSchema) as Record<string, unknown>,
          model: claimed.model,
          schemaName: 'laboratory_service_enrichment',
          ...(signal === undefined ? {} : { signal }),
          systemPrompt,
          userPayload: payload,
        })
        const enriched = enrichmentResultSchema.parse(JSON.parse(completion.content))
        drafts.push(...this.#serviceDrafts(claimed, loincRoots, enriched.services))
        output = { enriched, laboratoryCn: output }
      }
      const serviceIds = drafts.map(item => item.draft.id)
      if (new Set(serviceIds).size !== serviceIds.length) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_SERVICE_ID_CONFLICT',
          'Laboratory Service publication produced duplicate service identities',
          409,
        )
      }
      const outputHash = canonicalJsonHash(output)
      return this.#commands.execute({
        context: claimed.actorContext,
        contextRequirement: 'known',
        dataSchema: laboratoryServicePublicationJobSchema,
        expectedVersions: {},
        idempotencyKey: `${claimed.jobId}:complete:${outputHash}`,
        idempotencyScope: 'workspace',
        input: { jobId: claimed.jobId, outputHash },
        operation: 'laboratory-service-publication.complete',
      }, () => {
        const published = this.#publish(drafts, claimed)
        return {
          data: this.#publications.succeed(
            claimed,
            published.serviceIds,
            published.rootServiceIds,
            new Date().toISOString(),
          ),
          effects: published.serviceIds.map(reference => ({
            kind: 'created' as const,
            reference: `HospitalService/${reference}`,
            versionId: String(published.versions.get(reference)),
          })),
        }
      }).data
    } catch (error) {
      if (signal?.aborted === true) {
        return this.#commands.execute({
          context: claimed.actorContext,
          contextRequirement: 'known',
          dataSchema: laboratoryServicePublicationJobSchema,
          expectedVersions: {},
          idempotencyKey: `${claimed.jobId}:requeue:${claimed.startedAt}`,
          idempotencyScope: 'workspace',
          input: { jobId: claimed.jobId },
          operation: 'laboratory-service-publication.requeue',
        }, () => ({
          data: this.#publications.requeue(claimed, new Date().toISOString()),
          effects: [],
        })).data
      }
      return this.#fail(claimed, this.#publicFailure(error))
    }
  }

  #resolveRoot(
    context: ActorContext,
    referenceReleaseId: string,
    conceptId: string,
  ): ResolvedRoot {
    const root = this.#referenceData.laboratoryRecordFromRelease(
      context,
      referenceReleaseId,
      conceptId,
    )
    this.#assertEligibleRoot(root)
    const leaves: ReferenceLaboratoryRecord[] = []
    const expanded = new Set<string>()
    const leafIds = new Set<string>()
    const visiting = new Set<string>()
    const visited = new Set<string>()
    let edgeCount = 0
    const visit = (record: ReferenceLaboratoryRecord, depth: number): void => {
      if (record.concept.status !== 'active') {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_PANEL_INVALID',
          'The selected laboratory panel contains an inactive member',
          409,
        )
      }
      if (visiting.has(record.concept.id)) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_PANEL_INVALID',
          'The selected laboratory panel contains a cycle',
          409,
        )
      }
      if (expanded.has(record.concept.id)) return
      visited.add(record.concept.id)
      edgeCount += record.panelMembers.length
      if (depth > maximumPanelDepth
        || visited.size > maximumPanelNodes
        || edgeCount > maximumPanelEdges) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_PANEL_INVALID',
          'The selected laboratory panel exceeds the supported graph bounds',
          409,
        )
      }
      if (record.panelMembers.length === 0) {
        if (!leafIds.has(record.concept.id)) {
          leafIds.add(record.concept.id)
          leaves.push(record)
        }
        expanded.add(record.concept.id)
        return
      }
      visiting.add(record.concept.id)
      for (const member of record.panelMembers) {
        const child = this.#referenceData.laboratoryRecordFromRelease(
          context,
          referenceReleaseId,
          member.memberConceptId,
        )
        if (child === undefined) {
          throw new LaboratoryServicePublisherError(
            'LABORATORY_PANEL_INVALID',
            'The selected laboratory panel member is unavailable',
            409,
          )
        }
        visit(child, depth + 1)
        if (leaves.length > 128) {
          throw new LaboratoryServicePublisherError(
            'LABORATORY_PANEL_INVALID',
            'The selected laboratory panel exceeds the supported result closure',
            409,
          )
        }
      }
      visiting.delete(record.concept.id)
      expanded.add(record.concept.id)
    }
    visit(root!, 0)
    if (leaves.length === 0 || this.#specimen(root!) === undefined) {
      throw new LaboratoryServicePublisherError(
        'LABORATORY_SERVICE_METADATA_INCOMPLETE',
        'The selected laboratory item has no report leaves or specimen',
        409,
      )
    }
    for (const leaf of leaves) {
      if (leaf.definition.kind === 'loinc'
        && leaf.definition.scaleType === 'Qn'
        && leaf.units.length === 0) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_SERVICE_METADATA_INCOMPLETE',
          'A quantitative laboratory result has no UCUM unit',
          409,
        )
      }
      if (leaf.definition.kind === 'laboratory-cn-test') {
        this.#assertLaboratoryCnLeaf(leaf)
      }
    }
    const rootDefinition = root!.definition
    if (rootDefinition.kind === 'laboratory-cn-panel' && leaves.some(leaf => (
      leaf.definition.kind !== 'laboratory-cn-test'
      || leaf.definition.specimen !== rootDefinition.specimen
    ))) {
      throw new LaboratoryServicePublisherError(
        'LABORATORY_PANEL_INVALID',
        'The laboratory-cn panel contains incompatible specimen definitions',
        409,
      )
    }
    return { leaves, root: root! }
  }

  #assertLaboratoryCnLeaf(record: ReferenceLaboratoryRecord): void {
    if (record.definition.kind !== 'laboratory-cn-test') {
      throw new LaboratoryServicePublisherError(
        'LABORATORY_PANEL_INVALID',
        'The laboratory-cn panel contains a non-test leaf',
        409,
      )
    }
    const definition = record.definition
    if (definition.resultKind === 'quantity') {
      if (definition.unit === undefined || definition.healthyStrategy !== 'uniform'
        || definition.adultReferenceRules.some(rule => (
          rule.simulationLow === undefined || rule.simulationHigh === undefined
        ))) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_SERVICE_METADATA_INCOMPLETE',
          'A laboratory-cn Quantity result has incomplete generation metadata',
          409,
        )
      }
      return
    }
    if (definition.healthyStrategy !== 'fixed-normal'
      || definition.adultReferenceRules.some(rule => rule.normalValue === undefined)) {
      throw new LaboratoryServicePublisherError(
        'LABORATORY_SERVICE_METADATA_INCOMPLETE',
        'A laboratory-cn fixed result has no normal value',
        409,
      )
    }
  }

  #specimen(record: ReferenceLaboratoryRecord) {
    if (record.definition.kind === 'laboratory-cn-test'
      || record.definition.kind === 'laboratory-cn-panel') {
      return {
        code: `CN-SP-${createHash('sha256')
          .update(record.definition.specimen)
          .digest('hex')
          .slice(0, 12)}`,
        display: record.definition.specimen,
        system: laboratorySpecimenSystem,
        version: '1',
      }
    }
    const specimen = record.specimens[0]
    return specimen === undefined
      ? undefined
      : { code: specimen.partNumber, display: specimen.display }
  }

  #laboratoryCnServiceDrafts(
    job: ClaimedLaboratoryServicePublicationJob,
    roots: ResolvedRoot[],
  ): Array<{ draft: ServiceDraft; rootConceptId?: string }> {
    const drafts: Array<{ draft: ServiceDraft; rootConceptId?: string }> = []
    const standardStatus = this.#laboratoryStandardStatus(job.actorContext)
    for (const resolved of roots) {
      if (resolved.root.definition.kind !== 'laboratory-cn-panel'
        || resolved.leaves.some(leaf => leaf.definition.kind !== 'laboratory-cn-test')) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_PANEL_INVALID',
          'The selected laboratory-cn panel has an invalid closure',
          409,
        )
      }
      const rootDefinition = resolved.root.definition
      const componentServiceIds = resolved.leaves.map(leaf => this.#stableServiceId(
        `${resolved.root.concept.system}\0${resolved.root.concept.code}`
          + `\0${leaf.concept.system}\0${leaf.concept.code}`,
      ))
      const reportResults = resolved.leaves.map((leaf) => {
        if (leaf.definition.kind !== 'laboratory-cn-test') {
          throw new LaboratoryServicePublisherError(
            'LABORATORY_PANEL_INVALID',
            'The selected laboratory-cn panel has an invalid leaf',
            409,
          )
        }
        const definition = leaf.definition
        return {
          adultReferenceRules: definition.adultReferenceRules,
          alternateCodings: definition.alternateCodings,
          healthyStrategy: definition.healthyStrategy,
          precision: definition.precision,
          referenceConcept: this.#snapshot(leaf),
          referenceRange: { text: '按成人适用规则' },
          ...(definition.unit === undefined ? {} : { unit: definition.unit }),
          valueType: definition.resultKind === 'quantity' ? 'quantity' as const : 'string' as const,
        }
      })
      const rootServiceId = this.#stableServiceId(
        `${resolved.root.concept.system}\0${resolved.root.concept.code}`,
      )
      const sourceDataset = {
        datasetId: 'laboratory-cn' as const,
        releaseId: rootDefinition.datasetReleaseId,
      }
      drafts.push({
        draft: {
          allowedIndicationCodes: ['clinical-evaluation'],
          componentServiceIds,
          doctorOrderable: true,
          executingDepartmentId: 'department-laboratory',
          id: rootServiceId,
          localCode: `CM-LAB-${resolved.root.concept.code}`,
          nameZh: resolved.root.concept.display,
          priceFen: 0,
          publicationPolicyVersion: laboratoryCnPublicationPolicyVersion,
          referenceConcept: this.#snapshot(resolved.root),
          referenceReleaseId: job.referenceReleaseId,
          reportDefinition: {
            conclusionTemplate: laboratoryCnConclusion,
            results: reportResults,
          },
          serviceKind: 'laboratory',
          sourceDataset,
          standardStatus,
          specimen: this.#specimen(resolved.root)!,
          tatMinutes: 180,
        },
        rootConceptId: resolved.root.concept.id,
      })
      resolved.leaves.forEach((leaf, index) => {
        drafts.push({
          draft: {
            allowedIndicationCodes: ['clinical-evaluation'],
            componentServiceIds: [],
            doctorOrderable: false,
            executingDepartmentId: 'department-laboratory',
            id: componentServiceIds[index]!,
            localCode: `CM-LAB-COMP-${resolved.root.concept.code}-${leaf.concept.code}`,
            nameZh: leaf.concept.display,
            priceFen: 0,
            publicationPolicyVersion: laboratoryCnPublicationPolicyVersion,
            referenceConcept: this.#snapshot(leaf),
            referenceReleaseId: job.referenceReleaseId,
            reportDefinition: {
              conclusionTemplate: laboratoryCnConclusion,
              results: [reportResults[index]!],
            },
            serviceKind: 'laboratory',
            sourceDataset,
            standardStatus,
            specimen: this.#specimen(leaf)!,
            tatMinutes: 180,
          },
        })
      })
    }
    return drafts
  }

  #serviceDrafts(
    job: ClaimedLaboratoryServicePublicationJob,
    roots: ResolvedRoot[],
    enrichedServices: EnrichedService[],
  ): Array<{ draft: ServiceDraft; rootConceptId?: string }> {
    const enrichedByRoot = new Map(enrichedServices.map(item => [item.rootConceptId, item]))
    if (enrichedByRoot.size !== roots.length || enrichedServices.length !== roots.length) {
      throw new LaboratoryServicePublisherError(
        'CATALOG_ENRICHMENT_INVALID',
        'Catalog Enrichment returned an unexpected Laboratory Service set',
        409,
      )
    }
    const drafts: Array<{ draft: ServiceDraft; rootConceptId?: string }> = []
    for (const resolved of roots) {
      if (resolved.root.definition.kind !== 'loinc') {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_PANEL_INVALID',
          'Catalog Enrichment accepts only LOINC roots',
          409,
        )
      }
      const leaves = resolved.leaves.map((leaf) => {
        if (!isLoincLaboratoryRecord(leaf)) {
          throw new LaboratoryServicePublisherError(
            'LABORATORY_PANEL_INVALID',
            'A LOINC panel contains a non-LOINC leaf',
            409,
          )
        }
        return leaf
      })
      const enriched = enrichedByRoot.get(resolved.root.concept.id)
      if (enriched === undefined) {
        throw new LaboratoryServicePublisherError(
          'CATALOG_ENRICHMENT_INVALID',
          'Catalog Enrichment omitted a selected Laboratory Service',
          409,
        )
      }
      const expectedLeafIds = leaves.map(leaf => leaf.concept.id)
      const enrichedLeafIds = enriched.results.map(result => result.conceptId)
      if (new Set(enrichedLeafIds).size !== enrichedLeafIds.length
        || expectedLeafIds.length !== enrichedLeafIds.length
        || expectedLeafIds.some(id => !enrichedLeafIds.includes(id))) {
        throw new LaboratoryServicePublisherError(
          'CATALOG_ENRICHMENT_INVALID',
          'Catalog Enrichment changed the Laboratory Service report closure',
          409,
        )
      }
      const resultByConcept = new Map(enriched.results.map(result => [result.conceptId, result]))
      const reportResults = leaves.map((leaf) => {
        const result = resultByConcept.get(leaf.concept.id)!
        const quantitative = leaf.definition.scaleType === 'Qn'
        if (quantitative !== (result.valueType === 'quantity')) {
          throw new LaboratoryServicePublisherError(
            'CATALOG_ENRICHMENT_INVALID',
            'Catalog Enrichment returned a value type that conflicts with LOINC scale',
            409,
          )
        }
        const unit = result.valueType === 'quantity' ? leaf.units[0] : undefined
        return {
          alternateCodings: [],
          ...(result.allowedValues === undefined ? {} : { allowedValues: result.allowedValues }),
          referenceConcept: this.#snapshot(leaf),
          referenceRange: result.referenceRange,
          ...(unit === undefined
            ? {}
            : {
                unit: {
                  code: unit.code,
                  display: unit.code,
                  system: 'http://unitsofmeasure.org' as const,
                },
              }),
          valueType: result.valueType,
        }
      })
      const componentServiceIds = resolved.root.panelMembers.length === 0
        ? []
        : leaves.map(leaf => this.#serviceId(
            job.referenceReleaseId,
            `${resolved.root.concept.id}:${leaf.concept.id}`,
          ))
      const specimen = resolved.root.specimens[0]!
      const rootServiceId = this.#serviceId(job.referenceReleaseId, resolved.root.concept.id)
      drafts.push({
        draft: {
          allowedIndicationCodes: ['clinical-evaluation'],
          componentServiceIds,
          doctorOrderable: true,
          executingDepartmentId: 'department-laboratory',
          id: rootServiceId,
          localCode: `CM-LAB-${resolved.root.concept.code}`,
          nameEn: enriched.nameEn,
          nameZh: enriched.nameZh,
          priceFen: enriched.priceFen,
          referenceConcept: this.#snapshot(resolved.root),
          referenceReleaseId: job.referenceReleaseId,
          reportDefinition: {
            conclusionTemplate: enriched.conclusionTemplate,
            results: reportResults,
          },
          specimen: { code: specimen.partNumber, display: specimen.display },
          serviceKind: 'laboratory',
          tatMinutes: enriched.tatMinutes,
        },
        rootConceptId: resolved.root.concept.id,
      })
      if (resolved.root.panelMembers.length === 0) continue
      leaves.forEach((leaf, index) => {
        const leafSpecimen = leaf.specimens[0] ?? specimen
        drafts.push({
          draft: {
            allowedIndicationCodes: ['clinical-evaluation'],
            componentServiceIds: [],
            doctorOrderable: false,
            executingDepartmentId: 'department-laboratory',
            id: componentServiceIds[index]!,
            localCode: `CM-LAB-COMP-${resolved.root.concept.code}-${leaf.concept.code}`,
            nameEn: leaf.concept.display,
            nameZh: leaf.concept.display,
            priceFen: 0,
            referenceConcept: this.#snapshot(leaf),
            referenceReleaseId: job.referenceReleaseId,
            reportDefinition: {
              conclusionTemplate: leaf.concept.display,
              results: [reportResults[index]!],
            },
            specimen: { code: leafSpecimen.partNumber, display: leafSpecimen.display },
            serviceKind: 'laboratory',
            tatMinutes: enriched.tatMinutes,
          },
        })
      })
    }
    return drafts
  }

  #publish(
    drafts: Array<{ draft: ServiceDraft; rootConceptId?: string }>,
    job: ClaimedLaboratoryServicePublicationJob,
  ) {
    const serviceIds: string[] = []
    const rootServiceIds = new Map<string, string>()
    const versions = new Map<string, number>()
    const lookup = this.#database.driver.prepare(`
      SELECT version FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND service_id = ?
    `)
    const insert = this.#database.driver.prepare(`
      INSERT INTO hospital_service_catalog (
        workspace_id, epoch, service_id, code, name_zh, name_en,
        version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)
    const update = this.#database.driver.prepare(`
      UPDATE hospital_service_catalog
      SET code = ?, name_zh = ?, name_en = ?, version = ?, active = 1, config_json = ?
      WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND version = ?
    `)
    for (const item of drafts) {
      const current = z.object({ version: z.number().int().positive() }).optional().parse(
        lookup.get(job.workspaceId, job.epoch, item.draft.id),
      )
      const version = (current?.version ?? 0) + 1
      const snapshot = laboratoryServiceSnapshotSchema.parse({ ...item.draft, version })
      const config = JSON.stringify({
        availableScopes: ['outpatient'],
        billingUnit: {
          code: 'ITEM',
          display: '项目',
          system: 'urn:clinmesh:wst:billing-unit',
          valueSet: 'urn:clinmesh:wst:value-set:billing-unit',
          version: 'synthetic-2026',
        },
        category: {
          code: 'LABORATORY',
          display: '实验室检验',
          system: 'urn:clinmesh:wst:service-category',
          valueSet: 'urn:clinmesh:wst:value-set:service-category',
          version: 'synthetic-2026',
        },
        chargeDefinition: {
          currency: 'CNY',
          effectiveOn: '2026-09-01',
          id: `charge-definition-${snapshot.id}`,
          priceFen: snapshot.priceFen,
        },
        componentServiceIds: snapshot.componentServiceIds,
        executingDepartmentId: snapshot.executingDepartmentId,
        laboratoryService: snapshot,
        nationalService: {
          code: 'CM-NHC-SERVICE-LABORATORY',
          display: '合成实验室检验服务',
          id: 'reference-service-synthetic-laboratory',
          system: 'urn:clinmesh:reference:nhc-medical-service',
          version: 'synthetic-2026',
        },
        reportTemplate: snapshot.reportDefinition.conclusionTemplate,
        requestCatalogItemIds: [snapshot.referenceConcept.id],
        tatMinutes: snapshot.tatMinutes,
      })
      if (current === undefined) {
        insert.run(
          job.workspaceId,
          job.epoch,
          snapshot.id,
          snapshot.localCode,
          snapshot.nameZh,
          snapshot.nameEn ?? snapshot.nameZh,
          version,
          config,
        )
      } else {
        const changed = update.run(
          snapshot.localCode,
          snapshot.nameZh,
          snapshot.nameEn ?? snapshot.nameZh,
          version,
          config,
          job.workspaceId,
          job.epoch,
          snapshot.id,
          current.version,
        )
        if (changed.changes !== 1) {
          throw new LaboratoryServicePublisherError(
            'LABORATORY_SERVICE_VERSION_CONFLICT',
            'A Laboratory Service changed while it was being published',
            409,
          )
        }
      }
      serviceIds.push(snapshot.id)
      versions.set(snapshot.id, version)
      if (item.rootConceptId !== undefined) {
        rootServiceIds.set(item.rootConceptId, snapshot.id)
      }
    }
    return { rootServiceIds, serviceIds, versions }
  }

  #snapshot(record: ReferenceLaboratoryRecord) {
    return referenceConceptSnapshotSchema.parse({
      code: record.concept.code,
      display: record.concept.display,
      id: record.concept.id,
      sourceLocator: record.concept.sourceLocator,
      system: record.concept.system,
      version: record.concept.version,
    })
  }

  #serviceId(referenceReleaseId: string, identity: string): string {
    return `hospital-laboratory-service-${createHash('sha256')
      .update(`${referenceReleaseId}\0${identity}`)
      .digest('hex')
      .slice(0, 32)}`
  }

  #stableServiceId(identity: string): string {
    return `hospital-laboratory-service-${createHash('sha256')
      .update(`laboratory-cn\0${identity}`)
      .digest('hex')
      .slice(0, 32)}`
  }

  #publishedServices(
    context: ActorContext,
    conceptIds: readonly string[],
  ): Map<string, string> {
    if (conceptIds.length === 0) return new Map()
    const rows = z.array(z.object({
      config_json: z.string(),
      service_id: z.string(),
    }).strict()).parse(this.#database.driver.prepare(`
      SELECT service_id, config_json
      FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND active = 1
        AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.id')
          IN (${conceptIds.map(() => '?').join(', ')})
    `).all(context.workspaceId, context.epoch, ...conceptIds))
    return new Map(rows.map((row) => {
      const service = laboratoryServiceSnapshotSchema.parse(
        JSON.parse(row.config_json).laboratoryService,
      )
      return [service.referenceConcept.id, row.service_id]
    }))
  }

  #assertEligibleRoot(
    record: ReferenceLaboratoryRecord | undefined,
  ): asserts record is ReferenceLaboratoryRecord {
    if (record !== undefined
      && record.concept.status === 'active'
      && record.concept.domain === 'laboratory'
      && record.definition.kind === 'laboratory-cn-panel') return
    if (record !== undefined
      && record.concept.status === 'active'
      && record.concept.domain === 'laboratory'
      && record.definition.kind === 'loinc'
      && record.definition.classType === 1
      && (record.definition.orderObservation === 'Order'
        || record.definition.orderObservation === 'Both')) return
    throw new LaboratoryServicePublisherError(
      'LABORATORY_SERVICE_NOT_ELIGIBLE',
      'The selected Reference Concept is not an active orderable laboratory item',
      409,
    )
  }

  #fail(
    job: ClaimedLaboratoryServicePublicationJob,
    error: { code: string; message: string },
  ): LaboratoryServicePublicationJob {
    return this.#commands.execute({
      context: job.actorContext,
      contextRequirement: 'known',
      dataSchema: laboratoryServicePublicationJobSchema,
      expectedVersions: {},
      idempotencyKey: `${job.jobId}:fail:${error.code}`,
      idempotencyScope: 'workspace',
      input: { errorCode: error.code, jobId: job.jobId },
      operation: 'laboratory-service-publication.fail',
    }, () => ({
      data: this.#publications.fail(job, error, new Date().toISOString()),
      effects: [{
        kind: 'updated' as const,
        reference: `LaboratoryServicePublicationJob/${job.jobId}`,
        versionId: 'failed',
      }],
    })).data
  }

  #publicFailure(error: unknown): { code: string; message: string } {
    if (error instanceof LaboratoryServicePublisherError || error instanceof ChatCompletionsError) {
      return { code: error.code, message: error.message }
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return {
        code: 'CATALOG_ENRICHMENT_INVALID',
        message: 'Catalog Enrichment returned an invalid Laboratory Service definition',
      }
    }
    return {
      code: 'CATALOG_ENRICHMENT_FAILED',
      message: 'Catalog Enrichment failed',
    }
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new LaboratoryServicePublisherError(
        'ROLE_NOT_ALLOWED',
        'Only an administrator can publish Laboratory Services',
        403,
      )
    }
  }
}
