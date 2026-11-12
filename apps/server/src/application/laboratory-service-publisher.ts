import { createHash, randomUUID } from 'node:crypto'
import { modelUsageControlFailure } from './model-usage-control.ts'
import { modelTaskOutcomeUnknown } from './model-task-recovery.ts'
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
import { defaultSyntheticLaboratoryPriceFen, laboratoryOutpatientPrice } from './outpatient-investigation-billing.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'

function inpatientLaboratoryBilling(
  snapshot: Pick<LaboratoryServiceSnapshot, 'id' | 'nameZh' | 'priceFen'> & {
    referenceConcept: Pick<LaboratoryServiceSnapshot['referenceConcept'], 'code' | 'system' | 'version'>
  },
  existingInpatientPrice: boolean,
) {
  const priceFen = existingInpatientPrice && snapshot.priceFen > 0
    ? snapshot.priceFen
    : defaultSyntheticLaboratoryPriceFen(snapshot.referenceConcept)
  if (priceFen === undefined) return undefined
  return {
    id: `inpatient-charge-definition-${snapshot.id}`,
    version: 1,
    display: snapshot.nameZh,
    priceFen,
    currency: 'CNY' as const,
    trigger: 'execution-completed' as const,
    source: existingInpatientPrice && snapshot.priceFen > 0 ? 'published-hospital-price' : 'synthetic-hospital-basic-laboratory-2026',
    availableScopes: ['inpatient'],
    effectiveOn: '2026-08-24',
  }
}

const hsCtniConceptId = 'wst-886:2026:2100404B'
const wst886System = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'

function syntheticHsCtniRecord(datasetReleaseId: string): ReferenceLaboratoryRecord {
  const ruleMeta = {
    sourceLocation: '心肌肌钙蛋白实验室检测与临床应用中国专家共识（合成校准）',
    sourceStandard: 'ClinMesh Curated Baseline',
    sourceType: 'project-curated' as const,
    sourceVersion: '2026-11-12',
  }
  return {
    concept: {
      code: '2100404B',
      display: '高敏心肌肌钙蛋白I测定',
      domain: 'laboratory',
      id: hsCtniConceptId,
      sourceLocator: 'clinmesh-curated:laboratory-cn:test:2100404B',
      status: 'active',
      system: wst886System,
      version: '2026',
    },
    definition: {
      adultReferenceRules: [{
        high: 16,
        notes: '成年女性静脉血 99th 百分位上限',
        referenceKind: 'upper-bound',
        sex: 'female',
        simulationHigh: 16,
        simulationLow: 1,
        ...ruleMeta,
      }, {
        high: 34,
        notes: '成年男性静脉血 99th 百分位上限',
        referenceKind: 'upper-bound',
        sex: 'male',
        simulationHigh: 34,
        simulationLow: 1.2,
        ...ruleMeta,
      }, {
        high: 16,
        notes: '成人通用静脉血参考上限',
        referenceKind: 'upper-bound',
        sex: 'all',
        simulationHigh: 16,
        simulationLow: 1,
        ...ruleMeta,
      }],
      alternateCodings: [{ code: '89579-7', system: 'http://loinc.org', version: '2.83' }],
      analyte: '高敏心肌肌钙蛋白I',
      category: '心脏标志物',
      conceptId: hsCtniConceptId,
      datasetReleaseId,
      healthyStrategy: 'uniform',
      kind: 'laboratory-cn-test',
      precision: 1,
      resultKind: 'quantity',
      scale: '定量',
      sourceLocator: 'clinmesh-curated:laboratory-cn:test:2100404B',
      sourceVersion: '2026',
      specimen: '血清、血浆',
      unit: { code: 'ng/L', display: 'ng/L', system: 'http://unitsofmeasure.org' },
    },
    panelMembers: [],
    specimens: [],
    units: [],
  }
}

