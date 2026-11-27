import {
  guidelineTopicBundleSchema,
  guidelineTopicReadSchema,
  type GuidelineTopicBundle,
  type GuidelineTopicEvidence,
  type GuidelineTopicId,
  type GuidelineTopicPatientIndicator,
  type GuidelineTopicRead,
  type GuidelineTopicSummary,
  type PackSourceSummary,
} from '@clinmesh/contracts/guideline-topics'
import type { ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import type { CoronaryVesselFinding } from '@clinmesh/contracts/inpatient-angiography'
import type { InpatientGuidelineAdviceKind } from '@clinmesh/contracts/inpatient-guideline-advice'
import { pciMeasurementSchema, pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { investigationResultContentSchema } from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import type { ActorContext } from './command-executor.ts'
import { DiseasePackRegistry } from './disease-pack-runtime-service.ts'
import type { GuidelinePatientPopulation } from './guideline-corpus.ts'
import type { InpatientService } from './inpatient-service.ts'
import { resolvePatientGuidelinePopulation } from './patient-age.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

export interface GuidelineTopicReferenceSpec {
  readonly fragments: readonly string[]
  readonly page: number
  readonly sha256: string
  readonly sourceId: string
  readonly title: string
  readonly version: string
}

export interface GuidelineTopicDefinition {
  readonly conclusionKinds: readonly [InpatientGuidelineAdviceKind, InpatientGuidelineAdviceKind, InpatientGuidelineAdviceKind]
  readonly fingerprint: string
  readonly generationRule: string
  readonly id: GuidelineTopicId
  readonly limitations: readonly string[]
  readonly matchTerms: readonly string[]
  readonly navigation: string
  readonly references: readonly GuidelineTopicReferenceSpec[]
  readonly specialty: string
  readonly titleEn: string
  readonly titleZh: string
  readonly version: string
}

export class UnknownGuidelineTopicError extends Error {
  readonly code = 'GUIDELINE_TOPIC_NOT_FOUND' as const
  readonly status = 404 as const

  constructor(readonly topicId: string) {
    super(`Unknown guideline topic: ${topicId}`)
    this.name = 'UnknownGuidelineTopicError'
  }
}

export function computeGuidelineTopicFingerprint(spec: Omit<GuidelineTopicDefinition, 'fingerprint'>): string {
  return canonicalJsonHash({
    conclusionKinds: spec.conclusionKinds,
    generationRule: spec.generationRule,
    id: spec.id,
    limitations: spec.limitations,
    navigation: spec.navigation,
    references: spec.references,
    specialty: spec.specialty,
    titleEn: spec.titleEn,
    titleZh: spec.titleZh,
    version: spec.version,
  })
}

function buildTopic(spec: Omit<GuidelineTopicDefinition, 'fingerprint'>): GuidelineTopicDefinition {
  return { ...spec, fingerprint: computeGuidelineTopicFingerprint(spec) }
}

/**
 * Baseline non-migrated topics have all been migrated to pure-JSON disease packs (S13: t2dm-renal-care).
 */
const BASELINE_TOPICS_LIST: readonly GuidelineTopicDefinition[] = []

export interface RegisteredGuidelineTopicEntry {
  readonly definition: GuidelineTopicDefinition
  readonly ownerPack?: PackSourceSummary
}

let cachedDefaultTopicRegistry: DiseasePackRegistry | undefined

function getDefaultTopicPackRegistry(): DiseasePackRegistry {
  cachedDefaultTopicRegistry ??= new DiseasePackRegistry()
  return cachedDefaultTopicRegistry
}

function collectPackTopicEntries(registry: DiseasePackRegistry): RegisteredGuidelineTopicEntry[] {
  const entries: RegisteredGuidelineTopicEntry[] = []
  for (const effective of registry.listEffective()) {
    const ownerPack: PackSourceSummary = {
      packId: effective.pack.manifest.id,
      packVersion: effective.pack.manifest.version,
      titleZh: effective.pack.manifest.titleZh,
    }
    for (const topic of effective.pack.guidelineTopics ?? []) {
      entries.push({
        definition: buildTopic({
          conclusionKinds: topic.conclusionKinds as [InpatientGuidelineAdviceKind, InpatientGuidelineAdviceKind, InpatientGuidelineAdviceKind],
          generationRule: topic.generationRule,
          id: topic.id,
          limitations: topic.limitations,
          matchTerms: topic.matchTerms,
          navigation: topic.navigation,
          references: topic.references.map(ref => ({
            fragments: ref.fragments,
            page: ref.page,
            sha256: ref.sha256,
            sourceId: ref.sourceId,
            title: ref.title,
            version: ref.version,
          })),
          specialty: topic.specialty,
          titleEn: topic.titleEn,
          titleZh: topic.titleZh,
          version: topic.version,
        }),
        ownerPack,
      })
    }
  }
  return entries
}

export function listRegisteredGuidelineTopicEntries(registry?: DiseasePackRegistry): readonly RegisteredGuidelineTopicEntry[] {
  const packEntries = collectPackTopicEntries(registry ?? getDefaultTopicPackRegistry())
  const seenIds = new Set(packEntries.map(entry => entry.definition.id))
  const baselineEntries: RegisteredGuidelineTopicEntry[] = BASELINE_TOPICS_LIST
    .filter(topic => !seenIds.has(topic.id))
    .map(definition => ({ definition }))
  return [...packEntries, ...baselineEntries]
}

export function getGuidelineTopicEntry(
  topicId: GuidelineTopicId,
  registry?: DiseasePackRegistry,
): RegisteredGuidelineTopicEntry {
  const match = listRegisteredGuidelineTopicEntries(registry).find(entry => entry.definition.id === topicId)
  if (match === undefined) throw new UnknownGuidelineTopicError(topicId)
  return match
}

const LEGACY_PCI_STENT_2026_11_02_R1_DEFINITION_FINGERPRINT =
  listRegisteredGuidelineTopicEntries().find(entry => entry.definition.conclusionKinds.includes('stent-category'))?.definition.fingerprint ?? null

export function legacyPciStentTopicFingerprintIfUnchanged(definition: GuidelineTopicDefinition): string | null {
  if (
    LEGACY_PCI_STENT_2026_11_02_R1_DEFINITION_FINGERPRINT === null
    || !definition.conclusionKinds.includes('stent-category')
    || definition.fingerprint !== LEGACY_PCI_STENT_2026_11_02_R1_DEFINITION_FINGERPRINT
  ) {
    return null
  }
  return canonicalJsonHash({
    id: definition.id,
    limitations: definition.limitations,
    navigation: definition.navigation,
    references: definition.references,
    version: definition.version,
  })
}

export function listGuidelineTopicDefinitions(registry?: DiseasePackRegistry): readonly GuidelineTopicDefinition[] {
  return listRegisteredGuidelineTopicEntries(registry).map(entry => entry.definition)
}

export function getGuidelineTopicDefinition(topicId: GuidelineTopicId, registry?: DiseasePackRegistry): GuidelineTopicDefinition {
  return getGuidelineTopicEntry(topicId, registry).definition
}

export function toGuidelineTopicSummary(definition: GuidelineTopicDefinition): GuidelineTopicSummary {
  return {
    fingerprint: definition.fingerprint,
    id: definition.id,
    specialty: definition.specialty,
    titleEn: definition.titleEn,
    titleZh: definition.titleZh,
    version: definition.version,
  }
}

export function normalizeGuidelineFragmentText(text: string): string {
  return text
    .replace(/([a-z])-\r?\n([a-z])/g, '$1$2')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s/g, '')
    .toLowerCase()
}

export interface GuidelineTopicSourceReadResult {
  degradedReason: string | null
  definition: GuidelineTopicDefinition
  guidelines: GuidelineTopicEvidence[]
  missing: string[]
  sourceStatus: 'available' | 'unavailable' | 'read-failed'
  topic: {
    id: GuidelineTopicId
    limitations: string[]
    navigation: string
    version: string
  }
}

export function readGuidelineTopicSource(
  topicId: GuidelineTopicId,
  corpus?: GuidelineCorpus,
  options?: { population?: GuidelinePatientPopulation | undefined; registry?: DiseasePackRegistry | undefined },
): GuidelineTopicSourceReadResult {
  const definition = getGuidelineTopicDefinition(topicId, options?.registry)
  const topic = {
    id: definition.id,
    limitations: [...definition.limitations],
    navigation: definition.navigation,
    version: definition.version,
  }
  const empty = (degradedReason: string, missing: string[], sourceStatus: 'unavailable' | 'read-failed' = 'unavailable'): GuidelineTopicSourceReadResult => ({
    degradedReason,
    definition,
    guidelines: [],
    missing,
    sourceStatus,
    topic,
  })

  if (!corpus) {
    const msg = '尚无本专题可用的固定指南原文，无法提供指南参考意见。'
    return empty(msg, [msg], 'unavailable')
  }

  let read: ReturnType<GuidelineCorpus['readReferences']>
  try {
    read = corpus.readReferences(
      definition.references.map(({ page, sha256, sourceId, version }) => ({ page, sha256, sourceId, version })),
      options?.population === undefined ? undefined : { population: options.population },
    )
  } catch {
    const msg = '指南原文读取失败，请核查指南库后显式重新评估。'
    return empty(msg, [msg], 'read-failed')
  }

  if (read.missing.length > 0) {
    const missing = read.missing.map((item) => {
      const ref = definition.references.find(candidate => candidate.sourceId === item.sourceId && candidate.page === item.page)
        ?? definition.references.find(candidate => candidate.sourceId === item.sourceId)!
      if (item.status === 'withheld' && item.reason === 'population-mismatch') {
        return `${ref.title}物理第${item.page}页适用人群与当前患者不匹配（已隔离不可用），不予引用。`
      }
      return `${ref.title}物理第${item.page}页不可用，请核查来源版本、用途与正文。`
    })
    return empty(missing.join('；'), missing, 'unavailable')
  }

  for (const reference of definition.references) {
    const pageText = read.guidelines
      .filter(item =>
        item.sourceHash === reference.sha256
        && item.version === reference.version
        && Number(/^PDF 物理第 (\d+) 页/.exec(item.locator)?.[1]) === reference.page)
      .map(item => item.text)
      .join('\n')
    if (!reference.fragments.every(fragment => normalizeGuidelineFragmentText(pageText).includes(normalizeGuidelineFragmentText(fragment)))) {
      const msg = `指南物理第${reference.page}页未完整保留本专题所需条款与限定语，停止使用专题。`
      return empty(msg, [msg], 'unavailable')
    }
  }

  if (read.guidelines.length + 1 > 8 || Buffer.byteLength(JSON.stringify({ topic, guidelines: read.guidelines })) > 48 * 1024) {
    const msg = '指南专题与完整原文超出证据预算，不能截断限定语后提供意见。'
    return empty(msg, [msg], 'unavailable')
  }

  return {
    degradedReason: null,
    definition,
    guidelines: read.guidelines,
    missing: [],
    sourceStatus: 'available',
    topic,
  }
}

const POSITIVE_TOPIC_TRANSITION_ZH =
  '(?:但|惟|不过|却|而(?=\\s*(?:有|见|呈|出现|存在|考虑|诊断|确诊|拟))|现(?:有|因|诉|考虑|诊断|确诊)|目前(?:有|考虑|诊断|确诊)|拟(?:行|予|用|诊))'

const NEGATED_PARENTHETICAL_RE =
  /[（(]\s*(?:(?<!不\s*)否认|(?<![不未难待没能法以尚]\s*)(?:已\s*)?(?:排除|除外)|(?:暂\s*)?(?:不考虑|不行|不予)|(?:也\s*)?不是|不存在|无需|不需要|没有(?![想料法办])|未(?:见|发现|出现|提示|行|使用|予|服用|用|检出|合并|伴)|无(?![论故意妨关创菌限价])|(?<!\b(?:cannot|can't|could\s+not|not|never|unable\s+to)\s+)\b(?:no|without|denies|denied|ruled\s+out|rules\s+out|exclud(?:ed|es|ing)|negative\s+for|free\s+of)\b)[^）)]*[）)]/gi

function isNegatedOrInactiveEvidenceRecord(record: Record<string, unknown>): boolean {
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : ''
  if (status === 'cancelled' || status === 'entered-in-error' || status === 'revoked') return true
  const verificationStatus = record.verificationStatus
  if (verificationStatus !== null && typeof verificationStatus === 'object') {
    const coding = (verificationStatus as { coding?: unknown }).coding
    if (Array.isArray(coding)) {
      for (const item of coding) {
        const code =
          item !== null && typeof item === 'object' && typeof (item as { code?: unknown }).code === 'string'
            ? (item as { code: string }).code.trim().toLowerCase()
            : ''
        if (code === 'refuted' || code === 'entered-in-error') return true
      }
    }
  }
  return false
}

function scrubInactiveJsonEvidenceLines(textCorpus: string): string {
  return textCorpus
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return line
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return line
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return line
      const obj = parsed as Record<string, unknown>
      if (isNegatedOrInactiveEvidenceRecord(obj)) return ''
      if (Array.isArray(obj.entries)) {
        const activeEntries = obj.entries.filter(entry => {
          if (entry === null || typeof entry !== 'object') return true
          const e = entry as Record<string, unknown>
          if (isNegatedOrInactiveEvidenceRecord(e)) return false
          if (e.clinical !== null && typeof e.clinical === 'object' && !Array.isArray(e.clinical)) {
            if (isNegatedOrInactiveEvidenceRecord(e.clinical as Record<string, unknown>)) return false
          }
          return true
        })
        if (activeEntries.length === 0) return ''
        if (activeEntries.length !== obj.entries.length) {
          return JSON.stringify({ ...obj, entries: activeEntries })
        }
      }
      return line
    })
    .join('\n')
}

function scrubNegatedTopicClause(clause: string): string {
  let scrubbed = clause
  const hasParen = /[（(]/.test(scrubbed)
  if (hasParen) {
    // 1. Scrub term followed by bare negated status parenthetical, e.g. "ACS（已排除）", "T2DM (ruled out)", "急性胸痛（无）"
    scrubbed = scrubbed.replace(
      /(?:2\s*型糖尿病|(?<![A-Za-z0-9._/-])[A-Za-z0-9._/-]{1,48}(?:\s+(?!and\b|but\b|with\b)[A-Za-z0-9._/-]{1,48}){0,4}|[^\s，,。；;！!？?"{}[\]但惟（()）]{1,32})\s*[（(]\s*(?:无|否|否认|阴性|未见|(?:已\s*)?(?:排除|除外)|(?:暂\s*)?不考虑|no|none|negative|absent|denied|ruled\s+out|excluded)\s*[）)]/gi,
      ' ',
    )
  }
  if (/[:：]/.test(scrubbed)) {
    // 2. Scrub colon/label status negations before prefix negations consume trailing cues (e.g. "急性胸痛：无", "2 型糖尿病：否认", "ACS: negative")
    scrubbed = scrubbed.replace(
      /(?:2\s*型糖尿病|(?<![A-Za-z0-9._/-])[A-Za-z0-9._/-]{1,48}(?:\s+[A-Za-z0-9._/-]{1,48}){0,4}|[\u4e00-\u9fff0-9A-Za-z._/-]{1,24})\s*[:：]\s*(?:无|否|否认|阴性|未见|(?:已\s*)?(?:排除|除外)|(?:暂\s*)?不考虑|no|none|negative|absent|denied|ruled\s+out|excluded)(?=$|\s)/gi,
      ' ',
    )
  }
  if (/(?:排除|除外)\s*$/.test(scrubbed)) {
    // 3a. Scrub Chinese clause-end suffix rule-out negations (e.g. "ACS 已排除", "急性冠脉综合征除外")
    scrubbed = scrubbed.replace(
      /(?:2\s*型糖尿病|[^\s，,。；;！!？?"{}[\]但惟]){1,32}\s*(?<![不未难待没能法以尚]\s*)(?:已\s*)?(?:排除|除外)\s*$/gi,
      ' ',
    )
  }
  if (/\b(?:ruled\s+out|excluded)\b/i.test(scrubbed)) {
    // 3b. Scrub English passive or clause-end suffix rule-out negations (e.g. "NSTEMI was ruled out", "ACS and NSTEMI ruled out")
    scrubbed = scrubbed.replace(
      /(?<![A-Za-z0-9._/-])[A-Za-z0-9._/-]{1,48}(?:\s+(?!but\b|while\b|however\b|yet\b|though\b|although\b)[A-Za-z0-9._/-]{1,48}){0,6}\s+(?:(?:was|is|were|has\s+been|have\s+been)\s+(?<!\b(?:not|never|cannot|can't|could\s+not)\s+)(?:ruled\s+out|excluded)\b|(?<!\b(?:not|never|cannot|can't|could\s+not)\s+)(?:ruled\s+out|excluded)\s*$)/gi,
      ' ',
    )
  }
  if (hasParen) {
    // 4. Scrub self-contained negated parentheticals, e.g. "（否认2型糖尿病）"
    scrubbed = scrubbed.replace(NEGATED_PARENTHETICAL_RE, ' ')
  }
  if (/(?:无|未见|没有|否认)/.test(scrubbed) && /(?:禁忌|过敏)/.test(scrubbed)) {
    // 5. Narrowly scrub "无/未见/没有/否认 ... 禁忌(证)/过敏(史)" without consuming following positive context
    scrubbed = scrubbed.replace(/(?:无|未见|没有|否认)\s*.*?(?:禁忌证?|过敏史?)/gi, ' ')
  }
  // 6. Scrub Chinese prefix negations up to any positive transition or end of clause
  scrubbed = scrubbed.replace(
    new RegExp(
      `(?:(?<!不\\s*)否认|(?<![不未难待没能法以尚]\\s*)(?:已\\s*)?(?:排除|除外)|(?:暂\\s*)?(?:不考虑|不行|不予)|(?:也\\s*)?不是|不存在|无需|不需要|没有(?![想料法办])|未(?:见|发现|出现|提示|行|使用|予|服用|用|检出|合并|伴)|无(?![论故意妨关创菌限价])|非(?![常洲典法但要]|\\s*ST\\s*段抬高|左主干|急诊|靶血管|阻塞)).*?(?=${POSITIVE_TOPIC_TRANSITION_ZH}|$)`,
      'gi',
    ),
    ' ',
  )
  // 7. Scrub English prefix negations up to any positive transition or end of clause
  scrubbed = scrubbed.replace(
    /(?<!\b(?:cannot|can't|could\s+not|not|never|unable\s+to|fail(?:ed)?\s+to)\s+)\b(?:no(?:\s+(?:evidence|history|signs?|symptoms?|indication)\s+of)?|without|denies|denied|ruled\s+out|rules\s+out|exclud(?:ed|es|ing)|negative\s+for|free\s+of)\b.*?(?=\b(?:but|however|yet|though|although|presenting\s+with|now\s+with|admitted\s+for|admitted\s+with)\b|$)/gi,
    ' ',
  )
  return scrubbed
}

export function scrubNegatedGuidelineTopicCorpus(textCorpus: string): string {
  return scrubInactiveJsonEvidenceLines(textCorpus)
    .split(/[，,。；;！!？?\r\n"{}[\]]+/)
    .map(scrubNegatedTopicClause)
    .join('\n')
}

export function collectActivePackGuidelineTopicIds(
  activeRuntime: {
    allowedPackTopicIds: readonly string[]
    entries?: ReadonlyArray<{ activationStatus: string; currentStageId: string | null; packId: string }>
  } | undefined,
  registry?: DiseasePackRegistry,
): GuidelineTopicId[] {
  if (activeRuntime === undefined) return []
  const registeredEntries = listRegisteredGuidelineTopicEntries(registry)
  const registeredIds = new Set(registeredEntries.map(entry => entry.definition.id))
  const ordered: GuidelineTopicId[] = []
  const seen = new Set<string>()
  const pushTopic = (id: string) => {
    if (!seen.has(id) && registeredIds.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }

  for (const id of activeRuntime.allowedPackTopicIds) {
    pushTopic(id)
  }

  if (activeRuntime.entries !== undefined) {
    for (const entry of activeRuntime.entries) {
      if (entry.activationStatus !== 'active') continue
      for (const topicEntry of registeredEntries) {
        if (topicEntry.ownerPack?.packId === entry.packId) {
          pushTopic(topicEntry.definition.id)
        }
      }
    }
  }

  return ordered
}

export function collectPciSelectionMissingItems(options: {
  hasValidCandidate: boolean
  measurements: ReadonlyArray<z.infer<typeof pciMeasurementSchema>>
  targetSite: string | null | undefined
}): string[] {
  const missing: string[] = []
  if (!options.measurements.some(item => item.source.reference.startsWith('DiagnosticReport/'))) {
    missing.push('当前选型测量未关联本次正式造影报告；仅给出一般类别、测量要求与具体缺项。')
  }
  for (const [kind, label] of [
    ['lesion-length', '病变长度'],
    ['proximal-reference-diameter', '近端参考管径'],
    ['distal-reference-diameter', '远端参考管径'],
  ] as const) {
    const measurement = options.measurements.find(item => item.kind === kind)
    if (measurement?.value === null || measurement === undefined) missing.push(`缺少${label}。`)
    if (measurement && measurement.unit === null) missing.push(`${label}缺少单位。`)
    if (measurement?.object === 'unknown') missing.push(`${label}的测量对象尚未核实。`)
  }
  if (!options.targetSite) missing.push('缺少靶血管具体部位。')
  if (!options.hasValidCandidate) {
    missing.push('缺少本计划适用的具体耗材候选，类别意见不能代替具体产品。')
  }
  return missing
}

export function summarizeCoronaryAngiographyVessels(vessels: readonly CoronaryVesselFinding[]): {
  missingFfrMessages: string[]
  summaryText: string
} {
  const missingFfrMessages: string[] = []
  const parts: string[] = []
  for (const v of vessels) {
    const ffrValid = typeof v.ffr === 'number' && Number.isFinite(v.ffr)
    const ifrValid = typeof v.ifr === 'number' && Number.isFinite(v.ifr)
    if (v.stenosisPercent >= 40 && v.stenosisPercent < 90 && !ffrValid && !ifrValid) {
      missingFfrMessages.push(`${v.vessel}(${v.segment}) 呈 ${v.stenosisPercent}% 临界/中等狭窄，尚未记录该支 FFR/iFR 功能学测量或客观缺血证据。`)
    }
    const ffrPart = ffrValid ? `（FFR ${v.ffr}${v.ffr! > 0.8 ? ' > 0.80 保守治疗范围' : ' ≤ 0.80 功能性缺血'}）` : ''
    const ifrPart = ifrValid ? `（iFR ${v.ifr}${v.ifr! > 0.89 ? ' > 0.89 保守治疗范围' : ' ≤ 0.89 功能性缺血'}）` : ''
    parts.push(`${v.vessel}(${v.segment}) 狭窄 ${v.stenosisPercent}%${ffrPart}${ifrPart}`)
  }
  return {
    missingFfrMessages,
    summaryText: parts.join(' · '),
  }
}

interface SupplementaryClinicalIndicators {
  acsEligibility?: { sourceReference: string; valueText: string; versionId: string } | undefined
  angiographySummary?: {
    missingFfrMessages: string[]
    sourceReference: string
    summaryText: string
    versionId: string
  } | undefined
  ecgSummary?: { conclusion: string; sourceReference: string; versionId: string } | undefined
  hba1c?: { sourceReference: string; valueText: string; versionId: string } | undefined
  pciPlanSummary?: {
    hasValidCandidate: boolean
    measurements: Array<z.infer<typeof pciMeasurementSchema>>
    missingItems: string[]
    selectionVersion: number
    sourceReference: string
    targetSite: string | null
    versionId: string
  } | undefined
  troponinSeries?: {
    anyElevated: boolean
    count: number
    latestReference: string
    missingMessage: string | null
    observations: Array<{
      elevated: boolean
      itemText: string
      reference: string
      timestampMs: number | null
      versionId: string
    }>
    serialComplete: boolean
    summaryText: string
    versionId: string
  } | undefined
  cadEligibility?: { sourceReference: string; valueText: string; versionId: string } | undefined
  contrastProcedureEligibility?: { sourceReference: string; valueText: string; versionId: string } | undefined
  t2dmDiagnosis?: { sourceReference: string; valueText: string; versionId: string } | undefined
  tteLvef?: { lvefPct: number; sourceReference: string; versionId: string } | undefined
}

function scoreIndicator(
  scores: ClinicalScoreBundle,
  scoreId: ClinicalScoreBundle['scores'][number]['id'],
  labelZh: string,
  labelEn: string,
): GuidelineTopicPatientIndicator {
  const found = scores.scores.find(item => item.id === scoreId)
  if (found?.status === 'complete') {
    const firstRef = found.sourceReferences[0]
    return {
      code: scoreId,
      labelEn,
      labelZh,
      sourceReference: firstRef?.reference ?? null,
      status: 'present',
      valueText: found.summaryZh,
      versionId: firstRef?.versionId ?? null,
    }
  }
  return {
    code: scoreId,
    labelEn,
    labelZh,
    sourceReference: null,
    status: 'missing',
    valueText: found?.summaryZh ?? null,
    versionId: null,
  }
}

function clampNullableText(value: string | null | undefined, maxLen: number): string | null {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) return null
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed
}

export function clampTopicMissingList(items: readonly string[]): string[] {
  return clampStringList(items, 24, 2000, '项待补齐资料或指南来源')
}

function clampStringList(items: readonly string[], maxItems: number, maxLen: number, overflowLabel: string): string[] {
  const cleaned = items
    .map(item => clampNullableText(item, maxLen))
    .filter((item): item is string => item !== null)
  if (cleaned.length <= maxItems) return cleaned
  const head = cleaned.slice(0, maxItems - 1)
  head.push(`另有 ${cleaned.length - head.length} ${overflowLabel}。`)
  return head
}

function sanitizeIndicator(indicator: GuidelineTopicPatientIndicator): GuidelineTopicPatientIndicator {
  return {
    ...indicator,
    code: indicator.code.trim().slice(0, 64),
    labelEn: indicator.labelEn.trim().slice(0, 160),
    labelZh: indicator.labelZh.trim().slice(0, 160),
    sourceReference: clampNullableText(indicator.sourceReference, 128),
    valueText: clampNullableText(indicator.valueText, 240),
    versionId: clampNullableText(indicator.versionId, 64),
  }
}

export function buildGuidelineTopicRead(options: {
  corpus?: GuidelineCorpus | undefined
  population: GuidelinePatientPopulation
  registry?: DiseasePackRegistry | undefined
  scores: ClinicalScoreBundle
  supplementary: SupplementaryClinicalIndicators
  topicId: GuidelineTopicId
}): GuidelineTopicRead {
  const entry = getGuidelineTopicEntry(options.topicId, options.registry)
  const sourceRead = readGuidelineTopicSource(options.topicId, options.corpus, {
    population: options.population,
    registry: options.registry,
  })
  const { indicators, missingPatientInputs } = evaluateTopicPatientIndicators(
    options.topicId,
    options.scores,
    options.supplementary,
    options.registry,
  )
  return guidelineTopicReadSchema.parse({
    degradedReason: clampNullableText(sourceRead.degradedReason, 4000),
    guidelines: sourceRead.guidelines,
    limitations: clampStringList(sourceRead.definition.limitations, 12, 4000, '条适用限定说明'),
    missingPatientInputs: clampStringList(missingPatientInputs, 24, 4000, '项待补齐临床资料'),
    missingSources: clampStringList(sourceRead.missing, 24, 4000, '项缺失或受限指南来源'),
    navigation: sourceRead.definition.navigation.trim().slice(0, 4000),
    ...(entry.ownerPack === undefined
      ? {}
      : {
          packId: entry.ownerPack.packId,
          packVersion: entry.ownerPack.packVersion,
        }),
    patientIndicators: indicators.slice(0, 24).map(sanitizeIndicator),
    population: options.population,
    status: sourceRead.sourceStatus === 'available' ? 'available' : 'unavailable',
    topic: toGuidelineTopicSummary(sourceRead.definition),
  })
}

export function evaluateTopicPatientIndicators(
  topicId: GuidelineTopicId,
  scores: ClinicalScoreBundle,
  supplementary: SupplementaryClinicalIndicators,
  registry?: DiseasePackRegistry,
): { indicators: GuidelineTopicPatientIndicator[]; missingPatientInputs: string[] } {
  const definition = getGuidelineTopicDefinition(topicId, registry)
  const hasConclusionKind = (kind: InpatientGuidelineAdviceKind) => definition.conclusionKinds.includes(kind)
  const indicators: GuidelineTopicPatientIndicator[] = []
  const missing: string[] = []

  const pushExam = (
    code: string,
    labelZh: string,
    labelEn: string,
    present: { sourceReference: string; valueText: string; versionId: string } | undefined,
    missingMessage: string,
  ) => {
    if (present !== undefined) {
      indicators.push({
        code,
        labelEn,
        labelZh,
        sourceReference: present.sourceReference,
        status: 'present',
        valueText: present.valueText,
        versionId: present.versionId,
      })
    } else {
      indicators.push({
        code,
        labelEn,
        labelZh,
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push(missingMessage)
    }
  }

  const pushScore = (
    scoreId: ClinicalScoreBundle['scores'][number]['id'],
    labelZh: string,
    labelEn: string,
    missingPrefix: string,
  ) => {
    const ind = scoreIndicator(scores, scoreId, labelZh, labelEn)
    indicators.push(ind)
    if (ind.status === 'missing') {
      const score = scores.scores.find(item => item.id === scoreId)
      missing.push(score ? `${missingPrefix}（${score.summaryZh}）` : missingPrefix)
    }
  }

  if (hasConclusionKind('initial-triage-diagnostics')) {
    pushExam(
      'acs-presentation',
      '急性胸痛或疑似/确诊 ACS 就诊依据',
      'Acute chest pain or suspected/confirmed ACS presentation',
      supplementary.acsEligibility,
      '当前患者尚未记录急性胸痛主诉或疑似/确诊急性冠脉综合征（ACS）就诊依据，仅可按条件性参考核对。',
    )
    pushExam(
      'ecg-12-lead',
      '12 导联心电图报告',
      '12-lead ECG report',
      supplementary.ecgSummary === undefined
        ? undefined
        : {
            sourceReference: supplementary.ecgSummary.sourceReference,
            valueText: supplementary.ecgSummary.conclusion,
            versionId: supplementary.ecgSummary.versionId,
          },
      '缺少已签发 12 导联心电图结构化报告。',
    )
    if (supplementary.troponinSeries === undefined) {
      indicators.push({
        code: 'cardiac-troponin',
        labelEn: 'Serial cardiac troponin (cTn/hs-cTn)',
        labelZh: '心肌肌钙蛋白（cTn/hs-cTn 动态复测）',
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push('缺少心肌肌钙蛋白（cTn/hs-cTn）检验及动态复测记录。')
    } else {
      indicators.push({
        code: 'cardiac-troponin',
        labelEn: 'Serial cardiac troponin (cTn/hs-cTn)',
        labelZh: '心肌肌钙蛋白（cTn/hs-cTn 动态复测）',
        sourceReference: supplementary.troponinSeries.latestReference,
        status: supplementary.troponinSeries.serialComplete ? 'present' : 'missing',
        valueText: supplementary.troponinSeries.summaryText,
        versionId: supplementary.troponinSeries.versionId,
      })
      if (supplementary.troponinSeries.missingMessage !== null) {
        missing.push(supplementary.troponinSeries.missingMessage)
      }
    }
    pushScore('grace-acs', 'GRACE 急性冠脉综合征评分', 'GRACE ACS score', 'GRACE 危险分层未就绪')
    pushScore('timi-ua-nstemi', 'TIMI UA/NSTEMI 评分', 'TIMI UA/NSTEMI score', 'TIMI 缺血评分未就绪')
    pushScore('ckd-epi-2021-egfr', '基线估算肾小球滤过率 (eGFR)', 'Baseline eGFR', '缺少基线血肌酐与 eGFR')
  } else if (hasConclusionKind('revascularization-vs-gdmt')) {
    if (supplementary.angiographySummary !== undefined) {
      indicators.push({
        code: 'coronary-angiography',
        labelEn: 'Coronary angiography & FFR/iFR',
        labelZh: '冠脉造影解剖狭窄与功能学评估',
        sourceReference: supplementary.angiographySummary.sourceReference,
        status: 'present',
        valueText: supplementary.angiographySummary.summaryText,
        versionId: supplementary.angiographySummary.versionId,
      })
      missing.push(...supplementary.angiographySummary.missingFfrMessages)
    } else {
      indicators.push({
        code: 'coronary-angiography',
        labelEn: 'Coronary angiography & FFR/iFR',
        labelZh: '冠脉造影解剖狭窄与功能学评估',
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push('尚未关联本次正式冠脉造影狭窄率或 FFR/iFR 功能学评估记录。')
    }
    pushExam(
      'tte-lvef',
      '经胸超声心动图 LVEF',
      'Transthoracic echo LVEF',
      supplementary.tteLvef === undefined
        ? undefined
        : {
            sourceReference: supplementary.tteLvef.sourceReference,
            valueText: `LVEF ${supplementary.tteLvef.lvefPct}%`,
            versionId: supplementary.tteLvef.versionId,
          },
      '缺少经胸超声心动图左室射血分数（LVEF）记录。',
    )
    pushScore('ckd-epi-2021-egfr', '估算肾小球滤过率 (eGFR)', 'eGFR', '缺少造影/血运重建前血肌酐与 eGFR')
  } else if (hasConclusionKind('stent-category')) {
    if (supplementary.pciPlanSummary !== undefined) {
      const plan = supplementary.pciPlanSummary
      const findMeas = (kind: 'lesion-length' | 'proximal-reference-diameter' | 'distal-reference-diameter') => {
        const m = plan.measurements.find(item => item.kind === kind)
        if (m?.value == null) return null
        const unit = m.unit?.trim()
        return unit ? `${m.value}${unit}` : `${m.value}（缺单位）`
      }
      const lenStr = findMeas('lesion-length')
      const proxStr = findMeas('proximal-reference-diameter')
      const distStr = findMeas('distal-reference-diameter')
      const measParts = [
        lenStr ? `长度 ${lenStr}` : null,
        proxStr ? `近端 ${proxStr}` : null,
        distStr ? `远端 ${distStr}` : null,
      ].filter((part): part is string => part !== null)
      const sitePart = plan.targetSite ? plan.targetSite.slice(0, 80) : null
      const verPart = plan.selectionVersion > 0 ? `选型 v${plan.selectionVersion}` : null
      const detailParts = [sitePart, ...measParts, verPart].filter((part): part is string => part !== null)
      indicators.push({
        code: 'pci-selection-plan',
        labelEn: 'PCI target vessel & sizing measurements',
        labelZh: 'PCI 靶血管与参考段测量',
        sourceReference: plan.sourceReference,
        status: plan.missingItems.length === 0 ? 'present' : 'missing',
        valueText: (detailParts.length > 0 ? detailParts.join(' · ') : '待补充靶血管与管径/长度测量').slice(0, 240),
        versionId: plan.selectionVersion > 0 ? `${plan.versionId}.s${plan.selectionVersion}` : plan.versionId,
      })
      missing.push(...plan.missingItems)
    } else if (supplementary.angiographySummary !== undefined) {
      indicators.push({
        code: 'coronary-angiography',
        labelEn: 'Coronary angiography report',
        labelZh: '冠脉造影报告',
        sourceReference: supplementary.angiographySummary.sourceReference,
        status: 'present',
        valueText: supplementary.angiographySummary.summaryText,
        versionId: supplementary.angiographySummary.versionId,
      })
      missing.push('当前未绑定有效的 PCI 支架手术申请与近远端参考管径/病变长度选型参数。')
    } else {
      indicators.push({
        code: 'pci-selection-plan',
        labelEn: 'PCI target vessel & sizing measurements',
        labelZh: 'PCI 靶血管与参考段测量',
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push('缺少冠脉造影报告及 PCI 靶病变长度、近端/远端参考管径测量。')
    }
  } else if (hasConclusionKind('hydration-and-volume-balance')) {
    pushExam(
      'contrast-procedure-indication',
      '含碘对比剂造影/介入检查或手术计划',
      'Planned iodinated-contrast angiography or PCI procedure',
      supplementary.contrastProcedureEligibility,
      '当前尚未关联拟行冠脉造影、PCI 或其他血管内含碘对比剂检查/手术申请，仅可按条件性参考核对。',
    )
    pushScore('ckd-epi-2021-egfr', '术前估算肾小球滤过率 (eGFR)', 'Pre-procedural eGFR', '缺少术前血肌酐与 eGFR 危险分层依据')
    pushScore('cockcroft-gault-crcl', '肌酐清除率 (CrCl / 体重)', 'Creatinine clearance (CrCl)', '缺少体重或肌酐清除率（影响按体重水化速率计算）')
    pushExam(
      'tte-lvef',
      '左心室收缩功能 (TTE LVEF)',
      'Left ventricular function (TTE LVEF)',
      supplementary.tteLvef === undefined
        ? undefined
        : {
            sourceReference: supplementary.tteLvef.sourceReference,
            valueText: `LVEF ${supplementary.tteLvef.lvefPct}%`,
            versionId: supplementary.tteLvef.versionId,
          },
      '缺少经胸超声心动图 LVEF 或心功能评估（水化须防止左心功能不全容量负荷过重）。',
    )
  } else if (hasConclusionKind('dapt-duration-and-bleeding')) {
    pushExam(
      'cad-acs-eligibility',
      '冠心病/ACS 确诊或冠脉血运重建依据',
      'Confirmed CAD/ACS diagnosis or coronary revascularization',
      supplementary.cadEligibility,
      '当前患者尚未确认冠心病/急性冠脉综合征（ICD-10 I20–I25）或冠脉血运重建依据，仅可按条件性参考核对。',
    )
    pushScore('precise-dapt', 'PRECISE-DAPT 出血风险评分', 'PRECISE-DAPT bleeding score', 'PRECISE-DAPT 出血评分未就绪')
    pushScore('ascvd-ldl-target', 'ASCVD 风险分层与 LDL-C 目标核对', 'ASCVD risk & LDL-C goal', 'LDL-C 目标值核对未就绪')
    pushExam(
      'tte-lvef',
      '经胸超声心动图 LVEF',
      'Transthoracic echo LVEF',
      supplementary.tteLvef === undefined
        ? undefined
        : {
            sourceReference: supplementary.tteLvef.sourceReference,
            valueText: `LVEF ${supplementary.tteLvef.lvefPct}%`,
            versionId: supplementary.tteLvef.versionId,
          },
      '缺少 LVEF 评估（影响合并 LVEF ≤ 40% 时 ACEI/ARB/β 受体阻滞剂二级预防核对）。',
    )
  } else {
    pushExam(
      't2dm-diagnosis',
      '2 型糖尿病确诊依据',
      'Confirmed type 2 diabetes diagnosis',
      supplementary.t2dmDiagnosis,
      '当前患者尚未确认 2 型糖尿病（ICD-10 E11）适用诊断，仅可按条件性参考核对。',
    )
    pushScore('ckd-epi-2021-egfr', '估算肾小球滤过率 (eGFR / CKD 分期)', 'eGFR & CKD stage', '缺少血肌酐与 eGFR（无法判定二甲双胍/达格列净肾功能分期界值）')
    pushScore('cockcroft-gault-crcl', '肌酐清除率 (CrCl)', 'Creatinine clearance (CrCl)', '缺少体重或肌酐清除率')
    pushExam(
      'lab-hba1c',
      '糖化血红蛋白 (HbA1c)',
      'HbA1c',
      supplementary.hba1c,
      '缺少近期糖化血红蛋白（HbA1c）检验记录。',
    )
  }

  return { indicators, missingPatientInputs: missing }
}

export function extractSupplementaryIndicators(options: {
  caseId: string
  context: RepositoryContext
  database: ClinMeshDatabase
  encounterId?: string | undefined
  fhir: FhirRepository
  ineligibleObservationIds?: ReadonlySet<string> | undefined
  inpatient?: { actor: ActorContext; service: InpatientService } | undefined
  isArchivedCutoff?: boolean | undefined
  patientId?: string | undefined
  referenceCutoffIso?: string | undefined
}): SupplementaryClinicalIndicators {
  const { caseId, context, database, encounterId, fhir, ineligibleObservationIds, inpatient, isArchivedCutoff, patientId, referenceCutoffIso } = options
  const cutoffMs =
    referenceCutoffIso === undefined
      ? Number.NaN
      : /^\d{4}-\d{2}-\d{2}$/.test(referenceCutoffIso)
        ? Date.parse(`${referenceCutoffIso}T23:59:59.999+08:00`)
        : Date.parse(referenceCutoffIso)
  const encounterTimeCache = new Map<string, number | undefined>()
  const resolveExternalEncounterStartMs = (encRef: string | undefined): number | undefined => {
    const encId = encRef?.startsWith('Encounter/') ? encRef.slice('Encounter/'.length) : undefined
    if (!encId) return undefined
    if (encounterTimeCache.has(encId)) return encounterTimeCache.get(encId)
    let startMs: number | undefined
    try {
      const enc = z.object({
        actualPeriod: z.object({ start: z.string().optional() }).loose().optional(),
        plannedStartDate: z.string().optional(),
      }).loose().safeParse(fhir.read(context, 'Encounter', encId))
      const iso = enc.success ? (enc.data.actualPeriod?.start ?? enc.data.plannedStartDate) : undefined
      const parsed = iso ? (iso.length === 10 ? Date.parse(`${iso}T00:00:00+08:00`) : Date.parse(iso)) : Number.NaN
      if (Number.isFinite(parsed)) startMs = parsed
    } catch {
      startMs = undefined
    }
    encounterTimeCache.set(encId, startMs)
    return startMs
  }
  const parseResourceTimestampMs = (iso: string | undefined): number | undefined => {
    if (!iso) return undefined
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00+08:00`) : Date.parse(iso)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const examRows = z.array(z.object({
    content_json: z.string(),
    diagnostic_report_id: z.string(),
    exam_code: z.enum(['ecg-12-lead', 'tte']),
  })).parse(
    database.driver.prepare(`
      SELECT d.exam_code, c.diagnostic_report_id, c.content_json
      FROM examination_report_content c
      JOIN laboratory_request r
        ON r.workspace_id = c.workspace_id
       AND r.epoch = c.epoch
       AND r.request_id = c.request_id
       AND r.diagnostic_report_id = c.diagnostic_report_id
      JOIN examination_request_detail d
        ON d.workspace_id = c.workspace_id
       AND d.epoch = c.epoch
       AND d.request_id = c.request_id
      WHERE c.workspace_id = ? AND c.epoch = ? AND c.case_id = ?
        AND r.status IN ('reported', 'acknowledged')
      ORDER BY julianday(c.issued_at) DESC, c.diagnostic_report_id DESC
    `).all(context.workspaceId, context.epoch, caseId),
  )

  let ecgSummary: SupplementaryClinicalIndicators['ecgSummary']
  let tteLvef: SupplementaryClinicalIndicators['tteLvef']
  for (const row of examRows) {
    const parsed = investigationResultContentSchema.safeParse(JSON.parse(row.content_json))
    if (!parsed.success) continue
    const report = fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id)
    const versionId = report.meta?.versionId ?? '1'
    if (row.exam_code === 'ecg-12-lead' && ecgSummary === undefined) {
      ecgSummary = {
        conclusion: parsed.data.conclusion,
        sourceReference: `DiagnosticReport/${row.diagnostic_report_id}`,
        versionId,
      }
    }
    if (row.exam_code === 'tte' && tteLvef === undefined) {
      const lvef = parsed.data.results.find(item => item.code === 'lvef' && typeof item.value === 'number')
      if (lvef !== undefined && typeof lvef.value === 'number') {
        tteLvef = {
          lvefPct: lvef.value,
          sourceReference: `DiagnosticReport/${row.diagnostic_report_id}`,
          versionId,
        }
      }
    }
  }

  let hba1c: SupplementaryClinicalIndicators['hba1c']
  const specimenTimeCache = new Map<string, string | undefined>()
  const resolveSpecimenCollectedIso = (specimenRef: string | undefined): string | undefined => {
    const specId = specimenRef?.startsWith('Specimen/') ? specimenRef.slice('Specimen/'.length) : undefined
    if (!specId) return undefined
    if (specimenTimeCache.has(specId)) return specimenTimeCache.get(specId)
    let collectedIso: string | undefined
    try {
      const parsedSpec = z.object({
        collection: z.object({
          collectedDateTime: z.string().optional(),
          collectedPeriod: z.object({ start: z.string().optional() }).loose().optional(),
        }).loose().optional(),
      }).loose().safeParse(fhir.read(context, 'Specimen', specId))
      if (parsedSpec.success) {
        collectedIso =
          parsedSpec.data.collection?.collectedDateTime
          ?? parsedSpec.data.collection?.collectedPeriod?.start
      }
    } catch {
      collectedIso = undefined
    }
    specimenTimeCache.set(specId, collectedIso)
    return collectedIso
  }
  const troponinDesc: Array<{
    elevated: boolean
    itemText: string
    obsId: string
    samplingTimestampMs: number | undefined
    sortTimestampMs: number | undefined
    versionId: string
  }> = []
  const labReportRows = z.array(z.object({
    diagnostic_report_id: z.string(),
    report_time: z.string().nullable(),
  })).parse(
    database.driver.prepare(`
      SELECT r.diagnostic_report_id, COALESCE(r.reported_at, r.authored_at) AS report_time
      FROM laboratory_request r
      WHERE r.workspace_id = ? AND r.epoch = ? AND r.case_id = ?
        AND r.request_kind = 'laboratory'
        AND r.status IN ('reported', 'acknowledged')
        AND r.diagnostic_report_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM laboratory_report_revision rev
          WHERE rev.workspace_id = r.workspace_id
            AND rev.epoch = r.epoch
            AND rev.revision_of_diagnostic_report_id = r.diagnostic_report_id
        )
      ORDER BY julianday(COALESCE(r.reported_at, r.authored_at)) DESC, r.request_id DESC
    `).all(context.workspaceId, context.epoch, caseId),
  )
  for (const row of labReportRows) {
    const report = z.object({
      issued: z.string().optional(),
      result: z.array(z.object({ reference: z.string().optional() }).loose()).optional(),
      status: z.string().optional(),
    }).loose().safeParse(fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id))
    if (!report.success || !['final', 'amended', 'corrected'].includes(report.data.status ?? '')) continue
    for (const ref of report.data.result ?? []) {
      const obsId = ref.reference?.startsWith('Observation/') ? ref.reference.slice('Observation/'.length) : undefined
      if (!obsId) continue
      const obs = z.object({
        code: z.object({
          coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() }).loose()).optional(),
          text: z.string().optional(),
        }).loose().optional(),
        effectiveDateTime: z.string().optional(),
        effectiveInstant: z.string().optional(),
        effectivePeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
        id: z.string(),
        interpretation: z.array(z.object({
          coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
          text: z.string().optional(),
        }).loose()).optional(),
        meta: z.object({ versionId: z.string().optional() }).loose().optional(),
        referenceRange: z.array(z.object({
          high: z.object({ value: z.number().finite().optional() }).loose().optional(),
        }).loose()).optional(),
        specimen: z.object({ reference: z.string().optional() }).loose().optional(),
        status: z.string().optional(),
        valueBoolean: z.boolean().optional(),
        valueQuantity: z.object({ code: z.string().optional(), unit: z.string().optional(), value: z.number().finite().optional() }).loose().optional(),
      }).loose().safeParse(fhir.read(context, 'Observation', obsId))
      if (!obs.success || !['final', 'amended', 'corrected'].includes(obs.data.status ?? '')) continue
      if (ineligibleObservationIds?.has(obs.data.id)) continue
      const codes = new Set((obs.data.code?.coding ?? []).map(c => c.code ?? ''))
      const text = [obs.data.code?.text, ...(obs.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
      const rawUnit = (obs.data.valueQuantity?.unit ?? obs.data.valueQuantity?.code)?.trim() ?? ''
      if (
        hba1c === undefined
        && obs.data.valueQuantity?.value !== undefined
        && rawUnit.length > 0
        && (codes.has('1100301A') || codes.has('4548-4') || codes.has('17856-6') || /糖化血红蛋白|HbA1c/i.test(text))
      ) {
        hba1c = {
          sourceReference: `Observation/${obs.data.id}`,
          valueText: rawUnit === '%' ? `${obs.data.valueQuantity.value}%` : `${obs.data.valueQuantity.value} ${rawUnit}`,
          versionId: obs.data.meta?.versionId ?? '1',
        }
      }
      if (
        codes.has('2100404B') || codes.has('2100404A') || codes.has('2100504A')
        || codes.has('89579-7') || codes.has('49563-0') || codes.has('10839-9')
        || codes.has('6598-7') || codes.has('6597-9') || codes.has('67151-1') || codes.has('42757-5')
        || /肌钙蛋白|troponin/i.test(text)
      ) {
        const interpCodes = (obs.data.interpretation ?? [])
          .flatMap(item => [item.text, ...(item.coding ?? []).map(coding => coding.code)])
          .filter((item): item is string => Boolean(item))
          .map(item => item.trim().toUpperCase())
        const high = obs.data.referenceRange?.[0]?.high?.value
        const qty = obs.data.valueQuantity?.value
        const elevated =
          obs.data.valueBoolean !== undefined
            ? obs.data.valueBoolean
            : interpCodes.some(c => ['H', 'HH', 'HU', 'A', 'AA', 'POS', 'POSITIVE', 'HIGH', 'CRITICAL', 'ABNORMAL'].includes(c))
              ? true
              : interpCodes.some(c => ['N', 'NORMAL', 'NEG', 'NEGATIVE', 'L', 'LL', 'LOW'].includes(c))
                ? false
                : qty !== undefined && high !== undefined
                  ? qty > high
                  : undefined
        if (elevated !== undefined) {
          const samplingRawTs =
            obs.data.effectiveDateTime
            ?? obs.data.effectiveInstant
            ?? obs.data.effectivePeriod?.start
            ?? resolveSpecimenCollectedIso(obs.data.specimen?.reference)
          const parsedSamplingMs = samplingRawTs ? Date.parse(samplingRawTs) : Number.NaN
          const samplingTimestampMs = Number.isFinite(parsedSamplingMs) ? parsedSamplingMs : undefined
          const fallbackReportTs = report.data.issued ?? row.report_time ?? undefined
          const parsedSortMs = (samplingRawTs ?? fallbackReportTs) ? Date.parse((samplingRawTs ?? fallbackReportTs)!) : Number.NaN
          const timeLabel =
            samplingRawTs && samplingRawTs.length >= 16
              ? samplingRawTs.slice(5, 16).replace('T', ' ')
              : '未标采样时间'
          const valLabel = qty !== undefined ? (rawUnit ? `${qty} ${rawUnit}` : `${qty}`) : (elevated ? '阳性' : '阴性')
          const ver = obs.data.meta?.versionId ?? '1'
          troponinDesc.push({
            elevated,
            itemText: `${timeLabel} ${valLabel}(${elevated ? '升高' : '正常'}#v${ver})`,
            obsId: obs.data.id,
            samplingTimestampMs,
            sortTimestampMs: Number.isFinite(parsedSortMs) ? parsedSortMs : undefined,
            versionId: ver,
          })
        }
      }
    }
  }

  let troponinSeries: SupplementaryClinicalIndicators['troponinSeries']
  if (troponinDesc.length > 0) {
    const chrono = [...troponinDesc]
      .reverse()
      .map((item, seq) => ({ ...item, seq }))
      .sort((a, b) => {
        if (a.sortTimestampMs !== undefined && b.sortTimestampMs !== undefined && a.sortTimestampMs !== b.sortTimestampMs) {
          return a.sortTimestampMs - b.sortTimestampMs
        }
        return a.seq - b.seq
      })
    const anyElevated = chrono.some(item => item.elevated)
    const MIN_RETEST_MS = 60 * 60 * 1000
    const MAX_RETEST_MS = 6 * 60 * 60 * 1000
    const timedObs = chrono.filter(
      (item): item is (typeof chrono)[number] & { samplingTimestampMs: number } =>
        item.samplingTimestampMs !== undefined,
    )
    const episodes: Array<typeof timedObs> = []
    for (const item of timedObs) {
      const currentEp = episodes.at(-1)
      if (currentEp === undefined || item.samplingTimestampMs - currentEp.at(-1)!.samplingTimestampMs > MAX_RETEST_MS) {
        episodes.push([item])
      } else {
        currentEp.push(item)
      }
    }
    const episodeHasSerialWindow = (ep: typeof timedObs) =>
      ep.some((earlier, idx) =>
        ep.slice(idx + 1).some(later => {
          const delta = later.samplingTimestampMs - earlier.samplingTimestampMs
          return delta >= MIN_RETEST_MS && delta <= MAX_RETEST_MS
        }),
      )
    const latestEpisode = episodes.at(-1)
    const latestObs = chrono.at(-1)
    const hasUntimedElevatedObservation = chrono.some(item => item.samplingTimestampMs === undefined && item.elevated)
    const hasValidRepeatInterval =
      !hasUntimedElevatedObservation
      && latestObs?.samplingTimestampMs !== undefined
      && latestEpisode !== undefined
      && episodeHasSerialWindow(latestEpisode)
    const serialComplete = hasValidRepeatInterval
    const hasSubHourOnly =
      !serialComplete
      && latestEpisode !== undefined
      && latestEpisode.length >= 2
      && latestEpisode.at(-1)!.samplingTimestampMs - latestEpisode[0]!.samplingTimestampMs < MIN_RETEST_MS
    const missingMessage = serialComplete
      ? null
      : chrono.length < 2
        ? (
            anyElevated
              ? '当前仅有单次升高肌钙蛋白记录，尚未完成动态复测（如 1–3h 复查 cTn/hs-cTn 评估升降变化幅度）。'
              : '当前仅有单次阴性肌钙蛋白记录，尚未完成动态复测（如 1–3h 复查 cTn/hs-cTn），单次阴性不能排除 NSTE-ACS。'
          )
        : hasSubHourOnly
          ? '已记录多次肌钙蛋白但采样间隔不足 1 小时，尚未满足动态复测条件。'
          : '已记录多次肌钙蛋白但采样间隔超出 1–6 小时急性动态复测窗口（或缺少有效时间），尚未满足同次急性发作动态复测条件。'
    const latest = chrono.at(-1)!
    troponinSeries = {
      anyElevated,
      count: chrono.length,
      latestReference: `Observation/${latest.obsId}`,
      missingMessage,
      observations: chrono.map(item => ({
        elevated: item.elevated,
        itemText: item.itemText,
        reference: `Observation/${item.obsId}`,
        timestampMs: item.samplingTimestampMs ?? null,
        versionId: item.versionId,
      })),
      serialComplete,
      summaryText: chrono.map(item => item.itemText).join(' → ').slice(0, 240),
      versionId: `n${chrono.length}.${latest.versionId}`.slice(0, 64),
    }
  }

  let angiographySummary: SupplementaryClinicalIndicators['angiographySummary']
  let pciPlanSummary: SupplementaryClinicalIndicators['pciPlanSummary']
  if (inpatient !== undefined) {
    const reports = inpatient.service.angiography.reports(inpatient.actor, caseId)
    const latest = reports.find(item => item.status === 'final' || item.status === 'partial')
    if (latest !== undefined && latest.vessels.length > 0) {
      let reportVersionId = String(latest.version)
      try {
        reportVersionId = fhir.read(context, 'DiagnosticReport', latest.id).meta?.versionId ?? reportVersionId
      } catch { /* fallback to latest.version */ }
      const { missingFfrMessages, summaryText } = summarizeCoronaryAngiographyVessels(latest.vessels)
      angiographySummary = {
        missingFfrMessages,
        sourceReference: `DiagnosticReport/${latest.id}`,
        summaryText,
        versionId: reportVersionId,
      }
    }
    const pciCandidates = inpatient.service.surgery.read(inpatient.actor, caseId).requests
      .filter(item => item.status !== 'cancelled' && item.adHocPci?.status !== 'cancelled'
        && (pciSelectionProcedureCodes.includes(item.plannedProcedure.coding.code)
          || (item.adHocPci !== undefined && pciSelectionProcedureCodes.includes(item.adHocPci.procedure.coding.code))))
    const pciRequest = pciCandidates.findLast(item => item.status !== 'completed') ?? pciCandidates.at(-1)
    if (pciRequest !== undefined) {
      const selection = inpatient.service.pciSelection.read(inpatient.actor, caseId, pciRequest.id)
      const matchedDraft = selection.drafts?.find(item => item.requestId === pciRequest.id)
      const matchedConfirmation = selection.confirmation?.parameters.requestId === pciRequest.id ? selection.confirmation : undefined
      const parameters = matchedDraft?.parameters ?? matchedConfirmation?.parameters
      const selectionVersion = matchedDraft?.version ?? matchedConfirmation?.version ?? 0
      const measurements = parameters?.measurements ?? []
      const hasValidCandidate = selection.candidates.some(item => item.eligibility === 'valid')
      pciPlanSummary = {
        hasValidCandidate,
        measurements,
        missingItems: collectPciSelectionMissingItems({
          hasValidCandidate,
          measurements,
          targetSite: parameters?.targetSite,
        }),
        selectionVersion,
        sourceReference: `ServiceRequest/${pciRequest.id}`,
        targetSite: parameters?.targetSite ?? null,
        versionId: String(pciRequest.version),
      }
    }
  }

  let acsEligibility: SupplementaryClinicalIndicators['acsEligibility']
  let cadEligibility: SupplementaryClinicalIndicators['cadEligibility']
  let contrastProcedureEligibility: SupplementaryClinicalIndicators['contrastProcedureEligibility']
  const effectiveEncounterId = encounterId ?? caseId

  // Check outpatient triage chiefComplaint for acute chest pain / suspected ACS
  if (inpatient === undefined) {
    const triageRow = z.object({
      observation_id: z.string().nullable(),
      observation_version: z.string().nullable(),
      vital_json: z.string(),
    }).optional().parse(
      database.driver.prepare(`
        SELECT vital_json, observation_id, observation_version
        FROM triage_record
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        LIMIT 1
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (triageRow !== undefined) {
      const parsedTriage = z.object({ chiefComplaint: z.string().optional() }).loose().safeParse(JSON.parse(triageRow.vital_json))
      const cc = parsedTriage.success ? (parsedTriage.data.chiefComplaint ?? '') : ''
      const scrubbedCc = scrubNegatedGuidelineTopicCorpus(cc)
      if (/胸痛|胸闷痛|心前区|胸骨后|心绞痛|急性冠脉|\bACS\b|\bNSTEMI\b|\bSTEMI\b|chest\s*pain|angina|acute\s*coronary/i.test(scrubbedCc)) {
        acsEligibility = {
          sourceReference: triageRow.observation_id ? `Observation/${triageRow.observation_id}` : `Encounter/${effectiveEncounterId}`,
          valueText: cc.trim().slice(0, 240),
          versionId: triageRow.observation_version ?? '1',
        }
      }
    }
  }

  // Check inpatient surgeries & angiography for planned contrast exposure and CAD/PCI eligibility
  const nonPendingSurgeryRequestIds = new Set<string>()
  if (inpatient !== undefined) {
    const surgery = inpatient.service.surgery.read(inpatient.actor, caseId)
    for (const item of surgery.inProgress) nonPendingSurgeryRequestIds.add(item.requestId)
    for (const exec of surgery.executions) {
      if (exec.requestId) nonPendingSurgeryRequestIds.add(exec.requestId)
    }
    for (const req of surgery.requests) {
      if (req.status === 'cancelled') {
        nonPendingSurgeryRequestIds.add(req.id)
        continue
      }
      const code = req.plannedProcedure.coding.code
      const display = req.plannedProcedure.coding.display
      const isPendingContrastPlan =
        (req.status === 'requested' || req.status === 'ready')
        && !nonPendingSurgeryRequestIds.has(req.id)
      if (req.status === 'completed') nonPendingSurgeryRequestIds.add(req.id)
      if (
        isPendingContrastPlan
        && (/^(?:88\.5[567]|36\.0[67]|00\.66)/i.test(code) || /造影|经皮冠状动脉|支架|\bPCI\b|angiography/i.test(display))
      ) {
        contrastProcedureEligibility ??= {
          sourceReference: `ServiceRequest/${req.id}`,
          valueText: display.trim().slice(0, 240),
          versionId: String(req.version),
        }
      }
      if (/^(?:36\.0[67]|00\.66|36\.1)/i.test(code) || /经皮冠状动脉|支架|旁路|\bPCI\b|\bCABG\b/i.test(display)) {
        cadEligibility ??= {
          sourceReference: `ServiceRequest/${req.id}`,
          valueText: display.trim().slice(0, 240),
          versionId: String(req.version),
        }
      }
    }
    for (const exec of surgery.executions) {
      const code = exec.actualProcedure.coding.code
      const display = exec.actualProcedure.coding.display
      if (/^(?:36\.0[67]|00\.66|36\.1)/i.test(code) || /经皮冠状动脉|支架|旁路|\bPCI\b|\bCABG\b/i.test(display)) {
        cadEligibility ??= {
          sourceReference: `Procedure/${exec.id}`,
          valueText: display.trim().slice(0, 240),
          versionId: '1',
        }
      }
    }
    for (const report of inpatient.service.angiography.reports(inpatient.actor, caseId)) {
      if (!['final', 'partial'].includes(report.status)) continue
      if (report.vessels.some(v => v.stenosisPercent >= 50)) {
        cadEligibility ??= {
          sourceReference: `DiagnosticReport/${report.id}`,
          valueText: '冠脉造影狭窄 ≥50%',
          versionId: String(report.version),
        }
      }
    }
  }

  // Check encounter ServiceRequest for genuinely pending (status === 'active') planned contrast imaging / angiography
  if (contrastProcedureEligibility === undefined) {
    const codeableConceptSchema = z.object({
      coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() }).loose()).optional(),
      text: z.string().optional(),
    }).loose()
    const srParams = new URLSearchParams({ _count: '100', encounter: `Encounter/${effectiveEncounterId}` })
    for (;;) {
      const page = fhir.search(context, 'ServiceRequest', srParams)
      for (const raw of page.resources) {
        const parsed = z.object({
          code: codeableConceptSchema.extend({
            concept: codeableConceptSchema.optional(),
          }).optional(),
          id: z.string().min(1),
          meta: z.object({ versionId: z.string().optional() }).loose().optional(),
          status: z.string().optional(),
        }).loose().safeParse(raw)
        if (!parsed.success || parsed.data.status !== 'active' || nonPendingSurgeryRequestIds.has(parsed.data.id)) continue
        const concept = parsed.data.code?.concept ?? parsed.data.code
        const codings = [
          ...(parsed.data.code?.concept?.coding ?? []),
          ...(parsed.data.code?.coding ?? []),
        ]
        const display = [
          parsed.data.code?.concept?.text,
          parsed.data.code?.text,
          ...codings.map(c => c.display),
        ].filter(Boolean).join(' ')
        const codes = codings.map(c => c.code ?? '')
        if (
          codes.some(c => /^(?:88\.5[567]|36\.0[67]|00\.66)/i.test(c))
          || (
            /(?:冠脉|冠状动脉)\s*(?:造影|CTA|CT\s*血管)|增强\s*CT|CT\s*增强|\bCTA\b|\bDSA\b|\bPCI\b|angiography|contrast/i.test(display)
            && !/(?:无|非|不)\s*增强|without\s+contrast|non[-\s]?contrast/i.test(display)
          )
        ) {
          contrastProcedureEligibility = {
            sourceReference: `ServiceRequest/${parsed.data.id}`,
            valueText: (concept?.coding?.[0]?.display ?? concept?.text ?? codings[0]?.display ?? '含碘对比剂检查/手术').trim().slice(0, 240),
            versionId: parsed.data.meta?.versionId ?? '1',
          }
          break
        }
      }
      if (contrastProcedureEligibility !== undefined || page.nextCursor === undefined) break
      srParams.set('_cursor', page.nextCursor)
    }
  }

  // Check Encounter Condition for acute chest pain / suspected or confirmed ACS
  if (acsEligibility === undefined) {
    const encCondParams = new URLSearchParams({ _count: '100', encounter: `Encounter/${effectiveEncounterId}` })
    for (;;) {
      const page = fhir.search(context, 'Condition', encCondParams)
      for (const raw of page.resources) {
        const parsed = z.object({
          clinicalStatus: z.object({ coding: z.array(z.object({ code: z.string().optional() }).loose()).optional() }).loose().optional(),
          code: z.object({
            coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() }).loose()).optional(),
            text: z.string().optional(),
          }).loose().optional(),
          id: z.string().min(1),
          meta: z.object({ versionId: z.string().optional() }).loose().optional(),
          verificationStatus: z.object({ coding: z.array(z.object({ code: z.string().optional() }).loose()).optional() }).loose().optional(),
        }).loose().safeParse(raw)
        if (!parsed.success) continue
        const ver = parsed.data.verificationStatus?.coding?.[0]?.code
        const clin = parsed.data.clinicalStatus?.coding?.[0]?.code
        if (ver === 'entered-in-error' || ver === 'refuted' || clin === 'inactive' || clin === 'resolved') continue
        const codes = (parsed.data.code?.coding ?? []).map(c => c.code?.trim().toUpperCase() ?? '')
        const display = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
        const scrubbedDisplay = scrubNegatedGuidelineTopicCorpus(display)
        if (
          codes.some(c => /^(?:I20\.0|I2[1234]|R07)/.test(c))
          || /急性冠脉|不稳定型心绞痛|心肌梗死|急性胸痛|胸痛|\bACS\b|\bNSTEMI\b|\bSTEMI\b|acute\s*coronary|chest\s*pain/i.test(scrubbedDisplay)
        ) {
          acsEligibility = {
            sourceReference: `Condition/${parsed.data.id}`,
            valueText: (parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? '疑似/确诊 ACS').trim().slice(0, 240),
            versionId: parsed.data.meta?.versionId ?? '1',
          }
          break
        }
      }
      if (acsEligibility !== undefined || page.nextCursor === undefined) break
      encCondParams.set('_cursor', page.nextCursor)
    }
  }

  let t2dmDiagnosis: SupplementaryClinicalIndicators['t2dmDiagnosis']
  if (patientId !== undefined) {
    const condParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = fhir.search(context, 'Condition', condParams)
      for (const raw of page.resources) {
        const parsed = z.object({
          clinicalStatus: z.object({ coding: z.array(z.object({ code: z.string().optional() }).loose()).optional() }).loose().optional(),
          code: z.object({
            coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() }).loose()).optional(),
            text: z.string().optional(),
          }).loose().optional(),
          encounter: z.object({ reference: z.string().optional() }).loose().optional(),
          id: z.string().min(1),
          meta: z.object({ versionId: z.string().optional() }).loose().optional(),
          onsetDateTime: z.string().optional(),
          onsetPeriod: z.object({ start: z.string().optional() }).loose().optional(),
          recordedDate: z.string().optional(),
          verificationStatus: z.object({ coding: z.array(z.object({ code: z.string().optional() }).loose()).optional() }).loose().optional(),
        }).loose().safeParse(raw)
        if (!parsed.success) continue
        if (parsed.data.verificationStatus?.coding?.[0]?.code !== 'confirmed') continue
        const isCurrentEncCondition =
          effectiveEncounterId !== undefined && parsed.data.encounter?.reference === `Encounter/${effectiveEncounterId}`
        if (!isCurrentEncCondition && Number.isFinite(cutoffMs)) {
          const condTsMs =
            parseResourceTimestampMs(parsed.data.recordedDate ?? parsed.data.onsetDateTime ?? parsed.data.onsetPeriod?.start)
            ?? resolveExternalEncounterStartMs(parsed.data.encounter?.reference)
          if (condTsMs === undefined ? isArchivedCutoff === true : condTsMs > cutoffMs) continue
        }
        const clinCode = parsed.data.clinicalStatus?.coding?.[0]?.code
        const codes = (parsed.data.code?.coding ?? []).map(c => c.code?.trim() ?? '').filter(Boolean)
        const display = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
        const scrubbedDisplay = scrubNegatedGuidelineTopicCorpus(display)
        const isCadCondition =
          codes.some(code => /^(?:I2[0-5]|Z95\.[15]|Z98\.61)/i.test(code) || code === '53741008' || code === '22298006')
          || /冠心病|冠状动脉粥样硬化|心绞痛|心肌梗死|急性冠脉|冠脉支架|冠脉搭桥|coronary artery disease|myocardial infarction|angina/i.test(scrubbedDisplay)
        if (cadEligibility === undefined && isCadCondition && (clinCode !== 'inactive' || codes.some(c => /^(?:I25\.2|Z95\.[15]|Z98\.61)/i.test(c)))) {
          cadEligibility = {
            sourceReference: `Condition/${parsed.data.id}`,
            valueText: (parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? '冠心病').trim().slice(0, 240),
            versionId: parsed.data.meta?.versionId ?? '1',
          }
        }
        if (clinCode === 'inactive' || clinCode === 'resolved') continue
        if (
          t2dmDiagnosis === undefined
          && (
            codes.some(code => /^E11/i.test(code) || code === '44054006')
            || /2\s*型糖尿病|二型糖尿病|type\s*2\s*diabetes/i.test(scrubbedDisplay)
          )
        ) {
          t2dmDiagnosis = {
            sourceReference: `Condition/${parsed.data.id}`,
            valueText: (parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? '2型糖尿病').trim().slice(0, 240),
            versionId: parsed.data.meta?.versionId ?? '1',
          }
        }
      }
      if ((t2dmDiagnosis !== undefined && cadEligibility !== undefined) || page.nextCursor === undefined) break
      condParams.set('_cursor', page.nextCursor)
    }

    if (cadEligibility === undefined) {
      const procParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
      for (;;) {
        const page = fhir.search(context, 'Procedure', procParams)
        for (const raw of page.resources) {
          const parsed = z.object({
            code: z.object({
              coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() }).loose()).optional(),
              text: z.string().optional(),
            }).loose().optional(),
            encounter: z.object({ reference: z.string().optional() }).loose().optional(),
            id: z.string().min(1),
            meta: z.object({ versionId: z.string().optional() }).loose().optional(),
            occurenceDateTime: z.string().optional(),
            occurrenceDateTime: z.string().optional(),
            occurrencePeriod: z.object({ start: z.string().optional() }).loose().optional(),
            performedDateTime: z.string().optional(),
            performedPeriod: z.object({ start: z.string().optional() }).loose().optional(),
            status: z.string().optional(),
          }).loose().safeParse(raw)
          if (!parsed.success || parsed.data.status !== 'completed') continue
          const isCurrentEncProc =
            effectiveEncounterId !== undefined && parsed.data.encounter?.reference === `Encounter/${effectiveEncounterId}`
          if (!isCurrentEncProc && Number.isFinite(cutoffMs)) {
            const procTsMs =
              parseResourceTimestampMs(
                parsed.data.occurrenceDateTime
                ?? parsed.data.occurenceDateTime
                ?? parsed.data.performedDateTime
                ?? parsed.data.occurrencePeriod?.start
                ?? parsed.data.performedPeriod?.start,
              )
              ?? resolveExternalEncounterStartMs(parsed.data.encounter?.reference)
            if (procTsMs === undefined ? isArchivedCutoff === true : procTsMs > cutoffMs) continue
          }
          const codes = (parsed.data.code?.coding ?? []).map(c => c.code ?? '')
          const display = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
          if (
            codes.some(c => /^(?:00\.66|36\.0[67]|36\.1)/i.test(c))
            || /经皮冠状动脉|冠脉支架|冠状动脉旁路|\bPCI\b|\bCABG\b/i.test(display)
          ) {
            cadEligibility = {
              sourceReference: `Procedure/${parsed.data.id}`,
              valueText: (parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? '冠脉血运重建术后').trim().slice(0, 240),
              versionId: parsed.data.meta?.versionId ?? '1',
            }
            break
          }
        }
        if (cadEligibility !== undefined || page.nextCursor === undefined) break
        procParams.set('_cursor', page.nextCursor)
      }
    }
  }

  return {
    acsEligibility,
    angiographySummary,
    cadEligibility,
    contrastProcedureEligibility,
    ecgSummary,
    hba1c,
    pciPlanSummary,
    t2dmDiagnosis,
    troponinSeries,
    tteLvef,
  }
}

export function buildSynchronousTopicBundle(options: {
  activeRuntime?: {
    allowedPackTopicIds: readonly string[]
    hasStageScopeRestriction: boolean
    primaryPack?: PackSourceSummary | undefined
    sourcePacks: readonly PackSourceSummary[]
  } | undefined
  caseId: string
  context: RepositoryContext
  corpus?: GuidelineCorpus | undefined
  database: ClinMeshDatabase
  encounterId: string
  evaluatedAt: string
  fhir: FhirRepository
  inpatient?: { actor: ActorContext; service: InpatientService } | undefined
  isArchivedCutoff?: boolean | undefined
  patientBirthDate: string | undefined
  patientId?: string | undefined
  populationReferenceIso: string
  referenceCutoffIso?: string | undefined
  registry?: DiseasePackRegistry | undefined
  scores: ClinicalScoreBundle
  topicId?: GuidelineTopicId | undefined
}): GuidelineTopicBundle {
  const population = resolvePatientGuidelinePopulation(options.patientBirthDate, options.populationReferenceIso)
  const supplementary = extractSupplementaryIndicators({
    caseId: options.caseId,
    context: options.context,
    database: options.database,
    encounterId: options.encounterId,
    fhir: options.fhir,
    inpatient: options.inpatient,
    isArchivedCutoff: options.isArchivedCutoff,
    patientId: options.patientId,
    referenceCutoffIso: options.referenceCutoffIso ?? options.populationReferenceIso,
  })
  const entries = listRegisteredGuidelineTopicEntries(options.registry)
  const allowedPackTopics = options.activeRuntime?.hasStageScopeRestriction === true
    ? new Set(options.activeRuntime.allowedPackTopicIds)
    : undefined
  const targetTopicIds = options.topicId !== undefined
    ? [options.topicId]
    : entries
        .filter(entry => entry.ownerPack === undefined || allowedPackTopics === undefined || allowedPackTopics.has(entry.definition.id))
        .map(entry => entry.definition.id)
  const items = targetTopicIds.map(topicId => buildGuidelineTopicRead({
    corpus: options.corpus,
    population,
    registry: options.registry,
    scores: options.scores,
    supplementary,
    topicId,
  }))
  const derivedSourcePacks = new Map<string, PackSourceSummary>()
  for (const sp of options.activeRuntime?.sourcePacks ?? []) {
    derivedSourcePacks.set(sp.packId, sp)
  }
  if (derivedSourcePacks.size === 0 && options.topicId !== undefined) {
    const requestedOwner = getGuidelineTopicEntry(options.topicId, options.registry).ownerPack
    if (requestedOwner !== undefined) {
      derivedSourcePacks.set(requestedOwner.packId, requestedOwner)
    }
  } else if (derivedSourcePacks.size === 0 && options.topicId === undefined) {
    for (const entry of entries) {
      if (entry.ownerPack !== undefined) derivedSourcePacks.set(entry.ownerPack.packId, entry.ownerPack)
    }
  }
  const sourcePacks = [...derivedSourcePacks.values()]
  const primaryPack = options.activeRuntime?.primaryPack ?? sourcePacks[0]
  return guidelineTopicBundleSchema.parse({
    encounterId: options.encounterId,
    evaluatedAt: options.evaluatedAt,
    items,
    ...(primaryPack === undefined
      ? {}
      : {
          packId: primaryPack.packId,
          packVersion: primaryPack.packVersion,
        }),
    ...(sourcePacks.length === 0 ? {} : { sourcePacks }),
  })
}
