import {
  referenceDataProvenanceSchema,
  referenceDataReleaseListSchema,
  type ReferenceDataReleaseList,
  type ReferenceDataReleaseSummary,
  type ReferenceMedicationProduct,
} from '@clinmesh/contracts/reference-data'
import type { ActorContext } from './command-executor.ts'
import { syntheticNhsaMedicationProductSnapshot } from './scenario-data/medication-product-snapshot.ts'

const BUILTIN_ARTIFACT_CHECKSUM = 'b72aa94f14b640dc9bc2952d687728995cc06a137da734b2b74bbffb64256c93'
const BUILTIN_RELEASE_CONTENT_HASH = 'c200392183640c4893dfbfbe048a7c74dcfcf54babca8b136571ad6540719195'
const BUILTIN_RELEASE_ID = 'clinmesh-nhsa-medication-products-parser-fixture-2026-08-28'

export interface ReferenceDataReader {
  list(): ReferenceDataReleaseList
  medicationProducts(releaseId: string): ReferenceMedicationProduct[]
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
  // These hashes pin the synthetic Product artifact and manifest; changing either requires a new release ID.
  return referenceDataReleaseListSchema.parse({
    items: [{
      conceptCount: 0,
      contentHash: BUILTIN_RELEASE_CONTENT_HASH,
      createdAt: '2026-08-28T00:00:00.000Z',
      medicationProductCount: syntheticNhsaMedicationProductSnapshot.length,
      releaseId: BUILTIN_RELEASE_ID,
      schemaVersion: '1',
      sourceCount: 1,
      sources: [{
        artifactFormat: 'nhsa-medication-product-csv',
        acquisitionMethod: 'generated',
        checksum: BUILTIN_ARTIFACT_CHECKSUM,
        importDiagnostics: {
          acceptedCount: syntheticNhsaMedicationProductSnapshot.length,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: syntheticNhsaMedicationProductSnapshot.length,
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'clinmesh-synthetic-nhsa-medication-products',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/47',
        upstreamVersion: 'nhsa-medication-products-2026-08-07',
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
    return this.medicationProductSelection().release
  }

  provenance() {
    const release = this.current()
    return referenceDataProvenanceSchema.parse({
      contentHash: release.contentHash,
      releaseId: release.releaseId,
    })
  }

  medicationProductSelection(): {
    products: ReferenceMedicationProduct[]
    release: ReferenceDataReleaseSummary
  } {
    const release = this.#releases().items.find(item => item.medicationProductCount > 0)
    const builtin = builtinReferenceData().items[0]!
    if (release === undefined) return { products: syntheticNhsaMedicationProductSnapshot, release: builtin }
    if (release.releaseId === BUILTIN_RELEASE_ID) {
      if (release.contentHash !== builtin.contentHash) {
        throw new Error(`Built-in Reference Data Release hash mismatch: ${release.releaseId}`)
      }
      return { products: syntheticNhsaMedicationProductSnapshot, release: builtin }
    }
    const products = this.#reader?.medicationProducts(release.releaseId) ?? []
    if (products.length !== release.medicationProductCount) {
      throw new Error(`Reference Data Release Product count mismatch: ${release.releaseId}`)
    }
    return { products, release }
  }

  #releases(): ReferenceDataReleaseList {
    const releases = this.#reader?.list()
    if (releases === undefined || releases.items.length === 0) return builtinReferenceData()
    if (releases.items.some(release => release.medicationProductCount > 0)) return releases
    const builtin = builtinReferenceData().items[0]!
    return referenceDataReleaseListSchema.parse({
      items: [
        ...releases.items,
        ...(releases.items.some(release => release.releaseId === builtin.releaseId) ? [] : [builtin]),
      ],
    })
  }
}