const supplementalLaboratoryCnLoincCodings: Readonly<Record<string, readonly string[]>> = {
  '0100401A': ['718-7'],
  '0100501A': ['4544-3', '20570-8'],
  '0501703A': ['48065-7', '48066-5'],
  '1100301A': ['4548-4', '17856-6'],
  '1101204A': ['33863-2'],
  '1400205A': ['2951-2'],
  '1400305A': ['19123-9', '2601-3'],
  '1400404A': ['2777-1', '14879-1'],
  '1400505A': ['2075-0'],
  '1400605A': ['2823-3'],
  '1400705A': ['17861-6', '2000-8'],
  '1700204A': ['3094-0', '22664-7'],
  '1700304A': ['3084-1', '14933-6'],
  '1700404A': ['2160-0', '14682-9'],
  '2000104A': ['2093-3', '14647-2'],
  '2000204A': ['2571-8', '14927-8'],
  '2000304A': ['2085-9', '14646-4'],
  '2000404A': ['2089-1', '13457-7', '18262-6'],
  '2100104A': ['2157-6'],
  '2100304A': ['2639-3'],
  '2100404A': ['10839-9', '6598-7'],
  '2100404B': ['89579-7', '49563-0'],
  '2100504A': ['6597-9', '67151-1'],
  '2100604A': ['30934-4'],
  '2100704A': ['33762-6'],
}

function enrichedLaboratoryCnAlternateCodings(
  code: string,
  existing: LaboratoryCnTestRecord['definition']['alternateCodings'],
) {
  const supplemental = Object.hasOwn(supplementalLaboratoryCnLoincCodings, code)
    ? supplementalLaboratoryCnLoincCodings[code]
    : undefined
  if (supplemental === undefined) return existing
  const seen = new Set(existing.map(item => item.code))
  return [
    ...existing,
    ...supplemental
      .filter(loincCode => !seen.has(loincCode))
      .map(loincCode => ({ code: loincCode, system: 'http://loinc.org' as const, version: '2.83' })),
  ].slice(0, 4)
}

const defaultLaboratoryCriticalBoundsTable: Readonly<Record<string, { criticalMaximum?: number; criticalMinimum?: number }>> = {
  'wst-886:2026:0100101A#10*9/L': { criticalMaximum: 30, criticalMinimum: 2 },
  'wst-886:2026:0100301A#10*9/L': { criticalMaximum: 1000, criticalMinimum: 30 },
  'wst-886:2026:0100401A#g/L': { criticalMaximum: 200, criticalMinimum: 60 },
  'wst-886:2026:0100501A#L/L': { criticalMaximum: 0.6, criticalMinimum: 0.2 },
  'wst-886:2026:0501703A#mg/L': { criticalMaximum: 5 },
  'wst-886:2026:0501703A#ug/L': { criticalMaximum: 5000 },
  'wst-886:2026:1400205A#mmol/L': { criticalMaximum: 160, criticalMinimum: 120 },
  'wst-886:2026:1400605A#mmol/L': { criticalMaximum: 6.2, criticalMinimum: 2.8 },
  'wst-886:2026:1400705A#mmol/L': { criticalMaximum: 3.5, criticalMinimum: 1.75 },
  'wst-886:2026:1700404A#umol/L': { criticalMaximum: 600 },
  'wst-886:2026:2100404A#ng/L': { criticalMaximum: 500 },
  'wst-886:2026:2100404A#ng/mL': { criticalMaximum: 0.5 },
  'wst-886:2026:2100404A#pg/mL': { criticalMaximum: 500 },
  'wst-886:2026:2100404A#ug/L': { criticalMaximum: 0.5 },
  'wst-886:2026:2100404B#ng/L': { criticalMaximum: 100 },
  'wst-886:2026:2100504A#ng/L': { criticalMaximum: 100 },
  'wst-886:2026:2100504A#ng/mL': { criticalMaximum: 0.1 },
  'wst-886:2026:2100504A#ug/L': { criticalMaximum: 0.1 },
  'wst-886:2026:2100704A#ng/L': { criticalMaximum: 5000 },
  'wst-886:2026:2100704A#pg/mL': { criticalMaximum: 5000 },
}

