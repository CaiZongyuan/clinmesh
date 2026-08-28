import {
  referenceDataProvenanceSchema,
  referenceDataReleaseListSchema,
  type ReferenceDataReleaseList,
  type ReferenceDataReleaseSummary,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import type { ActorContext } from './command-executor.ts'
import { syntheticNhsaMedicationProductSnapshot } from './scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from './scenario-data/medical-service-snapshot.ts'

const BUILTIN_RELEASE_CONTENT_HASH = 'bc1e7ca7e11e31851acd651705ab627b45ff459c79dcca3aa1ebb32c81ae0b5e'
const BUILTIN_RELEASE_ID = 'clinmesh-hospital-reference-fixture-2026-08-28'

export interface ReferenceDataReader {
  list(): ReferenceDataReleaseList
  medicalServices(releaseId: string): ReferenceMedicalService[]
  medicationProducts(releaseId: string): ReferenceMedicationProduct[]
  valueSetEntries(releaseId: string): ReferenceValueSetEntry[]
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
  // These hashes pin the synthetic hospital reference manifest; changing a source requires a new release ID.
  return referenceDataReleaseListSchema.parse({
    items: [{
      conceptCount: 0,
      contentHash: BUILTIN_RELEASE_CONTENT_HASH,
      createdAt: '2026-08-28T00:00:00.000Z',
      medicationProductCount: syntheticNhsaMedicationProductSnapshot.length,
      releaseId: BUILTIN_RELEASE_ID,
      schemaVersion: '1',
      serviceCount: syntheticNhcMedicalServiceSnapshot.length,
      sourceCount: 3,
      sources: [{
        artifactFormat: 'nhsa-medication-product-csv',
        acquisitionMethod: 'generated',
        checksum: 'b72aa94f14b640dc9bc2952d687728995cc06a137da734b2b74bbffb64256c93',
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
      }, {
        acquisitionMethod: 'generated',
        artifactFormat: 'nhc-medical-service-csv',
        checksum: '8ed125b9d880f39ff0e7a503229e4bd1d69772ec86ee6c19808d6c68eca3954b',
        importDiagnostics: {
          acceptedCount: syntheticNhcMedicalServiceSnapshot.length,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: syntheticNhcMedicalServiceSnapshot.length,
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'clinmesh-synthetic-nhc-medical-services',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/48',
        upstreamVersion: 'nhc-medical-services-2026-08-28',
      }, {
        acquisitionMethod: 'generated',
        artifactFormat: 'wst-value-set-csv',
        checksum: '36fc6be3ab504b8f48f1cacedaac2aaae42c648ee8cd2bb6cded99a130b05a13',
        importDiagnostics: {
          acceptedCount: syntheticWstValueSetSnapshot.length,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: syntheticWstValueSetSnapshot.length,
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'clinmesh-synthetic-wst-value-set',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/48',
        upstreamVersion: 'WS-T-CM-2026',
      }],
      status: 'published',
      valueSetEntryCount: syntheticWstValueSetSnapshot.length,
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
    return this.hospitalReferenceSelection().release
  }

  provenance() {
    const release = this.current()
    return referenceDataProvenanceSchema.parse({
      contentHash: release.contentHash,
      releaseId: release.releaseId,
    })
  }

  hospitalReferenceSelection(): {
    products: ReferenceMedicationProduct[]
    release: ReferenceDataReleaseSummary
    services: ReferenceMedicalService[]
    valueSetEntries: ReferenceValueSetEntry[]
  } {
    const release = this.#releases().items.find(item => (
      item.medicationProductCount > 0
      && item.serviceCount > 0
      && item.valueSetEntryCount > 0
    ))
    const builtin = builtinReferenceData().items[0]!
    const builtinSelection = {
      products: syntheticNhsaMedicationProductSnapshot,
      release: builtin,
      services: syntheticNhcMedicalServiceSnapshot,
      valueSetEntries: syntheticWstValueSetSnapshot,
    }
    if (release === undefined) return builtinSelection
    if (release.releaseId === BUILTIN_RELEASE_ID) {
      if (release.contentHash !== builtin.contentHash) {
        throw new Error(`Built-in Reference Data Release hash mismatch: ${release.releaseId}`)
      }
      return builtinSelection
    }
    const products = this.#reader?.medicationProducts(release.releaseId) ?? []
    const services = this.#reader?.medicalServices(release.releaseId) ?? []
    const valueSetEntries = this.#reader?.valueSetEntries(release.releaseId) ?? []
    if (products.length !== release.medicationProductCount) {
      throw new Error(`Reference Data Release Product count mismatch: ${release.releaseId}`)
    }
    if (services.length !== release.serviceCount) {
      throw new Error(`Reference Data Release Service count mismatch: ${release.releaseId}`)
    }
    if (valueSetEntries.length !== release.valueSetEntryCount) {
      throw new Error(`Reference Data Release ValueSet count mismatch: ${release.releaseId}`)
    }
    return { products, release, services, valueSetEntries }
  }

  #releases(): ReferenceDataReleaseList {
    const releases = this.#reader?.list()
    if (releases === undefined || releases.items.length === 0) return builtinReferenceData()
    if (releases.items.some(release => (
      release.medicationProductCount > 0
      && release.serviceCount > 0
      && release.valueSetEntryCount > 0
    ))) return releases
    const builtin = builtinReferenceData().items[0]!
    return referenceDataReleaseListSchema.parse({
      items: [
        ...releases.items,
        ...(releases.items.some(release => release.releaseId === builtin.releaseId) ? [] : [builtin]),
      ],
    })
  }
}
