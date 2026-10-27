import type { GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'

export type GuidelineDeploymentPolicy = 'default' | 'internal-testing'
export const guidelinePassagePolicyRevision = 'readable-original-passages-v1'

export interface GuidelineSourceDefinition {
  id: string
  derivedFromSourceId?: string
  title: string
  publisher: string
  documentType: GuidelineEvidence['documentType']
  version: string
  publishedAt?: string
  effectiveAt?: string
  url: string
  downloadUrl?: string
  format: 'pdf' | 'text'
  sha256: string
  scope: string
  status: 'active' | 'withdrawn' | 'superseded'
  license: {
    id: string
    url: string
    usage: 'open' | 'non-commercial' | 'unverified'
  }
  distribution?: {
    packageId: string
    releaseId: string
    textStatus: 'verified' | 'pending' | 'unreadable'
    verificationRecord: string
  }
  topics: Array<{ terms: string[]; diagnosisQueries: string[] }>
}

export interface GuidelinePassage {
  locator: string
  text: string
}

export interface GuidelineDocument {
  source: GuidelineSourceDefinition
  passages: GuidelinePassage[]
}

export interface GuidelineSearchResult {
  guidelines: GuidelineEvidence[]
  diagnosisQueries: string[]
  inactiveSources: Array<Pick<GuidelineEvidence, 'id' | 'url' | 'sourceHash'>>
  revision: string
}

export interface GuidelineSourceStatus {
  source: GuidelineSourceDefinition
  bodyId?: string
  integrityValid?: false
  passageCount: number
  unusablePassageCount?: number
}

export function guidelineCorpusStatistics(sources: readonly GuidelineSourceStatus[], options: {
  allowNonCommercial?: boolean; deploymentPolicy?: GuidelineDeploymentPolicy; allowLocalEvaluation?: boolean
  sourceIds?: readonly string[]
} = {}) {
  const sourceIds = options.sourceIds === undefined ? undefined : new Set(options.sourceIds)
  const selected = sources.filter(item => sourceIds === undefined || sourceIds.has(item.source.id))
  const bodies = new Map(selected.filter(item => item.passageCount > 0).map(item => [item.bodyId ?? item.source.id, item]))
  const policy = { ...options, knownSources: sources.filter(item => item.integrityValid !== false).map(item => item.source) }
  const searchable = selected.filter(item => item.integrityValid !== false && item.passageCount > (item.unusablePassageCount ?? 0)
    && isGuidelineSourceUsable(item.source, options.allowNonCommercial, policy))
  const searchableBodies = new Map(searchable.map(item => [item.bodyId ?? item.source.id, item]))
  return {
    sourceCount: selected.length,
    documentCount: bodies.size,
    passageCount: [...bodies.values()].reduce((total, item) => total + item.passageCount, 0),
    unusablePassageCount: [...bodies.values()].reduce((total, item) => total + (item.unusablePassageCount ?? 0), 0),
    searchableSourceCount: searchable.length,
    searchableDocumentCount: searchableBodies.size,
    searchablePassageCount: [...searchableBodies.values()].reduce((total, item) => total + item.passageCount - (item.unusablePassageCount ?? 0), 0),
  }
}

export function isGuidelinePassageUsable(passage: Pick<GuidelinePassage, 'text'>): boolean {
  return passage.text.trim().length > 0 && !/[\p{Cc}\uFFFD]/u.test(passage.text.replaceAll(/[\t\n\r]/g, ''))
}

export const localEvaluationSourcePrefix = 'local-evaluation-'

export function guidelineSourceLineage(source: GuidelineSourceDefinition,
  knownSources: readonly GuidelineSourceDefinition[]): { sources: GuidelineSourceDefinition[]; complete: boolean } | null {
  if (source.derivedFromSourceId === undefined) return { sources: [source], complete: true }
  const known = new Map(knownSources.map(item => [item.id, item]))
  const lineage: GuidelineSourceDefinition[] = []
  const visited = new Set<string>()
  let current: GuidelineSourceDefinition | undefined = source
  while (current !== undefined) {
    if (visited.has(current.id)) return null
    visited.add(current.id)
    lineage.push(current)
    const parentId: string | undefined = current.derivedFromSourceId
    current = parentId === undefined ? undefined : known.get(parentId)
    if (parentId !== undefined && current === undefined) return { sources: lineage, complete: false }
  }
  return { sources: lineage, complete: true }
}

export function isGuidelineSourceUsable(source: GuidelineSourceDefinition, allowNonCommercial = false,
  options: { deploymentPolicy?: GuidelineDeploymentPolicy; allowLocalEvaluation?: boolean; knownSources?: readonly GuidelineSourceDefinition[] } = {}): boolean {
  if (hasSourceRestriction(source)) return false
  const lineage = guidelineSourceLineage(source, options.knownSources ?? [])
  if (lineage === null || !lineage.complete) return false
  if (lineage.sources.slice(1).some(hasSourceRestriction)) return false
  if (source.derivedFromSourceId === undefined && source.id.startsWith(localEvaluationSourcePrefix)
    && options.knownSources?.some(parent => !parent.id.startsWith(localEvaluationSourcePrefix) && hasSourceRestriction(parent)
      && (parent.sha256 === source.sha256 || source.id === `${localEvaluationSourcePrefix}${parent.id}`))) return false
  if (source.id.startsWith(localEvaluationSourcePrefix)) return options.allowLocalEvaluation === true
  return source.license.usage === 'open'
    || (source.license.usage === 'non-commercial' && allowNonCommercial)
    || (options.deploymentPolicy === 'internal-testing' && source.distribution?.textStatus === 'verified')
}

function hasSourceRestriction(source: GuidelineSourceDefinition): boolean {
  return source.status !== 'active' || (source.distribution !== undefined && source.distribution.textStatus !== 'verified')
}
