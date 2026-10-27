import type { GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'

export interface GuidelineSourceDefinition {
  id: string
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
}

export const localEvaluationSourcePrefix = 'local-evaluation-'

export function isGuidelineSourceUsable(source: GuidelineSourceDefinition, allowNonCommercial = false,
  options: { allowLocalEvaluation?: boolean; knownSources?: readonly GuidelineSourceDefinition[] } = {}): boolean {
  if (source.status !== 'active') return false
  if (options.knownSources?.some(parent => parent.status !== 'active' && (parent.sha256 === source.sha256
    || source.id === `${localEvaluationSourcePrefix}${parent.id}`))) return false
  if (source.id.startsWith(localEvaluationSourcePrefix)) return options.allowLocalEvaluation === true
  return source.license.usage === 'open' || (source.license.usage === 'non-commercial' && allowNonCommercial)
}