function defaultLaboratoryCriticalBounds(definition: LaboratoryCnTestRecord['definition']): {
  criticalMaximum?: number
  criticalMinimum?: number
} {
  if (definition.resultKind !== 'quantity' || definition.unit === undefined) return {}
  const key = `${definition.conceptId}#${definition.unit.code}`
  const candidate = Object.hasOwn(defaultLaboratoryCriticalBoundsTable, key)
    ? defaultLaboratoryCriticalBoundsTable[key]
    : undefined
  if (candidate === undefined) return {}
  const lows = definition.adultReferenceRules.flatMap(rule => rule.low === undefined ? [] : [rule.low])
  const highs = definition.adultReferenceRules.flatMap(rule => rule.high === undefined ? [] : [rule.high])
  const criticalMinimum = candidate.criticalMinimum !== undefined
    && lows.every(low => candidate.criticalMinimum! < low)
    && highs.every(high => candidate.criticalMinimum! < high)
    ? candidate.criticalMinimum
    : undefined
  const criticalMaximum = candidate.criticalMaximum !== undefined
    && highs.every(high => candidate.criticalMaximum! > high)
    && lows.every(low => candidate.criticalMaximum! > low)
    ? candidate.criticalMaximum
    : undefined
  if (criticalMinimum !== undefined && criticalMaximum !== undefined && criticalMinimum >= criticalMaximum) return {}
  return {
    ...(criticalMinimum === undefined ? {} : { criticalMinimum }),
    ...(criticalMaximum === undefined ? {} : { criticalMaximum }),
  }
}

