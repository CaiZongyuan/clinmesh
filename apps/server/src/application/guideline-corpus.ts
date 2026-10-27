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
  passageCount: number
  unusablePassageCount?: number
}

export function isGuidelinePassageUsable(passage: Pick<GuidelinePassage, 'text'>): boolean {
  return passage.text.trim().length > 0 && !/[\p{Cc}\uFFFD]/u.test(passage.text.replaceAll(/[\t\n\r]/g, ''))
}

export const localEvaluationSourcePrefix = 'local-evaluation-'

export function guidelineSourceLineage(source: GuidelineSourceDefinition,
  knownSources: readonly GuidelineSourceDefinition[]): GuidelineSourceDefinition[] | null {
  if (source.derivedFromSourceId === undefined) return [source]
  const known = new Map(knownSources.map(item => [item.id, item]))
  const lineage: GuidelineSourceDefinition[] = []
  const visited = new Set<string>()
  let current: GuidelineSourceDefinition | undefined = source
  while (current !== undefined) {
    if (visited.has(current.id)) return null
    visited.add(current.id)
    lineage.push(current)
    current = current.derivedFromSourceId === undefined ? undefined : known.get(current.derivedFromSourceId)
  }
  return lineage
}

export function isGuidelineSourceUsable(source: GuidelineSourceDefinition, allowNonCommercial = false,
  options: { deploymentPolicy?: GuidelineDeploymentPolicy; allowLocalEvaluation?: boolean; knownSources?: readonly GuidelineSourceDefinition[] } = {}): boolean {
  if (source.status !== 'active' || (source.distribution !== undefined && source.distribution.textStatus !== 'verified')) return false
  const lineage = guidelineSourceLineage(source, options.knownSources ?? [])
  if (lineage === null) return false
  if (options.knownSources?.some(parent => (parent.status !== 'active'
    || (parent.distribution !== undefined && parent.distribution.textStatus !== 'verified'))
    && lineage.some(derived => parent.id === derived.id || parent.sha256 === derived.sha256
      || derived.id === `${localEvaluationSourcePrefix}${parent.id}`))) return false
  if (source.id.startsWith(localEvaluationSourcePrefix)) return options.allowLocalEvaluation === true
  return source.license.usage === 'open'
    || (source.license.usage === 'non-commercial' && allowNonCommercial)
    || (options.deploymentPolicy === 'internal-testing' && source.distribution?.textStatus === 'verified')
}
