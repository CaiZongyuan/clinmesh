import {
  referenceDataProvenanceSchema,
  referenceDataReleaseListSchema,
  type ReferenceDataReleaseList,
} from '@clinmesh/contracts/reference-data'
import type { ActorContext } from './command-executor.ts'

const BUILTIN_ARTIFACT_CHECKSUM = 'c2b6041f9f43187433f89ccfbc646d0d6a484afe228ae834e20348cd606874d2'
const BUILTIN_RELEASE_CONTENT_HASH = 'c4f3db18716deead08d407dec4473d2fb30cf4d098fb8cad6cc04ef9fc7384a5'

export interface ReferenceDataReader {
  list(): ReferenceDataReleaseList
}

export class ReferenceDataError extends Error {
  readonly code = 'ROLE_NOT_ALLOWED'
  readonly status = 403

  constructor(message: string) {
    super(message)
    this.name = 'ReferenceDataError'
  }
}

function builtinReferenceData(): ReferenceDataReleaseList {
  // These hashes pin the empty fallback artifact and manifest; changing either requires a new release ID.
  return referenceDataReleaseListSchema.parse({
    items: [{
      conceptCount: 0,
      contentHash: BUILTIN_RELEASE_CONTENT_HASH,
      createdAt: '2026-08-27T00:00:00+08:00',
      releaseId: 'clinmesh-builtin-reference-v1',
      schemaVersion: '1',
      sourceCount: 1,
      sources: [{
        acquisitionMethod: 'generated',
        checksum: BUILTIN_ARTIFACT_CHECKSUM,
        importDiagnostics: {
          acceptedCount: 0,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: 0,
        retrievedAt: '2026-08-27T00:00:00+08:00',
        sourceId: 'clinmesh-builtin',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/43',
        upstreamVersion: 'builtin-reference-v1',
      }],
      status: 'published',
    }],
  })
}

export class ReferenceDataService {
  readonly #reader: ReferenceDataReader | undefined

  constructor(reader?: ReferenceDataReader) {
    this.#reader = reader
  }

  list(context: ActorContext): ReferenceDataReleaseList {
    if (context.roleCode !== 'administrator') {
      throw new ReferenceDataError('Only an administrator can read Reference Data releases')
    }
    return this.#releases()
  }

  current(): ReferenceDataReleaseList['items'][number] {
    return this.#releases().items[0]!
  }

  provenance() {
    const release = this.current()
    return referenceDataProvenanceSchema.parse({
      contentHash: release.contentHash,
      releaseId: release.releaseId,
    })
  }

  #releases(): ReferenceDataReleaseList {
    const releases = this.#reader?.list()
    return releases === undefined || releases.items.length === 0 ? builtinReferenceData() : releases
  }
}
