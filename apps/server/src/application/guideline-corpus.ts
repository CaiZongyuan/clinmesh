import type { GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'

export type GuidelineDeploymentPolicy = 'default' | 'internal-testing'

export interface GuidelineSourceDefinition {
  id: string
  title: string
  publisher: string
  documentType: GuidelineEvidence['documentType']
  version: string
  publishedAt?: string
  effectiveAt?: string
  url: string
  downloadUrl: string
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
}

export function isGuidelineSourceUsable(source: GuidelineSourceDefinition, allowNonCommercial = false,
  deploymentPolicy: GuidelineDeploymentPolicy = 'default'): boolean {
  if (source.status !== 'active' || (source.distribution !== undefined && source.distribution.textStatus !== 'verified')) return false
  return source.license.usage === 'open'
    || (source.license.usage === 'non-commercial' && allowNonCommercial)
    || (deploymentPolicy === 'internal-testing' && source.distribution?.textStatus === 'verified')
}