const promptVersion = 'laboratory-service-enrichment-v1'
const laboratoryCnPublicationPolicyVersion = 'clinmesh-laboratory-defaults-v2'
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
  readonly #canResume: ((workspaceId: string, taskId: string) => boolean) | undefined
  readonly #contextStatus: (context: ActorContext) => string
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #model: string | undefined
  readonly #models: GenerationModelBinding | undefined
  readonly #provider: JsonChatCompletionsProvider | undefined
  readonly #publications: LaboratoryServicePublicationRepository
  readonly #referenceData: ReferenceDataService

  constructor(input: {
    canResume?: (workspaceId: string, taskId: string) => boolean
    contextStatus?: (context: ActorContext) => string
    commands: CommandExecutor
    database: ClinMeshDatabase
    model?: string
    models?: GenerationModelBinding
    provider?: JsonChatCompletionsProvider
    publications: LaboratoryServicePublicationRepository
    referenceData: ReferenceDataService
  }) {
    this.#canResume = input.canResume
    this.#contextStatus = input.contextStatus ?? (() => 'active')
    this.#commands = input.commands
    this.#database = input.database
    this.#model = input.model
    this.#models = input.models
    this.#provider = input.provider
    this.#publications = input.publications
    this.#referenceData = input.referenceData
  }

  ensureInpatientPrices(): void {
    const rowSchema = z.object({
      availableScopesJson: z.string(),
      code: z.string(),
      epoch: z.string(),
      id: z.string(),
      nameZh: z.string(),
      priceFen: z.number().int().nonnegative(),
      service_id: z.string(),
      system: z.string(),
      version: z.string(),
      workspace_id: z.string(),
    })
    const rows = z.array(rowSchema).parse(this.#database.driver.prepare(`
      SELECT h.workspace_id, h.epoch, h.service_id,
        json_extract(h.config_json, '$.availableScopes') AS availableScopesJson,
        json_extract(h.config_json, '$.laboratoryService.id') AS id,
        json_extract(h.config_json, '$.laboratoryService.nameZh') AS nameZh,
        json_extract(h.config_json, '$.laboratoryService.priceFen') AS priceFen,
        json_extract(h.config_json, '$.laboratoryService.referenceConcept.system') AS system,
        json_extract(h.config_json, '$.laboratoryService.referenceConcept.version') AS version,
        json_extract(h.config_json, '$.laboratoryService.referenceConcept.code') AS code
      FROM hospital_service_catalog h JOIN workspace w ON w.workspace_id=h.workspace_id AND w.active_epoch=h.epoch
      WHERE h.active=1 AND json_type(h.config_json,'$.laboratoryService')='object'
        AND json_type(h.config_json,'$.inpatientInvestigationBilling') IS NULL
    `).all())
    const update = this.#database.driver.prepare("UPDATE hospital_service_catalog SET config_json=json_set(config_json,'$.inpatientInvestigationBilling',json(?),'$.availableScopes',json(?)) WHERE workspace_id=? AND epoch=? AND service_id=?")
    this.#database.driver.transaction(() => {
      for (const row of rows) {
        const availableScopes = z.array(z.string()).parse(JSON.parse(row.availableScopesJson))
        const billing = inpatientLaboratoryBilling(
          {
            id: row.id,
            nameZh: row.nameZh,
            priceFen: row.priceFen,
            referenceConcept: { code: row.code, system: row.system, version: row.version },
          },
          availableScopes.includes('inpatient'),
        )
        if (billing !== undefined) {
          update.run(
            JSON.stringify(billing),
            JSON.stringify([...new Set([...availableScopes, 'inpatient'])]),
            row.workspace_id,
            row.epoch,
            row.service_id,
          )
        }
      }
    })()
  }

  ensureDefaultServices(): void {
    const contexts = z.array(z.object({
      workspaceId: z.string(), epoch: z.string(), scenarioRunId: z.string(),
    })).parse(this.#database.driver.prepare(`
      SELECT workspace.workspace_id AS workspaceId, workspace.active_epoch AS epoch,
        run.scenario_run_id AS scenarioRunId
      FROM workspace JOIN scenario_run AS run
        ON run.workspace_id = workspace.workspace_id AND run.epoch = workspace.active_epoch
    `).all())
    for (const current of contexts) {
      const context: ActorContext = { ...current, actorId: 'actor-laboratory-defaults', roleCode: 'administrator' }
      const records: ReferenceLaboratoryRecord[] = []
      let page = 1
      let referenceReleaseId = ''
      while (true) {
        const result = this.#referenceData.searchLaboratoryCandidates(context, {
          page, pageSize: 50, sourceDataset: 'laboratory-cn',
        })
        records.push(...result.items)
        referenceReleaseId = result.referenceReleaseId
        if (records.length >= result.total || result.items.length === 0) break
        page += 1
      }
      if (records.length === 0) continue
      const cardiacAnchor = records.find(record => (
        (record.concept.code === 'CN-LAB-CARDIAC' || record.concept.code === '2100404A')
        && record.definition.kind !== 'loinc'
      ))
      if (cardiacAnchor !== undefined && cardiacAnchor.definition.kind !== 'loinc'
        && !records.some(record => record.concept.id === hsCtniConceptId)) {
        records.push(syntheticHsCtniRecord(cardiacAnchor.definition.datasetReleaseId))
      }
      const hasLoinc = this.#referenceData.searchLaboratoryCandidates(context, { page: 1, pageSize: 1, sourceDataset: 'loinc-zh-cn' }).total > 0
      const retired = hasLoinc ? [] : z.array(z.object({ id: z.string(), version: z.number().int() })).parse(this.#database.driver.prepare(`
        SELECT service_id AS id, version FROM hospital_service_catalog
        WHERE workspace_id = ? AND epoch = ? AND active = 1
          AND json_extract(config_json, '$.laboratoryService.referenceConcept.system') = 'http://loinc.org'
      `).all(current.workspaceId, current.epoch))
      const input = { referenceReleaseId, policyVersion: laboratoryCnPublicationPolicyVersion, retired }
      const installed = z.array(z.object({ configJson: z.string().nullable(), conceptId: z.string() })).parse(this.#database.driver.prepare(`
        SELECT CASE
            WHEN json_extract(config_json, '$.laboratoryService.referenceConcept.id') = 'laboratory-panel-cn:2026-09-01:CN-LAB-CARDIAC'
              THEN config_json
            ELSE NULL
          END AS configJson,
          json_extract(config_json, '$.laboratoryService.referenceConcept.id') AS conceptId
        FROM hospital_service_catalog WHERE workspace_id = ? AND epoch = ? AND active = 1
          AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
          AND json_extract(config_json, '$.laboratoryService.referenceReleaseId') = ?
          AND json_extract(config_json, '$.laboratoryService.publicationPolicyVersion') = ?
      `).all(current.workspaceId, current.epoch, referenceReleaseId, laboratoryCnPublicationPolicyVersion))
      const installedIds = new Set(installed.flatMap((item) => {
        if (cardiacAnchor !== undefined && item.conceptId === 'laboratory-panel-cn:2026-09-01:CN-LAB-CARDIAC' && item.configJson !== null) {
          const parsed = z.object({ laboratoryService: laboratoryServiceSnapshotSchema }).parse(JSON.parse(item.configJson))
          if (!parsed.laboratoryService.reportDefinition.results.some(result => result.referenceConcept.code === '2100404B')) {
            return []
          }
        }
        return [item.conceptId]
      }))
      const missing = records.filter(record => !installedIds.has(record.concept.id))
      if (missing.length === 0 && retired.length === 0) continue
      const roots = missing.map(record => this.#resolveRoot(context, referenceReleaseId, record.concept.id))
      const drafts = this.#laboratoryCnServiceDrafts({ actorContext: context, referenceReleaseId }, roots)
      this.#commands.execute({
        context, contextRequirement: 'current', dataSchema: z.object({ serviceCount: z.number().int() }),
        expectedVersions: {}, idempotencyKey: `laboratory-defaults:${current.epoch}:${canonicalJsonHash({ ...input, roots: missing.map(item => item.concept.id) })}`,
        idempotencyScope: 'workspace', input, operation: 'laboratory-service-defaults.initialize',
      }, () => {
        const published = this.#publish(drafts, current)
        const deactivate = this.#database.driver.prepare(`
          UPDATE hospital_service_catalog SET active = 0, version = version + 1,
            config_json = json_set(config_json, '$.laboratoryService.version', version + 1)
          WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND version = ?
        `)
        for (const service of retired) deactivate.run(current.workspaceId, current.epoch, service.id, service.version)
        return {
          data: { serviceCount: published.serviceIds.length },
          effects: [...published.serviceIds.map((reference) => {
            const version = published.versions.get(reference)
            return {
              kind: version === 1 ? 'created' as const : 'updated' as const,
              reference: `HospitalService/${reference}`,
              versionId: String(version),
            }
          }), ...retired.map(service => ({
            kind: 'updated' as const, reference: `HospitalService/${service.id}`, versionId: String(service.version + 1),
          }))],
        }
      })
    }
    this.#ensureOutpatientPrices()
    this.ensureInpatientPrices()
  }

  #ensureOutpatientPrices(): void {
    const rowSchema = z.object({
      code: z.string(),
      epoch: z.string(),
      id: z.string(),
      priceFen: z.number().int().nonnegative(),
      service_id: z.string(),
      system: z.string(),
      version: z.number().int().positive(),
      versionStr: z.string(),
      workspace_id: z.string(),
    })
    const rows = z.array(rowSchema).parse(
      this.#database.driver.prepare(`SELECT h.workspace_id, h.epoch, h.service_id,
          json_extract(h.config_json, '$.laboratoryService.id') AS id,
          json_extract(h.config_json, '$.laboratoryService.version') AS version,
          json_extract(h.config_json, '$.laboratoryService.priceFen') AS priceFen,
          json_extract(h.config_json, '$.laboratoryService.referenceConcept.system') AS system,
          json_extract(h.config_json, '$.laboratoryService.referenceConcept.version') AS versionStr,
          json_extract(h.config_json, '$.laboratoryService.referenceConcept.code') AS code
        FROM hospital_service_catalog h JOIN workspace w
        ON w.workspace_id=h.workspace_id AND w.active_epoch=h.epoch
        WHERE h.active=1 AND json_type(h.config_json,'$.laboratoryService')='object'
          AND json_type(h.config_json,'$.laboratoryService.outpatientBilling') IS NULL`).all(),
    )
    const update = this.#database.driver.prepare(`UPDATE hospital_service_catalog
      SET config_json=json_set(config_json,'$.laboratoryService.outpatientBilling',json(?))
      WHERE workspace_id=? AND epoch=? AND service_id=?`)
    this.#database.driver.transaction(() => {
      for (const row of rows) {
        const price = laboratoryOutpatientPrice({
          id: row.id,
          priceFen: row.priceFen,
          referenceConcept: { code: row.code, system: row.system, version: row.versionStr },
          version: row.version,
        })
        if (price !== undefined) update.run(JSON.stringify(price), row.workspace_id, row.epoch, row.service_id)
      }
    })()
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
    const sourceDataset = input.sourceDataset ?? 'laboratory-cn'
    const result = this.#referenceData.searchLaboratoryCandidates(context, { ...input, sourceDataset })
    const syntheticHsCtni = sourceDataset === 'laboratory-cn' && input.panelOnly !== true
      && this.#referenceData.laboratoryRecordFromRelease(context, result.referenceReleaseId, hsCtniConceptId) === undefined
      ? this.#syntheticHsCtniFromRelease(context, result.referenceReleaseId)
      : undefined
    const queryText = input.query?.trim().toLowerCase() ?? ''
    const matchesSyntheticHsCtni = syntheticHsCtni !== undefined && (
      queryText === ''
      || [
        syntheticHsCtni.concept.id,
        syntheticHsCtni.concept.code,
        syntheticHsCtni.concept.display,
        'hs-ctni',
        '89579-7',
      ].some(term => term.toLowerCase().includes(queryText))
    )
    const startIndex = (input.page - 1) * input.pageSize
    const endIndex = startIndex + input.pageSize
    const candidateItems = matchesSyntheticHsCtni
      && syntheticHsCtni !== undefined
      && result.items.length < input.pageSize
      && result.total >= startIndex
      && result.total < endIndex
      ? [...result.items, syntheticHsCtni]
      : result.items
    const total = matchesSyntheticHsCtni ? result.total + 1 : result.total
    const states = this.#publications.candidateStates(
      context.workspaceId,
      context.epoch,
      result.referenceReleaseId,
      candidateItems.map(item => item.concept.id),
    )
    const publishedServices = this.#publishedServices(
      context,
      candidateItems.map(item => item.concept.id),
    )
    return laboratoryServiceCandidateSearchSchema.parse({
      items: candidateItems.map((item) => {
        const state = states.get(item.concept.id)
        const publishedServiceId = state?.publishedServiceId
          ?? publishedServices.get(item.concept.id)
          ?? null
        const metadata = this.#candidateMetadata(context, item, result.referenceReleaseId)
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
      total,
    })
  }

  #candidateMetadata(context: ActorContext, record: ReferenceLaboratoryRecord, referenceReleaseId: string) {
    if (record.definition.kind === 'loinc') {
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
    const leaves = record.definition.kind === 'laboratory-cn-test'
      ? [record].filter(isLaboratoryCnTestRecord)
      : record.panelMembers.map(member => (
          this.#referenceData.laboratoryRecord(context, member.memberConceptId)
        )).filter(isLaboratoryCnTestRecord)
    if (record.definition.kind === 'laboratory-cn-panel'
      && record.concept.code === 'CN-LAB-CARDIAC'
      && !leaves.some(leaf => leaf.concept.id === hsCtniConceptId)) {
      const syntheticHs = this.#syntheticHsCtniFromRelease(context, referenceReleaseId)
      if (isLaboratoryCnTestRecord(syntheticHs)) leaves.push(syntheticHs)
    }
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
      memberCount: record.definition.kind === 'laboratory-cn-panel' && record.concept.code === 'CN-LAB-CARDIAC'
        ? leaves.length
        : record.panelMembers.length,
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

  async enqueue(input: {
    context: ActorContext
    entries: readonly { conceptId: string; expectedVersion: number }[]
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    const needsModel = input.entries.some(entry => this.#referenceData.laboratoryRecord(input.context, entry.conceptId)?.definition.kind === 'loinc')
    let model = this.#model ?? 'unconfigured'
    if (needsModel && this.#model !== undefined) {
      try {
        model = await this.#models?.bind(input.context.workspaceId,
          `catalog:${JSON.stringify([input.context.actorId, input.idempotencyKey])}`, this.#model) ?? this.#model
      } catch {
        throw new LaboratoryServicePublisherError('CATALOG_ENRICHMENT_UNAVAILABLE', 'The configured model is unavailable', 503)
      }
    }
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
      const referenceReleaseId = this.#referenceData.current().releaseId
      for (const conceptId of conceptIds) {
        const candidate = this.#referenceData.laboratoryRecord(input.context, conceptId)
          ?? (conceptId === hsCtniConceptId ? this.#syntheticHsCtniFromRelease(input.context, referenceReleaseId) : undefined)
        this.#assertEligibleRoot(candidate)
      }
      const now = new Date().toISOString()
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
          model,
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
    const claimed = this.#publications.claimNext(new Date().toISOString(), this.#canResume)
    if (claimed === undefined) return undefined
    const assertCurrent = () => {
      if (this.#contextStatus(claimed.actorContext) !== 'active') throw new LaboratoryServicePublisherError('ROLE_NOT_ALLOWED', 'The original task context is no longer active', 403)
    }
    try {
      assertCurrent()
      const roots = claimed.conceptIds.map(conceptId => this.#resolveRoot(
        claimed.actorContext,
        claimed.referenceReleaseId,
        conceptId,
      ))
      const laboratoryCnRoots = roots.filter(
        item => item.root.definition.kind !== 'loinc',
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
          onBeforeRequest: assertCurrent,
          usageContext: { workspaceId: claimed.workspaceId, epoch: claimed.actorContext.epoch,
            actorId: claimed.actorContext.actorId, taskId: claimed.jobId, stage: 'catalog-enrichment', trigger: 'manual',
            sources: [{ kind: 'job', id: claimed.jobId, relationship: 'trigger' }] },
          jsonSchema: z.toJSONSchema(enrichmentResultSchema) as Record<string, unknown>,
          model: claimed.model,
          schemaName: 'laboratory_service_enrichment',
          ...(signal === undefined ? {} : { signal }),
          systemPrompt,
          userPayload: payload,
          validate: value => enrichmentResultSchema.safeParse(value).success,
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
      assertCurrent()
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
      if (modelTaskOutcomeUnknown(error)) return this.#fail(claimed, {
        code: 'MODEL_OUTCOME_UNKNOWN', message: 'The model request outcome is unknown; automatic processing has stopped',
      })
      if (modelUsageControlFailure(error) !== undefined || signal?.aborted === true) {
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

  #syntheticHsCtniFromRelease(context: ActorContext, referenceReleaseId: string): ReferenceLaboratoryRecord | undefined {
    const anchor = this.#referenceData.laboratoryRecordFromRelease(
      context,
      referenceReleaseId,
      'laboratory-panel-cn:2026-09-01:CN-LAB-CARDIAC',
    ) ?? this.#referenceData.laboratoryRecordFromRelease(
      context,
      referenceReleaseId,
      'wst-886:2026:2100404A',
    )
    if (anchor === undefined || anchor.definition.kind === 'loinc') return undefined
    return syntheticHsCtniRecord(anchor.definition.datasetReleaseId)
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
    ) ?? (conceptId === hsCtniConceptId ? this.#syntheticHsCtniFromRelease(context, referenceReleaseId) : undefined)
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
    if (root!.definition.kind === 'laboratory-cn-panel'
      && root!.concept.code === 'CN-LAB-CARDIAC'
      && !leafIds.has(hsCtniConceptId)) {
      const hsCtni = syntheticHsCtniRecord(root!.definition.datasetReleaseId)
      leafIds.add(hsCtni.concept.id)
      leaves.push(hsCtni)
    }
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
    if (rootDefinition.kind === 'laboratory-cn-panel' && (
      leaves.some(leaf => leaf.definition.kind !== 'laboratory-cn-test')
      || this.#laboratoryCnSpecimen(root!, leaves) === undefined
    )) {
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
          || rule.referenceKind === 'coded' || rule.referenceKind === 'ordinal'
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
      || definition.adultReferenceRules.some(rule => (
        rule.normalValue === undefined
        || (rule.referenceKind !== 'coded' && rule.referenceKind !== 'ordinal')
      ))) {
      throw new LaboratoryServicePublisherError(
        'LABORATORY_SERVICE_METADATA_INCOMPLETE',
        'A laboratory-cn fixed result has no normal value',
        409,
      )
    }
  }

  #laboratoryCnSpecimen(root: ReferenceLaboratoryRecord, leaves: ReferenceLaboratoryRecord[]): string | undefined {
    if (root.definition.kind === 'loinc') return undefined
    if (root.definition.specimen === '混合标本') return root.definition.specimen
    const common = leaves.reduce((specimens, leaf) => leaf.definition.kind === 'loinc' ? []
      : specimens.filter(specimen => leaf.definition.kind !== 'loinc' && leaf.definition.specimen.split('、').includes(specimen)),
    root.definition.specimen.split('、'))
    return common.length === 0 ? undefined : common.join('、')
  }

  #specimen(record: ReferenceLaboratoryRecord, specimenOverride?: string) {
    if (record.definition.kind === 'laboratory-cn-test'
      || record.definition.kind === 'laboratory-cn-panel') {
      return {
        code: `CN-SP-${createHash('sha256')
          .update(specimenOverride ?? record.definition.specimen)
          .digest('hex')
          .slice(0, 12)}`,
        display: specimenOverride ?? record.definition.specimen,
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
    job: Pick<ClaimedLaboratoryServicePublicationJob, 'actorContext' | 'referenceReleaseId'>,
    roots: ResolvedRoot[],
  ): Array<{ draft: ServiceDraft; rootConceptId?: string }> {
    const drafts: Array<{ draft: ServiceDraft; rootConceptId?: string }> = []
    const standardStatus = this.#laboratoryStandardStatus(job.actorContext)
    for (const resolved of roots) {
      if (resolved.root.definition.kind === 'loinc'
        || resolved.leaves.some(leaf => leaf.definition.kind !== 'laboratory-cn-test')) {
        throw new LaboratoryServicePublisherError(
          'LABORATORY_PANEL_INVALID',
          'The selected laboratory-cn panel has an invalid closure',
          409,
        )
      }
      const rootDefinition = resolved.root.definition
      const componentServiceIds = rootDefinition.kind === 'laboratory-cn-test' ? [] : resolved.leaves.map(leaf => this.#stableServiceId(
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
          alternateCodings: enrichedLaboratoryCnAlternateCodings(
            leaf.concept.code,
            definition.alternateCodings,
          ),
          ...defaultLaboratoryCriticalBounds(definition),
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
          specimen: this.#specimen(resolved.root, this.#laboratoryCnSpecimen(resolved.root, resolved.leaves))!,
          tatMinutes: 180,
        },
        rootConceptId: resolved.root.concept.id,
      })
      if (rootDefinition.kind === 'laboratory-cn-test') continue
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
    job: Pick<ClaimedLaboratoryServicePublicationJob, 'workspaceId' | 'epoch'>,
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
      snapshot.outpatientBilling = laboratoryOutpatientPrice(snapshot)
      const config = JSON.stringify({
        availableScopes: ['outpatient', 'inpatient'],
        inpatientInvestigationBilling: inpatientLaboratoryBilling(snapshot,true),
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
      && (record.definition.kind === 'laboratory-cn-panel' || record.definition.kind === 'laboratory-cn-test')) return
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
